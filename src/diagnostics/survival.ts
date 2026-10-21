// Survival reports: what the work was when it got stuck (a stall the watchdog saw, a skill that threw), as plain
// JSON: the milestone and its goals, the plan (the steps done and left), the step, the task queue, the bot (inventory,
// equipment, health, food, XP, where, the time of day), what the memory knows (the base, chests, points of interest,
// the blocks the plan needs), the last failures with their codes and partial results, and the last movement reports,
// with a one-line diagnosis from simple rules (diagnoseSurvival) that read only the report.
import type { Bot } from 'mineflayer'
import type { PlanStep } from '../planner/steps'
import type { ItemCount } from '../core/inventory'
import type { StallTrigger } from './watchdog'
import { diagnoseDeath, type DeathFacts } from './death'

type XYZ = [number, number, number]

export type SurvivalReportKind = 'stall' | 'skill_failed' | 'death'

/** what a step is about, for the rules: its kind and item, the blocks a mine step looks for, what a craft or smelt uses */
export interface StepFacts {
  /** the executor's line for it ("mine 3 cobblestone (3 stone)") */
  desc: string
  /** kind:item, the watchdog's key */
  key: string
  kind: string
  item: string
  count: number
  /** a mine step's block, and all the blocks that will do */
  block?: string
  blocks?: string[]
  /** a craft's ingredients, a smelt's inputs */
  needs?: ItemCount[]
  /** a smelt's fuel */
  fuel?: ItemCount[]
  /** a mob a kill step hunts */
  mob?: string
}

export interface StepTrace extends StepFacts {
  /** its place in the plan */
  index: number
  since: number
  /** where the bot was when it started, and the farthest it went from there (sampled every 20 ticks) */
  start: XYZ | null
  distance: number
  /** the step's task state (kept across preemptions: an explore's legs, a start count) */
  state?: unknown
}

export interface ErrorEntry {
  tick: number
  /** the step's line, or the task's (or milestone's) name */
  what: string
  step?: StepFacts
  code?: string
  reason?: string
  message: string
  /** a movement report's diagnosis on the error (navigate's) */
  diagnosis?: string
  /** what it got done before it failed */
  partial?: unknown
  /** the failures of the step in a row */
  n?: number
  /**
   * The bag's free slots when it failed: a stall's last failure is told with the slots it had then, not the report's
   * (a 26.3 stall's NO_SPACE from 3000 ticks before read 'inventory full (13 free slots)', the bag long emptied)
   */
  freeSlots?: number
}

export interface MilestoneTrace {
  id: string
  title: string
  goals: string[]
  since: number
  /** tries that failed since it was first worked on */
  failures: number
}

export interface PlanTrace {
  /** the plan's number in its obtain */
  n: number
  requests: string[]
  steps: string[]
  /** in a report: the steps run and the ones left (from the one running) */
  done?: string[]
  left?: string[]
  /** the step running (or that ran last) */
  index: number
  /** the blocks its mine steps look for */
  blocks: string[]
  since: number
}

/** a report in a line: what the saves keep, and the stall reports list of the movement ones */
export interface ReportSummary {
  kind: string
  tick: number
  time: string
  diagnosis: string
  file: string | null
}

export interface TasksSnapshot {
  current: { name: string, priority: number, attempt: number, ticks: number } | null
  queue: Array<{ name: string, priority: number, attempt: number, preempted: boolean }>
  /** the reflex running (bot.survival.reflexes.current) */
  reflex: string | null
}

export interface MemorySummary {
  base: { pos: XYZ, dimension: string } | null
  chests: Array<{ pos: XYZ, dimension: string, items: Record<string, number> }>
  pois: Array<{ kind: string, pos: XYZ, dimension: string, note?: string }>
  /** the remembered blocks, counted by name */
  blocks: Record<string, number>
  /** the blocks the plan needs: how many are remembered, and the nearest few */
  needed: Record<string, { count: number, nearest: XYZ[] }>
  death: { pos: XYZ, dimension: string, seen: number } | null
}

