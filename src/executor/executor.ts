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
import { obtainAll, type ObtainPlan, type ObtainRequest, type StrategyKind } from '../planner/obtain'
import { toolsAtLeast } from '../planner/progression'
import { checkPlan, type PlanStep, type Station } from '../planner/steps'
import { baseRecord, type BaseRecord } from '../base/pois'
import { storeItems } from '../skills/chest'
import { isAbort } from '../skills/errors'
import { emptySlots, settleInventory, trace } from '../skills/util'
import { wornOutTools } from './durability'
import { defaultKeep, junkToToss, splitInventory, type KeepRule } from './keep'
import { DEFAULT_RUNNERS, MIN_TOOL_USES, type StepContext, type StepOutcome, type StepRunner } from './steps'

/** how far from the bot a failed mine step's remembered blocks are forgotten */
export const FORGET_RADIUS = 128

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
  /** strategies the plans never use (default: barter, until the nether skills do it) */
  exclude?: StrategyKind[]
  runners?: Partial<Record<PlanStep['kind'], StepRunner<any>>>
  hooks?: ExecutorHooks
  /** a line per step and replan */
  log?: (line: string) => void
  /** the spawn or base, where exploring turns around */
  home?: () => Vec3 | null
}

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
    case 'loot': return `loot ${step.count} ${step.item} at ${step.from.x} ${step.from.y} ${step.from.z}`
    default: return `${step.kind} ${step.count} ${step.item}`
  }
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
    return inv.countAny(alts) >= r.count
  })
}

/** what the requests need, by item: what's kept when storing or making room */
export function neededItems (requests: readonly ObtainRequest[], plan?: ObtainPlan): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (name: string, n: number): void => { if (!name.startsWith('#')) out[name] = Math.max(out[name] ?? 0, n) }
  for (const r of requests) for (const i of typeof r.item === 'string' ? [r.item] : r.item) add(i, r.count)
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
      exclude: opts.exclude ?? ['barter']
    }
    this.runners = { ...DEFAULT_RUNNERS, ...opts.runners } as any
    this.hooks = opts.hooks ?? {}
    this.logFn = opts.log ?? (line => trace('executor:', line))
    this.home = opts.home ?? (() => null)
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
  plan (requests: readonly ObtainRequest[], inventory: Inventory = ownedInventory(this.bot)): ObtainPlan {
    return obtainAll(this.bot.registry as any, requests, {
      inventory,
      stations: this.stations(),
      memory: this.memory,
      position: this.bot.entity.position,
      dimension: this.bot.game?.dimension,
      exclude: this.options.exclude
    })
  }

  /**
   * Gets the requests into the inventory: plan, run the steps, plan again on every surprise, until the inventory
   * meets them. Throws a TaskError when it can't (NOT_FOUND when no plan exists, the last step's error when a step
   * keeps failing, DIED when the bot died).
   */
  async obtain (requests: readonly ObtainRequest[], signal?: AbortSignal): Promise<ObtainOutcome> {
    const failures = new Map<string, number>()
    let plans = 0
    let steps = 0
    let lastError: unknown = null
    while (true) {
      throwIfOwnerAborted(signal)
      const inv = ownedInventory(this.bot)
      if (requestsMet(inv, requests)) return { plans, steps }
      if (plans >= this.options.maxReplans) {
        throw new TaskError('FAILED', `gave up after ${plans} plans`, { cause: lastError })
      }
      const plan = this.plan(requests, inv)
      plans++
      if (!plan.ok) {
        const what = plan.unresolved.map(r => `${r.count} ${String(r.item)}`).join(', ')
        throw new TaskError('NOT_FOUND', `no plan for ${what}`, { cause: lastError })
      }
      this.log(`plan ${plans}: ${plan.steps.map(describeStep).join(', ')}`)
      if (plan.steps.length === 0) return { plans, steps }
      const needed = neededItems(requests, plan)
      for (let i = 0; i < plan.steps.length; i++) {
        throwIfOwnerAborted(signal)
        const step = plan.steps[i]
        await this.prepare(step, needed, signal)
        // the rest of the plan has to hold for what the bot has now (a reflex ate, a tool broke, the bot died)
        const check = checkPlan(this.bot.registry as any, plan.steps.slice(i), ownedInventory(this.bot), this.stations())
        if (!check.ok) {
          this.log(`replan: ${check.error != null ? `${describeStep(check.error.step)} ${check.error.reason}` : 'the plan no longer holds'}`)
          break
        }
        const key = `${step.kind}:${step.item}`
        let outcome: StepOutcome
        try {
          outcome = await this.runStep(step, signal)
          steps++
        } catch (err) {
          if (isAbort(err) && signal?.aborted === true) throw err
          if (TaskError.is(err, 'DIED', 'ABORTED')) throw err
          lastError = err
          const n = (failures.get(key) ?? 0) + 1
          failures.set(key, n)
          this.log(`step failed (${n}): ${describeStep(step)}: ${(err as Error).message}`)
          if (step.kind === 'mine') this.forgetFailedBlocks(step)
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
   * A mine step that failed: the remembered blocks of its kinds near the bot are forgotten, so the next plan prices
   * them as blocks yet to be found. One diamond ore remembered under a lake kept the iron milestone planning a diamond
   * sword, and the step failed the same way five times over.
   */
  private forgetFailedBlocks (step: Extract<PlanStep, { kind: 'mine' }>): void {
    const dimension = normalizeDimension(this.bot.game?.dimension)
    const known = this.memory.findBlocks(step.blocks, { dimension, near: this.bot.entity.position, maxDistance: FORGET_RADIUS, count: 256 })
    for (const b of known) this.memory.forgetBlock(b, dimension)
    if (known.length > 0) this.log(`forgot ${known.length} remembered ${step.blocks.join(', ')} after the step failed`)
  }

  /**
   * Runs `fn` as a foreground task (so the reflexes preempt it; it runs again from the start after, so it should be
   * safe to repeat), cancelled when `signal` fires. Never call it from inside a task: the queue runs one at a time.
   */
  async task<T> (name: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfOwnerAborted(signal)
    const handle = this.tasks.enqueue<T>({ name, onPreempt: 'resume' }, async (ctx) => await fn(ctx.signal))
    const onAbort = (): void => handle.cancel(`${name} was stopped`)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await handle.result
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
    }, signal)
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
      const toss = junkToToss(this.bot.inventory.items(), want, { keep: this.options.keep, needed, anything: force })
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
    const { store: toStore } = splitInventory(this.bot.inventory.items(), { keep: this.options.keep, needed })
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
