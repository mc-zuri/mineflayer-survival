// The executor: runs the obtain resolver's step list through the skills, one foreground task a step (so a reflex
// preempts it and it resumes), and plans again whenever the game comes out other than the plan: a step failed, the
// rest of the plan no longer checks against the inventory (a reflex ate the food, a tool broke, the bot died), or a
// step brought another wood or meat than planned. Before each step it makes room in the inventory (the base's chests,
// or the junk thrown away) and makes a new tool when the one in use is about to break.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from '../core/errors'
import { Inventory, type ItemCount } from '../core/inventory'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import type { TaskRunner } from '../core/taskRunner'
import { itemTags } from '../core/tags'
import { heldFor, obtainAll, type ObtainOptions, type ObtainPlan, type ObtainRequest, type StrategyKind } from '../planner/obtain'
import { toolsAtLeast } from '../planner/progression'
import type { ToolMaterial } from '../core/items'
import { checkPlan, type PlanStep, type Station } from '../planner/steps'
import { baseRecord, type BaseRecord } from '../base/pois'
import { storeItems } from '../skills/chest'
import { craft } from '../skills/craft'
import { placeBlock } from '../skills/placeBlock'
import { findPlacement } from '../skills/placement'
import { isAbort } from '../skills/errors'
import { tossAway } from '../skills/pickupDrops'
import { holdBag, type BagKeeper } from '../skills/bag'
import { countItems, emptySlots, trace } from '../skills/util'
import { replacementTiers, usesLeft, watchToolWear, wornOutTools, type WornTool } from './durability'
import { defaultKeep, JUNK, junkToToss, ROUTE_STONE, splitInventory, THROW_LOOP_REPEATS, THROW_LOOP_TICKS, ThrowHistory, type KeepRule, type ProtectOptions, type ScaffoldKeep } from './keep'
import { DEFAULT_RUNNERS, MIN_TOOL_USES, mobSubstitutes, outOfTheWay, SCAFFOLD_ITEMS, type StepContext, type StepOutcome, type StepRunner } from './steps'
import { SIGHTED_BLOCKS, Sightings } from './sight'
import { noteVillage } from '../skills/village'
import { digDepotNook, dumpPit, lavaThrow, pitThrow, rememberAround } from './explore'
import { noteSpawners, SPAWNER_POI } from '../skills/spawnerFarm'
import { farmCells, grownPlots, knownFarms } from '../skills/farm'
import { GROW_TICKS } from '../core/crops'
import type { Diagnostics } from '../diagnostics'
import { WALK_TICKS_PER_BLOCK } from '../planner/sources'
import { withNetherSafety } from '../nether/safety'
import { travel } from '../skills/travel'

/** ticks between the looks for a village about the bot */
export const VILLAGE_CHECK_TICKS = 400

/** how far from the bot a failed mine step's remembered blocks are forgotten: all of them in the dimension */
export const FORGET_RADIUS = Infinity

export interface ExecutorHooks {
  /** before every step (the runner sleeps through the night here) */
  beforeStep?: (step: PlanStep) => Promise<void>
}

export interface ExecutorOptions {
  /** default: bot.survival.memory */
  memory?: WorldMemory
  /** the foreground queue the steps run on (default: bot.survival.tasks) */
  tasks?: TaskRunner
  /** what the bot carries when it stores at the base (default: defaultKeep) */
  keep?: KeepRule
  /** plans before giving up on the requests (default 30) */
  maxReplans?: number
  /** a step that failed this many times in a row fails the requests (default 3) */
  maxStepFailures?: number
  /** make a new tool when the one of the step's kind has this many uses left (default MIN_TOOL_USES, 24) */
  minToolUses?: number
  /** make room when fewer slots than this are free (default 2) */
  minFreeSlots?: number
  /**
   * What making room may throw away beyond the keep rule's count, after the junk (the runner's: the stock over its
   * working set while there's no base to store it in; default nothing)
   */
  surplus?: (name: string) => boolean
  /**
   * Whether the stock has its high mark of an item (the runner's stock policy, over what's carried and stored): the
   * route's stone (keep.ts ROUTE_STONE) beyond the keep count is thrown away then, not stored, and not picked up while
   * the bag carries what's kept of it (default: always, nothing wanting more of it than the working set)
   */
  stocked?: (name: string) => boolean
  /** the building blocks kept whatever is thrown away (default: SCAFFOLD_ITEMS, SCAFFOLD_KEEP of them) */
  scaffold?: ScaffoldKeep
  /** strategies the plans never use (default: barter, until the nether skills do it) */
  exclude?: StrategyKind[]
  runners?: Partial<Record<PlanStep['kind'], StepRunner<any>>>
  hooks?: ExecutorHooks
  /** a line per step and replan */
  log?: (line: string) => void
  /** the spawn or base, where exploring turns around */
  home?: () => Vec3 | null
}

/** times a task is stopped for a worn tool (TOOL_WORN) and run again before the stop is let through */
export const MAX_WEAR_STOPS = 3

/** ticks a worn tool whose replacement failed is let be (no task stopped for it) before another try */
export const WEAR_RETRY_TICKS = 12000

/** ticks a replacement may cost to be got at once (a tier lower, or a spare of it held, before a dearer one) */
export const WEAR_REPLACE_TICKS = 6000

/** how far from where a task stopped for a worn tool the bot goes back there before it runs the task again */
export const WEAR_RETURN_RANGE = 8

/** where and for what a task was stopped by the wear watch */
interface WearStop {
  tool: WornTool
  at: Vec3
  dimension: string
}

/** how far the base may be for makeRoom to walk there and store (some 500 ticks each way); farther, a depot */
export const BASE_STORE_RANGE = 96

/** how far a known chest may be for stashNearby to use it rather than put down a depot */
export const DEPOT_RANGE = 32

/** slots made beyond the usual when what's thrown away goes into lava (explore.ts lavaThrow) */
export const LAVA_ROOM = 6

/** the memory's point of interest for a chest the bot put down away from the base (a mine depot): its chests count as stock */
export const DEPOT_POI = 'mine_depot'