export interface BotState {
  username: string
  version: string
  dimension: string | null
  pos: XYZ | null
  health: number | null
  food: number | null
  saturation: number | null
  xp: { level: number, points: number } | null
  time: { timeOfDay: number, day: number } | null
  inventory: ItemCount[]
  equipment: { hand: string | null, offhand: string | null, head: string | null, chest: string | null, legs: string | null, feet: string | null }
  freeSlots: number | null
  /** the air left (bot.oxygenLevel, 0 to 20: 15 ticks a point), when under 20 */
  air?: number
}

export interface SurvivalReport {
  version: 1
  kind: SurvivalReportKind
  time: string
  /** play's tick (over the runs of a resumed game), else the task runner's */
  tick: number
  message: string
  diagnosis: string
  /** what the watchdog saw (a stall) */
  trigger?: StallTrigger
  /** the skill that threw (skill_failed) */
  skill?: SkillFacts
  /** how the bot died, and the recovery (death) */
  death?: DeathFacts
  work: {
    milestone: MilestoneTrace | null
    plan: PlanTrace | null
    step: StepTrace | null
    tasks: TasksSnapshot | null
    /** what the work waits for on purpose (the night down the mine) */
    waiting: string | null
    /** the last progress the watchdog saw */
    lastProgress: { tick: number, what: string }
  }
  bot: BotState
  memory: MemorySummary | null
  /** the last failures, oldest first */
  errors: ErrorEntry[]
  /** the last movement reports (stuck, no path, failed moves) */
  movement: ReportSummary[]
  context?: Record<string, unknown>
}

export interface SkillFacts {
  /** the task's name ("step:mine 3 cobblestone (3 stone)", "store cobblestone", "kit") */
  name: string
  step?: StepFacts
  /** the step as planned (its args), or what the caller passed */
  args?: unknown
  code?: string
  reason?: string
  message: string
  /** a movement report's diagnosis on the error (navigate's) */
  diagnosis?: string
  partial?: unknown
  /** the window open when it threw, else the last one closed in the 200 ticks before */
  window: WindowSnapshot | null
  /** the block it dug or looked at */
  target: { pos: XYZ, block: string, source: 'dig' | 'cursor' } | null
  /** a craft step's recipe */
  recipe?: unknown
  /** how many times the same task failed with the same code since this report (counted, not reported again) */
  repeats?: number
}

export interface WindowSnapshot {
  id: number
  type: string
  title: string
  /** the container's slots, not the player inventory's (slot: item x count) */
  slots: Array<{ slot: number, item: string, count: number }>
  openedAt: number
  closedAt: number | null
  /** a furnace's fuel and progress (0..1), as mineflayer's furnace window has them */
  furnace?: { fuel: number | null, progress: number | null, input: string | null, fuelItem: string | null, output: string | null }
}

const ROUND = (n: number): number => Math.round(n * 100) / 100

export function xyzOf (v: { x: number, y: number, z: number } | null | undefined): XYZ | null {
  return v == null ? null : [ROUND(v.x), ROUND(v.y), ROUND(v.z)]
}

/** a value as plain JSON (a partial result with Vec3s and items), cut to `max` characters */
export function plain (value: unknown, max = 4000): unknown {
  if (value === undefined) return undefined
  try {
    const seen = new WeakSet()
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return Number(v)
      if (v != null && typeof v === 'object') {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
        // an item or a block: its name and count, not its NBT and registry
        if (typeof v.name === 'string' && typeof v.type === 'number' && (typeof v.count === 'number' || v.position != null)) {
          return v.position != null ? { name: v.name, pos: xyzOf(v.position) } : { name: v.name, count: v.count }
        }
      }
      return v
    })
    if (json == null) return undefined
    if (json.length > max) return { truncated: json.slice(0, max) }
    return JSON.parse(json)
  } catch {
    return String(value)
  }
}

