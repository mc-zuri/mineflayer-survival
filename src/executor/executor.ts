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
import { checkPlan, type PlanStep, type Station } from '../planner/steps'
import { baseRecord, type BaseRecord } from '../base/pois'
import { storeItems } from '../skills/chest'
import { isAbort } from '../skills/errors'
import { emptySlots, settleInventory, trace } from '../skills/util'
import { wornOutTools } from './durability'
import { defaultKeep, junkToToss, splitInventory, type KeepRule } from './keep'
import { DEFAULT_RUNNERS, MIN_TOOL_USES, mobSubstitutes, outOfTheWay, type StepContext, type StepOutcome, type StepRunner } from './steps'
import { SIGHTED_BLOCKS, Sightings } from './sight'
import { noteVillage } from '../skills/village'
import { rememberAround } from './explore'
import { farmCells, grownPlots, knownFarms } from '../skills/farm'
import { GROW_TICKS } from '../core/crops'
import type { Diagnostics } from '../diagnostics'
import { WALK_TICKS_PER_BLOCK } from '../planner/sources'
import { withNetherSafety } from '../nether/safety'

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
  /** strategies the plans never use (default: barter, until the nether skills do it) */
  exclude?: StrategyKind[]
  runners?: Partial<Record<PlanStep['kind'], StepRunner<any>>>
  hooks?: ExecutorHooks
  /** a line per step and replan */
  log?: (line: string) => void
  /** the spawn or base, where exploring turns around */
  home?: () => Vec3 | null
}

/** what a caller adds to the executor's plans (the night's: undergroundOnly; a stock top-up's: no loot, exclude) */
export type PlanOptions = Pick<ObtainOptions, 'undergroundOnly' | 'exclude' | 'exactYields'>

export interface ObtainOutcome {
  /** plans made */
  plans: number
  /** steps run */
  steps: number
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
      exclude: opts.exclude ?? ['barter']
    }
    this.runners = { ...DEFAULT_RUNNERS, ...opts.runners } as any
    this.hooks = opts.hooks ?? {}
    this.logFn = opts.log ?? (line => trace('executor:', line))
    this.home = opts.home ?? (() => null)
    this.sightings = new Sightings(bot, () => this.tasks.tick, pos => outOfTheWay(bot, pos))
    // a village passed by is noted, with its farms' crops and hay, for the food plans
    let nextVillageCheck = 0
    bot.on('physicsTick', () => {
      if (this.tasks.tick < nextVillageCheck || typeof bot.findBlock !== 'function' || typeof bot.findBlocks !== 'function' || bot.entity == null) return
      nextVillageCheck = this.tasks.tick + VILLAGE_CHECK_TICKS
      if (normalizeDimension(bot.game?.dimension) !== 'overworld') return
      const before = this.memory.getPois('village').length
      const at = noteVillage(bot, this.memory, names => rememberAround(bot, this.memory, names, 64))
      if (at != null && this.memory.getPois('village').length > before) this.log(`a village at ${at.toString()}: its crops and hay noted`)
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
   */
  async task<T> (name: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, info?: { step?: PlanStep, desc?: string, args?: unknown }): Promise<T> {
    throwIfOwnerAborted(signal)
    // in the nether, every task's paths with the nether's settings (no lava edges or magma, ledges dear, the deaths
    // kept away from): a mine step for warped stems after a death walked the bot into the lava (26.3)
    const run = async (s: AbortSignal): Promise<T> => normalizeDimension(this.bot.game?.dimension) === 'the_nether'
      ? await withNetherSafety(this.bot, async () => await fn(s))
      : await fn(s)
    const handle = this.tasks.enqueue<T>({ name, onPreempt: 'resume' }, async (ctx) => await run(ctx.signal))
    const onAbort = (): void => handle.cancel(`${name} was stopped`)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await handle.result
    } catch (err) {
      // a skill that threw (not stopped, not dead): a skill report, with the window, the target and the step's args
      if (!isAbort(err) && !TaskError.is(err, 'DIED') && signal?.aborted !== true && !(this.bot.health <= 0)) {
        try { this.diagnostics?.skillFailed(name, err, info) } catch {}
      }
      throw err
    } finally {
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
        replacingTools: this.replacing
      }
      return await runner(step, stepCtx)
    }, signal, { step, desc: describeStep(step) })
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
   * Frees slots: stores what isn't kept in the base's chests when the base is within reach (or `force`), else throws
   * the junk away (and, when that isn't enough and `force`, the rest of what storing would take).
   */
  async makeRoom (needed: Record<string, number> = {}, signal?: AbortSignal, force = false): Promise<void> {
    if (this.makingRoom) return
    this.makingRoom = true
    try {
      const base = this.base
      if (base != null && base.chests.length > 0 && (force || this.nearBase(base, 256))) {
        await this.storeAtBase(needed, signal)
        if (emptySlots(this.bot) >= this.options.minFreeSlots) return
      }
      const want = this.options.minFreeSlots + 2 - emptySlots(this.bot)
      const toss = junkToToss(this.bot.inventory.items(), want, { keep: this.options.keep, registry: this.bot.registry, needed, anything: force, surplus: this.options.surplus })
      if (toss.length > 0) this.log(`throwing away ${toss.map(t => `${t.count} ${t.name}`).join(', ')}`)
      if (toss.length > 0) {
        await this.task('make room', async (s) => {
          for (const t of toss) {
            await settleInventory(this.bot, s)
            await this.bot.toss(this.bot.registry.itemsByName[t.name].id, null, t.count).catch(() => {})
          }
        }, signal)
      }
    } finally {
      this.makingRoom = false
    }
  }

  /** takes everything the keep rule doesn't keep (nor the needed) to the base's chests, the remembered contents updated */
  async storeAtBase (needed: Record<string, number> = {}, signal?: AbortSignal): Promise<Record<string, number>> {
    const base = this.base
    if (base == null || base.chests.length === 0) return {}
    const { store: toStore } = splitInventory(this.bot.inventory.items(), { keep: this.options.keep, registry: this.bot.registry, needed })
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
        const res = await this.task(`store ${filter.join(', ')}`, async (s) => await storeItems(this.bot, { chest: vec(pos), filter, count }, s), signal)
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
          const res = await this.task(`store ${it.name}`, async (s) => await storeItems(this.bot, { chest: vec(pos), filter: [it.name], count: left }, s), signal)
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

function vec (p: { x: number, y: number, z: number }): Vec3 {
  return new Vec3(p.x, p.y, p.z)
}

function inBox (b: { min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number } }): (pos: Vec3) => boolean {
  return pos => pos.x >= b.min.x && pos.y >= b.min.y && pos.z >= b.min.z && pos.x < b.max.x && pos.y < b.max.y && pos.z < b.max.z
}

function throwIfOwnerAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason instanceof TaskError ? signal.reason : new TaskError('ABORTED', 'the executor was stopped')
}