/** runs a part of making room: as a foreground task, or straight in the task it's made in (a step's) */
type RoomRunner = <T>(name: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>

/** the building blocks (SCAFFOLD_ITEMS) the bag keeps whatever is thrown away: a stack for the pathfinder's bridges and towers */
export const SCAFFOLD_KEEP = 64

/** what a caller adds to the executor's plans (the night's: undergroundOnly; a stock top-up's: no loot, exclude) */
export type PlanOptions = Pick<ObtainOptions, 'undergroundOnly' | 'exclude' | 'exactYields'>

export interface ObtainOutcome {
  /** plans made */
  plans: number
  /** steps run */
  steps: number
}

/** what a task is (for the reports) and how it runs */
export interface TaskInfo {
  step?: PlanStep
  desc?: string
  args?: unknown
  /** false: the task doesn't hold the bag (a store into the base's chests) */
  room?: boolean
  /** false: no wear watch (the task isn't stopped for a worn tool) */
  wear?: boolean
}

/** a step as a log line: "mine 3 cobblestone" */
export function describeStep (step: PlanStep): string {
  switch (step.kind) {
    case 'mine': return `mine ${step.count} ${step.item} (${step.blockCount} ${step.block})`
    case 'kill': return `kill ${step.kills} ${step.mob} for ${step.count} ${step.item}`
    case 'smelt': return `smelt ${step.count} ${step.item}`
    case 'farm': return `farm ${step.count} ${step.item} (${step.plots > 0 ? `${step.plots} plots sown, ` : ''}${step.cycles} harvests)`
    case 'loot': return `loot ${step.count} ${step.item} at ${step.from.x} ${step.from.y} ${step.from.z}`
    default: return `${step.kind} ${step.count} ${step.item}`
  }
}

/** a request as a log line: "3 cobblestone", "40 nutrition of cooked_beef,bread" */
export function describeRequest (r: ObtainRequest): string {
  return `${r.count}${r.unit === 'nutrition' ? ' nutrition of' : ''} ${String(r.item)}${r.optional === true ? ' (optional)' : ''}`
}

/** the inventory the plans start from: the main slots and the off hand, and the worn armor (planMilestone's owned) */
export function ownedInventory (bot: Bot): Inventory {
  const items: ItemCount[] = bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
  for (const slot of [5, 6, 7, 8, 45]) {
    const item = bot.inventory.slots[slot]
    if (item != null) items.push({ name: item.name, count: item.count })
  }
  return new Inventory(bot.registry as any, items)
}

/** the requests the inventory already meets */
export function requestsMet (inv: Inventory, requests: readonly ObtainRequest[]): boolean {
  const tags = itemTags(inv.registry)
  return requests.every(r => {
    if (r.optional === true) return true
    const alts = (typeof r.item === 'string' ? [r.item] : r.item).flatMap(i => [...tags.resolve(i)])
    return heldFor(inv, alts, r) >= r.count
  })
}

/** what the requests need, by item: what's kept when storing or making room */
export function neededItems (requests: readonly ObtainRequest[], plan?: ObtainPlan): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (name: string, n: number): void => { if (!name.startsWith('#')) out[name] = Math.max(out[name] ?? 0, n) }
  // (food points: the keep rule keeps every safe food)
  for (const r of requests) if (r.unit !== 'nutrition') for (const i of typeof r.item === 'string' ? [r.item] : r.item) add(i, r.count)
  for (const step of plan?.steps ?? []) {
    if (step.kind === 'craft') for (const i of step.ingredients) add(i.name, (out[i.name] ?? 0) + i.count)
    if (step.kind === 'smelt') for (const i of [...step.inputs, ...step.fuel]) add(i.name, (out[i.name] ?? 0) + i.count)
    if (step.kind === 'mine' && step.tool != null) add(step.tool, 1)
  }
  return out
}

export class Executor {
  readonly memory: WorldMemory
  readonly tasks: TaskRunner
  /** what's in sight and what wasn't found, for the plans' find costs */
  readonly sightings: Sightings
  readonly options: Required<Omit<ExecutorOptions, 'memory' | 'tasks' | 'runners' | 'hooks' | 'log' | 'home'>>
  private readonly runners: Record<PlanStep['kind'], StepRunner<any>>
  private readonly hooks: ExecutorHooks
  private readonly logFn: (line: string) => void
  private readonly home: () => Vec3 | null
  /** the tool replacement in progress (it obtains with this executor: no replacing within it) */
  private replacing = false
  private makingRoom = false
  /** the stacks thrown for room lately: one thrown again and again was picked up again (ThrowHistory) */
  private readonly throws = new ThrowHistory()
  /** a loop of throws with no chest to break it found: no room made on the way till this tick */
  private roomLoopUntil = -Infinity
  /** worn tools (kind:material) whose replacement failed: the tick until which no task is stopped for them */
  private readonly wearMuted = new Map<string, number>()
  /** what the requests being obtained need (neededItems): kept by the room made during a step */
  private needed: Record<string, number> = {}
  /**
   * The bag's keeper every task holds the bag with (skills/bag.ts): room made on the way at the skills' safe points,
   * in a milestone's own tasks (the obsidian from the lava, the walks and staircases to it, the nether's and the
   * stronghold's trips) as in a step's
   */
  readonly bagKeeper: BagKeeper

  constructor (readonly bot: Bot, opts: ExecutorOptions = {}) {
    this.memory = opts.memory ?? bot.survival.memory
    this.tasks = opts.tasks ?? bot.survival.tasks
    this.options = {
      keep: opts.keep ?? defaultKeep,
      maxReplans: opts.maxReplans ?? 30,
      maxStepFailures: opts.maxStepFailures ?? 3,
      minToolUses: opts.minToolUses ?? MIN_TOOL_USES,
      minFreeSlots: opts.minFreeSlots ?? 2,
      surplus: opts.surplus ?? (() => false),
      stocked: opts.stocked ?? (() => true),
      scaffold: opts.scaffold ?? { items: SCAFFOLD_ITEMS, keep: SCAFFOLD_KEEP },
      exclude: opts.exclude ?? ['barter']
    }
    this.runners = { ...DEFAULT_RUNNERS, ...opts.runners } as any
    this.hooks = opts.hooks ?? {}
    this.logFn = opts.log ?? (line => trace('executor:', line))
    this.home = opts.home ?? (() => null)
    this.sightings = new Sightings(bot, () => this.tasks.tick, pos => outOfTheWay(bot, pos))
    this.bagKeeper = {
      minFree: this.options.minFreeSlots,
      room: async (s, toward) => await this.makeRoomDuringStep(s, toward),
      unwanted: name => this.unwantedDrop(name)
    }
    // a village passed by is noted, with its farms' crops and hay, for the food plans
    let nextVillageCheck = 0
    bot.on('physicsTick', () => {
      if (this.tasks.tick < nextVillageCheck || typeof bot.findBlock !== 'function' || typeof bot.findBlocks !== 'function' || bot.entity == null) return
      nextVillageCheck = this.tasks.tick + VILLAGE_CHECK_TICKS
      if (normalizeDimension(bot.game?.dimension) !== 'overworld') return
      const before = this.memory.getPois('village').length
      const at = noteVillage(bot, this.memory, names => rememberAround(bot, this.memory, names, 64))
      if (at != null && this.memory.getPois('village').length > before) this.log(`a village at ${at.toString()}: its crops and hay noted`)
      // a dungeon's spawner passed by (a cave, the mine): the epochs' experience farm is built round one
      if (noteSpawners(bot, this.memory, 32) > 0) this.log(`a spawner noted: ${this.memory.getPois(SPAWNER_POI).slice(-1).map(p => `${p.note ?? '?'} at ${p.x} ${p.y} ${p.z}`).join('')}`)
    })
  }

