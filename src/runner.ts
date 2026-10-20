// bot.survival.play(): the milestone loop. The next milestone not done, its goals planned and run through the
// executor (the base by buildBase, the enchanting by its handler), the night slept through when there's a bed, a death
// recovered from (back to the death spot while the items last, else to the base for a kit), the memory saved to a
// JSON file after each milestone so a run can resume, and an event with the tick count at each milestone reached.
// The enchanting, nether, eyes and End milestones run through src/milestones.ts (the enchanting, nether, stronghold and
// End skills); bot.survival.handlers or play's options replace any milestone's handler, and stopAt stops play before one.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from './core/errors'
import { isBed } from './core/items'
import { Inventory, type ItemCount } from './core/inventory'
import { normalizeDimension, type WorldMemory, type WorldMemoryJSON } from './core/memory'
import { FOOD_GOAL, FOOD_POINTS, MILESTONES, foodGoals, milestonesAhead, type Milestone, type MilestoneId, type ProgressState } from './planner/progression'
import { heldFor, unitValue, type ObtainRequest } from './planner/obtain'
import { comeUp, dayPhase, nightAction, nightGoals, topUpPlaces } from './planner/schedule'
import { describeLevel, StockPolicy, stockedItem, storedAtBase, type StockLevel, type StockOptions, type StockPlace, type TopUp } from './planner/stock'
import { onSurface, SURFACE_MIN_Y } from './executor/explore'
import { itemTags } from './core/tags'
import type { Station } from './planner/steps'
import { buildBase, HOUSE_BLUEPRINT, HOUSE_DEPTHS, type BuildBaseOptions } from './base/build'
import { baseRecord } from './base/pois'
import { DEPOT_POI, Executor, describeRequest, ownedInventory, type ExecutorOptions, type PlanOptions } from './executor/executor'
import { SPARE_FOOD_POINTS, milestoneNeeds, spareKitGoals, stockKeepRule, tripSpareGoals } from './executor/keep'
import { isAbort } from './skills/errors'
import { navigate, navigateNear, pickaxeForTheWay } from './skills/navigate'
import { pickupDrops } from './skills/pickupDrops'
import { retrieveItems } from './skills/chest'
import { canSleepNow, sleep } from './skills/sleep'
import { MILESTONE_HANDLERS, harvestGrownFarms } from './milestones'
import { EPOCHS, EPOCH_HANDLERS, isEpoch, nextEpoch } from './epochs'
import { TRIP_KIT, keepUnbroken, takeTripKit } from './skills/tripKit'
import { armorPoints, shelter, sleepThroughNight, undergroundAtWork } from './skills/shelter'
import { overland } from './end/strongholdSkills'
import { unstick } from './executor/explore'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import type { Diagnostics, ReportSummary, WatchdogOptions } from './diagnostics'
import { isDeathMessage } from './diagnostics/death'
import { RANGED_HOSTILES } from './reflexes/rules'
import { blockIdsNamed, findBlock } from './core/findBlocks'
import type { Seed } from './worldgen'

export interface MilestoneContext {
  bot: Bot
  milestone: Milestone
  state: ProgressState
  executor: Executor
  signal: AbortSignal
  log: (line: string) => void
  /** the world's seed, when play was given it (the End Cities' placement for the elytra epoch) */
  seed?: Seed
}

/** works on a milestone; play checks `done` again after it returns */
export type MilestoneHandler = (ctx: MilestoneContext) => Promise<void>

/**
 * The milestones that need skills play doesn't have: a handler has to be registered for them (bot.survival.handlers).
 * The nether, eyes and End have theirs now (src/milestones.ts); `stopAt` stops play before one all the same.
 */
export const UNWIRED: readonly MilestoneId[] = []

/**
 * Milestones the game can be won without (enchanted gear helps, but the dragon dies to unenchanted diamond): one that
 * fails maxFailures times in a row is left out and play goes on, where any other stops it
 */
export const OPTIONAL_MILESTONES: readonly MilestoneId[] = ['enchanting']
/** the ticks an optional milestone may have in all before it's left out (the enchant epoch's herd, shelves and levels fit in 300000) */
export const OPTIONAL_MILESTONE_TICKS = 400000

/** milestones that are a trip across the world, not worked from home: the night's mining waits till they're done */
/** the times a milestone not ready to go on is tried again before it counts as a failure */
export const NOT_READY_TRIES = 10

/** the ticks the re-equipping after a death may take in all */
export const REEQUIP_TICKS = 24000

/** the basics a bot back from a death makes again when it lacks them, in order */
export function reequipGoals (inv: { count: (name: string) => number, countAny?: (names: readonly string[]) => number }): ObtainRequest[] {
  const any = (names: string[]): number => names.reduce((n, name) => n + inv.count(name), 0)
  const out: ObtainRequest[] = []
  const picks = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe']
  const swords = ['netherite_sword', 'diamond_sword', 'iron_sword']
  if (any([...picks, 'stone_pickaxe', 'wooden_pickaxe']) === 0) out.push({ item: 'stone_pickaxe', count: 1 })
  if (any([...swords, 'stone_sword']) === 0) out.push({ item: 'stone_sword', count: 1 })
  if (any(picks) === 0) out.push({ item: 'iron_pickaxe', count: 1 })
  if (any(['bucket', 'water_bucket', 'lava_bucket']) === 0) out.push({ item: 'bucket', count: 1 })
  if (any(swords) === 0) out.push({ item: 'iron_sword', count: 1 })
  if (any(['iron_chestplate', 'diamond_chestplate', 'netherite_chestplate']) === 0) out.push({ item: 'iron_chestplate', count: 1 })
  return out
}

/** deaths in a row while recovering from one before play just goes on */
export const RECOVERY_DEATHS = 5

export const TRIP_MILESTONES: readonly MilestoneId[] = ['eyes', 'end']
/** the stock's marks topped up on a trip: what it spends on the way (food, arrows, blocks to bridge and pillar with) */
export const TRIP_STOCK_MARKS: readonly string[] = ['food', 'arrow', 'stone']

export interface MilestoneEvent {
  id: MilestoneId
  title: string
  /** the bot's physics ticks (one a server tick under lockstep), over all the runs of a resumed game */
  tick: number
  /** wall-clock milliseconds since play started (this run) */
  wallMs: number
  /** the stock's levels then, carried and stored, by mark (planner/stock.ts; none without a stock policy) */
  stock?: Record<string, { carried: number, stored: number, low: number, high: number }>
}

export interface PlayOptions {
  /** stop once this milestone is reached */
  until?: MilestoneId
  /** stop before working on this milestone */
  stopAt?: MilestoneId
  /** milestones treated as done (not worked on) */
  skip?: MilestoneId[]
  /**
   * once the dragon is dead, go on with the epochs (src/epochs.ts: a farm kept, an experience farm, mending on the
   * gear), each left out after maxFailures, play finishing when none is left (default false: play ends at the dragon)
   */
  epochs?: boolean
  /**
   * the world's seed when it's known: the epochs go by the structures it places (the End Cities' candidates), not only
   * by what's in sight
   */
  seed?: Seed
  /** handlers by milestone, over bot.survival.handlers and the defaults */
  handlers?: Partial<Record<MilestoneId, MilestoneHandler>>
  /** the memory and progress are saved here after every milestone and step, and loaded from it at the start */
  saveFile?: string
  /** where to save instead of a file (a browser's localStorage, which has no fs), over saveFile */
  saveStore?: SaveStore
  /** sleep at night when a bed is at hand (default true) */
  sleep?: boolean
  /** from dusk with a pickaxe and no bed, mine through the night (the schedule's nightAction; default true) */
  nightMining?: boolean
  /** go back for the items when the bot died at most this many ticks ago (default 6000: ItemEntity's 5 min lifespan) */
  deathItemTicks?: number
  /** a milestone failing this many times in a row stops play (default 5) */
  maxFailures?: number
  /** the stock policy's top-ups: false for none, options for another policy than bot.survival.stock (createPlugin's) */
  stock?: false | StockOptions
  executor?: ExecutorOptions
  base?: Partial<Omit<BuildBaseOptions, 'executor'>>
  /** stop after this many ticks of this run (the work in hand is aborted) */
  maxTicks?: number
  /** a line per milestone, plan and failure (default: console.log with a [survival] prefix and the tick, tickLine) */
  log?: (line: string) => void
  signal?: AbortSignal
  /** the stall watchdog's limits (bot.survival.diagnostics: a stall report when the work gets nowhere) */
  watchdog?: WatchdogOptions
}

export interface PlayResult {
  reached: MilestoneEvent[]
  /** the milestone play stopped before, null when the dragon is dead or `until` was reached */
  stoppedAt: MilestoneId | null
  reason: 'until' | 'finished' | 'unwired' | 'failed' | 'aborted' | 'budget'
  error?: unknown
}

