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
import { FOOD_GOAL, FOOD_POINTS, HUNGRY_FIND_FACTOR, HUNGRY_FOOD, MEAL_POINTS, MILESTONES, STARVING_FOOD, foodGoals, mealGoals, milestonesAhead, type Milestone, type MilestoneId, type ProgressState } from './planner/progression'
import { heldFor, unitValue, type ObtainRequest } from './planner/obtain'
import { carriesWeapon, comeUp, dayPhase, nightAction, nightGeared, nightGoals, topUpPlaces } from './planner/schedule'
import { describeLevel, markAt, STOCK_RESERVE_SLOTS, StockPolicy, stockedItem, storedAtBase, type StockLevel, type StockOptions, type StockPlace, type TopUp } from './planner/stock'
import { eat } from './skills/eat'
import { ensureSurface, exploreForBlocks, inWater, onSurface, SURFACE_MIN_Y, toShore } from './executor/explore'
import { itemTags } from './core/tags'
import type { Station } from './planner/steps'
import { bedIfNear, buildBase, keepBaseUnbroken, HOUSE_BLUEPRINT, HOUSE_DEPTHS, type BuildBaseOptions } from './base/build'
import { baseBuilt, baseRecord } from './base/pois'
import { DEPOT_POI, Executor, describeRequest, ownedInventory, type ExecutorOptions, type PlanOptions } from './executor/executor'
import { SPARE_FOOD_POINTS, gearScore, milestoneNeeds, spareKitGoals, stockKeepRule, tripSpareGoals } from './executor/keep'
import { isAbort } from './skills/errors'
import { navigate, navigateNear, pickaxeForTheWay } from './skills/navigate'
import { pickupDrops } from './skills/pickupDrops'
import { caveReady, caveRuleOn, sealPocket } from './skills/caves'
import { SPAWNER_POI } from './skills/spawnerFarm'
import { keepWaterBucket, waterBucketEmpty } from './skills/bucket'
import { retrieveItems } from './skills/chest'
import { canSleepNow, sleep } from './skills/sleep'
import { FARM_RANGE, HERD_TRIP, MEAL_FARM_PLOTS, MILESTONE_HANDLERS, harvestGrownFarms, keepCaneFarm, keepFarm, tendHerd } from './milestones'
import { farmCells, grownPlots, knownFarms } from './skills/farm'
import { herdFromMemory, herdSupply } from './skills/herd'
import { knownCaneFarm } from './skills/caneFarm'
import { EPOCHS, EPOCH_HANDLERS, isEpoch, nextEpoch } from './epochs'
import { TRIP_KIT, keepUnbroken, takeTripKit } from './skills/tripKit'
import { armorPoints, shelter, sleepThroughNight, undergroundAtWork } from './skills/shelter'
import { REFUGE_TRIES, chooseRefuge, describeSituation, findBaseDoor, inBounds, refugeSituation, shutInBase, takeRefuge, waitInBase, type Refuge } from './skills/refuge'
import { bestMeleeWeapon } from './skills/weapons'
import { followWay, wayLength } from './skills/wayDown'
import { overland } from './end/strongholdSkills'
import { returnOverworld } from './nether/portalTravel'
import { unstick } from './executor/explore'
import { slimeBallsShort, toSlimeChunk } from './skills/slimeChunk'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import type { Diagnostics, ReportSummary, WatchdogOptions } from './diagnostics'
import { isDeathMessage } from './diagnostics/death'
import { RANGED_HOSTILES } from './reflexes/rules'
import { blockIdsNamed, findBlock } from './core/findBlocks'
import type { Seed } from './worldgen'
import { foodLandOf, seekFoodLand } from './executor/foodLand'

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
/** a not-ready back sooner than this got nothing: NOT_READY_WAIT_TICKS waited before the next try */
export const NOT_READY_MIN_TICKS = 200
export const NOT_READY_WAIT_TICKS = 1200
/** a milestone that failed sooner than this after its start waits a while before its next try (failureBackoff) */
export const FAST_FAILURE_TICKS = 600
/** the wait after a milestone's first fast failure in a row, doubled for each one after */
export const FAILURE_BACKOFF_TICKS = 300

/**
 * The ticks to wait before a milestone's next try, after its `fastInARow`th failure in a row that came `worked` ticks
 * after its start: none for one that worked FAST_FAILURE_TICKS or more, else `base` doubled for each fast one before,
 * so the tries' failures are spread over a while (4500 ticks for maxFailures' 5), the world given its time to change,
 * the steps' notes of what they couldn't get to theirs to take effect. A 1.21.11 bot shut in its house failed the iron
 * milestone 5 times in 180 ticks, 'no path' to the same log each time, and the game stopped (ls-1.21.11 t103081 to
 * t103261)
 */
export function failureBackoff (fastInARow: number, worked: number, base = FAILURE_BACKOFF_TICKS): number {
  if (worked >= FAST_FAILURE_TICKS || base <= 0 || fastInARow <= 0) return 0
  return base * 2 ** (fastInARow - 1)
}

/** the tries of a milestone short of only its food that bank more of it before they're counted as not ready */
export const FOOD_BANK_TRIES = 12
/** the wait by home between such tries (the farm's crops grow, the herd's cooldown runs) */
export const FOOD_BANK_WAIT_TICKS = 2400
/**
 * the waits by home a milestone waiting for a farm to grow (its error's `growing`) has before its tries count again,
 * each its error's waitTicks (else GROW_WAIT_TICKS): the cane farm's first canes for the enchanting table's book come
 * some CANE_GROW_TICKS (21845) after its planting, and 8 waits of 6000 cover two of them
 */
export const GROW_WAIT_TRIES = 8
export const GROW_WAIT_TICKS = 6000

/** the wait after a starving bot's food work that got none, before the next (feedFirst) */
export const FOOD_FIRST_WAIT_TICKS = 200

/** the ticks a spare kit for the base may take to get (stashSpareKit), its food and tools; none stored after */
export const SPARE_KIT_TICKS = 12000

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

/** each refuge after a respawn in the log's words */
const REFUGE_WORDS: Record<Refuge, string> = { base: "in behind the base's door", sleep: 'the bed', pillar: 'up a pillar', hole: 'a hole dug', flee: 'a run from them' }

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
  /** the food points the nether gate asks for (default: milestones' netherGate, 80 with a farm or herd, else 120) */
  netherFood?: number
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
  /**
   * the first wait after a milestone's fast failure (failureBackoff; 0 for none): play's default FAILURE_BACKOFF_TICKS,
   * a Runner made alone none (its tests' handlers fail with no ticks going)
   */
  failureBackoffTicks?: number
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

/**
 * Whether the bot is bare for the milestones' work: the wood's milestone done (it had a pickaxe once) and no pickaxe
 * carried now (a re-equip after a death that failed). The work's mines and caves with the fists are none to go on with.
 */
export function bareForWork (bot: Bot, reached: readonly string[]): boolean {
  if (!reached.includes('wood')) return false
  return !bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
}

/** ticks the spare kit put back after a recovery may take (its tools: the base's iron and wood) */
export const SPARE_KIT_RECOVERY_TICKS = 6000

/** how far the first wood survey goes from home, doubled each survey to WOOD_SURVEY_MAX (woodSurvey) */
export const WOOD_SURVEY_RADIUS = 96
export const WOOD_SURVEY_MAX = 384

/** how far wood survey `n` + 1 goes */
export function woodSurveyRadius (n: number): number {
  return Math.min(WOOD_SURVEY_MAX, WOOD_SURVEY_RADIUS * 2 ** Math.max(0, n))
}

/** the bare gate's first wait between its re-equips, doubled each try to BARE_BACKOFF_MAX */
export const BARE_BACKOFF_TICKS = 1200
export const BARE_BACKOFF_MAX = 9600
/** the most a bare bot waits in one go (the loop's night, food and herd looked at between) */
export const BARE_WAIT_TICKS = 600

/** the wait before the bare gate's re-equip try `tries` + 1 */
export function bareBackoffTicks (tries: number): number {
  return Math.min(BARE_BACKOFF_MAX, BARE_BACKOFF_TICKS * 2 ** Math.max(0, tries))
}

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
      // (the monsters by the bed fought only with a weapon: a bare bot loses to a zombie, the hostiles reflex's
      // unarmedOutmatched; the bed refused, a hole)
      return await sleepThroughNight(bot, { signal, bedDistance: 16, fight: bestMeleeWeapon(bot) != null })
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'DIED')) throw err
      // the night over as it went for the bed (the server's 'not night' at dawn): nothing more to wait out; else a hole
      if (!canSleepNow(bot.time?.timeOfDay ?? 0, false)) return
    }
  }
  return await shelter(bot, { signal })
}

interface DeathSpot {
  x: number
  y: number
  z: number
  dimension: string
  seen: number
  underground?: boolean
  worth?: boolean
  killer?: string
  dear?: boolean
  way?: Array<{ x: number, y: number, z: number }>
  killers?: number
  gear?: number
  inWater?: boolean
  cave?: boolean
  drowned?: boolean
  /** the deaths before this one at the spot (WorldMemory.deathsNear, DEATH_SPOT_SAME) */
  before?: number
}
interface DeathSpotNow {
  tick: number
  dimension: string
  position: Vec3
  minY: number
  blockAt: (pos: Vec3) => { name: string } | null
  bare?: boolean
  /** the bot's gear now (gearScore) */
  gear?: number
  /** fit for the caves now (skills/caves caveReady) */
  caveReady?: boolean
}

/** how near another death a death spot is the same spot (deathSpotSkip: twice there, given up): the two of ls4-26.3's zombie cave were 9 apart */
export const DEATH_SPOT_SAME = 12

/** ticks a block of the way to a death spot takes at a walk (some 4.3 blocks a second, the bends and the climbs between) */
export const DEATH_TRIP_TICKS_PER_BLOCK = 5
/** a trip down to a death spot under the ground is taken when it's this share of the items' time left at most */
export const DEATH_TRIP_UNDERGROUND_SHARE = 0.5
/** the base this near the respawn: its kit is taken before a trip down to a death spot under the ground */
export const DEATH_TRIP_KIT_RANGE = 32