  log (line: string): void {
    this.logFn(line)
  }

  get base (): BaseRecord | null {
    return baseRecord(this.memory)
  }

  /** the base's stations when the bot is near it (a plan counts on them only then) */
  stations (): Station[] {
    const base = this.base
    if (base == null || !this.nearBase(base, 48)) return []
    const out: Station[] = []
    if (base.table != null) out.push('crafting_table')
    if (base.furnaces.length > 0) out.push('furnace')
    return out
  }

  private nearBase (base: BaseRecord, distance: number): boolean {
    if (normalizeDimension(this.bot.game?.dimension) !== this.memory.base?.dimension) return false
    const p = this.bot.entity.position
    return Math.hypot(p.x - base.origin.x, p.y - base.origin.y, p.z - base.origin.z) <= distance
  }

  /** plans the requests from what the bot holds now */
  plan (requests: readonly ObtainRequest[], inventory: Inventory = ownedInventory(this.bot), extra: PlanOptions = {}): ObtainPlan {
    return obtainAll(this.bot.registry as any, requests, {
      ...extra,
      inventory,
      stations: this.stations(),
      memory: this.memory,
      position: this.bot.entity.position,
      dimension: this.bot.game?.dimension,
      exclude: [...this.options.exclude, ...(extra.exclude ?? [])],
      findCost: t => this.sightings.cost(t),
      farmCost: crop => this.farmCost(crop)
    })
  }

  /**
   * Gets the requests into the inventory: plan, run the steps, plan again on every surprise, until the inventory
   * meets them. Throws a TaskError when it can't (NOT_FOUND when no plan exists, the last step's error when a step
   * keeps failing, DIED when the bot died).
   */
  async obtain (requests: readonly ObtainRequest[], signal?: AbortSignal, planOptions: PlanOptions = {}): Promise<ObtainOutcome> {
    // the stall watchdog counts while there's work (play arms it too)
    const disarm = this.diagnostics?.arm()
    try {
      return await this.obtainLoop(requests, signal, planOptions)
    } finally {
      disarm?.()
    }
  }

  /** the stuck reports (bot.survival.diagnostics), told of each plan and step */
  private get diagnostics (): Diagnostics | undefined {
    return (this.bot as any).survival?.diagnostics
  }

  private async obtainLoop (requests: readonly ObtainRequest[], signal?: AbortSignal, planOptions: PlanOptions = {}): Promise<ObtainOutcome> {
    const diag = this.diagnostics
    const failures = new Map<string, number>()
    let plans = 0
    let steps = 0
    let lastError: unknown = null
    // the check that failed the last plan before a step of it ran, by its step and reason with the counts: a plan
    // made again from the same inventory fails it again (the planner counted on what its steps don't yield), so the
    // second time the next plans count on no drop beyond their steps' counts (exactYields), and a third time it fails
    let lastCheck: string | null = null
    let exact = planOptions.exactYields === true
    while (true) {
      throwIfOwnerAborted(signal)
      const inv = ownedInventory(this.bot)
      if (requestsMet(inv, requests)) return { plans, steps }
      if (plans >= this.options.maxReplans) {
        throw new TaskError('FAILED', `gave up after ${plans} plans`, { cause: lastError })
      }
      const plan = this.plan(requests, inv, exact ? { ...planOptions, exactYields: true } : planOptions)
      plans++
      if (!plan.ok) {
        const what = plan.unresolved.map(r => `${r.count} ${String(r.item)}`).join(', ')
        const err = new TaskError('NOT_FOUND', `no plan for ${what}`, { cause: lastError })
        diag?.noPlan(requests.map(describeRequest), err)
        throw err
      }
      this.log(`plan ${plans}: ${plan.steps.map(describeStep).join(', ')}`)
      diag?.planMade(plans, requests.map(describeRequest), plan.steps.map(s => ({ desc: describeStep(s), blocks: s.kind === 'mine' ? s.blocks : undefined })))
      if (plan.steps.length === 0) return { plans, steps }
      const needed = neededItems(requests, plan)
      this.needed = needed
      for (let i = 0; i < plan.steps.length; i++) {
        throwIfOwnerAborted(signal)
        const step = plan.steps[i]
        await this.prepare(step, needed, signal)
        // the rest of the plan has to hold for what the bot has now (a reflex ate, a tool broke, the bot died)
        const check = checkPlan(this.bot.registry as any, plan.steps.slice(i), ownedInventory(this.bot), this.stations())
        if (!check.ok) {
          const why = check.error != null ? `${describeStep(check.error.step)} ${check.error.reason}` : 'the plan no longer holds'
          this.log(`replan: ${why}`)
          if (why === lastCheck) {
            if (exact) throw new TaskError('FAILED', `the plans fail their check the same way: ${why}`, { cause: lastError })
            exact = true
            this.log('replan: the same check failed twice: planning from the inventory, counting on no drop beyond the steps\' counts')
          }
          lastCheck = why
          break
        }
        const key = `${step.kind}:${step.item}`
        let outcome: StepOutcome
        diag?.stepStarted(step, describeStep(step), i)
        try {
          outcome = await this.runStep(step, signal)
          steps++
          diag?.stepDone(step, outcome.gained)
        } catch (err) {
          if (isAbort(err) && signal?.aborted === true) throw err
          if (TaskError.is(err, 'DIED', 'ABORTED')) throw err
          lastError = err
          const n = (failures.get(key) ?? 0) + 1
          failures.set(key, n)
          this.log(`step failed (${n}): ${describeStep(step)}: ${(err as Error).message}`)
          diag?.stepFailed(step, describeStep(step), err, n)
          if (step.kind === 'mine') this.forgetFailedBlocks(step)
          this.noteMissing(step, err)
          if (n >= this.options.maxStepFailures) throw err
          if (TaskError.is(err, 'INVENTORY_FULL')) await this.makeRoom(needed, signal, true)
          break
        }
        failures.delete(key)
        if (outcome.replan === true) { this.log(`replan: ${describeStep(step)} came out differently`); break }
        if (outcome.gained < step.count) { this.log(`replan: ${describeStep(step)} gained ${outcome.gained}`); break }
      }
    }
  }