/** the step's facts for the rules */
export function stepFacts (step: PlanStep, desc: string): StepFacts {
  const facts: StepFacts = { desc, key: `${step.kind}:${step.item}`, kind: step.kind, item: step.item, count: step.count }
  switch (step.kind) {
    case 'mine': facts.block = step.block; facts.blocks = [...step.blocks]; break
    case 'craft': facts.needs = step.ingredients.map(i => ({ name: i.name, count: i.count })); break
    case 'smelt':
      facts.needs = step.inputs.map(i => ({ name: i.name, count: i.count }))
      facts.fuel = step.fuel.map(i => ({ name: i.name, count: i.count }))
      break
    case 'kill': facts.mob = step.mob; break
    default: break
  }
  return facts
}

/** an error as an entry of the history: its code, the skill's reason, the message, the partial result */
export function errorEntry (tick: number, what: string, err: unknown, step?: StepFacts, n?: number): ErrorEntry {
  const e = err as any
  const entry: ErrorEntry = { tick, what, message: String(e?.message ?? e ?? 'unknown') }
  if (step != null) entry.step = step
  if (typeof e?.code === 'string') entry.code = e.code
  if (typeof e?.reason === 'string') entry.reason = e.reason
  // navigate's errors carry their movement report's diagnosis; a wrapped one may be a cause or two down
  for (let c = e, i = 0; c != null && i < 4; c = c.cause, i++) {
    if (typeof c.diagnosis === 'string') { entry.diagnosis = c.diagnosis; break }
  }
  if (e?.partial !== undefined) entry.partial = plain(e.partial, 1000)
  if (n != null) entry.n = n
  return entry
}

const ARMOR_SLOTS = { head: 5, chest: 6, legs: 7, feet: 8 } as const

/** the bot as the reports show it */
export function botState (bot: Bot): BotState {
  const b = bot as any
  const items = new Map<string, number>()
  let free: number | null = null
  try {
    for (const i of bot.inventory.items()) items.set(i.name, (items.get(i.name) ?? 0) + i.count)
    free = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null
  } catch {}
  const slot = (n: number): string | null => {
    const it = bot.inventory?.slots?.[n]
    return it != null ? `${it.name}${it.count > 1 ? ` x${it.count}` : ''}` : null
  }
  const held = bot.heldItem
  return {
    username: bot.username,
    version: bot.version,
    dimension: b.game?.dimension ?? null,
    pos: xyzOf(bot.entity?.position),
    health: bot.health ?? null,
    food: bot.food ?? null,
    saturation: b.foodSaturation ?? null,
    xp: b.experience != null ? { level: b.experience.level ?? 0, points: b.experience.points ?? 0 } : null,
    time: b.time != null ? { timeOfDay: b.time.timeOfDay ?? 0, day: b.time.day ?? Math.floor((b.time.age ?? 0) / 24000) } : null,
    inventory: [...items].map(([name, count]) => ({ name, count })),
    equipment: {
      hand: held != null ? `${held.name}${held.count > 1 ? ` x${held.count}` : ''}` : null,
      offhand: slot(45),
      head: slot(ARMOR_SLOTS.head),
      chest: slot(ARMOR_SLOTS.chest),
      legs: slot(ARMOR_SLOTS.legs),
      feet: slot(ARMOR_SLOTS.feet)
    },
    freeSlots: free,
    ...(typeof b.oxygenLevel === 'number' && b.oxygenLevel < 20 ? { air: b.oxygenLevel } : {})
  }
}