/**
 * whether a death spot's drops lie under the water (the cell over the spot water: the head goes under to reach them),
 * with no dry cell to reach them from (a floor, its feet's and head's cells open and dry, within 4 across and 2 up or down)
 */
export function dropsUnderWater (blockAt: (pos: Vec3) => { name: string } | null, at: { x: number, y: number, z: number }): boolean {
  const spot = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  const wet = (p: Vec3): boolean => /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(blockAt(p)?.name ?? '')
  if (!wet(spot.offset(0, 1, 0))) return false
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const c = spot.offset(dx, dy, dz)
        const open = (p: Vec3): boolean => { const n = blockAt(p)?.name ?? 'stone'; return /^(air|cave_air|void_air|short_grass|tall_grass|fern)$/.test(n) }
        if (open(c) && open(c.offset(0, 1, 0)) && !open(c.offset(0, -1, 0)) && !wet(c.offset(0, -1, 0))) return false
      }
    }
  }
  return true
}

/** whether a death spot is worth going back to (deathSpotSkip: no reason not to) */
export function deathSpotWorthIt (death: DeathSpot | null, now: DeathSpotNow, maxTicks: number): boolean {
  return deathSpotSkip(death, now, maxTicks) == null
}

/**
 * Why a death spot isn't gone back to, null when it is: another dimension; shot dead and back bare; nothing worth the
 * trip; under the ground, but for dear drops (dropsDear) with the way down walked known (skills/wayDown) and the trip
 * along it DEATH_TRIP_UNDERGROUND_SHARE of the items' time left or less; the void; the items gone (an ItemEntity's
 * lifespan, 6000 ticks) before the walk there; lava or fire by it
 */
export function deathSpotSkip (death: DeathSpot | null, now: DeathSpotNow, maxTicks: number): string | null {
  if (death == null) return 'no death spot'
  if (death.dimension !== now.dimension) return `in another dimension (${death.dimension})`
  // shot dead, and back bare (no armor, no shield): the archer is likely where it was (a skeleton in a tree's shade by
  // day), and shoots again; a 26.3 bot went back so to its spot by a skeleton and was shot dead again (full-26.3-fresh-d)
  if (death.killer != null && RANGED_HOSTILES.has(death.killer) && now.bare === true) return `shot dead by a ${death.killer}, back bare`
  // died there before: the spot is given up (a third trip ends as the two did). A 26.3 bot slain by zombies in a cave at
  // y -58 went back for its dear drops along its way down with less on, and was slain there again (ls4-26.3, t386611)
  if ((death.before ?? 0) > 0) return `died there ${(death.before ?? 0) + 1} times`
  // drowned guard it: a drowned stays in the water by day (no sun under it), and the drops in the water are a swim
  // in its tridents' reach; a 1.21.11 bot went back bare to its spot in the sea and was impaled there again
  // (ls3b-1.21.11, t401692 and t404182)
  if (death.killer === 'drowned' && death.inWater === true) return 'killed by a drowned in the water'
  // drowned there, the drops under the water: gone back for, the head goes under again (a 1.21.11 Grim game's bot went
  // back to its death spot in the sea and drowned there again, f1-grim t108711 to t120443)
  if (death.drowned === true && dropsUnderWater(now.blockAt, death)) return 'drowned there, the drops under the water'
  // in a cave, the cave rule: not gone into by a bot not fit for the caves (the way down through one too)
  if (death.cave === true && now.caveReady === false) return 'in a cave, not cave-ready'
  // killed by more than one, and no better armed now than then: they're still about it, and win again
  if ((death.killers ?? 0) > 1 && death.gear != null && now.gear != null && now.gear <= death.gear) return `killed by ${death.killers ?? 0} mobs (${death.killer ?? 'mob'}), no better armed now (${now.gear} to ${death.gear})`
  // nothing dropped worth the trip (dropsWorthATrip): the mobs that killed the bot are likely still there
  if (death.worth === false) return 'nothing worth the trip'
  // a death in a cave or down a mine is left: the mobs that killed the bot in the dark are still there (and a trip
  // down after the items on seed 4 ended in a fall and another death); but for dear drops, by the way the bot went
  // down: a 26.3 bot slain at y 20 with a diamond sword and pickaxe and iron armor left them, and its game stalled at
  // the enchanting with iron tools (ls-26.3, t100061)
  const way = death.underground === true && death.dear === true && death.way != null && death.way.length > 0 ? death.way : null
  if (death.underground === true && death.dear !== true) return 'underground, nothing dear'
  if (death.underground === true && way == null) return 'underground, no way down known'
  if (death.y < now.minY + 1) return 'in the void'
  const age = now.tick - death.seen
  if (age < 0 || age > maxTicks) return 'the items gone'
  // the way there, at walking speed, before the items despawn (down the way walked: to its start and along it)
  const blocks = way != null ? wayLength(way, now.position) : now.position.distanceTo(new Vec3(death.x, death.y, death.z))
  const travel = blocks * DEATH_TRIP_TICKS_PER_BLOCK
  if (age + travel > maxTicks) return `the items gone before the walk there (${Math.round(travel)} ticks)`
  if (way != null && travel > (maxTicks - age) * DEATH_TRIP_UNDERGROUND_SHARE) return `underground, the way down too long for the items' time (${Math.round(travel)} ticks of ${maxTicks - age})`
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const name = now.blockAt(new Vec3(death.x + dx, death.y + dy, death.z + dz))?.name
      if (name === 'lava' || name === 'fire') return `${name} by it`
    }
  }
  return null
}

/**
 * Whether the trip back to a death spot waits for the day first, or is given up: a death to a mob at night in the
 * overworld, the night not over, is gone back to by day (the mobs that killed the bot are about it all night; they burn
 * or go off by day) if the items would still be there by then and the way there (`travel` ticks), else not at all.
 * 'go' otherwise.
 */
export function deathSpotTiming (death: { seen: number, killer?: string, underground?: boolean } | null, now: { tick: number, timeOfDay: number, dimension: string }, travel: number, maxTicks: number): 'go' | 'wait' | 'skip' {
  // (under the ground the dark is the same by day: a wait only loses the items)
  if (death == null || death.killer == null || death.underground === true || now.dimension !== 'overworld' || !canSleepNow(now.timeOfDay, false)) return 'go'
  // (the night's end: the undead burn from about 23460, VanillaTime's sunrise)
  const toDay = (24000 + 23460 - now.timeOfDay) % 24000
  return now.tick - death.seen + toDay + travel <= maxTicks ? 'wait' : 'skip'
}

/** a system message about the player that isn't an advancement or a join: a death message (DeathMessageType's) */
export { isDeathMessage }

/** logs cut at dusk for a night down the mine with no wood carried, if they cost DUSK_WOOD_TICKS or less */
export const DUSK_LOGS = 4
/**
 * how near a spawner known (a dungeon's, a mineshaft's) the night's wait below the surface is logged as behind the rock
 * (BaseSpawner's requiredPlayerRange 16: it spawns while a player is within)
 */
export const SPAWNER_KEEP_OFF = 16
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

/** ticks after an empty bucket found no pool to fill at before it is looked at again */
export const WATER_RETRY_TICKS = 1200

/** ticks a meal (mealGoals) may take before the work goes on without it */
export const MEAL_TICKS = 6000
/** ticks a trip to food land (seekFoodLand: the scouting, the walk there) may take before the food work goes on where the bot is */
export const FOOD_TRIP_TICKS = 12000

/** ticks a try of the food work takes for one that got no food to count as dry (foodWorking) */
export const FOOD_DRY_TICKS = 3000

/** ticks a meal that came to nothing waits before it is tried again */
export const MEAL_RETRY_TICKS = 6000

/** ticks between the herd's upkeeps between trips: the breeding's cooldown (Animal.setAge(6000)) */
export const HERD_TEND_TICKS = 6000

/** ticks between the tries for the base's bed, when the base was built without it (bedLater) */
export const BED_LATER_TICKS = 6000
/** ticks an upkeep of the herd between trips may take */
export const HERD_UPKEEP_TICKS = 6000

/**
 * ticks a restock's plans (restockGoals) may take, the reflexes' not counted, before the work goes on without the rest
 * (tried again after RESTOCK_RETRY_TICKS): a 1.21.11 bot with a full bar and 14 points carried explored for kelp for
 * its restock from t157268 to t186669 (some 18000 ticks of its own, the night's 11000 besides), the enchanting
 * stalled (rt-1)
 */
export const RESTOCK_TICKS = 12000

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

/**
 * Where a restock (restockGoals) goes from a dimension: 'here' in the overworld, its animals and farms; from the nether
 * 'overworld', back through the portal first (none of them there: a 1.21.11 bot low on food after its blaze fight by
 * a fortress went exploring the nether for a pig or a cow among the blazes and was fireballed, f6-1.21.11, t564149 at
 * (80, 62, 192)); none from the End
 */