  /**
   * A mine step that failed: the remembered blocks of its kinds are forgotten, so the next plan prices them as blocks
   * yet to be found (diamonds remembered 200 blocks off kept the iron milestone on seed 5 planning a diamond helmet). One diamond ore remembered under a lake kept the iron milestone planning a diamond
   * sword, and the step failed the same way five times over.
   */
  private forgetFailedBlocks (step: Extract<PlanStep, { kind: 'mine' }>): void {
    const dimension = normalizeDimension(this.bot.game?.dimension)
    const known = this.memory.findBlocks(step.blocks, { dimension, near: this.bot.entity.position, maxDistance: FORGET_RADIUS, count: 256 })
    for (const b of known) this.memory.forgetBlock(b, dimension)
    if (known.length > 0) this.log(`forgot ${known.length} remembered ${step.blocks.join(', ')} after the step failed`)
  }

  /**
   * Ticks until the farm of a crop the bot sowed can be harvested, and the walk there: none left once half its plots
   * have grown (as seen), else what's left of GROW_TICKS since the sowing; undefined with no such farm
   */
  farmCost (crop: string): number | undefined {
    const farm = knownFarms(this.memory, normalizeDimension(this.bot.game?.dimension)).find(f => f.crop === crop)
    if (farm == null) return undefined
    const walk = Math.ceil(this.bot.entity.position.distanceTo(farm.water) * WALK_TICKS_PER_BLOCK)
    const cells = farmCells(farm)
    if (typeof this.bot.blockAt === 'function' && grownPlots(p => this.bot.blockAt(p) as any, cells, crop).length * 2 >= cells.length) return walk
    const age = Number((this.bot.time as any)?.age ?? 0)
    return walk + Math.max(0, farm.sown + GROW_TICKS - age)
  }

  /**
   * A step that explored and found none (NOT_FOUND): its animals (any meat animal for meat: the hunt looked for all
   * of them) or its food blocks are dear to the next plans for a while, which go for another source then (berries in a
   * snowy taiga, where the hunt for cows found none)
   */
  private noteMissing (step: PlanStep, err: unknown): void {
    if (!TaskError.is(err, 'NOT_FOUND')) return
    const names = step.kind === 'kill'
      ? [step.mob, ...mobSubstitutes(step)]
      : step.kind === 'mine' ? step.blocks.filter(b => SIGHTED_BLOCKS.includes(b)) : []
    if (names.length === 0) return
    this.sightings.missing(names)
    this.log(`none of ${names.join(', ')} found: the plans go for another source for a while`)
  }

  /**
   * Runs `fn` as a foreground task (so the reflexes preempt it; it runs again from the start after, so it should be
   * safe to repeat), cancelled when `signal` fires. Never call it from inside a task: the queue runs one at a time.
   * The task holds the bag (bagKeeper) unless `info.room` is false (a store into the base's chests: no depot put
   * down on the way there). Unless it's a plan's step or `info.wear` is false, the held tool is watched as the task
   * wears it (watchToolWear): about to break with no spare of its tier, the task is stopped (TOOL_WORN), the tool
   * replaced (replaceWornTool: made from what's carried, looted from the base or a depot, or obtained), the bot taken
   * back to where it stopped, and the task run again, up to MAX_WEAR_STOPS times.
   */
  async task<T> (name: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, info?: TaskInfo): Promise<T> {
    for (let stops = 0; ; stops++) {
      const watch: { stop: WearStop | null } = { stop: null }
      try {
        return await this.runTask(name, fn, signal, info, watch)
      } catch (err) {
        const stop = watch.stop
        if (stop == null || !TaskError.is(err, 'TOOL_WORN') || signal?.aborted === true) throw err
        const partial = err.partial
        this.log(`${name}: stopped, the ${stop.tool.name} has ${stop.tool.uses} uses left and no spare of its tier${partial != null ? ` (got so far: ${JSON.stringify(partial)})` : ''}`)
        if (stops >= MAX_WEAR_STOPS) {
          this.muteWorn(stop.tool)
          throw err
        }
        await this.replaceWornTool(stop.tool, signal)
        await this.backTo(stop, name, signal)
      }
    }
  }

  /** the wear watch's mute: no task is stopped for the tool for WEAR_RETRY_TICKS */
  private muteWorn (tool: WornTool): void {
    this.wearMuted.set(`${tool.kind}:${tool.material}`, this.tasks.tick + WEAR_RETRY_TICKS)
  }

  private wornMuted (tool: WornTool): boolean {
    return (this.wearMuted.get(`${tool.kind}:${tool.material}`) ?? -1) > this.tasks.tick
  }