/** what bot.survival.memory knows, with the remembered blocks of `needed` (nearest the bot first) */
export function memorySummary (bot: Bot, needed: readonly string[]): MemorySummary | null {
  const memory = (bot as any).survival?.memory
  if (memory == null || typeof memory.toJSON !== 'function') return null
  const json = memory.toJSON()
  const at = (p: { x: number, y: number, z: number }): XYZ => [p.x, p.y, p.z]
  const blocks: Record<string, number> = {}
  for (const b of json.blocks) blocks[b.name] = (blocks[b.name] ?? 0) + 1
  const out: MemorySummary['needed'] = {}
  const pos = bot.entity?.position
  for (const name of new Set(needed)) {
    const known = json.blocks.filter((b: any) => b.name === name)
    if (pos != null) known.sort((a: any, b: any) => Math.hypot(a.x - pos.x, a.y - pos.y, a.z - pos.z) - Math.hypot(b.x - pos.x, b.y - pos.y, b.z - pos.z))
    out[name] = { count: known.length, nearest: known.slice(0, 3).map(at) }
  }
  return {
    base: json.base != null ? { pos: at(json.base), dimension: json.base.dimension } : null,
    chests: json.chests.slice(0, 30).map((c: any) => ({ pos: at(c), dimension: c.dimension, items: c.items })),
    pois: json.pois.slice(-40).map((p: any) => ({ kind: p.kind, pos: at(p), dimension: p.dimension, ...(p.note != null ? { note: p.note } : {}) })),
    blocks,
    needed: out,
    death: json.death != null ? { pos: at(json.death), dimension: json.death.dimension, seen: json.death.seen } : null
  }
}

// --- the rules ---

const stripCode = (m: string): string => m.replace(/^[A-Z_]+: /, '')
const cut = (m: string, n = 120): string => m.length > n ? `${m.slice(0, n - 3)}...` : m

/** a step as the diagnosis names it: "mine diamond_ore", "smelt iron_ingot" */
export function stepName (s: Pick<StepFacts, 'kind' | 'item' | 'block'>): string {
  return `${s.kind} ${s.kind === 'mine' && s.block != null ? s.block : s.item}`
}