/** where play keeps its save (SaveFile's JSON): a file (saveFile), or any other storage */
export interface SaveStore {
  /** the JSON saved last, null when there's none yet */
  read: () => string | null
  write: (json: string) => void
  /** where it is, for the log */
  name: string
}

/** a save file, written whole to a .tmp file and renamed over the old one */
export function fileSaveStore (file: string): SaveStore {
  return {
    name: file,
    read: () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
    write: (json) => {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, json)
      fs.renameSync(tmp, file)
    }
  }
}

interface SaveFile {
  version: 1
  memory: WorldMemoryJSON
  reached: MilestoneEvent[]
  /** ticks of the earlier runs */
  ticks: number
  /** the reports of the stuck bot so far (bot.survival.diagnostics' summaries: kind, tick, diagnosis, file) */
  reports?: ReportSummary[]
}

/** the bot's state as the milestones read it */
export function progressState (bot: Bot, memory: WorldMemory): ProgressState {
  const items: ItemCount[] = bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
  const equipment: string[] = []
  const enchanted: string[] = []
  const mended: string[] = []
  for (const slot of [5, 6, 7, 8, 45]) {
    const item = bot.inventory.slots[slot]
    if (item != null) equipment.push(item.name)
  }
  for (const item of [...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(s => bot.inventory.slots[s])]) {
    if (item != null && (item.enchants?.length ?? 0) > 0) enchanted.push(item.name)
    if (item != null && item.name !== 'enchanted_book' && (item.enchants ?? []).some(e => e.name === 'mending')) mended.push(item.name)
  }
  const base = baseRecord(memory)
  const stations: Station[] = []
  if (base?.table != null) stations.push('crafting_table')
  if ((base?.furnaces.length ?? 0) > 0) stations.push('furnace')
  return { inventory: new Inventory(bot.registry as any, items), equipment, memory, stations, enchanted, mended, advancements: [...((bot as any).survival?.advancements ?? [])] }
}

/**
 * A respawn this far from the trip kit or further walks there by day when it has no armor (a 26.3 bot respawned at the
 * world's spawn at night, bare, walked 600 blocks into skeletons and a creeper and was blown up)
 */
export const NIGHT_WALK_DISTANCE = 64

/** whether to wait the night out (a bed by, else a hole dug: shelter) before the walk to the trip kit */
export function waitOutNightFirst (timeOfDay: number, distance: number, armor: number): boolean {
  return canSleepNow(timeOfDay, false) && distance > NIGHT_WALK_DISTANCE && armor === 0
}

/**
 * The night waited out where the bot is: the bed by if there's one, else a hole dug in the ground (shelter). A try
 * resumed by day (the task preempted by a reflex) has no night left to wait out.
 */
export async function waitOutTheNight (bot: Bot, signal: AbortSignal): Promise<unknown> {
  if (!canSleepNow(bot.time?.timeOfDay ?? 0, false)) return
  const bed = typeof bot.findBlock === 'function' ? findBlock(bot, { matching: blockIdsNamed(bot, isBed), maxDistance: 16 }) : null
  if (bed != null) {
    try {
      return await sleepThroughNight(bot, { signal, bedDistance: 16 })
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'DIED')) throw err
      // the night over as it went for the bed (the server's 'not night' at dawn): nothing more to wait out; else a hole
      if (!canSleepNow(bot.time?.timeOfDay ?? 0, false)) return
    }
  }
  return await shelter(bot, { signal })
}

/** whether a death spot is worth going back to: in this dimension, not underground, in lava or the void, the items not gone yet */
export function deathSpotWorthIt (death: { x: number, y: number, z: number, dimension: string, seen: number, underground?: boolean, worth?: boolean, killer?: string } | null, now: { tick: number, dimension: string, position: Vec3, minY: number, blockAt: (pos: Vec3) => { name: string } | null, bare?: boolean }, maxTicks: number): boolean {
  if (death == null || death.dimension !== now.dimension) return false
  // shot dead, and back bare (no armor, no shield): the archer is likely where it was (a skeleton in a tree's shade by
  // day), and shoots again; a 26.3 bot went back so to its spot by a skeleton and was shot dead again (full-26.3-fresh-d)
  if (death.killer != null && RANGED_HOSTILES.has(death.killer) && now.bare === true) return false
  // nothing dropped worth the trip (dropsWorthATrip): the mobs that killed the bot are likely still there
  if (death.worth === false) return false
  // a death in a cave or down a mine is left: the mobs that killed the bot in the dark are still there (and a trip
  // down after the items on seed 4 ended in a fall and another death)
  if (death.underground === true) return false
  if (death.y < now.minY + 1) return false
  const age = now.tick - death.seen
  if (age < 0 || age > maxTicks) return false
  // the way there, at walking speed, before the items despawn
  const travel = now.position.distanceTo(new Vec3(death.x, death.y, death.z)) * 5
  if (age + travel > maxTicks) return false
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const name = now.blockAt(new Vec3(death.x + dx, death.y + dy, death.z + dz))?.name
      if (name === 'lava' || name === 'fire') return false
    }
  }
  return true
}

/**
 * Whether the trip back to a death spot waits for the day first, or is given up: a death to a mob at night in the
 * overworld, the night not over, is gone back to by day (the mobs that killed the bot are about it all night; they burn
 * or go off by day) if the items would still be there by then and the way there (`travel` ticks), else not at all.
 * 'go' otherwise.
 */
export function deathSpotTiming (death: { seen: number, killer?: string } | null, now: { tick: number, timeOfDay: number, dimension: string }, travel: number, maxTicks: number): 'go' | 'wait' | 'skip' {
  if (death == null || death.killer == null || now.dimension !== 'overworld' || !canSleepNow(now.timeOfDay, false)) return 'go'
  // (the night's end: the undead burn from about 23460, VanillaTime's sunrise)
  const toDay = (24000 + 23460 - now.timeOfDay) % 24000
  return now.tick - death.seen + toDay + travel <= maxTicks ? 'wait' : 'skip'
}

/** a system message about the player that isn't an advancement or a join: a death message (DeathMessageType's) */
export { isDeathMessage }

/** logs cut at dusk for a night down the mine with no wood carried, if they cost DUSK_WOOD_TICKS or less */
export const DUSK_LOGS = 4
export const DUSK_WOOD_TICKS = 800

/** the wood carried, in logs (a log is 4 planks, a plank 2 sticks) */
export function woodCarried (inv: Inventory): number {
  const tags = itemTags(inv.registry)
  return inv.countAny(tags.resolve('#logs_that_burn')) + inv.countAny(tags.resolve('#planks')) / 4 + inv.count('stick') / 8
}

/** reflexes firing again within this many ticks of the last are counted, not logged each */
export const REFLEX_LOG_TICKS = 200

/** food points under which a bot past the food milestone gets food again (up to FOOD_POINTS) before going on */
export const FOOD_RESTOCK = FOOD_POINTS / 2

/** ticks a restock that failed waits before it is tried again (the work goes on meanwhile) */
export const RESTOCK_RETRY_TICKS = 6000

/** ticks a stock top-up that ended short (its budget spent, a failure) waits to be tried again */
export const STOCK_RETRY_TICKS = 2400

/** ticks a stock top-up left for later (its plan dearer than its budget: no axe yet, its source far) waits to be looked at again */
export const STOCK_WAIT_TICKS = 600

/** ticks the spare pickaxe a trip carries may cost (the plan's estimate: made from the iron held or stored, not mined for) */
export const TRIP_SPARE_TICKS = 1500

/**
 * The milestone to work on: the first not reached in this game and not done now. One reached stays reached when its
 * items are lost (a death, a broken tool): what a later milestone needs of them its own plan gets, so a death after
 * the iron doesn't send the bot back to the wood, stone and food (seed 7, where it then ran out of ticks hunting cows).
 */
export function nextToWork (state: ProgressState, reached: readonly MilestoneId[], skip: ReadonlySet<MilestoneId> = new Set()): Milestone | null {
  return MILESTONES.find(m => !skip.has(m.id) && !reached.includes(m.id) && !m.done(state)) ?? null
}

/** what to get back first of what a reached milestone gave: food, when it ran low (FOOD_RESTOCK) */
export function restockGoals (state: ProgressState, reached: readonly MilestoneId[]): ObtainRequest[] | null {
  if (!reached.includes('food') || state.inventory.foodPoints() >= FOOD_RESTOCK) return null
  return foodGoals(state.inventory, FOOD_POINTS)
}

/** ticks the milestones' needs (keep.ts milestoneNeeds, planned) hold before they're planned again */
export const MILESTONE_NEEDS_TICKS = 1200