  /**
   * A new tool for one the wear watch stopped a task for: of its tier or better, else of a tier lower (replacementTiers),
   * the cheap way first (a plan within WEAR_REPLACE_TICKS: made from what's carried, a spare looted from the base or a
   * depot), a spare of a lower tier held in good shape doing before a dear plan; else the first plan there is. None got,
   * the tool is let be for a while (muteWorn) and used till it breaks. Whether there's one now.
   */
  async replaceWornTool (tool: WornTool, signal?: AbortSignal): Promise<boolean> {
    if (this.replacing) return false
    this.replacing = true
    try {
      const tiers = replacementTiers(tool.material)
      const request = (material: ToolMaterial): ObtainRequest[] => {
        const alts = toolsAtLeast(tool.kind, material)
        return [{ item: alts, count: ownedInventory(this.bot).countAny(alts) + 1 }]
      }
      // a spare of a lower tier held in good shape: it goes on after the worn one
      const spareHeld = (material: ToolMaterial): string | null => {
        const alts = toolsAtLeast(tool.kind, material)
        return this.bot.inventory.items().find(i => alts.includes(i.name) && usesLeft(i) > this.options.minToolUses * 2)?.name ?? null
      }
      const get = async (material: ToolMaterial, why: string): Promise<boolean> => {
        this.log(`the ${tool.name} has ${tool.uses} uses left: another of ${material} or better (${why})`)
        try {
          await this.obtain(request(material), signal)
          return true
        } catch (err) {
          if (TaskError.is(err, 'DIED', 'ABORTED') || signal?.aborted === true) throw err
          this.log(`no new ${tool.kind} of ${material}: ${(err as Error).message}`)
          return false
        }
      }
      const plans = tiers.map(material => ({ material, plan: this.plan(request(material)) }))
      for (const [i, { material, plan }] of plans.entries()) {
        const spare = i > 0 ? spareHeld(material) : null
        if (spare != null) {
          this.log(`the ${tool.name} has ${tool.uses} uses left: the ${spare} held goes on after it`)
          this.muteWorn(tool)
          return true
        }
        if (plan.ok && plan.cost <= WEAR_REPLACE_TICKS && await get(material, `a plan of ${Math.round(plan.cost)} ticks`)) return true
      }
      for (const { material, plan } of plans) {
        if (plan.ok && plan.cost > WEAR_REPLACE_TICKS && await get(material, `a dear plan, ${Math.round(plan.cost)} ticks`)) return true
      }
      this.log(`no new ${tool.kind} for the ${tool.name}: it's used till it breaks`)
      this.muteWorn(tool)
      return false
    } finally {
      this.replacing = false
    }
  }

  /** back to where a task stopped for a worn tool (the new one got away from there: the base's chest), to go on from there */
  private async backTo (stop: WearStop, name: string, signal?: AbortSignal): Promise<void> {
    if (normalizeDimension(this.bot.game?.dimension) !== stop.dimension || this.bot.entity.position.distanceTo(stop.at) <= WEAR_RETURN_RANGE) return
    this.log(`back to ${stop.at.floored().toString()}, where ${name} stopped`)
    await this.task(`back to where ${name} stopped`, async (s) => { await travel(this.bot, { target: stop.at, range: 2, exactY: true }, s) }, signal, { wear: false })
      .catch(err => {
        if (TaskError.is(err, 'DIED') || signal?.aborted === true) throw err
        this.log(`not back where ${name} stopped: ${(err as Error).message}`)
      })
  }