export function restockFrom (dimension: string | undefined): 'here' | 'overworld' | 'none' {
  const d = normalizeDimension(dimension)
  return d === 'overworld' ? 'here' : d === 'the_nether' ? 'overworld' : 'none'
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

/**
 * The base's house built (or built on, where the memory has it): the first base is the minimal house of day 1, dug in
 * a few blocks under the ground (HOUSE_BLUEPRINT); the full creeper-proof base is play's base options' (BASE_BLUEPRINT)
 * for later. `gather` false: what's held put in, nothing got first (the bed got later, bedLater)
 */
async function buildHouse (bot: Bot, executor: Executor, signal: AbortSignal | undefined, log: (line: string) => void, gather = true): Promise<void> {
  const opts = (bot as any).survival?.playOptions?.base ?? {}
  // (by the food land when the bot went to one: the spawn's land has no food, foodLand.ts)
  const land = foodLandOf(executor.memory)
  // a base left with most of its blocks missing is built on where it is, not sited again (baseBuilt)
  const base = executor.memory.base
  const at = base != null && base.dimension === normalizeDimension(bot.game?.dimension) ? { origin: new Vec3(base.x, base.y, base.z) } : {}
  await buildBase(bot, { blueprint: HOUSE_BLUEPRINT, depths: HOUSE_DEPTHS, chests: 2, ...(land != null ? { around: land } : {}), ...at, ...opts, ...(gather ? {} : { gather: false }), executor, signal, log })
}

const defaultHandlers: Partial<Record<MilestoneId, MilestoneHandler>> = {
  base: async ({ bot, executor, signal, log }) => await buildHouse(bot, executor, signal, log),
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
  /** the round of work under way (loop), cut by the starving watch */
  private roundCtrl: AbortController | null = null
  /** whether the round was cut for food */
  private cutForFood = false
  /** food comes first (foodFirstNow's latch) */
  private foodFirst = false
  /** feedFirst under way */
  private feeding = false
  /** the day (bot.time.day) whose night's mining is over: the rest of that night is the milestones' and the reflexes' */
  private nightMinedDay = -1
  private inNightWork = false
  private restockRetryAt = 0
  private mealRetryAt = 0
  /** the food work under way (a meal, a restock, the food milestone): home is the food land meanwhile (foodLand.ts) */
  private foodWork = 0
  /** the food work's tries in a row that got no food (foodWorking's): the food land's left after FOOD_LAND_DRY_TRIES */
  private foodDry = 0
  private waterRetryAt = 0
  /** the tick the herd was last tended at between trips (keepHerd) */
  private herdTendedAt = -Infinity
  /** the tick the base's bed was last tried for (bedLater) */
  private bedTriedAt = -Infinity
  private readonly store: SaveStore | null
  /** what play keeps on hand beyond the milestones' needs (planner/stock.ts), null for nothing */
  readonly stock: StockPolicy | null
  /** a stock mark's next top-up, by id: STOCK_RETRY_TICKS after one ended short */
  private readonly stockRetryAt = new Map<string, number>()

  constructor (readonly bot: Bot, readonly options: PlayOptions = {}) {
    this.log = options.log ?? (line => console.log(tickLine(this.tick, line)))
    this.store = options.saveStore ?? (options.saveFile != null ? fileSaveStore(options.saveFile) : null)
    // (the night reflex's: below the surface without the gear its progress had, no night's work there)
    if ((bot as any).survival != null) (bot as any).survival.nightGeared = (): boolean => this.nightGeared()
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
      // (the seed's biomes, for the shores the cane is explored for along)
      seed: options.seed,
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
    // the food land the food work is done from (and the bot's home while it has no base: its farm, herd and base go
    // up there)
    const land = foodLandOf(this.memory)
    if (land != null && (base == null || this.foodWork > 0)) return land
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
    // and the base's bed, table, furnaces and chests (a resume sets no build's protection)
    keepBaseUnbroken(this.bot, this.memory)
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
    const offStarving = this.watchStarving()
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
      offStarving()
      this.bot.off('reflex' as any, onReflex)
      this.bot.off('death', onDeath)
      this.bot.off('messagestr' as any, onMessage)
      offChests()
      outer?.removeEventListener('abort', onOuter)
      disarm?.()
      if (diag != null && diag.clock === clock) diag.clock = null
    }
  }

  private async loop (playSignal: AbortSignal): Promise<PlayResult> {
    this.playSignal = playSignal
    const skip = new Set(this.options.skip ?? [])
    const failures = new Map<MilestoneId, number>()
    // the fast failures in a row (failureBackoff)
    const fastFailures = new Map<MilestoneId, number>()
    const notReady = new Map<MilestoneId, number>()
    // the food points a milestone short of only its food had at its last try, and its tries so (FOOD_BANK_TRIES)
    const foodBank = new Map<MilestoneId, { points: number, tries: number }>()
    // the waits by home for what a farm grows (a milestone not ready with `growing`: GROW_WAIT_TRIES)
    const growWaits = new Map<MilestoneId, number>()
    const spent = new Map<MilestoneId, number>()
    const maxFailures = this.options.maxFailures ?? 5
    const stopped = (): boolean => playSignal.aborted
    this.load()
    this.loaded = true
    let detach = (): void => {}
    for (;;) {
      // each round of the work under its own signal, cut when the bot is starving (the starving watch: watchStarving)
      detach()
      const round = new AbortController()
      const onPlay = (): void => round.abort(playSignal.reason)
      if (playSignal.aborted) onPlay()
      playSignal.addEventListener('abort', onPlay, { once: true })
      detach = () => playSignal.removeEventListener('abort', onPlay)
      this.roundCtrl = round
      this.cutForFood = false
      const signal = round.signal
      try {
        if (stopped()) return this.stop(null, 'aborted')
        if (this.bot.health <= 0 || (this.bot as any).isAlive === false) await this.recover(signal)
        // starving: food is the only work till the bar is over HUNGRY_FOOD (foodFirstNow), no milestone, stock, kit
        // or tool's replacement started meanwhile
        if (this.foodFirstNow()) {
          try {
            await this.feedFirst(signal)
          } catch (err) {
            if (stopped()) return this.stop(null, 'aborted', err)
            if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
              this.log(`died getting food: ${(err as Error).message}`)
              await this.recover(signal)
            }
          }
          continue
        }
        const state = progressState(this.bot, this.memory)
        this.noteReached(state)
        if (this.options.until != null && this.reached.some(r => r.id === this.options.until)) return this.stop(null, 'until')
        const reachedIds = this.reached.map(r => r.id)
        try {
          await this.nightSchedule(signal)
        } catch (err) {
          if (stopped()) return this.stop(null, 'aborted', err)
          // (cut for the bot's food: starving, the work given up for it, no failure counted)
          if (this.cutForFood) continue
          if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
            this.log(`died in the night's mine: ${(err as Error).message}`)
            await this.recover(signal)
            continue
          }
          throw err
        }
        // the water bucket kept filled for the fall reflex (keepWaterBucket), at a pool near, in the overworld
        if (this.bot.survival.tasks.tick >= this.waterRetryAt && normalizeDimension(this.bot.game?.dimension) === 'overworld' && waterBucketEmpty(this.bot)) {
          let filled = false
          try {
            filled = await this.executor.task('fill the water bucket', async (s) => await keepWaterBucket(this.bot, s), signal)
          } catch (err) {
            if (stopped()) return this.stop(null, 'aborted', err)
            // (cut for the bot's food: starving, the work given up for it, no failure counted)
            if (this.cutForFood) continue
            if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
              await this.recover(signal)
              continue
            }
          }
          if (filled) this.log('the water bucket filled again')
          else this.waterRetryAt = this.bot.survival.tasks.tick + WATER_RETRY_TICKS
        }
        // a meal first when hungry and short of food (mealGoals): what's in sight before a cow somewhere, its own ticks
        // at most; the work it left (untilDusk's hunger watch) after
        const meal = this.mealDue()
        if (meal != null) {
          this.log(`hungry (food ${this.bot.food ?? 0}, ${ownedInventory(this.bot).foodPoints()} points carried): a meal first`)
          try {
            await this.foodWorking(async () => await this.untilDusk(signal, async (s) => await this.getMeal(meal, s)))
          } catch (err) {
            if (stopped()) return this.stop(null, 'aborted', err)
            // (cut for the bot's food: starving, the work given up for it, no failure counted)
            if (this.cutForFood) continue
            if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
              this.log(`died getting a meal: ${(err as Error).message}`)
              await this.recover(signal)
              continue
            }
            this.log(`no meal for now: ${(err as Error).message}`)
          }
          if (this.mealDue() != null) this.mealRetryAt = this.bot.survival.tasks.tick + MEAL_RETRY_TICKS
          continue
        }
        const restockAt = restockFrom(this.bot.game?.dimension)
        const restock = this.bot.survival.tasks.tick >= this.restockRetryAt && restockAt !== 'none' ? restockGoals(state, reachedIds) : null
        if (restock != null && restockAt === 'overworld') {
          this.log(`food low (${state.inventory.foodPoints()} points) in the nether: back to the overworld for it`)
          try {
            await returnOverworld(this.bot, {}, signal)
          } catch (err) {
            if (stopped()) return this.stop('food', 'aborted', err)
            if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
              this.log(`died going back for food: ${(err as Error).message}`)
              await this.recover(signal)
              continue
            }
            this.restockRetryAt = this.bot.survival.tasks.tick + RESTOCK_RETRY_TICKS
            this.log(`not back to the overworld for food: ${(err as Error).message}`)
          }
          continue
        }
        if (restock != null) {
          try {
            this.log(`food low (${state.inventory.foodPoints()} points): getting more before going on`)
            await this.foodWorking(async () => await this.untilDusk(signal, { hunger: true }, async (s) => {
              // the renewable food first: the farm's harvest, and the herd's surplus slaughtered and cooked
              await harvestGrownFarms(this.bot, this.executor, s, this.log)
              await this.tendHerdFor(FOOD_POINTS - ownedInventory(this.bot).foodPoints(), s)
              // then the rest from food land when home's has none
              if (restockGoals(progressState(this.bot, this.memory), reachedIds) != null) await this.toFoodLand(s)
              // (RESTOCK_TICKS of its own at most, the reflexes' not counted: the milestone goes on after, the meals
              // keep the bar up meanwhile)
              await this.withinTicks(RESTOCK_TICKS, s, () => (this.executor.tasks.current?.priority ?? 0) <= 0, async (t) => {
                await this.executor.obtain(restockGoals(progressState(this.bot, this.memory), reachedIds) ?? [], t)
              })
            }))
          } catch (err) {
            if (stopped()) return this.stop('food', 'aborted', err)
            // (cut for the bot's food: starving, the work given up for it, no failure counted)
            if (this.cutForFood) continue
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
        // bare (the wood's milestone done and no pickaxe left: a re-equip after a death that failed): no milestone's work
        // in that state, its mines and its caves with the fists; the kit taken and the basics made again first, tried
        // again after a backoff (bareBackoffTicks) while they don't come. A 26.3 bot back from its second death with
        // nothing, its re-equip failing 'no oak_log found exploring', went on with the enchanting's work 165000 ticks
        // with dirt and gravel, down to y -53 (f4-26.3, seed -6080033689226204554, t107263 on)
        if (bareForWork(this.bot, reachedIds)) {
          const now = this.bot.survival.tasks.tick
          if (now >= this.bareRetryAt) {
            this.log(`bare (no pickaxe): re-equipping before the work${this.bareTries > 0 ? ` (try ${this.bareTries + 1})` : ''}`)
            try {
              if (baseRecord(this.memory) != null) await this.rekit(signal)
              await this.reequip(signal)
            } catch (err) {
              if (stopped()) return this.stop(null, 'aborted', err)
              // (cut for the bot's food: starving, the work given up for it, no failure counted)
              if (this.cutForFood) continue
              if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
                this.log(`died re-equipping: ${(err as Error).message}`)
                await this.recover(signal)
                continue
              }
              this.log(`re-equipping: ${(err as Error).message}`)
            }
            if (bareForWork(this.bot, reachedIds)) {
              const wait = bareBackoffTicks(this.bareTries++)
              this.bareRetryAt = this.bot.survival.tasks.tick + wait
              this.log(`still bare: the work waits, re-equipping again in ${wait} ticks`)
            }
          }
          if (bareForWork(this.bot, reachedIds)) {
            await this.waitTicksOrAbort(Math.max(1, Math.min(BARE_WAIT_TICKS, this.bareRetryAt - this.bot.survival.tasks.tick)), signal)
            continue
          }
        }
        this.bareTries = 0
        this.bareRetryAt = 0
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
          const how = await this.foodWorking(async () => await this.untilDusk(signal, { hunger: true }, async (s) => {
            if (m.id === 'food') await this.toFoodLand(s)
            await handler({ bot: this.bot, milestone: m, state, executor: this.executor, signal: s, log: this.log, seed: this.options.seed })
            // the milestone ends with the stock topped up for the ones after it, what can be got where the bot is
            // (topUpPlaces: the surface's by day, the mine's down there); the milestone's own marks apply once it's done
            const done = m.done(progressState(this.bot, this.memory))
            await this.topUp(this.topUpPlacesNow(), s, done ? [...reachedIds, m.id] : reachedIds)
          }), m.id === 'food')
          account()
          if (stopped()) return this.stop(m.id, 'aborted')
          if (how === 'dusk') {
            this.log(`dusk: ${m.id} left for the night's mine`)
            continue
          }
          if (how === 'hungry') {
            this.log(`hungry: ${m.id} left for a meal`)
            continue
          }
          failures.delete(m.id)
          fastFailures.delete(m.id)
          growWaits.delete(m.id)
        } catch (err) {
          account()
          if (stopped()) return this.stop(m.id, 'aborted', err)
          // (cut for the bot's food: starving, the work given up for it, no failure counted)
          if (this.cutForFood) continue
          if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
            this.log(`died working on ${m.id}: ${(err as Error).message}`)
            await this.recover(signal)
            continue
          }
          // a milestone not ready to go on (the nether's gear still being got: netherKit's notReady) is tried again
          // without counting it a failure, NOT_READY_TRIES times (a 26.3 bot back from its deaths failed the nether
          // twice on 'not going into the nether without' its armor, the game's stop three more away)
          if ((err as any)?.notReady === true) {
            // its way being searched for (the portal frame's lava, down a staircase at the next spot: lavaSearch): tried
            // again from there, never counted, a while waited when it came back at once; a 1.21.11 bot with no lava nor
            // obsidian known failed the nether five times in 4500 ticks and play stopped (f4-1.21.11, t191592)
            if ((err as any).searching === true) {
              this.log(`milestone ${m.id}: ${(err as Error).message}`)
              if (this.bot.survival.tasks.tick - begun < NOT_READY_MIN_TICKS) {
                const from = this.bot.survival.tasks.tick
                try {
                  await this.topUp(this.topUpPlacesNow(), signal, reachedIds)
                  const left = NOT_READY_WAIT_TICKS - (this.bot.survival.tasks.tick - from)
                  if (left > 0) await this.waitTicksOrAbort(left, signal)
                } catch (e) {
                  if (stopped()) return this.stop(m.id, 'aborted', e)
                  // (cut for the bot's food: starving, the work given up for it, no failure counted)
                  if (this.cutForFood) continue
                  if (TaskError.is(e, 'DIED') || this.bot.health <= 0) {
                    this.log(`died waiting to search for ${m.id} again: ${(e as Error).message}`)
                    await this.recover(signal)
                  }
                }
              }
              continue
            }
            // waiting for a farm to grow (the enchanting table's book's canes, the cane farm by home): a wait by home
            // with the herd tended and the stock topped up, not a try counted, GROW_WAIT_TRIES times
            if ((err as any).growing === true) {
              const k = (growWaits.get(m.id) ?? 0) + 1
              growWaits.set(m.id, k)
              if (k <= GROW_WAIT_TRIES) {
                const wait = Number((err as any).waitTicks ?? GROW_WAIT_TICKS)
                this.log(`milestone ${m.id}: ${(err as Error).message}: waiting by home (${k} of ${GROW_WAIT_TRIES})`)
                const from = this.bot.survival.tasks.tick
                try {
                  await this.keepHerd(signal)
                  await this.topUp(this.topUpPlacesNow(), signal, reachedIds)
                  const left = wait - (this.bot.survival.tasks.tick - from)
                  if (left > 0) await this.waitTicksOrAbort(left, signal)
                } catch (e) {
                  if (stopped()) return this.stop(m.id, 'aborted', e)
                  // (cut for the bot's food: starving, the work given up for it, no failure counted)
                  if (this.cutForFood) continue
                  if (TaskError.is(e, 'DIED') || this.bot.health <= 0) {
                    this.log(`died waiting for ${m.id}'s farm: ${(e as Error).message}`)
                    await this.recover(signal)
                  }
                }
                continue
              }
            }
            // short of the food only, and more of it than at the last try: banked, not a try counted (its own cap
            // FOOD_BANK_TRIES); the farm and the herd tended, and the crops waited for by home in between
            const points = Number((err as any).foodPoints)
            if ((err as any).foodShort === true && Number.isFinite(points)) {
              const last = foodBank.get(m.id)
              const tries = (last?.tries ?? 0) + 1
              foodBank.set(m.id, { points, tries })
              if ((last == null || points > last.points) && tries <= FOOD_BANK_TRIES) {
                this.log(`milestone ${m.id}: ${points} food points banked (${tries}): the farm and the herd till the next try`)
                const from = this.bot.survival.tasks.tick
                try {
                  await this.keepHerd(signal)
                  // the stock's top-ups meanwhile (the work by home), else a wait
                  await this.topUp(this.topUpPlacesNow(), signal, reachedIds)
                  const left = FOOD_BANK_WAIT_TICKS - (this.bot.survival.tasks.tick - from)
                  if (left > 0) await this.waitTicksOrAbort(left, signal)
                } catch (e) {
                  if (stopped()) return this.stop(m.id, 'aborted', e)
                  // (cut for the bot's food: starving, the work given up for it, no failure counted)
                  if (this.cutForFood) continue
                  if (TaskError.is(e, 'DIED') || this.bot.health <= 0) {
                    this.log(`died banking food for ${m.id}: ${(e as Error).message}`)
                    await this.recover(signal)
                  }
                }
                continue
              }
            }
            const k = (notReady.get(m.id) ?? 0) + 1
            notReady.set(m.id, k)
            if (k < NOT_READY_TRIES) {
              this.log(`milestone ${m.id} not ready (${k}): ${(err as Error).message}`)
              // back at once (nothing could be got: a bag full of junk that wouldn't go, 26.3, the ten tries and five
              // failures all in one tick, the game stopped): a while waited first
              if (this.bot.survival.tasks.tick - begun < NOT_READY_MIN_TICKS) {
                // the stock's top-ups meanwhile (the string, feathers and slime the gate may be short of come in so
                // over the tries), the wait for what's left of NOT_READY_WAIT_TICKS: a 1.21.11 bot with no bow waited
                // out ten tries a failure for a slime ball, then its water bottles, and the game stopped at the nether
                // (full-1.21.11-fresh-g)
                const from = this.bot.survival.tasks.tick
                try {
                  // the bag's room made at the base first, the top-ups' room after (a bag short of it got none of
                  // the string the gate was short of, 'no room this trip for arrow, string, feather, flint (4 slots
                  // free)' at each of its tries: f3k-run5, f4-run2)
                  await this.roomForTopUps(signal)
                  await this.topUp(this.topUpPlacesNow(), signal, reachedIds)
                } catch (e) {
                  if (stopped()) return this.stop(m.id, 'aborted', e)
                  // (cut for the bot's food: starving, the work given up for it, no failure counted)
                  if (this.cutForFood) continue
                  if (TaskError.is(e, 'DIED') || this.bot.health <= 0) {
                    this.log(`died topping up for ${m.id}: ${(e as Error).message}`)
                    await this.recover(signal)
                    continue
                  }
                }
                const left = NOT_READY_WAIT_TICKS - (this.bot.survival.tasks.tick - from)
                this.log(`milestone ${m.id}: nothing came of it, the stock topped up${left > 0 ? `, waiting ${left} ticks` : ''}`)
                if (left > 0) await this.waitTicksOrAbort(left, signal)
              }
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
          // a milestone not ready (its kit still short) never ends play: its tries go on with its back-off, the kit's
          // top-ups and its own gets between (two 1.21.11 games stopped at the nether's gate for its water bottles, five
          // failures of ten tries each: f3k-run5, f4-run2)
          if (n >= maxFailures && (err as any)?.notReady === true && (err as any).growing !== true) {
            this.log(`milestone ${m.id} still not ready after ${n} failures: backing off, its kit's still to get`)
            failures.set(m.id, maxFailures - 1)
          } else if (n >= maxFailures) return this.stop(m.id, 'failed', err)
          // back at once: a while before the next try (the stock's top-ups meanwhile, then the wait for what's left)
          const worked = this.bot.survival.tasks.tick - begun
          const fast = worked < FAST_FAILURE_TICKS ? (fastFailures.get(m.id) ?? 0) + 1 : 0
          fastFailures.set(m.id, fast)
          const backoff = failureBackoff(fast, worked, this.options.failureBackoffTicks ?? 0)
          if (backoff > 0) {
            this.log(`milestone ${m.id} failed ${worked} ticks in: ${backoff} ticks before its next try`)
            const from = this.bot.survival.tasks.tick
            try {
              await this.topUp(this.topUpPlacesNow(), signal, reachedIds)
              const left = backoff - (this.bot.survival.tasks.tick - from)
              if (left > 0) await this.waitTicksOrAbort(left, signal)
            } catch (e) {
              if (stopped()) return this.stop(m.id, 'aborted', e)
              // (cut for the bot's food: starving, the work given up for it, no failure counted)
              if (this.cutForFood) continue
              if (TaskError.is(e, 'DIED') || this.bot.health <= 0) {
                this.log(`died waiting to try ${m.id} again: ${(e as Error).message}`)
                await this.recover(signal)
              }
            }
          }
        }
        try {
          await this.afterTrip(signal)
        } catch (err) {
          if (stopped()) return this.stop(m.id, 'aborted', err)
          // (cut for the bot's food: starving, the work given up for it, no failure counted)
          if (this.cutForFood) continue
          // a death in the herd's upkeep or the store at the base after a milestone (keepHerd's tendHerd: its hunt, its
          // kelp) goes to the recovery as every other: thrown on, it ended play and the whole game. A 1.21.11 bot
          // drowned getting the herd's kelp, and the e2e stopped 'play threw: the bot died' (ls3c-1.21.11, t390765;
          // full-1.21.11-fresh-j, t210976, blown up by a creeper while exploring for kelp)
          if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
            this.log(`died after ${m.id}: ${(err as Error).message}`)
            await this.recover(signal)
            continue
          }
          throw err
        }
        this.save()
      } catch (err) {
        // a cut for the food that got past the round's own catches: the food first, next round
        if (!stopped() && this.cutForFood) continue
        throw err
      }
    }
  }

  private stop (at: MilestoneId | null, reason: PlayResult['reason'], error?: unknown): PlayResult {
    this.save()
    const result: PlayResult = { reached: [...this.reached], stoppedAt: at, reason }
    if (error !== undefined) result.error = error
    this.bot.emit('survivalStopped' as any, result)
    return result
  }

  /**
   * Room in the bag for the stock's top-ups (STOCK_RESERVE_SLOTS free): what isn't kept stored at the base's chests
   * (storeAtBase) when there's a base and the bag has less; nothing else done. Throws only for a death or the signal.
   */
  async roomForTopUps (signal?: AbortSignal): Promise<void> {
    const free = this.bot.inventory.emptySlotCount?.() ?? 36
    const stock = this.options.stock
    if (stock === false || free >= (stock?.reserveSlots ?? STOCK_RESERVE_SLOTS)) return
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    try {
      const moved = await this.executor.storeAtBase({}, signal)
      this.log(`room for the stock: ${Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing'} stored at the base (${free} slots free before)`)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`room for the stock: ${(err as Error).message}`)
    }
  }

  /** the valuables into the base's chests when the bot is back near it, the herd tended first (keepHerd) */
  private async afterTrip (signal?: AbortSignal): Promise<void> {
    await this.keepHerd(signal)
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    // (the base's dimension: a bot in the nether by the base's coordinates went for its chests there, 'no chest at
    // (-56, 72, 9) (netherrack)' 30 plans, full-1.21.11-fresh-i)
    if (normalizeDimension(this.bot.game?.dimension) !== (this.memory.base?.dimension ?? 'overworld')) return
    const p = this.bot.entity.position
    if (Math.hypot(p.x - base.origin.x, p.y - base.origin.y, p.z - base.origin.z) > 96) return
    try {
      await this.executor.storeAtBase({}, signal)
      await this.bedLater(signal)
      await this.stashSpareKit(signal)
      await this.carrySpare(signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`storing failed: ${(err as Error).message}`)
    }
  }

  /**
   * The base's bed put in when the base was built without it (buildBase's bedIfNear: no wool near then), once its wool
   * is near: a bed held, or one planned within BED_NOW_TICKS (a sheep in sight). Every BED_LATER_TICKS at most.
   */
  async bedLater (signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    const base = baseRecord(this.memory)
    if (base == null || base.bed != null || !baseBuilt(this.memory)) return
    if (normalizeDimension(bot.game?.dimension) !== (this.memory.base?.dimension ?? 'overworld')) return
    const now = bot.survival.tasks.tick
    if (now - this.bedTriedAt < BED_LATER_TICKS) return
    this.bedTriedAt = now
    if (!await bedIfNear(bot, this.executor, signal, line => this.log(`base bed: ${line}`))) return
    this.log('base bed: put in')
    await buildHouse(bot, this.executor, signal, this.log, false)
  }

  /**
   * The farm's and the herd's upkeep between trips (keepFarm: the farm started when there's none, harvested, baked and
   * grown; tendHerd: started when there's none, bred, the surplus slaughtered for the food the stock is short of and
   * cooked, the gate shut), from the food milestone on, by day, every HERD_TEND_TICKS at
   * most, within HERD_UPKEEP_TICKS; what fails is logged and the game goes on
   */
  async keepHerd (signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    if (!this.reached.some(r => r.id === 'food') || bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return
    if (dayPhase(bot.time?.timeOfDay ?? 0) !== 'day') return
    const now = this.bot.survival.tasks.tick
    if (now - this.herdTendedAt < HERD_TEND_TICKS) return
    this.herdTendedAt = now
    // the food short of the stock's high mark (carried and stored), the herd's to give first
    const food = this.stockLevels()?.find(l => l.mark.id === 'food')
    const want = food != null ? food.mark.high - food.have : 2 * FOOD_POINTS - ownedInventory(bot).foodPoints()
    const ctrl = new AbortController()
    const outer = signal ?? ctrl.signal
    await this.withBudget(HERD_UPKEEP_TICKS, outer, async (s) => {
      // the farm first (started when there's none, its grown wheat harvested, baked and sown further): the herd's
      // wheat comes from it
      await keepFarm(bot, this.executor, s, this.log).catch(err => {
        if (TaskError.is(err, 'DIED') || s.aborted) throw err
        this.log(`farm: upkeep: ${(err as Error).message}`)
      })
      await this.tendHerdFor(want, s)
      // and the cane farm by home: its grown canes cut (the books' paper comes in so between the trips)
      if (knownCaneFarm(this.memory) != null) await keepCaneFarm(bot, this.executor, s, this.log)
    }).catch(err => {
      if (TaskError.is(err, 'DIED') || signal?.aborted === true) throw err
      this.log(`herd: upkeep: ${(err as Error).message}`)
    })
  }

  /** the herd tended for `want` food points (tendHerd), a failure logged */
  private async tendHerdFor (want: number, signal: AbortSignal): Promise<void> {
    await tendHerd(this.bot, this.executor, signal, this.log, { want: Math.max(0, want) }).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      this.log(`herd: ${(err as Error).message}`)
    })
  }

  /**
   * A spare kit in the base's chests before the next trip out (spareKitGoals: a second pickaxe, sword and axe of the
   * tier carried, and food), made when they lack one and stored, for rekit to take after a death
   */
  async stashSpareKit (signal?: AbortSignal, opts: { food?: boolean } = {}): Promise<void> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    const dimension = this.memory.base?.dimension ?? 'overworld'
    const stored: Record<string, number> = {}
    for (const c of base.chests) {
      for (const [name, n] of Object.entries(this.memory.chestAt(c, dimension)?.items ?? {})) stored[name] = (stored[name] ?? 0) + n
    }
    const carried = ownedInventory(this.bot)
    // (the spare food only from a bag with its own food in it, FOOD_RESTOCK points at least, nor at all with `food`
    // false: the bot's own meals first, play's restock)
    const goals = spareKitGoals(carried, stored).filter(g => g.unit !== 'nutrition' || (opts.food !== false && carried.foodPoints() >= FOOD_RESTOCK))
    if (goals.length === 0) return
    this.log('a spare kit for the base')
    // within SPARE_KIT_TICKS, given up for a meal when hungry (the hunger watch) or for the night's mine: a 1.21.11
    // bot's spare kit after a death went on for its food 76000 ticks, cows then cod not found, and the bot starved to
    // 0.08 health with no meal, a fall from a ledge killed it (f5-1.21.11, t1232449 to t1308224)
    let timedOut = false
    const how = await this.untilDusk(signal ?? new AbortController().signal, { hunger: true }, async (s) => {
      await this.withinTicks(SPARE_KIT_TICKS, s, async (t) => { await this.executor.obtain(goals, t) }).catch(err => {
        if (TaskError.is(err, 'TIMEOUT') && signal?.aborted !== true) { timedOut = true; return }
        throw err
      })
    })
    if (timedOut || how !== 'done') {
      this.log(`a spare kit for the base: ${timedOut ? `out of its ${SPARE_KIT_TICKS} ticks` : how === 'hungry' ? 'hungry, a meal first' : 'the night is for the mine'}: none stored this time`)
      return
    }
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
        const waiting = tried.size === 0 ? (this.stock?.marks ?? []).filter(m => this.stock?.active.has(m.id) === true && markAt(m, places) && (this.stockRetryAt.get(m.id) ?? 0) <= this.bot.survival.tasks.tick) : []
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
      goals: goals.length > 0 || this.dueTopUps(['underground'], reached).length > 0,
      // (a bot back bare from a death: the surface and the shelter by night till it's re-kitted)
      geared: this.nightGeared()
    })
    return action === 'mine' ? { day, goals } : null
  }

  /** the weapon and armor the progress has had are on hand, worn or carried (nightGeared) */
  nightGeared (): boolean {
    return nightGeared(this.reached.map(r => r.id), { weapon: carriesWeapon(this.bot.inventory.items().map(i => i.name)), armor: armorPoints(this.bot) })
  }

  /** at night in the overworld without the gear (nightGeared): the night waited out where the bot is before `what` */
  async nightOutFirst (what: string, signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    if (bot.time == null || dayPhase(bot.time.timeOfDay) !== 'night' || normalizeDimension(bot.game?.dimension) !== 'overworld' || this.nightGeared()) return
    this.log(`night (time ${bot.time.timeOfDay}) with no weapon or armor: the night waited out before ${what}`)
    await this.waitOutNight(signal)
  }

  /**
   * The night waited out where the bot is (waitOutTheNight: a bed by, else a hole dug), or in the base's box behind
   * its shut door when it's in there (waitInBase): not out by the bed or down a hole dug in the base's floor
   */
  async waitOutNight (signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    const base = this.baseHere()
    const inBase = shutInBase(bot, base, findBaseDoor(bot, base))
    await this.executor.task('wait out the night', async (s) => inBase ? await waitInBase(bot, base, { signal: s }) : await waitOutTheNight(bot, s), signal).catch(err => {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`the night: ${(err as Error).message}`)
    })
  }

  /** the base as the memory has it when it's in this dimension, else null */
  baseHere (): ReturnType<typeof baseRecord> {
    const base = baseRecord(this.memory)
    return base != null && (this.memory.base?.dimension ?? 'overworld') === normalizeDimension(this.bot.game?.dimension) ? base : null
  }

  /**
   * After a respawn: safe first, at night or with hostiles within REFUGE_THREAT_RANGE and no weapon and armor at
   * hand (skills/refuge chooseRefuge: in behind the base's door, the bed, a pillar, a hole, a run), each refuge that
   * fails not chosen again, up to REFUGE_TRIES; the kit after. The last refuge taken, or null when none was wanted.
   * A 1.21.11 bot killed at night respawned bare by its base, a zombie there already, went for its base's chest,
   * fought the zombie with its fists and died 750 ticks after (full-1.21.11-fresh-m, t133707 to t134432).
   */
  async refugeFirst (signal?: AbortSignal): Promise<Refuge | null> {
    const bot = this.bot
    const base = this.baseHere()
    const failed = new Set<Refuge>()
    let taken: Refuge | null = null
    for (let i = 0; i < REFUGE_TRIES; i++) {
      const situation = refugeSituation(bot, { base, failed })
      const refuge = chooseRefuge(situation)
      if (refuge == null) break
      this.log(`after the respawn (${describeSituation(situation)}): ${REFUGE_WORDS[refuge]}`)
      try {
        await this.executor.task(`refuge: ${refuge}`, async (s) => await takeRefuge(bot, refuge, { signal: s, base }), signal)
        taken = refuge
      } catch (err) {
        if (TaskError.is(err, 'DIED') || isAbort(err) || bot.health <= 0) throw err
        this.log(`refuge ${refuge}: ${(err as Error).message}`)
        failed.add(refuge)
      }
    }
    return taken
  }

  /**
   * Runs the day's work under a signal that also fires at dusk when the night is to be mined (nightDue, looked at
   * every 20 ticks): a hunt or a walk that runs on into the night is cut off for the mine instead of the night reflex
   * digging in on the surface (seed 7: the hunt ran into the night and the shelter waited 11000 ticks). Resolves
   * 'dusk' when cut off so.
   */
  async untilDusk (signal: AbortSignal, optsOrFn: { hunger?: boolean } | ((s: AbortSignal) => Promise<void>), maybeFn?: (s: AbortSignal) => Promise<void>): Promise<'done' | 'dusk' | 'hungry'> {
    const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn as (s: AbortSignal) => Promise<void>
    const hunger = typeof optsOrFn === 'function' ? false : optsOrFn.hunger === true
    const bot = this.bot
    const ctrl = new AbortController()
    const onOuter = (): void => ctrl.abort(signal.reason)
    if (signal.aborted) onOuter()
    signal.addEventListener('abort', onOuter, { once: true })
    let n = 0
    let why: 'dusk' | 'hungry' = 'dusk'
    const watch = (): void => {
      if (++n % 20 !== 0 || ctrl.signal.aborted) return
      if (this.nightDue() != null) {
        ctrl.abort(new TaskError('ABORTED', 'dusk: the night is for the mine'))
      } else if (hunger && this.mealDue() != null) {
        // (the work stopped for a meal: a 26.3 bot's hunt for cows went on from food 9 to 0, full-26.3-s31337-g)
        why = 'hungry'
        ctrl.abort(new TaskError('ABORTED', 'hungry: a meal first'))
      }
    }
    bot.on('physicsTick', watch)
    try {
      await fn(ctrl.signal)
      return 'done'
    } catch (err) {
      if (!signal.aborted && ctrl.signal.aborted) return why
      throw err
    } finally {
      bot.off('physicsTick', watch)
      signal.removeEventListener('abort', onOuter)
    }
  }

  /**
   * Whether food comes first: starving (the bar at STARVING_FOOD or under with none to eat carried: mealGoals), from
   * then till the bar is over HUNGRY_FOOD, in the overworld. A 1.21.11 bot starved twice under work nothing stopped
   * for a meal (a worn pickaxe's replacement exploring the deepslate 155000 ticks; a spare kit's 76000 ticks for its
   * food) and a hit of 1 killed it each time (f5-1.21.11, t1124683 and t1308224)
   */
  foodFirstNow (): boolean {
    const bot = this.bot
    if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return false
    const food = bot.food ?? 20
    if (this.foodFirst && food > HUNGRY_FOOD) this.foodFirst = false
    if (!this.foodFirst && food <= STARVING_FOOD && mealGoals(food, ownedInventory(bot)) != null) this.foodFirst = true
    return this.foodFirst
  }

  /**
   * The starving watch: every 20 ticks, food first (foodFirstNow) and no food work under way, the round of work cut
   * (whatever it is: a milestone, the stock, a kit, a tool's replacement, a recovery's), the reflexes left to run
   */
  watchStarving (): () => void {
    let n = 0
    const tick = (): void => {
      if (++n % 20 !== 0 || this.feeding || !this.foodFirstNow()) return
      const round = this.roundCtrl
      if (round == null || round.signal.aborted) return
      this.cutForFood = true
      this.log(`starving (food ${this.bot.food ?? 0}, nothing to eat carried): the work stopped for food`)
      round.abort(new TaskError('ABORTED', 'starving: food first'))
    }
    this.bot.on('physicsTick', tick)
    return () => { this.bot.off('physicsTick', tick) }
  }

  /**
   * Food, the only work while it comes first: what's carried eaten, else the meal (up to the surface first, the food
   * land, the meal's goals within MEAL_TICKS), a wait of FOOD_FIRST_WAIT_TICKS after one that came to nothing
   */
  async feedFirst (signal: AbortSignal): Promise<void> {
    this.feeding = true
    try {
      const food = this.bot.food ?? 20
      const meal = mealGoals(food, ownedInventory(this.bot))
      if (meal == null) {
        await eat(this.bot, { signal }).catch(err => { if (signal.aborted) throw err })
        if ((this.bot.food ?? 20) <= food) await this.waitTicksOrAbort(FOOD_FIRST_WAIT_TICKS, signal)
        return
      }
      this.log(`starving (food ${food}): food is the only work till the bar is over ${HUNGRY_FOOD}`)
      try {
        await this.foodWorking(async () => await this.getMeal(meal, signal))
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED') || this.bot.health <= 0) throw err
        this.log(`no food yet: ${(err as Error).message}`)
        await this.waitTicksOrAbort(FOOD_FIRST_WAIT_TICKS, signal)
      }
    } finally {
      this.feeding = false
    }
  }

  /**
   * A meal (mealGoals' `meal`): up to the surface first (upForFood), then the home's food when it has some to give
   * (homeFoodFirst: a grown farm harvested and baked, the herd's surplus slaughtered and cooked), then, still hungry,
   * the food land and the meal's own plans within MEAL_TICKS. The meal went to the food land and its hunts first: a
   * 1.21.11 bot's meals explored 170 blocks off for cows and chickens and died there, or starved on the way (f5-1.21.11,
   * seed 671229120248951486, t120754, t144131 to t193129)
   */
  async getMeal (meal: ObtainRequest[], signal: AbortSignal): Promise<void> {
    await this.upForFood(signal)
    if (await this.homeFoodFirst(MEAL_POINTS, signal)) {
      meal = mealGoals(this.bot.food ?? 20, ownedInventory(this.bot)) ?? []
      if (meal.length === 0) {
        this.log('a meal from the home food')
        return
      }
    }
    await this.toFoodLand(signal)
    await this.withinTicks(MEAL_TICKS, signal, async (t) => {
      await this.executor.obtain(meal, t, { unseenFactor: HUNGRY_FIND_FACTOR })
    })
  }

  /**
   * The home's food now: a farm the bot sowed grown within FARM_RANGE (the walk to it short of its growing left, or
   * MEAL_FARM_PLOTS of its plots seen grown), or
   * the herd's surplus (herdSupply: adults beyond its BREEDERS_KEPT, as seen or remembered) within HERD_TRIP
   */
  homeFoodNow (): { farm: boolean, herd: boolean } {
    const bot = this.bot
    if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return { farm: false, herd: false }
    // (or a bread's worth of its plots grown, MEAL_FARM_PLOTS, as seen: its rows ripen a plot at a time)
    const farm = knownFarms(this.memory, 'overworld').some(f => {
      const walk = bot.entity.position.distanceTo(f.water)
      const cost = this.executor.farmCost(f.crop)
      if (walk > FARM_RANGE || cost == null) return false
      return cost <= walk * 5 + 1 || (typeof bot.blockAt === 'function' && grownPlots(p => bot.blockAt(p) as any, farmCells(f), f.crop).length >= MEAL_FARM_PLOTS)
    })
    const herd = herdFromMemory(this.memory, bot.entity.position)
    const supply = herd != null ? herdSupply(bot, this.memory, herd.mob, Number((bot.time as any)?.age ?? 0)) : undefined
    return { farm, herd: supply != null && supply.surplus > 0 && supply.distance <= HERD_TRIP }
  }

  /**
   * The home's food first, when it has some (homeFoodNow): the grown farm harvested and its wheat baked
   * (harvestGrownFarms), the herd's surplus slaughtered and cooked for `want` points (tendHerd). Resolves whether there
   * was any to go for.
   */
  async homeFoodFirst (want: number, signal: AbortSignal): Promise<boolean> {
    const home = this.homeFoodNow()
    if (!home.farm && !home.herd) return false
    this.log(`the home's food first:${home.farm ? ' the farm grown' : ''}${home.herd ? ' the herd surplus' : ''}`)
    if (home.farm) {
      await harvestGrownFarms(this.bot, this.executor, signal, this.log, true, MEAL_FARM_PLOTS).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        this.log(`farm: ${(err as Error).message}`)
      })
    }
    if (home.herd && mealGoals(this.bot.food ?? 20, ownedInventory(this.bot)) != null) await this.tendHerdFor(want, signal)
    return true
  }

  /** the meal due now (mealGoals), in the overworld, once the last one that came to nothing has waited its retry */
  mealDue (): ObtainRequest[] | null {
    const bot = this.bot
    if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld' || bot.survival.tasks.tick < this.mealRetryAt) return null
    return mealGoals(bot.food ?? 20, ownedInventory(bot))
  }

  /** runs `fn` stopped (TIMEOUT) after `ticks` ticks */
  /** runs `fn` as food work (`on`): home is the food land meanwhile */
  private async foodWorking<T> (fn: () => Promise<T>, on = true): Promise<T> {
    if (!on) return await fn()
    this.foodWork++
    // (the food got: the bar and the points carried; a try of FOOD_DRY_TICKS or more that got none is a dry one)
    const food = (): number => (this.bot.food ?? 0) + (this.bot.inventory != null ? ownedInventory(this.bot).foodPoints() : 0)
    const before = food()
    const from = this.bot.survival.tasks.tick
    try {
      return await fn()
    } finally {
      this.foodWork--
      if (food() > before) this.foodDry = 0
      else if (this.bot.survival.tasks.tick - from >= FOOD_DRY_TICKS && this.bot.health > 0) this.foodDry++
    }
  }

  /**
   * To food land when home's land has none (seekFoodLand: no food biome about it, or its animals hunted for and none
   * found), within FOOD_TRIP_TICKS; the food work goes on from wherever the bot got to
   */
  /**
   * Up to the open sky before a meal's hunt (the food's land, its animals, its bushes) for a bot under the cave rule
   * underground: by the rock (its own tunnel back, or a staircase dug: ensureSurface, the caves shut), never through a
   * cave; with no way up but through one, no meal from down there (FAILED). A 26.3 bot's meal began at y 33 by a cave,
   * its hunt went down the cave to y 27 and cave spiders killed it (f5-26.3, t58998 to t59474).
   */
  private async upForFood (signal: AbortSignal): Promise<void> {
    if (!caveRuleOn(this.bot)) return
    const p = this.bot.entity.position
    if (onSurface(p2 => this.bot.blockAt(p2) as any, new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z)), true)) return
    const up = await this.executor.task('up for food', async (s) => await ensureSurface(this.bot, s), signal)
    if (!up && caveRuleOn(this.bot)) throw new TaskError('FAILED', 'underground with no way up but through a cave: no meal from down here')
  }

  private async toFoodLand (signal: AbortSignal): Promise<void> {
    const name = 'to food land'
    try {
      // (its own ticks: not a night's shelter that preempted it, 9000 ticks of the trip's on seed 31337)
      await this.withinTicks(FOOD_TRIP_TICKS, signal, () => this.executor.tasks.current?.name === name, async (t) => {
        await this.executor.task(name, async (s) => {
          await seekFoodLand(this.bot, {
            survey: this.executor.biomes,
            memory: this.memory,
            home: this.home(),
            misses: name => this.executor.sightings.misses(name),
            forgetLand: () => { this.executor.forgetLand(); this.foodDry = 0 },
            dryTries: this.foodDry,
            seed: this.options.seed,
            log: this.log
          }, s)
        }, t)
      })
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED') || this.bot.health <= 0) throw err
      this.log(`no food land: ${(err as Error).message}`)
    }
  }

  async withinTicks (ticks: number, signal: AbortSignal, countsOrFn: (() => boolean) | ((s: AbortSignal) => Promise<void>), maybeFn?: (s: AbortSignal) => Promise<void>): Promise<void> {
    // (`counts`: whether a tick counts against the budget)
    const fn = maybeFn ?? countsOrFn as (s: AbortSignal) => Promise<void>
    const counts = maybeFn != null ? countsOrFn as () => boolean : () => true
    const ctrl = new AbortController()
    const onOuter = (): void => ctrl.abort(signal.reason)
    if (signal.aborted) onOuter()
    signal.addEventListener('abort', onOuter, { once: true })
    let n = 0
    const count = (): void => { if (counts() && ++n >= ticks && !ctrl.signal.aborted) ctrl.abort(new TaskError('TIMEOUT', `out of its ${ticks} ticks`)) }
    this.bot.on('physicsTick', count)
    try {
      await fn(ctrl.signal)
    } catch (err) {
      if (!signal.aborted && ctrl.signal.aborted) throw new TaskError('TIMEOUT', `out of its ${ticks} ticks`)
      throw err
    } finally {
      this.bot.off('physicsTick', count)
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
      // the slime balls of the nether's fire resistance short (its magma cream) and the seed known: the mine started in
      // the nearest slime chunk, where slimes spawn under y 40 (worldgen/slime), their balls left for the drops reflex
      const seed = this.options.seed
      if (seed != null && !ctrl.signal.aborted && this.reached.some(r => r.id === 'iron') && slimeBallsShort(bot) &&
        normalizeDimension(bot.game?.dimension) === 'overworld' && typeof bot.blockAt === 'function' && onSurface(p => bot.blockAt(p) as any, bot.entity.position.floored())) {
        const at = await this.executor.task('to a slime chunk', async (s) => await toSlimeChunk(bot, seed, s), ctrl.signal).catch(err => {
          if (signal?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
          return null
        })
        this.log(at != null ? `night: the mine in the slime chunk at ${at.x} ${at.z}, for slime balls` : 'night: no slime chunk to mine in')
      }
      // the mine starts on dry ground: in the water (a lake over the spot, a pond) the bot goes to the shore first
      if (!ctrl.signal.aborted && typeof bot.blockAt === 'function' && inWater(bot)) {
        const dry = await this.executor.task('out of the water', async (s) => await toShore(bot, s), ctrl.signal).catch(err => {
          if (signal?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
          return false
        })
        this.log(`night: in the water at the mine's start: ${dry ? 'out on the shore' : 'no shore found'}`)
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
        // in a sealed pocket, for a bot not fit for the caves: its tunnel's ends and any way in from a cave blocked, a
        // spawner near behind the rock (sealPocket; the caves reflex and the wall-in keep it so)
        if (caveRuleOn(bot) && !ctrl.signal.aborted) await this.sealForTheNight(ctrl.signal, signal)
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

  /**
   * The bot shut in where it waits out the night below the surface (sealPocket), logged with the nearest spawner known
   * within SPAWNER_KEEP_OFF; a pocket that can't be had is logged and the wait goes on (the reflexes' wall-in then)
   */
  private async sealForTheNight (signal: AbortSignal, outer?: AbortSignal): Promise<void> {
    const bot = this.bot
    const at = bot.entity.position
    const spawner = this.memory.getPois(SPAWNER_POI, { dimension: 'overworld', near: at })[0]
    const near = spawner != null && Math.hypot(spawner.x - at.x, spawner.y - at.y, spawner.z - at.z) < SPAWNER_KEEP_OFF ? `, a ${spawner.note ?? ''} spawner ${Math.round(Math.hypot(spawner.x - at.x, spawner.y - at.y, spawner.z - at.z))} off behind the rock` : ''
    try {
      const placed = await this.executor.task('seal in for the night', async (s) => await sealPocket(bot, s), signal)
      this.log(`night: sealed in for the rest of it (${placed} blocks put${near})`)
    } catch (err) {
      if (outer?.aborted === true || TaskError.is(err, 'DIED') || bot.health <= 0) throw err
      if (!signal.aborted) this.log(`night: no sealed pocket here: ${(err as Error).message}`)
    }
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
  /** the wood surveys so far (woodSurveyRadius) and their spiral's legs */
  private woodSurveys = 0
  private readonly woodSurveyProgress = { leg: 0 }
  /** the bare gate's next re-equip (bareForWork), and its tries so far (bareBackoffTicks) */
  private bareRetryAt = 0
  private bareTries = 0

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
    // safe first (refugeFirst); shut in the base, its chests are by: the kit taken there and then, the death spot after
    await this.refugeFirst(signal)
    let kitted = false
    const base = this.baseHere()
    if (shutInBase(bot, base, findBaseDoor(bot, base))) {
      const kit = await this.rekit(signal)
      diag?.recovery({ kit: kit ?? 'no base' })
      kitted = true
    }
    const death = this.memory.death
    // a spot the bot died at again on the way back for its items (mobs in a cave, a fall) is left: a third trip
    // there ends the same way
    const deadly = death != null && this.deadlySpots.some(p => p.distanceTo(new Vec3(death.x, death.y, death.z)) < DEADLY_SPOT_RADIUS)
    if (deadly) this.log(`not back to the death spot at ${death.x} ${death.y} ${death.z}: died there going back before`)
    if (deadly) diag?.recovery({ deathSpot: 'skipped: died there going back before' })
    const skip = deadly ? null : deathSpotSkip(death == null ? null : { ...death, before: this.memory.deathsNear(death, death.dimension, DEATH_SPOT_SAME) }, {
      // (the memory's clock, the death's stamp's)
      tick: this.memory.now,
      dimension: normalizeDimension(bot.game?.dimension),
      position: bot.entity.position,
      minY: (bot.game as any)?.minY ?? -64,
      blockAt: pos => bot.blockAt(pos),
      bare: armorPoints(bot) === 0 && bot.inventory.items().every(i => i.name !== 'shield') && bot.inventory.slots[45]?.name !== 'shield',
      gear: gearScore([...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(i => bot.inventory.slots[i])].filter(i => i != null).map(i => i.name)),
      caveReady: caveReady(bot)
    }, this.options.deathItemTicks ?? 6000)
    const worth = !deadly && skip == null
    if (death != null && !deadly && skip != null) this.log(`not back to the death spot at ${death.x} ${death.y} ${death.z}: ${skip}`)
    if (!deadly && skip != null) diag?.recovery({ deathSpot: death == null ? 'skipped: no death spot' : `skipped: not worth it (${skip})` })
    // down a cave or a mine (the drops dear, the way down known): the base's kit first when the base is by, the mobs
    // that killed the bot likely still about the spot
    if (death != null && worth && death.underground === true && !kitted && base != null && bot.entity.position.distanceTo(new Vec3(base.origin.x, base.origin.y, base.origin.z)) <= DEATH_TRIP_KIT_RANGE) {
      const kit = await this.rekit(signal)
      diag?.recovery({ kit: kit ?? 'no base' })
      kitted = true
    }
    // a death to a mob at night: back by day, the night waited out (indoors, in the base, a hole) where the bot is
    const timing = death == null || !worth ? 'go' : deathSpotTiming(death, { tick: this.memory.now, timeOfDay: bot.time?.timeOfDay ?? 0, dimension: normalizeDimension(bot.game?.dimension) }, bot.entity.position.distanceTo(new Vec3(death.x, death.y, death.z)) * 5, this.options.deathItemTicks ?? 6000)
    if (death != null && worth && timing === 'skip') {
      this.log(`not back to the death spot at ${death.x} ${death.y} ${death.z}: killed by a ${death.killer ?? 'mob'} at night, the items gone by the day`)
      diag?.recovery({ deathSpot: 'skipped: killed at night, the items gone by the day' })
    }
    if (death != null && worth && timing === 'wait') {
      this.log(`the death spot at ${death.x} ${death.y} ${death.z} by day: killed by a ${death.killer ?? 'mob'} at night, the night waited out first`)
      await this.waitOutNight(signal)
    }
    if (death != null && worth && timing !== 'skip') {
      this.log(`back to the death spot at ${death.x} ${death.y} ${death.z}`)
      try {
        const spot = new Vec3(death.x, death.y, death.z)
        const picked = await this.executor.task('to the death spot', async (s) => {
          // a long trip the pathfinder may plan short of: a few tries, getting moving by hand between them
          const near = async (at: Vec3, range: number): Promise<void> => {
            for (let i = 0; ; i++) {
              try {
                await navigateNear(bot, at, range, s)
                break
              } catch (err) {
                if (isAbort(err) || i >= 3) throw err
                await unstick(bot, s)
              }
            }
          }
          // down a cave or a mine: to where the way down left the open sky, then along it (followWay)
          if (death.underground === true && death.way != null && death.way.length > 0) {
            const [first, ...rest] = death.way
            await near(new Vec3(first.x, first.y, first.z), 2)
            await followWay(bot, rest, s)
          }
          await near(spot, 3)
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
    if (!kitted) {
      const kit = await this.rekit(signal)
      diag?.recovery({ kit: kit ?? 'no base' })
    }
    // what neither a trip kit nor the base gave back: made again from scratch (a 26.3 bot back from a death with dirt
    // and seeds went on to the nether's portal, every try failing for want of a bucket and a pickaxe)
    await this.reequip(signal)
    // and a spare kit in the base's chests again before the work goes on (the one taken was its only one: a 26.3 bot's
    // second death, 14000 ticks after its first, found the chests with none, f4-26.3, t106041)
    await this.spareKitAfterRecovery(signal)
  }

  /**
   * The trees surveyed for a re-equip with none found near (a mine step's exploring for logs, NOT_FOUND): out over the
   * surface from home to woodSurveyRadius (wider at each survey, WOOD_SURVEY_RADIUS doubled to WOOD_SURVEY_MAX, the
   * spiral's legs kept across them), the logs seen remembered for the plans; whether some were found. A 26.3 bot's
   * re-equips after its second death each explored a few legs for oak logs and failed, and it went on without a pickaxe
   * (f4-26.3, t106821 to t107263)
   */
  async woodSurvey (signal?: AbortSignal): Promise<boolean> {
    const logs = [...itemTags(this.bot.registry as any).resolve('#logs_that_burn')]
    const radius = woodSurveyRadius(this.woodSurveys++)
    this.log(`wood: surveying for trees out to ${radius} blocks`)
    const home = this.memory.base ?? null
    try {
      return await this.executor.task('survey for trees', async (s) => await exploreForBlocks(this.bot, {
        names: logs,
        memory: this.memory,
        center: home != null ? new Vec3(home.x, home.y, home.z) : undefined,
        maxRadius: radius,
        progress: this.woodSurveyProgress,
        remember: logs
      }, s), signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`wood: survey: ${(err as Error).message}`)
      return false
    }
  }

  /** stashSpareKit by the base after a recovery, a failure logged */
  private async spareKitAfterRecovery (signal?: AbortSignal): Promise<void> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    if (normalizeDimension(this.bot.game?.dimension) !== (this.memory.base?.dimension ?? 'overworld')) return
    const p = this.bot.entity.position
    if (Math.hypot(p.x - base.origin.x, p.y - base.origin.y, p.z - base.origin.z) > 96) return
    // (its tools only, within SPARE_KIT_RECOVERY_TICKS: the recovery's own spare kit's food goal sent a starving bot
    // back from a death out exploring for animals for 15000 to 40000 ticks, at 0.3 to 4 health, and it was shot by a
    // skeleton twice and poked to death by a berry bush, 'died again recovering', f5-1.21.11, t312126, t385877,
    // t1206281)
    const outer = signal ?? new AbortController().signal
    try {
      await this.withBudget(SPARE_KIT_RECOVERY_TICKS, outer, async (s) => await this.stashSpareKit(s, { food: false }))
    } catch (err) {
      if (TaskError.is(err, 'DIED') || signal?.aborted === true) throw err
      this.log(`no spare kit after the recovery: ${(err as Error).message}`)
    }
  }

  /**
   * After a death, the basics the bot lacks made again in order (reequipGoals: a pickaxe and a sword of stone at
   * least, then iron ones, a bucket, an iron chestplate), each as can be, within REEQUIP_TICKS in all
   */
  async reequip (signal?: AbortSignal): Promise<void> {
    // the iron's ore and the stone are down a mine: at night a bot short of the gear its progress had waits for the
    // day first (a bed by, else a hole dug), not down there in the dark with its fists (nightGeared)
    if (reequipGoals(ownedInventory(this.bot)).length > 0) await this.nightOutFirst('re-equipping', signal)
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
        // no wood found for it: a survey further out for trees (woodSurvey: wider each time, the logs seen remembered
        // for the plan), and the goal again once
        if (TaskError.is(err, 'NOT_FOUND') && /_log|_stem/.test((err as Error).message) && await this.woodSurvey(signal)) {
          try {
            await this.executor.obtain([goal], signal)
          } catch (again) {
            if (TaskError.is(again, 'DIED') || isAbort(again)) throw again
            this.log(`re-equipping: no ${goal.item} after the survey: ${(again as Error).message}`)
          }
        }
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
      await this.waitOutNight(signal)
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
  /** waits `ticks` game ticks, or until the signal aborts */
  private async waitTicksOrAbort (ticks: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      let n = 0
      const done = (): void => { this.bot.off('physicsTick', onTick); signal.removeEventListener('abort', done); resolve() }
      const onTick = (): void => { if (++n >= ticks) done() }
      this.bot.on('physicsTick', onTick)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  async rekit (signal?: AbortSignal): Promise<Record<string, number> | null> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return null
    const took: Record<string, number> = {}
    const bot = this.bot
    const dimension = this.memory.base?.dimension ?? 'overworld'
    this.log('to the base for a kit')
    // (in its box already, shut in after a respawn: the walk out to the entrance and back left out)
    if (base.entrance != null && (base.bounds == null || !inBounds(bot.entity.position, base.bounds))) {
      const e = base.entrance
      // (the base's door in sight, a way in by hand: no pickaxe wanted; a 26.3 bot respawned by its hut on a plain
      // with no trees spent its 12000 ticks exploring for logs to make one, the kit in the hut, tests/integration/respawn)
      const doorIn = findBaseDoor(bot, base) != null
      if (!doorIn) await pickaxeForTheWay(bot, signal)
      // nothing to make one from (back from a death with 2 dirt, the dug-in base 5 blocks down, the way in stone and
      // the searches timing out by hand, 26.3): the wood got and a pickaxe made as the start of the game is
      if (!doorIn && !bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
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
  return await new Runner(bot, { failureBackoffTicks: FAILURE_BACKOFF_TICKS, ...options }).play()
}