/** how near an earlier deadly spot (one the bot died going back to) a death spot is passed over */
export const DEADLY_SPOT_RADIUS = 16

/** a log line with the game's tick in front, so where a run's ticks went reads off its log: "[survival] t1234 plan 1: ..." */
export function tickLine (tick: number, line: string): string {
  return `[survival] t${tick} ${line}`
}

/** a milestone's goals as the reports list them ("3 iron_ingot") */
export function describeGoals (m: Milestone, state: ProgressState): string[] {
  try {
    return m.goals(state).map(describeRequest)
  } catch {
    return []
  }
}

/** gets the goals of a milestone through the executor */
const obtainGoals: MilestoneHandler = async ({ milestone, state, executor, signal }) => {
  await executor.obtain(milestone.goals(state), signal)
}

const defaultHandlers: Partial<Record<MilestoneId, MilestoneHandler>> = {
  base: async ({ bot, executor, signal, log }) => {
    const opts = (bot as any).survival?.playOptions?.base ?? {}
    // the first base is the minimal house of day 1, dug in a few blocks under the ground (HOUSE_BLUEPRINT); the full
    // creeper-proof base is play's base options' (BASE_BLUEPRINT) for later
    await buildBase(bot, { blueprint: HOUSE_BLUEPRINT, depths: HOUSE_DEPTHS, chests: 2, ...opts, executor, signal, log })
  },
  ...MILESTONE_HANDLERS,
  ...EPOCH_HANDLERS
}

export class Runner {
  readonly executor: Executor
  readonly reached: MilestoneEvent[] = []
  private ticksBefore = 0
  /** the milestone being worked on (play's stop names it when an abort gets past the loop) */
  private current: MilestoneId | null = null
  /** the milestone being worked on, for what the bag keeps (milestoneNeeds) */
  private working: Milestone | null = null
  /** the needs last planned, kept MILESTONE_NEEDS_TICKS */
  private needs: { id: MilestoneId, tick: number, needs: Readonly<Record<string, number>> } | null = null
  /** the save loaded (or there was none): the chests' changes are saved from then on */
  private loaded = false
  private readonly started = Date.now()
  private readonly log: (line: string) => void
  private sleepCooldownUntil = 0
  /** play's signal, for the night's work started from the executor's beforeStep hook */
  private playSignal?: AbortSignal
  /** the day (bot.time.day) whose night's mining is over: the rest of that night is the milestones' and the reflexes' */
  private nightMinedDay = -1
  private inNightWork = false
  private restockRetryAt = 0
  private readonly store: SaveStore | null
  /** what play keeps on hand beyond the milestones' needs (planner/stock.ts), null for nothing */
  readonly stock: StockPolicy | null
  /** a stock mark's next top-up, by id: STOCK_RETRY_TICKS after one ended short */
  private readonly stockRetryAt = new Map<string, number>()

  constructor (readonly bot: Bot, readonly options: PlayOptions = {}) {
    this.log = options.log ?? (line => console.log(tickLine(this.tick, line)))
    this.store = options.saveStore ?? (options.saveFile != null ? fileSaveStore(options.saveFile) : null)
    // the reports of a stuck bot next to the save (a stuck folder), when nothing else says where: an e2e run's
    // checkpoints have them then
    const diag = this.diagnostics
    if (diag != null && !diag.dirChosen && diag.dir == null && options.saveFile != null) diag.dir = path.join(path.dirname(path.resolve(options.saveFile)), 'stuck')
    const stock = options.stock
    this.stock = stock === false || stock?.enabled === false ? null : stock != null ? new StockPolicy(stock) : (bot as any).survival?.stock ?? null
    this.executor = new Executor(bot, {
      log: this.log,
      home: () => this.home(),
      milestoneNeeds: () => this.milestoneNeeds(),
      ...options.executor,
      // the stock's working set carried, the rest stored at the base
      keep: options.executor?.keep ?? (this.stock != null ? stockKeepRule(this.stock) : undefined),
      // and with no base's chests to take the rest, the stock over its working set goes when room is wanted (the
      // tunnels' cobblestone, 160 of it on 26.3 seed 3, the bag full: the diamond pickaxe's craft failed for room)
      surplus: options.executor?.surplus ?? (name => this.stock?.keepCount(name, bot.registry as any) != null && (baseRecord(this.memory)?.chests.length ?? 0) === 0),
      // the route's stone over the working set is thrown away once the stock has its high mark (stored before: a 26.3
      // bag down the diamonds' mine held 433 cobblestone)
      stocked: options.executor?.stocked ?? (name => this.stock == null || this.bot.entity == null || stockedItem(this.stock.marks, name, ownedInventory(this.bot), this.stockStored(), this.reached.map(r => r.id))),
      hooks: {
        ...options.executor?.hooks,
        beforeStep: async (step) => {
          await options.executor?.hooks?.beforeStep?.(step)
          await this.nightCheck()
          await this.nightSchedule(this.playSignal)
        }
      }
    })
  }

  get memory (): WorldMemory {
    return this.executor.memory
  }

  /**
   * What the milestone being worked on (else the next to work on) and the one after it need (keep.ts milestoneNeeds:
   * their goals, the plan for them, their kit), planned again every MILESTONE_NEEDS_TICKS: no store, stash, depot or
   * throw takes it from the bag
   */
  milestoneNeeds (): Readonly<Record<string, number>> {
    if (this.bot.entity == null || this.bot.inventory == null) return {}
    const tick = this.bot.survival.tasks.tick
    try {
      const state = progressState(this.bot, this.memory)
      const m = this.working ?? nextToWork(state, this.reached.map(r => r.id))
      if (m == null) return {}
      if (this.needs != null && this.needs.id === m.id && tick - this.needs.tick < MILESTONE_NEEDS_TICKS) return this.needs.needs
      const needs = milestoneNeeds(milestonesAhead(m, state), state, goals => this.executor.plan(goals, state.inventory))
      this.needs = { id: m.id, tick, needs }
      return needs
    } catch {
      return this.needs?.needs ?? {}
    }
  }

  /** the reports of a stuck bot (bot.survival.diagnostics): told of each milestone, its failures and the waits */
  get diagnostics (): Diagnostics | undefined {
    return (this.bot as any).survival?.diagnostics
  }

  /** ticks over all runs of this game */
  get tick (): number {
    return this.ticksBefore + this.bot.survival.tasks.tick
  }

  private home (): Vec3 | null {
    const base = this.memory.base
    if (base != null) return new Vec3(base.x, base.y, base.z)
    const spawn = (this.bot as any).spawnPoint as Vec3 | undefined
    return spawn ?? null
  }

  load (): void {
    const json = this.store?.read() ?? null
    if (json == null) return
    const data: SaveFile = JSON.parse(json)
    if (data.version !== 1) throw new Error(`unknown save file version ${String(data.version)}`)
    this.memory.restore(data.memory)
    // the trip kit's chest and the spawn bed by it kept from the paths again (keepUnbroken: the bed's other half is
    // one of the cells round its foot)
    const kept: Vec3[] = []
    for (const p of this.memory.getPois(TRIP_KIT, { dimension: 'overworld' })) kept.push(new Vec3(p.x, p.y, p.z))
    for (const p of this.memory.getPois('spawn_bed', { dimension: 'overworld' })) {
      const foot = new Vec3(p.x, p.y, p.z)
      kept.push(foot, foot.offset(1, 0, 0), foot.offset(-1, 0, 0), foot.offset(0, 0, 1), foot.offset(0, 0, -1))
    }
    if (kept.length > 0) keepUnbroken(this.bot, kept)
    this.reached.push(...data.reached)
    this.ticksBefore = data.ticks
    // the memory's clock goes on from the save's (a chest's age, a death's)
    this.memory.tickBase = data.ticks
    this.memory.now = this.tick
    if (Array.isArray(data.reports)) this.diagnostics?.restoreHistory(data.reports)
    this.log(`resumed from ${this.store?.name ?? ''}: ${data.reached.length > 0 ? data.reached.map(r => r.id).join(', ') : 'no milestones yet'}`)
  }

  save (): void {
    if (this.store == null) return
    const data: SaveFile = { version: 1, memory: this.memory.toJSON(), reached: this.reached, ticks: this.tick }
    const reports = this.diagnostics?.history
    if (reports != null && reports.length > 0) data.reports = reports
    this.store.write(JSON.stringify(data))
  }

  private handlerFor (id: MilestoneId): MilestoneHandler | null {
    const registered = (this.bot as any).survival?.handlers?.[id] as MilestoneHandler | undefined
    const handler = this.options.handlers?.[id] ?? registered ?? defaultHandlers[id]
    if (handler != null) return handler
    if (UNWIRED.includes(id)) return null
    return obtainGoals
  }