  /** a task as task() runs it once, `watch.stop` set when the wear watch stopped it */
  private async runTask<T> (name: string, fn: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, info: TaskInfo | undefined, watch: { stop: WearStop | null }): Promise<T> {
    throwIfOwnerAborted(signal)
    // in the nether, every task's paths with the nether's settings (no lava edges or magma, ledges dear, the deaths
    // kept away from): a mine step for warped stems after a death walked the bot into the lava (26.3)
    const inDimension = async (s: AbortSignal): Promise<T> => normalizeDimension(this.bot.game?.dimension) === 'the_nether'
      ? await withNetherSafety(this.bot, async () => await fn(s))
      : await fn(s)
    // the attempt running now (not one a reflex preempted)
    let active = false
    const run = async (s: AbortSignal): Promise<T> => {
      active = true
      try {
        if (info?.room === false) return await inDimension(s)
        const release = holdBag(this.bot, this.bagKeeper, s)
        try {
          return await inDimension(s)
        } finally {
          release()
        }
      } finally {
        active = false
      }
    }
    const handle = this.tasks.enqueue<T>({ name, onPreempt: 'resume' }, async (ctx) => await run(ctx.signal))
    const onAbort = (): void => handle.cancel(`${name} was stopped`)
    signal?.addEventListener('abort', onAbort, { once: true })
    // the held tool watched as the task wears it (not a plan's step: a mine step hands a worn tool back itself, and the
    // executor replaces it before the next; nor within a replacement): stopped with TOOL_WORN when it's about to break
    // with no spare of its tier, and task() replaces it and runs the task again. Long tasks never made one: a 26.3
    // whole game's staircase down to the deep lava broke the diamond and the iron pickaxe, the spare 160 blocks off
    const unwatch = info?.step == null && info?.wear !== false && !this.replacing && typeof (this.bot as any).on === 'function'
      ? watchToolWear(this.bot as any, {
        minUses: this.options.minToolUses,
        active: () => active,
        muted: tool => this.wornMuted(tool),
        stop: tool => {
          watch.stop = { tool, at: this.bot.entity.position.clone(), dimension: normalizeDimension(this.bot.game?.dimension) }
          handle.stop(new TaskError('TOOL_WORN', `the ${tool.name} has ${tool.uses} uses left, no spare of its tier: ${name} stopped for another`))
        }
      })
      : () => {}
    try {
      return await handle.result
    } catch (err) {
      // a skill that threw (not stopped, not dead): a skill report, with the window, the target and the step's args
      if (!isAbort(err) && !TaskError.is(err, 'DIED') && signal?.aborted !== true && !(this.bot.health <= 0)) {
        try { this.diagnostics?.skillFailed(name, err, info) } catch {}
      }
      throw err
    } finally {
      unwatch()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** runs one step as a foreground task (resumed after a reflex preempts it) */
  async runStep (step: PlanStep, signal?: AbortSignal): Promise<StepOutcome> {
    const runner = this.runners[step.kind]
    const base = this.base
    const near = base != null && this.nearBase(base, 48)
    // kept across the attempts a reflex's preemption makes
    const state: Record<string, any> = {}
    const diag = this.diagnostics
    if (diag?.step != null && diag.step.key === `${step.kind}:${step.item}`) diag.step.state = state
    return await this.task(`step:${describeStep(step)}`, async (taskSignal) => {
      const stepCtx: StepContext = {
        bot: this.bot,
        memory: this.memory,
        signal: taskSignal,
        state,
        log: line => this.log(line),
        table: near && base?.table != null ? vec(base.table) : null,
        furnace: near && base != null && base.furnaces.length > 0 ? vec(base.furnaces[0]) : null,
        home: this.home(),
        protect: base?.bounds != null ? inBox(base.bounds) : undefined,
        // the logs for a new axe are cut with the worn one: handed back for a new axe, the plan for one started over
        // 30 times and the milestone failed (seed 5)
        replacingTools: this.replacing,
        unwanted: name => this.unwantedDrop(name),
        room: async (toward) => await this.makeRoomDuringStep(taskSignal, toward)
      }
      return await runner(step, stepCtx)
    }, signal, { step, desc: describeStep(step) })
  }

  /** what no store or throw takes from the bag beyond keep.ts protectedCounts' own: the best hoe while the bot keeps a farm */
  protect (): ProtectOptions {
    return { farming: knownFarms(this.memory, normalizeDimension(this.bot.game?.dimension)).length > 0 }
  }

  /** what making room may throw away beyond the keep count: the options' surplus, and the route's stone the stock has enough of */
  isSurplus (name: string): boolean {
    return this.options.surplus(name) || (ROUTE_STONE.has(name) && this.options.stocked(name))
  }

  /**
   * A drop not gone for while working: the route's stone the stock has enough of (isSurplus), once the bag carries
   * what's kept of it (the keep count, what the requests need)
   */
  unwantedDrop (name: string): boolean {
    if (!ROUTE_STONE.has(name) || !this.options.stocked(name)) return false
    const kept = Math.max(this.options.keep(name, this.bot.registry as any) ?? 0, this.needed[name] ?? 0)
    return countItems(this.bot, name) >= kept
  }

  /** before a step: room in the inventory, a tool that won't break during it, the hooks */
  private async prepare (step: PlanStep, needed: Record<string, number>, signal?: AbortSignal): Promise<void> {
    if (emptySlots(this.bot) < this.options.minFreeSlots) await this.makeRoom(needed, signal)
    if (step.kind === 'mine' || step.kind === 'kill') await this.replaceWornTools(signal)
    await this.hooks.beforeStep?.(step)
  }

  /**
   * Makes a new tool for each kind whose best one is about to break (and no other of its tier is in better shape),
   * from a plan that leaves the worn one out, so the work goes on with the old one meanwhile.
   */
  async replaceWornTools (signal?: AbortSignal): Promise<void> {
    if (this.replacing) return
    const worn = wornOutTools(this.bot.inventory.items(), { minUses: this.options.minToolUses })
    if (worn.length === 0) return
    this.replacing = true
    try {
      for (const w of worn) {
        const alts = toolsAtLeast(w.kind, w.material === 'golden' ? 'wooden' : w.material)
        const inv = ownedInventory(this.bot)
        const have = inv.countAny(alts)
        this.log(`${w.item.name} has ${w.uses} uses left: making another`)
        try {
          await this.obtain([{ item: alts, count: have + 1 }], signal)
        } catch (err) {
          if (TaskError.is(err, 'DIED', 'ABORTED') || signal?.aborted === true) throw err
          this.log(`no new ${w.kind}: ${(err as Error).message}`)
        }
      }
    } finally {
      this.replacing = false
    }
  }

  /**
   * Frees slots, the cheapest way first: throws away the junk and what's surplus (the route's stone the stock has
   * enough of), behind the bot (tossAway); then stores what isn't kept in the base's chests when the base is within
   * BASE_STORE_RANGE (or `force`); then puts it in a chest near (stashNearby: a known one, or a mine depot put down
   * here). When `force` and there's no room still, it throws the rest of what storing would take, never a valuable
   * (keep.ts's isValuable), and with nothing left to throw fails INVENTORY_FULL: a forced room had thrown an
   * enchanting table and a diamond away (26.3). `inTask`: the signal of the task it runs in (a step's, room made on the
   * way: makeRoomDuringStep), whose skills it calls straight, with no walk to the base. `toward`: where the bot goes
   * next (the pit for what's thrown dug off its way). A stack thrown THROW_LOOP_REPEATS times within THROW_LOOP_TICKS
   * (ThrowHistory: it came back each time) isn't thrown again: it goes to the base's chests or a chest near with the
   * rest, and with no chest to take it, the room fails INVENTORY_FULL with a report rather than throw it once more.
   */
  async makeRoom (needed: Record<string, number> = {}, signal?: AbortSignal, force = false, inTask?: AbortSignal, toward?: Vec3): Promise<void> {
    if (this.makingRoom) return
    this.makingRoom = true
    const run: RoomRunner = inTask != null ? async (_name, fn) => await fn(inTask) : async (name, fn) => await this.task(name, fn, signal, { room: false })
    try {
      const thrown = await this.tossJunk(needed, false, run, toward)
      if (thrown.room) return
      const base = this.base
      if (inTask == null && base != null && base.chests.length > 0 && (force || this.nearBase(base, BASE_STORE_RANGE))) {
        await this.storeAtBase(needed, signal)
        if (emptySlots(this.bot) >= this.options.minFreeSlots) return
      }
      await this.stashNearby(needed, signal, run, new Set(thrown.looping.map(t => t.name)))
      if (thrown.looping.length > 0 && emptySlots(this.bot) < this.options.minFreeSlots) this.roomLoops(thrown.looping)
      if (!force || emptySlots(this.bot) >= this.options.minFreeSlots) return
      await this.tossJunk(needed, true, run, toward)
      if (emptySlots(this.bot) === 0) {
        throw new TaskError('INVENTORY_FULL', 'no room: nothing to throw away but what is kept or valuable, and no chest near to put it in')
      }
    } finally {
      this.makingRoom = false
    }
  }

  /**
   * Room made during a step (StepContext.room), when the bag is short of minFreeSlots: the route's drops come in as the
   * bot walks a staircase or a tunnel, and a mine step for 5 diamonds may dig hundreds of blocks of it before it ends
   * and the room before the next step is made. The junk and the surplus thrown, the rest in a depot; never a walk to
   * the base, never a failure (the step's own pickups say NO_SPACE)
   */
  async makeRoomDuringStep (signal: AbortSignal, toward?: Vec3): Promise<void> {
    if (emptySlots(this.bot) >= this.options.minFreeSlots) return
    // a loop of throws with no chest to break it: the work goes on with the bag as it is a while (a full bag picks up
    // nothing), not one more throw and stash each step
    if (this.tasks.tick < this.roomLoopUntil) return
    try {
      await this.makeRoom(this.needed, signal, false, signal, toward)
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'DIED', 'ABORTED') || signal.aborted) throw err
      this.log(`no room made on the way: ${(err as Error).message}`)
    }
  }

  /**
   * A loop of throws for room no chest broke (the stacks `looping` came back each time they were thrown): fails
   * INVENTORY_FULL, with a report, and no room is made on the way for THROW_LOOP_TICKS
   */
  private roomLoops (looping: ReadonlyArray<{ name: string, count: number }>): never {
    const err = new TaskError('INVENTORY_FULL', `making room loops: ${looping.map(t => `${t.count} ${t.name}`).join(', ')} thrown ${THROW_LOOP_REPEATS} times within ${THROW_LOOP_TICKS} ticks and picked up again, and no chest to put them in (${emptySlots(this.bot)} slots free)`)
    this.roomLoopUntil = this.tasks.tick + THROW_LOOP_TICKS
    try { this.diagnostics?.skillFailed('make room', err, { args: { looping, at: this.bot.entity.position.floored().toString() } }) } catch {}
    throw err
  }