function held (r: SurvivalReport, name: string): number {
  return r.bot.inventory.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

/**
 * Why a step (or a skill) doesn't get done, from its facts, its last error and the report: a mine step's block not
 * known and not found exploring, a craft's or smelt's missing item or fuel, no path (with the movement report's
 * diagnosis), no tool, a full inventory; else the error's code and message.
 */
export function causeOf (r: SurvivalReport, s: StepFacts | null | undefined, e: ErrorEntry | null | undefined): string {
  const code = e?.reason ?? e?.code
  const message = e != null ? stripCode(e.message) : ''
  if (s?.kind === 'mine' && (e == null || code === 'NOT_FOUND')) {
    const names = s.blocks ?? (s.block != null ? [s.block] : [])
    const known = names.reduce((n, b) => n + (r.memory?.needed[b]?.count ?? r.memory?.blocks[b] ?? 0), 0)
    if (known === 0) return `no known ${s.block ?? s.item}, explored ${Math.round(r.work.step?.key === s.key ? r.work.step.distance : 0)} blocks`
  }
  if (s?.kind === 'smelt' && (e == null || code === 'MISSING_ITEMS' || /fuel/i.test(message))) {
    const fuel = s.fuel ?? []
    if ((fuel.length > 0 && fuel.every(f => held(r, f.name) === 0)) || /fuel/i.test(message)) return 'no fuel reachable'
  }
  if ((s?.kind === 'craft' || s?.kind === 'smelt') && (e == null || code === 'MISSING_ITEMS')) {
    const short = (s.needs ?? []).find(n => held(r, n.name) < n.count)
    if (short != null) return `missing ${short.name} (have ${held(r, short.name)}/${short.count})`
  }
  if (s?.kind === 'kill' && code === 'NOT_FOUND') return `no ${s.mob ?? s.item} found`
  if (code === 'NO_PATH' || code === 'STUCK') {
    const movement = e?.diagnosis ?? [...r.movement].reverse().find(m => e == null || m.tick >= e.tick - 200)?.diagnosis
    return `no path${movement != null ? `: ${movement}` : message !== '' ? ` (${cut(message)})` : ''}`
  }
  if (code === 'NO_TOOL') return `no tool: ${cut(message)}`
  if (code === 'NO_SPACE' || code === 'INVENTORY_FULL') return `inventory full (${String(e?.freeSlots ?? r.bot.freeSlots ?? '?')} free slots): ${cut(message)}`
  if (e != null) return `${code ?? 'error'}: ${cut(message)}`
  return 'no error yet'
}

/** the last error of the step with this key */
function lastErrorOf (r: SurvivalReport, key: string): ErrorEntry | null {
  for (let i = r.errors.length - 1; i >= 0; i--) if (r.errors[i].step?.key === key) return r.errors[i]
  return null
}

/**
 * The report's diagnosis, one line: for a stall the rule that fired and why ("smelt iron_ingot failed 5× : no fuel
 * reachable", "milestone nether: re-planned 12× in 8000 ticks", "milestone diamonds: no progress in 6000 ticks; mine
 * diamond_ore: no known diamond_ore, explored 96 blocks"); for a skill that threw, what and why.
 */
export function diagnoseSurvival (r: SurvivalReport): string {
  if (r.kind === 'death' && r.death != null) return diagnoseDeath(r.death)
  const milestone = r.work.milestone?.id ?? 'none'
  if (r.kind === 'stall' && r.trigger != null) {
    const t = r.trigger
    if (t.rule === 'step_repeat') {
      const e = lastErrorOf(r, t.key)
      const s = e?.step ?? (r.work.step?.key === t.key ? r.work.step : null)
      return `${s != null ? stepName(s) : t.key.replace(':', ' ')} failed ${t.count}× : ${causeOf(r, s, e)}`
    }
    if (t.rule === 'replan_loop') {
      const e = r.errors[r.errors.length - 1]
      const last = e != null && e.tick >= t.since ? `; last failure: ${e.step != null ? stepName(e.step) : e.what}: ${causeOf(r, e.step, e)}` : ''
      return `milestone ${milestone}: re-planned ${t.count}× in ${t.tick - t.since} ticks${last}`
    }
    const s = r.work.step
    const e = s != null ? lastErrorOf(r, s.key) : r.errors[r.errors.length - 1] ?? null
    const on = s != null ? `; ${stepName(s)}: ${causeOf(r, s, e != null && e.tick >= s.since ? e : null)}` : e != null ? `; last failure ${t.tick - e.tick} ticks ago: ${e.what}: ${causeOf(r, e.step, e)}` : ''
    return `milestone ${milestone}: no progress in ${t.count} ticks${on}`
  }
  if (r.kind === 'skill_failed' && r.skill != null) {
    const k = r.skill
    const e: ErrorEntry = { tick: r.tick, what: k.name, message: k.message, ...(k.code != null ? { code: k.code } : {}), ...(k.reason != null ? { reason: k.reason } : {}), ...(k.diagnosis != null ? { diagnosis: k.diagnosis } : {}) }
    return `${k.step != null ? stepName(k.step) : k.name} failed: ${causeOf(r, k.step, e)}`
  }
  return `${r.kind}: ${r.message}`
}

export interface SurvivalReportInput {
  kind: SurvivalReportKind
  tick: number
  message: string
  trigger?: StallTrigger
  skill?: SkillFacts
  death?: DeathFacts
  work: SurvivalReport['work']
  errors: ErrorEntry[]
  movement: ReportSummary[]
  /** the block names the memory summary lists the remembered ones of */
  needed: string[]
  context?: Record<string, unknown>
}

/** a survival report of the bot and the work as they are now */
export function buildSurvivalReport (bot: Bot, input: SurvivalReportInput): SurvivalReport {
  let memory: MemorySummary | null = null
  try { memory = memorySummary(bot, input.needed) } catch {}
  const report: SurvivalReport = {
    version: 1,
    kind: input.kind,
    time: new Date().toISOString(),
    tick: input.tick,
    message: input.message,
    diagnosis: '',
    ...(input.trigger != null ? { trigger: input.trigger } : {}),
    ...(input.skill != null ? { skill: input.skill } : {}),
    ...(input.death != null ? { death: input.death } : {}),
    work: input.work,
    bot: botState(bot),
    memory,
    errors: input.errors,
    movement: input.movement,
    ...(input.context != null ? { context: input.context } : {})
  }
  report.diagnosis = diagnoseSurvival(report)
  return report
}