  /** the milestones done now that weren't before: their events */
  private noteReached (state: ProgressState): void {
    for (const m of [...MILESTONES, ...(this.options.epochs === true ? EPOCHS : [])]) {
      if (this.reached.some(r => r.id === m.id)) continue
      if (!m.done(state)) continue
      const event: MilestoneEvent = { id: m.id, title: m.title, tick: this.tick, wallMs: Date.now() - this.started }
      const levels = this.stockLevels()
      if (levels != null) {
        event.stock = Object.fromEntries(levels.map(l => [l.mark.id, { carried: Math.floor(l.carried), stored: Math.floor(l.stored), low: l.mark.low, high: l.mark.high }]))
      }
      this.reached.push(event)
      this.log(`milestone ${m.id} reached at tick ${event.tick} (${(event.wallMs / 1000).toFixed(1)} s)`)
      this.diagnostics?.milestoneReached(m.id)
      if (levels != null) this.log(`stock at ${m.id}: ${levels.map(describeLevel).join(', ')}`)
      // the save as it is when the milestone is reached: the e2e's checkpoint copies it with the world
      this.save()
      this.bot.emit('survivalMilestone' as any, event)
    }
  }

  async play (): Promise<PlayResult> {
    // the caller's signal and the tick budget, as one
    const controller = new AbortController()
    const outer = this.options.signal
    const onOuter = (): void => controller.abort(outer?.reason)
    if (outer?.aborted === true) onOuter()
    outer?.addEventListener('abort', onOuter, { once: true })
    const startTick = this.bot.survival.tasks.tick
    let overBudget = false
    const onTick = (): void => {
      if (this.options.maxTicks == null || overBudget || this.bot.survival.tasks.tick - startTick < this.options.maxTicks) return
      overBudget = true
      this.log(`out of ticks (${this.options.maxTicks})`)
      controller.abort(new TaskError('TIMEOUT', `play ran out of its ${this.options.maxTicks} ticks`))
    }
    this.bot.on('physicsTick', onTick)
    // the reflexes that preempt the work, in the log: one line a reflex, repeats within REFLEX_LOG_TICKS counted
    let last: { name: string, tick: number, repeats: number } | null = null
    const onReflex = (name: string, detail?: string): void => {
      const tick = this.tick
      if (last != null && last.name === name && tick - last.tick < REFLEX_LOG_TICKS) { last.repeats++; last.tick = tick; return }
      if (last != null && last.repeats > 0) this.log(`reflex ${last.name} ${last.repeats} times more`)
      // what it does and where (a fall's start and landing: the falls off the End's pillars said nothing of where)
      const p = this.bot.entity?.position
      this.log(`reflex ${name}${detail != null && detail !== '' ? ` (${detail})` : ''}${name === 'fall' && p != null ? ` at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : ''}`)
      last = { name, tick, repeats: 0 }
    }
    this.bot.on('reflex' as any, onReflex)
    // the deaths, where and why: the server's death message (the system chat line that starts with the bot's name)
    const onDeath = (): void => { const p = this.bot.entity?.position; this.log(`died at ${p != null ? `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}` : '?'}`) }
    const onMessage = (message: string): void => {
      if (typeof message === 'string' && message.startsWith(`${this.bot.username} `) && isDeathMessage(message)) this.log(`server: ${message}`)
    }
    this.bot.on('death', onDeath)
    this.bot.on('messagestr' as any, onMessage)
    // the save written after every change to a chest's remembered contents (a store, a take, a depot put down), once
    // for the changes of one moment, not only at the milestones: a checkpoint's save from before a rekit's take had
    // the base's chest still holding the diamond pickaxe, and the resumed run walked there for it (26.3)
    let saving = false
    const offChests = this.memory.onChestChange(() => {
      if (!this.loaded || saving) return
      saving = true
      queueMicrotask(() => {
        saving = false
        try { this.save() } catch (err) { this.log(`no save after a chest's change: ${(err as Error).message}`) }
      })
    })
    // the stall watchdog, on play's ticks
    const diag = this.diagnostics
    const clock = (): number => this.tick
    if (diag != null) diag.clock = clock
    const disarm = diag?.arm(this.options.watchdog)
    try {
      let result: PlayResult
      try {
        result = await this.loop(controller.signal)
      } catch (err) {
        // an abort that got past the loop's own catches (a recovery from a death under way when the budget ran out:
        // pnpm e2e crashed on the TaskError, exit code 2, no FAIL line) is still a stop
        if (!controller.signal.aborted) throw err
        result = this.stop(this.current, 'aborted', err)
      }
      if (overBudget && result.reason === 'aborted') result.reason = 'budget'
      return result
    } finally {
      this.bot.off('physicsTick', onTick)
      this.bot.off('reflex' as any, onReflex)
      this.bot.off('death', onDeath)
      this.bot.off('messagestr' as any, onMessage)
      offChests()
      outer?.removeEventListener('abort', onOuter)
      disarm?.()
      if (diag != null && diag.clock === clock) diag.clock = null
    }
  }

  private async loop (signal: AbortSignal): Promise<PlayResult> {
    this.playSignal = signal
    const skip = new Set(this.options.skip ?? [])
    const failures = new Map<MilestoneId, number>()
    const notReady = new Map<MilestoneId, number>()
    const spent = new Map<MilestoneId, number>()
    const maxFailures = this.options.maxFailures ?? 5
    const stopped = (): boolean => signal.aborted
    this.load()
    this.loaded = true
    for (;;) {
      if (stopped()) return this.stop(null, 'aborted')
      if (this.bot.health <= 0 || (this.bot as any).isAlive === false) await this.recover(signal)
      const state = progressState(this.bot, this.memory)
      this.noteReached(state)
      if (this.options.until != null && this.reached.some(r => r.id === this.options.until)) return this.stop(null, 'until')
      const reachedIds = this.reached.map(r => r.id)
      try {
        await this.nightSchedule(signal)
      } catch (err) {
        if (stopped()) return this.stop(null, 'aborted', err)
        if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
          this.log(`died in the night's mine: ${(err as Error).message}`)
          await this.recover(signal)
          continue
        }
        throw err
      }
      const restock = this.bot.survival.tasks.tick >= this.restockRetryAt ? restockGoals(state, reachedIds) : null
      if (restock != null) {
        try {
          this.log(`food low (${state.inventory.foodPoints()} points): getting more before going on`)
          await this.untilDusk(signal, async (s) => {
            // the renewable food first: the farm's harvest
            await harvestGrownFarms(this.bot, this.executor, s, this.log)
            await this.executor.obtain(restockGoals(progressState(this.bot, this.memory), reachedIds) ?? [], s)
          })
        } catch (err) {
          if (stopped()) return this.stop('food', 'aborted', err)
          if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
            this.log(`died getting food: ${(err as Error).message}`)
            await this.recover(signal)
            continue
          }
          this.restockRetryAt = this.bot.survival.tasks.tick + RESTOCK_RETRY_TICKS
          this.log(`no more food for now: ${(err as Error).message}`)
        }
        continue
      }
      // the epochs once the milestones are done (the dragon dead), when play's options ask for them
      const m = nextToWork(state, reachedIds, skip) ?? (this.options.epochs === true ? nextEpoch(state, reachedIds, skip) : null)
      if (m == null) return this.stop(null, 'finished')
      this.current = m.id
      this.working = m
      if (this.options.stopAt === m.id) return this.stop(m.id, 'until')
      const handler = this.handlerFor(m.id)
      if (handler == null) {
        this.log(`milestone ${m.id} needs skills that aren't wired yet: stopping (register bot.survival.handlers.${m.id})`)
        return this.stop(m.id, 'unwired')
      }
      // an optional milestone that has had its time is left out (the enchanting's 5 failures took 300000 ticks of a
      // 26.3 whole game, the dragon not needing it)
      if (OPTIONAL_MILESTONES.includes(m.id) && (spent.get(m.id) ?? 0) >= OPTIONAL_MILESTONE_TICKS) {
        this.log(`milestone ${m.id} left out after ${spent.get(m.id) ?? 0} ticks: on to the next`)
        skip.add(m.id)
        continue
      }
      this.log(`working on ${m.id}: ${m.title}`)
      this.diagnostics?.milestoneStarted(m.id, m.title, describeGoals(m, state))
      const begun = this.bot.survival.tasks.tick
      const account = (): void => { spent.set(m.id, (spent.get(m.id) ?? 0) + this.bot.survival.tasks.tick - begun) }
      try {
        const how = await this.untilDusk(signal, async (s) => {
          await handler({ bot: this.bot, milestone: m, state, executor: this.executor, signal: s, log: this.log, seed: this.options.seed })
          // the milestone ends with the stock topped up for the ones after it, what can be got where the bot is
          // (topUpPlaces: the surface's by day, the mine's down there); the milestone's own marks apply once it's done
          const done = m.done(progressState(this.bot, this.memory))
          await this.topUp(this.topUpPlacesNow(), s, done ? [...reachedIds, m.id] : reachedIds)
        })
        account()
        if (stopped()) return this.stop(m.id, 'aborted')
        if (how === 'dusk') {
          this.log(`dusk: ${m.id} left for the night's mine`)
          continue
        }
        failures.delete(m.id)
      } catch (err) {
        account()
        if (stopped()) return this.stop(m.id, 'aborted', err)
        if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
          this.log(`died working on ${m.id}: ${(err as Error).message}`)
          await this.recover(signal)
          continue
        }
        // a milestone not ready to go on (the nether's gear still being got: netherKit's notReady) is tried again
        // without counting it a failure, NOT_READY_TRIES times (a 26.3 bot back from its deaths failed the nether
        // twice on 'not going into the nether without' its armor, the game's stop three more away)
        if ((err as any)?.notReady === true) {
          const k = (notReady.get(m.id) ?? 0) + 1
          notReady.set(m.id, k)
          if (k < NOT_READY_TRIES) {
            this.log(`milestone ${m.id} not ready (${k}): ${(err as Error).message}`)
            continue
          }
          notReady.delete(m.id)
        }
        const n = (failures.get(m.id) ?? 0) + 1
        failures.set(m.id, n)
        this.log(`milestone ${m.id} failed (${n}): ${(err as Error).message}`)
        this.diagnostics?.milestoneFailed(m.id, err)
        if (n >= maxFailures && (OPTIONAL_MILESTONES.includes(m.id) || isEpoch(m.id))) {
          // the dragon doesn't need it: the game goes on without
          this.log(`milestone ${m.id} left out after ${n} failures: on to the next`)
          skip.add(m.id)
          failures.delete(m.id)
          continue
        }
        if (n >= maxFailures) return this.stop(m.id, 'failed', err)
      }
      try {
        await this.afterTrip(signal)
      } catch (err) {
        if (stopped()) return this.stop(m.id, 'aborted', err)
        throw err
      }
      this.save()
    }
  }

  private stop (at: MilestoneId | null, reason: PlayResult['reason'], error?: unknown): PlayResult {
    this.save()
    const result: PlayResult = { reached: [...this.reached], stoppedAt: at, reason }
    if (error !== undefined) result.error = error
    this.bot.emit('survivalStopped' as any, result)
    return result
  }

  /** the valuables into the base's chests when the bot is back near it */
  private async afterTrip (signal?: AbortSignal): Promise<void> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    const p = this.bot.entity.position
    if (Math.hypot(p.x - base.origin.x, p.y - base.origin.y, p.z - base.origin.z) > 96) return
    try {
      await this.executor.storeAtBase({}, signal)
      await this.stashSpareKit(signal)
      await this.carrySpare(signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`storing failed: ${(err as Error).message}`)
    }
  }

  /**
   * A spare kit in the base's chests before the next trip out (spareKitGoals: a second pickaxe, sword and axe of the
   * tier carried, and food), made when they lack one and stored, for rekit to take after a death
   */
  async stashSpareKit (signal?: AbortSignal): Promise<void> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    const dimension = this.memory.base?.dimension ?? 'overworld'
    const stored: Record<string, number> = {}
    for (const c of base.chests) {
      for (const [name, n] of Object.entries(this.memory.chestAt(c, dimension)?.items ?? {})) stored[name] = (stored[name] ?? 0) + n
    }
    const carried = ownedInventory(this.bot)
    const goals = spareKitGoals(carried, stored)
    if (goals.length === 0) return
    this.log('a spare kit for the base')
    await this.executor.obtain(goals, signal)
    // one of each tool made, and food for the points short
    const inv = ownedInventory(this.bot)
    const items: ItemCount[] = []
    for (const g of goals) {
      if (g.unit === 'nutrition') {
        // the points the chests are short of (the goal is what was carried and those)
        let points = Math.min(SPARE_FOOD_POINTS, g.count - heldFor(carried, FOOD_GOAL, g))
        for (const name of [...FOOD_GOAL].sort((a, b) => unitValue(g, b, this.bot.registry as any) - unitValue(g, a, this.bot.registry as any))) {
          const n = Math.min(inv.count(name), Math.ceil(Math.max(0, points) / unitValue(g, name, this.bot.registry as any)))
          if (n <= 0) continue
          items.push({ name, count: n })
          points -= n * unitValue(g, name, this.bot.registry as any)
        }
      } else {
        const name = (g.item as readonly string[]).find(a => inv.count(a) > 1) ?? (g.item as readonly string[]).find(a => inv.count(a) > 0)
        if (name != null) items.push({ name, count: 1 })
      }
    }
    await this.executor.storeExact(items, signal)
  }

  /**
   * The spare pickaxe the next trip carries (tripSpareGoals: an iron one beside a diamond one), made when it's cheap
   * (within TRIP_SPARE_TICKS by the plan: the iron held or stored at the base), so a pickaxe worn out far off has
   * another in the bag
   */
  async carrySpare (signal?: AbortSignal): Promise<void> {
    const goals = tripSpareGoals(ownedInventory(this.bot))
    if (goals.length === 0) return
    const plan = this.executor.plan(goals)
    if (!plan.ok || plan.cost > TRIP_SPARE_TICKS) return
    this.log(`a spare pickaxe for the trips: ${describeRequest(goals[0])}`)
    try {
      await this.executor.obtain(goals, signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err) || signal?.aborted === true) throw err
      this.log(`no spare pickaxe: ${(err as Error).message}`)
    }
  }

  /**
   * What the base's chests and the mine depots (DEPOT_POI: chests put down away from the base for what the bag couldn't
   * carry) hold, summed (the memory's contents, as seen or stored last)
   */
  stockStored (): Record<string, number> {
    const base = baseRecord(this.memory)
    const dimension = this.memory.base?.dimension ?? 'overworld'
    const chests = (base?.chests ?? []).map(c => this.memory.chestAt(c, dimension))
    for (const d of this.memory.getPois(DEPOT_POI)) chests.push(this.memory.chestAt(d, d.dimension))
    return storedAtBase(chests)
  }

  /** the stock's levels now (carried and at the base), null without a stock policy */
  stockLevels (): StockLevel[] | null {
    if (this.stock == null || this.bot.entity == null) return null
    return this.stock.update(ownedInventory(this.bot), this.stockStored(), this.reached.map(r => r.id))
  }

  /** where the top-ups are got now (topUpPlaces): the surface's by day up there, the mine's at night or deep down */
  private topUpPlacesNow (): StockPlace[] {
    const bot = this.bot
    if (bot.entity == null) return []
    // down at the ores' depth, not a pit or a hill's cave by the surface: on 26.3 seed 2 the stone milestone ended under
    // a hill at y 63, and the day went on coal and iron there, the stack of logs left for another day
    return topUpPlaces(dayPhase(bot.time?.timeOfDay ?? 0), bot.entity.position.y < SURFACE_MIN_Y)
  }

  /** the stock's top-ups due at these places (in the overworld, where their sources are), not waiting for a retry */
  dueTopUps (places: readonly StockPlace[], reached: readonly MilestoneId[] = this.reached.map(r => r.id)): TopUp[] {
    if (this.stock == null || places.length === 0 || this.bot.entity == null) return []
    if (normalizeDimension(this.bot.game?.dimension) !== 'overworld') return []
    const now = this.bot.survival.tasks.tick
    // the room counted in the 36 slots the items go to (the owned inventory has the worn armor and the off hand too)
    const bag = new Inventory(this.bot.registry as any, this.bot.inventory.items().map(i => ({ name: i.name, count: i.count })))
    // with no base's chests to take what's over the working set, a top-up gathers no more than it
    const canStore = (baseRecord(this.memory)?.chests.length ?? 0) > 0
    const due = this.stock.topUps(ownedInventory(this.bot), this.stockStored(), reached, places, { bag, canStore }).filter(u => (this.stockRetryAt.get(u.mark.id) ?? 0) <= now)
    // on a trip (the stronghold search, the End) only what the trip itself spends: on 1.21.11 seed 2 a gold top-up mined
    // 48 ores 26 blocks off from the portal room it had just found
    const upNext = nextToWork(progressState(this.bot, this.memory), reached, new Set(this.options.skip ?? []))
    return upNext != null && TRIP_MILESTONES.includes(upNext.id) ? due.filter(u => TRIP_STOCK_MARKS.includes(u.mark.id)) : due
  }

  /**
   * The stock's top-ups due here (dueTopUps), the lowest first, each once: planned without looting the base's chests
   * (what they hold is stock already) and, down the mine, with what a mine has; left for later when the plan costs
   * more than the top-up's budget (its source isn't near: no trees in sight, the ore's level far), and stopped when it
   * has run its budget's ticks. One left waits STOCK_WAIT_TICKS, one that ends short STOCK_RETRY_TICKS. Throws only for a
   * death or the signal.
   */
  async topUp (places: readonly StockPlace[], signal: AbortSignal, reached: readonly MilestoneId[] = this.reached.map(r => r.id)): Promise<void> {
    const tried = new Set<string>()
    for (;;) {
      if (signal.aborted) throw signal.reason
      const up = this.dueTopUps(places, reached).find(u => !tried.has(u.mark.id))
      if (up == null) {
        // marks under way with nothing to gather this trip: no room in the bag (or at their working set, no base)
        const waiting = tried.size === 0 ? (this.stock?.marks ?? []).filter(m => this.stock?.active.has(m.id) === true && places.includes(m.where) && (this.stockRetryAt.get(m.id) ?? 0) <= this.bot.survival.tasks.tick) : []
        if (waiting.length > 0) this.log(`stock: no room this trip for ${waiting.map(m => m.id).join(', ')} (${this.bot.inventory.emptySlotCount?.() ?? '?'} slots free)`)
        return
      }
      tried.add(up.mark.id)
      const retryLater = (ticks = STOCK_RETRY_TICKS): void => { this.stockRetryAt.set(up.mark.id, this.bot.survival.tasks.tick + ticks) }
      const options: PlanOptions = { exclude: ['loot'], ...(places.includes('surface') ? {} : { undergroundOnly: true }) }
      const plan = this.executor.plan([up.request], undefined, options)
      if (!plan.ok || plan.cost > up.budget) {
        this.log(`stock: ${describeLevel(up.level)}: not now (${plan.ok ? `${plan.cost} ticks for ${up.units}, over its ${up.budget}` : 'no plan'})`)
        retryLater(STOCK_WAIT_TICKS)
        continue
      }
      this.log(`stock: ${describeLevel(up.level)}: ${up.units} more, in ${up.budget} ticks at most`)
      const start = this.bot.survival.tasks.tick
      // the stall watchdog is told of what a top-up gathered, so a long trip for it is no stall
      const gained = (): void => {
        const now = this.stockLevels()?.find(l => l.mark.id === up.mark.id)?.have ?? up.level.have
        if (now > up.level.have) this.diagnostics?.progress(`stock ${up.mark.id} ${Math.floor(now)}`)
      }
      try {
        await this.withBudget(up.budget, signal, async (s) => await this.executor.obtain([up.request], s, options))
        gained()
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED') || this.bot.health <= 0) throw err
        gained()
        this.log(`stock: ${up.mark.id} stopped after ${this.bot.survival.tasks.tick - start} ticks: ${(err as Error).message}`)
        retryLater()
      }
    }
  }

  /** runs fn under a signal that also fires once it has run `ticks` ticks */
  private async withBudget<T> (ticks: number, signal: AbortSignal, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController()
    const onOuter = (): void => ctrl.abort(signal.reason)
    if (signal.aborted) onOuter()
    signal.addEventListener('abort', onOuter, { once: true })
    const end = this.bot.survival.tasks.tick + ticks
    const watch = (): void => {
      if (!ctrl.signal.aborted && this.bot.survival.tasks.tick >= end) ctrl.abort(new TaskError('TIMEOUT', `its ${ticks} ticks are up`))
    }
    this.bot.on('physicsTick', watch)
    try {
      return await fn(ctrl.signal)
    } finally {
      this.bot.off('physicsTick', watch)
      signal.removeEventListener('abort', onOuter)
    }
  }

  /** whether a bed is at hand: one held, the base's when near, or one standing nearby */
  private bedAtHand (): boolean {
    const bot = this.bot
    const base = baseRecord(this.memory)
    if (base?.bed != null && bot.entity.position.distanceTo(new Vec3(base.bed.x, base.bed.y, base.bed.z)) <= 64) return true
    if (bot.inventory.items().some(i => isBed(i.name))) return true
    return typeof bot.findBlock === 'function' && findBlock(bot, { matching: blockIdsNamed(bot, isBed), maxDistance: 32 }) != null
  }

  /**
   * The schedule (nightAction): from dusk with a pickaxe and no bed, the night goes down the mine (mineTheNight), once a
   * night; the bed and the shelter are nightCheck's and the night reflex's
   */
  async nightSchedule (signal?: AbortSignal): Promise<void> {
    const due = this.nightDue()
    if (due == null) return
    this.nightMinedDay = due.day
    await this.mineTheNight(due.goals, signal)
  }

  /** the night's mining when the schedule calls for it now (nightAction 'mine', not mined yet this night), else null */
  nightDue (): { day: number, goals: ObtainRequest[] } | null {
    const bot = this.bot
    if (this.inNightWork || this.options.nightMining === false || bot.time == null || bot.entity == null) return null
    const day = (bot.time as any).day ?? Math.floor(((bot.time as any).age ?? 0) / 24000)
    if (day === this.nightMinedDay) return null
    const phase = dayPhase(bot.time.timeOfDay)
    if (phase === 'day') return null
    const reached = this.reached.map(r => r.id)
    // a trip across the world (the stronghold search, the End) isn't stopped for a night down a mine: on 26.3 seed 2
    // the bot dug down 1800 blocks short of the stronghold, mined gold all night, and set off again through the caves
    const upNext = nextToWork(progressState(bot, this.memory), reached, new Set(this.options.skip ?? []))
    if (upNext != null && TRIP_MILESTONES.includes(upNext.id)) return null
    const inv = ownedInventory(bot)
    // the nether's pearls hunted by night (its rods got: the endermen come out on the surface at night): a 26.3 bot
    // back from the fortress with its rods went down a mine for redstone at dusk, the night's endermen left
    if (upNext?.id === 'nether' && inv.count('blaze_rod') + inv.count('blaze_powder') > 0) return null
    const goals = nightGoals(inv, reached)
    const action = nightAction({
      phase,
      overworld: normalizeDimension(bot.game?.dimension) === 'overworld',
      bed: this.options.sleep !== false && this.bedAtHand(),
      pickaxe: inv.bestTool('pickaxe'),
      // the stock's mine top-ups are the night's work too (the ores by night)
      goals: goals.length > 0 || this.dueTopUps(['underground'], reached).length > 0
    })
    return action === 'mine' ? { day, goals } : null
  }

  /**
   * Runs the day's work under a signal that also fires at dusk when the night is to be mined (nightDue, looked at
   * every 20 ticks): a hunt or a walk that runs on into the night is cut off for the mine instead of the night reflex
   * digging in on the surface (seed 7: the hunt ran into the night and the shelter waited 11000 ticks). Resolves
   * 'dusk' when cut off so.
   */
  async untilDusk (signal: AbortSignal, fn: (s: AbortSignal) => Promise<void>): Promise<'done' | 'dusk'> {
    const bot = this.bot
    const ctrl = new AbortController()
    const onOuter = (): void => ctrl.abort(signal.reason)
    if (signal.aborted) onOuter()
    signal.addEventListener('abort', onOuter, { once: true })
    let n = 0
    const watch = (): void => {
      if (++n % 20 !== 0 || ctrl.signal.aborted || this.nightDue() == null) return
      ctrl.abort(new TaskError('ABORTED', 'dusk: the night is for the mine'))
    }
    bot.on('physicsTick', watch)
    try {
      await fn(ctrl.signal)
      return 'done'
    } catch (err) {
      if (!signal.aborted && ctrl.signal.aborted) return 'dusk'
      throw err
    } finally {
      bot.off('physicsTick', watch)
      signal.removeEventListener('abort', onOuter)
    }
  }

  /**
   * The night down the mine: its goals (nightGoals: torches, the iron, the diamonds) one after the other, planned with
   * what a mine has (undergroundOnly), until the day comes back or the food runs low (comeUp). The night reflex leaves
   * the bot to it (bot.survival.nightWork): the staircase down is a roof within a few blocks.
   */
  async mineTheNight (goals: readonly ObtainRequest[], signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    const ctrl = new AbortController()
    const onOuter = (): void => ctrl.abort(signal?.reason)
    if (signal?.aborted === true) onOuter()
    signal?.addEventListener('abort', onOuter, { once: true })
    const watch = (): void => {
      if (ctrl.signal.aborted || !comeUp(dayPhase(bot.time.timeOfDay), ownedInventory(bot).foodPoints(), bot.food ?? 20)) return
      ctrl.abort(new TaskError('ABORTED', 'the night is over'))
    }
    bot.on('physicsTick', watch)
    this.inNightWork = true
    ;(bot as any).survival.nightWork = true
    this.log(`night (time ${bot.time.timeOfDay}): down the mine for ${goals.map(g => `${g.count} ${String(g.item)}`).join(', ')}`)
    try {
      // the sticks of the torches and the tools down there are the day's wood: some cut first when trees are near
      // and none is carried (a respawn at dusk had none, and the night got no torches and no stone pickaxe on seed 4)
      if (woodCarried(ownedInventory(bot)) < 2) {
        const wood = [{ item: '#logs_that_burn', count: DUSK_LOGS }]
        const plan = this.executor.plan(wood)
        if (plan.ok && plan.cost <= DUSK_WOOD_TICKS) {
          await this.executor.obtain(wood, ctrl.signal).catch(err => {
            if (signal?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
            this.log(`night: no wood: ${(err as Error).message}`)
          })
        }
      }
      for (const goal of goals) {
        if (ctrl.signal.aborted) break
        try {
          await this.executor.obtain([{ ...goal, optional: false }], ctrl.signal, { undergroundOnly: true })
        } catch (err) {
          if (signal?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
          if (ctrl.signal.aborted) break
          this.log(`night: no ${String(goal.item)}: ${(err as Error).message}`)
        }
      }
      // the night's goals got: the iron or diamonds milestone goes on down here where its plan needs nothing from up
      // there (the smelting and the crafting), and then the rest of the night is waited out in the lit mine, not
      // spent going up for the day's work: on seed 4 the bot climbed into a ravine at night for animals, sheltered
      // 5000 ticks there, and a zombie killed it
      const reached = this.reached.map(r => r.id)
      const next = MILESTONES.find(m => (m.id === 'iron' || m.id === 'diamonds') && !reached.includes(m.id) && !m.done(progressState(bot, this.memory)))
      if (!ctrl.signal.aborted && next != null) {
        const work = next.goals(progressState(bot, this.memory))
        if (this.executor.plan(work, undefined, { undergroundOnly: true }).ok) {
          this.log(`night: ${next.id} goes on down here`)
          try {
            await this.executor.obtain(work, ctrl.signal, { undergroundOnly: true })
          } catch (err) {
            if (signal?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
            if (!ctrl.signal.aborted) this.log(`night: ${next.id} stopped: ${(err as Error).message}`)
          }
        }
      }
      // the rest of the night for the stock's mine top-ups (stone, coal, torches, the ores), down here at their level
      if (!ctrl.signal.aborted) {
        try {
          await this.topUp(['underground'], ctrl.signal)
        } catch (err) {
          if (signal?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
        }
      }
      // (only when the day's work is the surface's: the hunt, the house. The iron's last logs are a short trip up:
      // waiting for them cost seed 2 7000 ticks)
      const upNext = nextToWork(progressState(bot, this.memory), this.reached.map(r => r.id), new Set(this.options.skip ?? []))
      const surfaceWork = upNext != null && MILESTONES.indexOf(upNext) < MILESTONES.findIndex(m => m.id === 'iron')
      if (!ctrl.signal.aborted && surfaceWork && typeof bot.blockAt === 'function' && !onSurface(p => bot.blockAt(p) as any, bot.entity.position.floored())) {
        this.log(`night (time ${bot.time.timeOfDay}): the rest of it waited out down the mine`)
        // (a wait, not a stall)
        this.diagnostics?.wait('the rest of the night down the mine')
        await new Promise<void>(resolve => {
          if (ctrl.signal.aborted) return resolve()
          ctrl.signal.addEventListener('abort', () => resolve(), { once: true })
        }).finally(() => this.diagnostics?.wait(null))
        if (signal?.aborted === true) throw signal.reason
      }
    } finally {
      bot.off('physicsTick', watch)
      signal?.removeEventListener('abort', onOuter)
      this.inNightWork = false
      ;(bot as any).survival.nightWork = false
    }
    this.log(`night's mining over at time ${bot.time.timeOfDay}`)
  }

  /** sleeps through the night when a bed is at hand: one held, the base's when near, or one standing nearby */
  async nightCheck (signal?: AbortSignal): Promise<void> {
    if (this.options.sleep === false) return
    const bot = this.bot
    const thundering = bot.isRaining && ((bot as any).thunderState ?? 0) > 0
    if (!canSleepNow(bot.time.timeOfDay, thundering)) return
    if (this.bot.survival.tasks.tick < this.sleepCooldownUntil) return
    if (normalizeDimension(bot.game?.dimension) !== 'overworld') return
    // below the surface the night is work (the night reflex sleeps there when the rest is due, its bed's room dug)
    if (typeof bot.blockAt === 'function' && undergroundAtWork(p => bot.blockAt(p) as any, bot.entity.position)) return
    const base = baseRecord(this.memory)
    const baseBed = base?.bed != null && bot.entity.position.distanceTo(new Vec3(base.bed.x, base.bed.y, base.bed.z)) <= 64 ? new Vec3(base.bed.x, base.bed.y, base.bed.z) : null
    const held = bot.inventory.items().some(i => isBed(i.name))
    const near = findBlock(bot, { matching: blockIdsNamed(bot, isBed), maxDistance: 32 }) != null
    if (baseBed == null && !held && !near) return
    this.log(`night (time ${bot.time.timeOfDay}): sleeping`)
    try {
      await this.executor.task('sleep', async (s) => await sleep(bot, { bed: near ? undefined : baseBed ?? undefined, pickUpBed: !near && baseBed == null }, s), signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || (isAbort(err) && signal?.aborted === true)) throw err
      // monsters nearby, the bed taken: try again in a while
      this.sleepCooldownUntil = this.bot.survival.tasks.tick + 400
      this.log(`couldn't sleep: ${(err as Error).message}`)
    }
  }

  /** death spots the bot died again going back to */
  readonly deadlySpots: Vec3[] = []

  /** after a death: respawned, then back for the items, or to the base for a kit (the death report told how it went) */
  /**
   * recoverFromDeath for play's loop: a death on the way back (to the kit, the items) is recovered from in turn, up to
   * RECOVERY_DEATHS times, and a recovery that fails otherwise is logged, play going on (a creeper's death on the
   * walk back to the trip kit was an unhandled rejection that ended the 26.3 run)
   */
  async recover (signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < RECOVERY_DEATHS; i++) {
      try {
        await this.recoverFromDeath(signal)
        return
      } catch (err) {
        if (signal?.aborted === true) throw err
        if (TaskError.is(err, 'DIED') || this.bot.health <= 0) { this.log(`died again recovering: ${(err as Error).message}`); continue }
        this.log(`recovery: ${(err as Error).message}`)
        return
      }
    }
  }

  async recoverFromDeath (signal?: AbortSignal): Promise<void> {
    try {
      await this.recoverOnce(signal)
      this.diagnostics?.recovery({ done: this.bot.survival.tasks.tick })
    } catch (err) {
      this.diagnostics?.recovery({ done: this.bot.survival.tasks.tick, ...(TaskError.is(err, 'DIED') ? {} : { deathSpot: `failed: ${(err as Error).message}` }) })
      throw err
    }
  }

  private async recoverOnce (signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    const diag = this.diagnostics
    if (bot.health <= 0 || (bot as any).isAlive === false) {
      await new Promise<void>(resolve => {
        const done = (): void => { bot.off('spawn', done); resolve() }
        bot.on('spawn', done)
        if ((bot as any).isAlive !== false && bot.health > 0) done()
      })
    }
    // the respawn's position and chunks come a few ticks after
    await bot.waitForTicks(20)
    diag?.recovery({})
    this.save()
    const death = this.memory.death
    // a spot the bot died at again on the way back for its items (mobs in a cave, a fall) is left: a third trip
    // there ends the same way
    const deadly = death != null && this.deadlySpots.some(p => p.distanceTo(new Vec3(death.x, death.y, death.z)) < DEADLY_SPOT_RADIUS)
    if (deadly) this.log(`not back to the death spot at ${death.x} ${death.y} ${death.z}: died there going back before`)
    if (deadly) diag?.recovery({ deathSpot: 'skipped: died there going back before' })
    const worth = !deadly && deathSpotWorthIt(death, {
      // (the memory's clock, the death's stamp's)
      tick: this.memory.now,
      dimension: normalizeDimension(bot.game?.dimension),
      position: bot.entity.position,
      minY: (bot.game as any)?.minY ?? -64,
      blockAt: pos => bot.blockAt(pos),
      bare: armorPoints(bot) === 0 && bot.inventory.items().every(i => i.name !== 'shield') && bot.inventory.slots[45]?.name !== 'shield'
    }, this.options.deathItemTicks ?? 6000)
    if (!deadly && !worth) diag?.recovery({ deathSpot: death == null ? 'skipped: no death spot' : 'skipped: not worth it (nothing worth the trip, another dimension, underground, lava, the void, or the items gone first)' })
    // a death to a mob at night: back by day, the night waited out (indoors, in the base, a hole) where the bot is
    const timing = death == null || !worth ? 'go' : deathSpotTiming(death, { tick: this.memory.now, timeOfDay: bot.time?.timeOfDay ?? 0, dimension: normalizeDimension(bot.game?.dimension) }, bot.entity.position.distanceTo(new Vec3(death.x, death.y, death.z)) * 5, this.options.deathItemTicks ?? 6000)
    if (death != null && worth && timing === 'skip') {
      this.log(`not back to the death spot at ${death.x} ${death.y} ${death.z}: killed by a ${death.killer ?? 'mob'} at night, the items gone by the day`)
      diag?.recovery({ deathSpot: 'skipped: killed at night, the items gone by the day' })
    }
    if (death != null && worth && timing === 'wait') {
      this.log(`the death spot at ${death.x} ${death.y} ${death.z} by day: killed by a ${death.killer ?? 'mob'} at night, the night waited out first`)
      await this.executor.task('wait out the night', async (s) => await waitOutTheNight(bot, s), signal).catch(err => {
        if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
        this.log(`the night: ${(err as Error).message}`)
      })
    }
    if (death != null && worth && timing !== 'skip') {
      this.log(`back to the death spot at ${death.x} ${death.y} ${death.z}`)
      try {
        const spot = new Vec3(death.x, death.y, death.z)
        const picked = await this.executor.task('to the death spot', async (s) => {
          // a long trip the pathfinder may plan short of: a few tries, getting moving by hand between them
          for (let i = 0; ; i++) {
            try {
              await navigateNear(bot, spot, 3, s)
              break
            } catch (err) {
              if (isAbort(err) || i >= 3) throw err
              await unstick(bot, s)
            }
          }
          return await pickupDrops(bot, { near: spot.offset(0.5, 0.5, 0.5), radius: 10 }, s)
        }, signal)
        diag?.recovery({ deathSpot: 'went', picked: { ...picked.items } })
        this.memory.death = null
        return
      } catch (err) {
        if (TaskError.is(err, 'DIED')) {
          this.deadlySpots.push(new Vec3(death.x, death.y, death.z))
          return await this.recoverOnce(signal)
        }
        this.log(`couldn't get the items back: ${(err as Error).message}`)
        diag?.recovery({ deathSpot: `failed: ${(err as Error).message}` })
      }
    }
    // a trip's spare kit (left by the stronghold's portal room before the End) first: the trip goes on from there
    const trip = await this.tripRekit(signal)
    if (trip != null) {
      diag?.recovery({ kit: trip })
      return
    }
    const kit = await this.rekit(signal)
    diag?.recovery({ kit: kit ?? 'no base' })
    // what neither a trip kit nor the base gave back: made again from scratch (a 26.3 bot back from a death with dirt
    // and seeds went on to the nether's portal, every try failing for want of a bucket and a pickaxe)
    await this.reequip(signal)
  }

  /**
   * After a death, the basics the bot lacks made again in order (reequipGoals: a pickaxe and a sword of stone at
   * least, then iron ones, a bucket, an iron chestplate), each as can be, within REEQUIP_TICKS in all
   */
  async reequip (signal?: AbortSignal): Promise<void> {
    const start = this.bot.survival.tasks.tick
    for (const goal of reequipGoals(ownedInventory(this.bot))) {
      if (this.bot.survival.tasks.tick - start > REEQUIP_TICKS) break
      // (each against the inventory as it is now: an earlier one may have brought it)
      if (!reequipGoals(ownedInventory(this.bot)).some(g => g.item === goal.item)) continue
      this.log(`re-equipping: ${goal.item}`)
      try {
        await this.executor.obtain([goal], signal)
      } catch (err) {
        if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
        this.log(`re-equipping: no ${goal.item}: ${(err as Error).message}`)
      }
    }
  }

  /**
   * The trip kit's chest (skills/tripKit) when it still holds something: gone to over the surface and emptied. Null
   * when there's none.
   */
  async tripRekit (signal?: AbortSignal): Promise<Record<string, number> | null> {
    const poi = this.memory.getPois(TRIP_KIT, { dimension: 'overworld', near: this.bot.entity.position })[0]
    if (poi == null || normalizeDimension(this.bot.game?.dimension) !== 'overworld') return null
    const items = this.memory.chestAt(poi, 'overworld')?.items ?? {}
    if (Object.values(items).every(n => n <= 0)) return null
    this.log(`to the trip kit at ${poi.x} ${poi.y} ${poi.z}`)
    const at = new Vec3(poi.x, poi.y, poi.z)
    const bot = this.bot
    const far = bot.entity.position.distanceTo(at)
    if (waitOutNightFirst(bot.time?.timeOfDay ?? 0, far, armorPoints(bot))) {
      this.log(`night, ${far.toFixed(0)} blocks from the trip kit with no armor: the night waited out first`)
      await this.executor.task('wait out the night', async (s) => await waitOutTheNight(bot, s), signal).catch(err => {
        if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
        this.log(`the night: ${(err as Error).message}`)
      })
    }
    try {
      if (this.bot.entity.position.distanceTo(at) > 4) await this.executor.task('to the trip kit', async (s) => { await overland(this.bot, { target: at, range: 2, exactY: true }, s) }, signal)
      return await this.executor.task('the trip kit', async (s) => await takeTripKit(this.bot, this.memory, s), signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`the trip kit: ${(err as Error).message}`)
      return null
    }
  }

  /** takes the kit (what the keep rule keeps: tools, armor, food, torches...) out of the base's chests; what it took, null with no base */
  async rekit (signal?: AbortSignal): Promise<Record<string, number> | null> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return null
    const took: Record<string, number> = {}
    const bot = this.bot
    const dimension = this.memory.base?.dimension ?? 'overworld'
    this.log('to the base for a kit')
    if (base.entrance != null) {
      const e = base.entrance
      await pickaxeForTheWay(bot, signal)
      // nothing to make one from (back from a death with 2 dirt, the dug-in base 5 blocks down, the way in stone and
      // the searches timing out by hand, 26.3): the wood got and a pickaxe made as the start of the game is
      if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
        this.log('a pickaxe for the way into the base')
        await this.executor.obtain([{ item: ['stone_pickaxe', 'wooden_pickaxe'], count: 1 }], signal).catch(err => {
          if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
          this.log(`no pickaxe for the way in: ${(err as Error).message}`)
        })
      }
      // (a search that timed out 10 blocks from the dug-in base left the bot with no kit at all, its diamond tools in
      // the chest: the walk then, by hops and a stair down when the path doesn't come, 26.3)
      await this.executor.task('to the base', async (s) => await navigate(bot, { goal: new goals.GoalNear(e.x, e.y, e.z, 2) }, s).catch(async err => {
        if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
        await overland(bot, { target: new Vec3(e.x, e.y, e.z), range: 2, exactY: true }, s)
      }), signal).catch(err => {
        if (TaskError.is(err, 'DIED')) throw err
      })
    }
    for (const chest of base.chests) {
      const known = this.memory.chestAt(chest, dimension)
      const wanted = Object.keys(known?.items ?? {}).filter(name => (this.executor.options.keep(name, bot.registry) ?? 0) > 0)
      if (wanted.length === 0) continue
      try {
        const at = new Vec3(chest.x, chest.y, chest.z)
        if (bot.entity.position.distanceTo(at) > 4) {
          await this.executor.task('to the kit', async (s) => await overland(bot, { target: at, range: 2, exactY: true }, s), signal).catch(err => { if (TaskError.is(err, 'DIED')) throw err })
        }
        // (the chest's contents remembered as the window shows them: chest.ts rememberContents)
        const res = await this.executor.task('kit', async (s) => await retrieveItems(bot, { chest: at, filter: wanted, memory: this.memory }, s), signal)
        for (const [name, n] of Object.entries(res.moved)) took[name] = (took[name] ?? 0) + n
      } catch (err) {
        if (TaskError.is(err, 'DIED')) throw err
        this.log(`kit from ${chest.x} ${chest.y} ${chest.z} failed: ${(err as Error).message}`)
      }
    }
    return took
  }
}

/** plays the game from where the bot is; see PlayOptions */
export async function play (bot: Bot, options: PlayOptions = {}): Promise<PlayResult> {
  ;(bot as any).survival.playOptions = options
  return await new Runner(bot, options).play()
}