  /**
   * Throws away the junk and the surplus (and with `anything`, what storing would take) for room: whole stacks, the
   * least worth first (junkToToss), into lava or a pit off the way. Not a stack thrown THROW_LOOP_REPEATS times
   * within THROW_LOOP_TICKS already (ThrowHistory: it was picked up again each time): those are `looping`, for a chest.
   * Whether there's room now.
   */
  private async tossJunk (needed: Record<string, number>, anything: boolean, run: RoomRunner, toward?: Vec3): Promise<{ room: boolean, looping: Array<{ name: string, count: number }> }> {
    const lava = (): { yaw: number, pitch: number } | null => lavaThrow(p => this.bot.blockAt(p) as any, this.bot.entity.position, (this.bot.entity as any).eyeHeight ?? 1.62)
    // with lava in reach, LAVA_ROOM more slots: what burns is gone for good, and the work about a lava lake (its
    // obsidian) turns the lava it would be thrown into later
    const want = this.options.minFreeSlots + 2 + (lava() != null ? LAVA_ROOM : 0) - emptySlots(this.bot)
    if (want <= 0) return { room: true, looping: [] }
    const stacks = this.bot.inventory.items().map(i => ({ name: i.name, count: i.count, enchanted: isEnchanted(i) }))
    let toss = junkToToss(stacks, want, { keep: this.options.keep, registry: this.bot.registry, needed, anything, surplus: name => this.isSurplus(name), scaffold: this.options.scaffold, protect: this.protect() })
    const looping = this.throws.looping(toss, this.tasks.tick, name => this.bot.registry.itemsByName[name]?.stackSize ?? 64)
    if (looping.length > 0) {
      this.log(`making room loops: ${looping.map(t => `${t.count} ${t.name}`).join(', ')} thrown ${THROW_LOOP_REPEATS - 1} times within ${THROW_LOOP_TICKS} ticks came back: into a chest instead`)
      const names = new Set(looping.map(t => t.name))
      toss = toss.filter(t => !names.has(t.name))
    }
    if (toss.length > 0) {
      this.log(`throwing away ${toss.map(t => `${t.count} ${t.name}`).join(', ')}`)
      this.throws.record(toss, this.tasks.tick)
      await run('make room', async (s) => {
        // into lava in reach, where it burns (lavaThrow); else into a pit dug beside the bot, out of its reach as it
        // walks by (or behind it), and never gone back for (tossAway): thrown at a wall, the stack fell at its feet and
        // was picked up again 40 ticks on (Player.drop's pickup delay)
        let pit: Vec3 | null | undefined
        for (const t of toss) {
          const burn = lava()
          if (burn == null && pit === undefined) pit = await dumpPit(this.bot, s, toward)
          // into the pit along a look whose flight ends there (pitThrow), else aimed at it
          const look = burn == null && pit != null ? pitThrow(p => this.bot.blockAt(p) as any, this.bot.entity.position, pit, (this.bot.entity as any).eyeHeight ?? 1.62) : null
          const into = burn ?? (look != null && pit != null ? { ...look, pit } : pit)
          await tossAway(this.bot, t.name, t.count, s, into ?? undefined).catch(err => { if (isAbort(err)) throw err })
        }
      })
    }
    return { room: emptySlots(this.bot) >= this.options.minFreeSlots, looping }
  }

  /**
   * Puts what the keep rule doesn't keep (nor the needed) into a chest near the bot: a known one within DEPOT_RANGE
   * (a depot put down before, the base's), else a mine depot put down here: a carried chest (one crafted from the
   * bag's wood when none is), in a nook dug into the wall beside the bot, off the way back (digDepotNook), or on the
   * floor beside it with room over it (ChestBlock.isChestBlockedAt). The chest is remembered with what went in (the
   * planner fetches from it, the stock counts it: DEPOT_POI); the junk and the stone the stock has enough of are
   * thrown, not stored, but `also`'s (the stacks a throw keeps getting back: makeRoom). What was stored.
   */
  async stashNearby (needed: Record<string, number> = {}, signal?: AbortSignal, run: RoomRunner = async (name, fn) => await this.task(name, fn, signal, { room: false }), also: ReadonlySet<string> = new Set()): Promise<Record<string, number>> {
    const moved: Record<string, number> = {}
    const { store } = splitInventory(this.bot.inventory.items(), { keep: this.options.keep, registry: this.bot.registry, needed, protect: this.protect() })
    const worth = store.filter(it => also.has(it.name) || (!JUNK.has(it.name) && !this.isSurplus(it.name)))
    if (worth.length === 0) return moved
    const dimension = normalizeDimension(this.bot.game?.dimension)
    const here = this.bot.entity.position
    const near = this.memory.knownChests(dimension)
      .map(c => vec(c))
      .filter(p => p.distanceTo(here) <= DEPOT_RANGE && ['chest', 'trapped_chest', 'barrel'].includes(this.bot.blockAt(p)?.name ?? ''))
      .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
    let chest: Vec3 | null = near[0] ?? null
    if (chest == null) {
      try {
        chest = await run('put down a depot', async (s) => await this.putDownDepot(s))
      } catch (err) {
        if (TaskError.is(err, 'DIED', 'ABORTED') || signal?.aborted === true || isAbort(err)) throw err
        this.log(`no depot put down: ${(err as Error).message}`)
        return moved
      }
      if (chest == null) return moved
      this.memory.rememberChest(chest, {}, dimension)
      this.memory.addPoi(DEPOT_POI, chest, dimension)
      this.log(`a depot chest put down at ${chest.toString()}`)
    }
    const at = chest
    for (const it of worth) {
      throwIfOwnerAborted(signal)
      try {
        const res = await run(`store ${it.name}`, async (s) => await storeItems(this.bot, { chest: at, filter: [it.name], count: it.count, protect: this.protect() }, s))
        const n = res.moved[it.name] ?? 0
        this.rememberStored(at, it.name, n, dimension)
        if (n > 0) moved[it.name] = (moved[it.name] ?? 0) + n
      } catch (err) {
        if (TaskError.is(err, 'DIED', 'ABORTED') || signal?.aborted === true || isAbort(err)) throw err
        // a full chest, or one that won't open: the rest stays
        const partial = ((err as TaskError).partial as { moved?: Record<string, number> } | undefined)?.moved?.[it.name] ?? 0
        this.rememberStored(at, it.name, partial, dimension)
        break
      }
    }
    if (Object.keys(moved).length > 0) this.log(`stashed ${Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ')} in a chest at ${at.toString()}`)
    return moved
  }

  /** a chest put down by the bot for a depot (crafted first when none is carried), or null when there's no way to */
  private async putDownDepot (signal: AbortSignal): Promise<Vec3 | null> {
    const bot = this.bot
    if (countItems(bot, 'chest') === 0) {
      // 8 planks (2 logs) at the carried table
      await craft(bot, { item: 'chest', pickUpTable: true }, signal)
      if (countItems(bot, 'chest') === 0) return null
    }
    const nook = await digDepotNook(bot, signal)
    const at = nook ?? findPlacement(p => bot.blockAt(p) as any, bot.entity.position, { radius: 3, freeAbove: true })
    if (at == null) return null
    await placeBlock(bot, { pos: at, item: 'chest' }, signal)
    return bot.blockAt(at)?.name === 'chest' ? at : null
  }

  /** takes everything the keep rule doesn't keep (nor the needed) to the base's chests, the remembered contents updated */
  async storeAtBase (needed: Record<string, number> = {}, signal?: AbortSignal): Promise<Record<string, number>> {
    const base = this.base
    if (base == null || base.chests.length === 0) return {}
    const { store: toStore } = splitInventory(this.bot.inventory.items(), { keep: this.options.keep, registry: this.bot.registry, needed, protect: this.protect() })
    const moved: Record<string, number> = {}
    if (toStore.length === 0) return moved
    const dimension = this.memory.base?.dimension ?? 'overworld'
    const left = new Map(toStore.map(s => [s.name, s.count]))
    // the chests that hold some of it already first, then the emptiest
    const chests = [...base.chests].sort((a, b) => {
      const score = (p: { x: number, y: number, z: number }): number => {
        const known = this.memory.chestAt(p, dimension)
        const shared = [...left.keys()].some(n => (known?.items[n] ?? 0) > 0) ? -1000 : 0
        return shared + Object.keys(known?.items ?? {}).length
      }
      return score(a) - score(b)
    })
    const held = new Map<string, number>()
    for (const i of this.bot.inventory.items()) held.set(i.name, (held.get(i.name) ?? 0) + i.count)
    const record = (pos: { x: number, y: number, z: number }, res: Record<string, number>): void => {
      for (const [name, n] of Object.entries(res)) {
        if (n <= 0) continue
        moved[name] = (moved[name] ?? 0) + n
        this.rememberStored(pos, name, n, dimension)
        const rest = (left.get(name) ?? 0) - n
        if (rest > 0) left.set(name, rest)
        else left.delete(name)
      }
    }
    const store = async (pos: { x: number, y: number, z: number }, filter: string[], count?: number): Promise<boolean> => {
      try {
        const res = await this.task(`store ${filter.join(', ')}`, async (s) => await storeItems(this.bot, { chest: vec(pos), filter, count, protect: this.protect() }, s), signal, { room: false })
        record(pos, res.moved)
        return true
      } catch (err) {
        if (TaskError.is(err, 'DIED', 'ABORTED') || signal?.aborted === true) throw err
        record(pos, ((err as TaskError).partial as { moved?: Record<string, number> } | undefined)?.moved ?? {})
        // the chest is full (or out of reach): the next one
        return false
      }
    }
    for (const pos of chests) {
      if (left.size === 0) break
      throwIfOwnerAborted(signal)
      // in one opening the items stored whole, then one by one the ones partly kept
      const whole = [...left].filter(([name, n]) => n >= (held.get(name) ?? 0)).map(([name]) => name)
      if (whole.length > 0 && !(await store(pos, whole))) continue
      let full = false
      for (const [name, count] of [...left]) {
        if (!(await store(pos, [name], count))) { full = true; break }
      }
      if (full) continue
    }
    if (Object.keys(moved).length > 0) this.log(`stored ${Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ')}`)
    return moved
  }

  /** puts these counts in the base's chests (the first with room), the remembered contents updated; what was stored */
  async storeExact (items: readonly ItemCount[], signal?: AbortSignal): Promise<Record<string, number>> {
    const base = this.base
    const moved: Record<string, number> = {}
    if (base == null || base.chests.length === 0) return moved
    const dimension = this.memory.base?.dimension ?? 'overworld'
    for (const it of items) {
      let left = it.count
      for (const pos of base.chests) {
        if (left <= 0) break
        throwIfOwnerAborted(signal)
        try {
          const res = await this.task(`store ${it.name}`, async (s) => await storeItems(this.bot, { chest: vec(pos), filter: [it.name], count: left, protect: this.protect() }, s), signal, { room: false })
          const n = res.moved[it.name] ?? 0
          this.rememberStored(pos, it.name, n, dimension)
          moved[it.name] = (moved[it.name] ?? 0) + n
          left -= n
        } catch (err) {
          if (TaskError.is(err, 'DIED', 'ABORTED') || signal?.aborted === true) throw err
        }
      }
    }
    if (Object.keys(moved).length > 0) this.log(`stored ${Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ')}`)
    return moved
  }

  private rememberStored (pos: { x: number, y: number, z: number }, name: string, n: number, dimension: string): void {
    if (n <= 0) return
    const known = this.memory.chestAt(pos, dimension)
    const items = { ...(known?.items ?? {}) }
    items[name] = (items[name] ?? 0) + n
    this.memory.rememberChest(pos, items, dimension)
  }
}

/** a stack with enchantments (prismarine-item's, of its components or its NBT): never thrown away */
function isEnchanted (item: unknown): boolean {
  try {
    return ((item as { enchants?: unknown[] }).enchants?.length ?? 0) > 0
  } catch {
    return false
  }
}

function vec (p: { x: number, y: number, z: number }): Vec3 {
  return new Vec3(p.x, p.y, p.z)
}

function inBox (b: { min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number } }): (pos: Vec3) => boolean {
  return pos => pos.x >= b.min.x && pos.y >= b.min.y && pos.z >= b.min.z && pos.x < b.max.x && pos.y < b.max.y && pos.z < b.max.z
}

function throwIfOwnerAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason instanceof TaskError ? signal.reason : new TaskError('ABORTED', 'the executor was stopped')
}
