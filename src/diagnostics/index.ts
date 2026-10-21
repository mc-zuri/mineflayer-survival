// bot.survival.diagnostics: the reports of a bot that got stuck, kept in memory for a client to show (lastReports,
// onReport) and, in Node, written as JSON files to a directory (SURVIVAL_STUCK_DIR, or the options' dir), each with
// one log line: "[survival] <kind> report: <diagnosis> (<file>)".
// - movement (report.ts): navigate's STUCK, no path, a goto given up, the pathfinder's failed moves;
// - survival (survival.ts): a stall the watchdog saw (watchdog.ts: the runner and the executor feed it), and a skill
//   that threw (the executor's tasks).
import type { Bot } from 'mineflayer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildReport, type BuildReportOptions, type ReportKind, type StuckReport } from './report'
import {
  botState, buildSurvivalReport, diagnoseSurvival, errorEntry, plain, stepFacts, xyzOf,
  type BotState, type ErrorEntry, type MilestoneTrace, type PlanTrace, type ReportSummary, type SkillFacts, type StepTrace,
  type SurvivalReport, type SurvivalReportKind, type TasksSnapshot, type WindowSnapshot
} from './survival'
import { StallWatchdog, type StallTrigger, type WatchdogOptions } from './watchdog'
import { DEATH_TICKS, isDeathMessage, type DamageSample, type DeathFacts, type EntityFacts, type HealthSample, type Recovery, type ReflexSample } from './death'
import type { PlanStep } from '../planner/steps'

export * from './report'
export * from './survival'
export * from './watchdog'
export * from './death'

/** any report the diagnostics keep */
export type DiagnosticReport = StuckReport | SurvivalReport

/** the movement reports' kinds */
export const MOVEMENT_KINDS: readonly string[] = ['stuck', 'move_failed', 'no_path', 'goto_failed', 'manual']

export interface DiagnosticsOptions {
  /** where the reports are written (Node only); null for nowhere. Default: SURVIVAL_STUCK_DIR, else nowhere */
  dir?: string | null
  /** reports kept in memory (default 50) */
  keep?: number
  /** keep the pathfinder's movement check on at all times, not only while a path executes (default false) */
  alwaysOn?: boolean
  /** the fewest ticks between two reports of failed moves (default 100): a goto searches again after each */
  moveFailedEvery?: number
  /** the stall watchdog's limits (play's options' watchdog over these) */
  watchdog?: WatchdogOptions
  /** failures kept for the reports (default 20) */
  keepErrors?: number
  /** each report's log line (default console.error); null for none */
  log?: ((line: string) => void) | null
}

/** what the runner and the executor told the diagnostics, as it was told (onTrace: a recorder's) */
export type TraceEvent =
  | { type: 'milestoneStarted', id: string, title: string, goals: string[] }
  | { type: 'milestoneReached', id: string }
  | { type: 'milestoneFailed', id: string, error: unknown }
  | { type: 'planMade', n: number, requests: string[], steps: string[] }
  | { type: 'noPlan', requests: string[], error: unknown }
  | { type: 'stepStarted', desc: string, index: number }
  | { type: 'stepDone', key: string, gained: number }
  | { type: 'stepFailed', desc: string, error: unknown, n: number }

export interface ReportRecord {
  report: DiagnosticReport
  /** the file it was written to, if it was */
  file: string | null
}

function envDir (): string | null {
  const dir = typeof process !== 'undefined' ? process.env?.SURVIVAL_STUCK_DIR : undefined
  return dir != null && dir !== '' ? dir : null
}

/** a skill report isn't made again for the same task and code within this many ticks (counted on the last instead) */
export const SKILL_REPORT_TICKS = 200
/** the last window closed this many ticks before a skill threw is in its report */
export const WINDOW_TICKS = 200

export class Diagnostics {
  /** where the reports go (Node); the runner sets it next to its save when nothing else did */
  dir: string | null
  /** whether the dir was chosen (the options' dir, null for nowhere, or SURVIVAL_STUCK_DIR) */
  readonly dirChosen: boolean
  private readonly keep: number
  private readonly records: ReportRecord[] = []
  private readonly listeners = new Set<(report: DiagnosticReport, file: string | null) => void>()
  private readonly tracers = new Set<(event: TraceEvent) => void>()
  private readonly moveFailedEvery: number
  private lastMoveFailedTick = -Infinity
  private written = 0
  private readonly logLine: ((line: string) => void) | null
  /** the summaries of every report (the last 200), for the save: a resumed run keeps them */
  readonly history: ReportSummary[] = []

  // --- the work, as the runner and the executor tell it ---
  readonly watchdog: StallWatchdog
  milestone: MilestoneTrace | null = null
  plan: PlanTrace | null = null
  step: StepTrace | null = null
  readonly errors: ErrorEntry[] = []
  private readonly keepErrors: number
  private armed = 0
  private ticks = 0
  /** play's tick (over a resumed game's runs), set while it plays */
  clock: (() => number) | null = null
  private highWater = new Map<string, number>()
  private window: { snapshot: WindowSnapshot, live: any } | null = null
  private lastSkill: { key: string, tick: number, record: ReportRecord } | null = null
  // --- for the death reports ---
  private readonly healthLog: HealthSample[] = []
  private readonly damageLog: DamageSample[] = []
  private readonly reflexLog: ReflexSample[] = []
  private readonly deathLines: Array<{ tick: number, message: string }> = []
  /** the bot every 20 ticks, and when the server said it was killed (death_combat_event): what it had */
  private lastState: BotState | null = null
  private killedState: { tick: number, state: BotState } | null = null
  /** the last death's report, until its recovery is done (and its death message, when that comes after) */
  private lastDeath: { record: ReportRecord, tick: number } | null = null

  constructor (private readonly bot: Bot, private readonly opts: DiagnosticsOptions = {}) {
    this.dir = opts.dir !== undefined ? opts.dir : envDir()
    this.dirChosen = opts.dir !== undefined || this.dir != null
    this.keep = opts.keep ?? 50
    this.keepErrors = opts.keepErrors ?? 20
    this.moveFailedEvery = opts.moveFailedEvery ?? 100
    this.logLine = opts.log !== undefined ? opts.log : (line) => console.error(line)
    this.watchdog = new StallWatchdog(opts.watchdog)
    const check = (bot as any).pathfinder?.diagnostics
    if (opts.alwaysOn === true && check != null) check.alwaysOn = true
    // a move the pathfinder gave up on: it searches again round it, so a report now and then, not one each
    bot.on('pathfinderMoveFailed' as any, () => {
      const tick: number = (bot as any).pathfinder?.diagnostics?.tick ?? 0
      if (tick - this.lastMoveFailedTick < this.moveFailedEvery) return
      this.lastMoveFailedTick = tick
      try {
        this.report({ kind: 'move_failed', message: (bot as any).pathfinder?.lastMoveError ?? 'a move failed' })
      } catch {}
    })
    bot.on('physicsTick', () => this.physicsTick())
    // the windows the skills open, for a skill report: the one open, else the last closed (a furnace's state)
    bot.on('windowOpen' as any, (w: any) => { this.window = { snapshot: this.windowSnapshot(w, null), live: w } })
    bot.on('windowClose' as any, (w: any) => {
      if (this.window?.live === w || this.window == null) this.window = { snapshot: this.windowSnapshot(w, this.now()), live: null }
    })
    this.watchDeaths()
  }

  /** the tick reports are stamped with: play's (over a resumed game's runs), else the task runner's */
  now (): number {
    if (this.clock != null) return this.clock()
    return (this.bot as any).survival?.tasks?.tick ?? this.ticks
  }

  /** the reports kept, oldest first (the last `n` of them) */
  lastReports (n = this.keep): DiagnosticReport[] {
    return this.records.slice(-n).map((r) => r.report)
  }

  /** the reports kept, with the files they went to */
  lastRecords (n = this.keep): ReportRecord[] {
    return this.records.slice(-n)
  }

  /** calls `cb` with each report made from now on; returns the call to stop */
  onReport (cb: (report: DiagnosticReport, file: string | null) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** calls `cb` with each thing the runner and the executor tell (milestones, plans, steps); returns the call to stop */
  onTrace (cb: (event: TraceEvent) => void): () => void {
    this.tracers.add(cb)
    return () => { this.tracers.delete(cb) }
  }

  private trace (event: TraceEvent): void {
    for (const cb of this.tracers) {
      try { cb(event) } catch {}
    }
  }

  /** a movement report of the bot as it is now, kept, written and handed to the listeners */
  report (opts: BuildReportOptions): StuckReport {
    const report = buildReport(this.bot, opts)
    this.add(report)
    return report
  }

  /** a movement report on request (a client's /survival dump) */
  dump (message = 'dump'): StuckReport {
    return this.report({ kind: 'manual', message })
  }

  /** the file the report was written to, if it was */
  fileOf (report: DiagnosticReport): string | null {
    return this.records.find((r) => r.report === report)?.file ?? null
  }

  /** keeps a report built elsewhere (navigate builds one when it sees the bot stuck, before the trip unwinds) */
  add (report: DiagnosticReport): ReportRecord {
    const file = this.write(report)
    const record = { report, file }
    this.records.push(record)
    if (this.records.length > this.keep) this.records.splice(0, this.records.length - this.keep)
    this.history.push({ kind: report.kind, tick: this.isMovement(report) ? this.now() : report.tick, time: report.time, diagnosis: report.diagnosis, file })
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)
    this.logLine?.(`[survival] ${report.kind} report: ${report.diagnosis} (${file ?? 'not saved'})`)
    for (const cb of this.listeners) {
      try {
        cb(report, file)
      } catch {}
    }
    return record
  }

  private isMovement (report: DiagnosticReport): report is StuckReport {
    return MOVEMENT_KINDS.includes(report.kind)
  }

  /** the summaries of an earlier run's reports (a resumed game's save), before this run's */
  restoreHistory (earlier: readonly ReportSummary[]): void {
    const known = new Set(this.history.map(h => `${h.time}|${h.kind}|${String(h.file)}`))
    const add = earlier.filter(h => h != null && typeof h.kind === 'string' && !known.has(`${h.time}|${h.kind}|${String(h.file)}`))
    this.history.unshift(...add.map(h => ({ ...h })))
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)
  }

  /** writes the record's report again to its file (a death report with its recovery) */
  rewrite (record: ReportRecord): void {
    if (record.file == null) return
    try {
      fs.writeFileSync(record.file, JSON.stringify(record.report, null, 1))
    } catch {}
    const h = this.history.find(s => s.file === record.file)
    if (h != null) h.diagnosis = record.report.diagnosis
  }

  private write (report: DiagnosticReport): string | null {
    if (this.dir == null || typeof fs.writeFileSync !== 'function') return null
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const stamp = report.time.replace(/[:.]/g, '-')
      const file = path.join(this.dir, `${stamp}-${this.bot.username}-${report.kind}-${++this.written}.json`)
      fs.writeFileSync(file, JSON.stringify(report, null, 1))
      return file
    } catch {
      return null
    }
  }

  // --- deaths ---

  private watchDeaths (): void {
    const bot = this.bot as any
    const recent = <T extends { tick: number }>(list: T[], item: T): void => {
      list.push(item)
      const since = item.tick - DEATH_TICKS
      // (the last one before the window too: the health it started from)
      while (list.length > 1 && list[1].tick < since) list.shift()
      if (list.length > 400) list.splice(0, list.length - 400)
    }
    bot.on('health', () => {
      const last = this.healthLog[this.healthLog.length - 1]
      if (last != null && last.health === bot.health && last.food === bot.food) return
      recent(this.healthLog, { tick: this.now(), health: bot.health, food: bot.food })
    })
    bot.on('reflex', (name: string) => recent(this.reflexLog, { tick: this.now(), name }))
    bot.on('reflexFailed', (name: string, err: unknown) => recent(this.reflexLog, { tick: this.now(), name, failed: String((err as Error)?.message ?? err) }))
    bot.on('messagestr', (message: string) => {
      if (typeof message !== 'string' || !message.startsWith(`${String(bot.username)} `) || !isDeathMessage(message)) return
      recent(this.deathLines, { tick: this.now(), message })
      // a death message after the death: onto its report
      const d = this.lastDeath
      const death = (d?.record.report as SurvivalReport | undefined)?.death
      if (d != null && death != null && death.message == null && this.now() - d.tick <= 100) {
        death.message = message
        this.deathLines.length = 0
        this.rediagnose(d.record)
      }
    })
    // the hits (ClientboundDamageEventPacket: the type, the entity that caused it and the one that hit), and the
    // server's word that the bot was killed (ClientboundPlayerCombatKillPacket, before the inventory drops)
    const client = bot._client
    if (typeof client?.on === 'function') {
      client.on('damage_event', (p: any) => {
        if (p?.entityId !== bot.entity?.id) return
        recent(this.damageLog, { tick: this.now(), type: p.sourceTypeId ?? null, cause: this.entityFacts(bot.entities?.[p.sourceCauseId - 1]), direct: this.entityFacts(bot.entities?.[p.sourceDirectId - 1]), health: null })
      })
      client.on('death_combat_event', (p: any) => {
        if (p?.playerId !== bot.entity?.id) return
        try { this.killedState = { tick: this.now(), state: botState(this.bot) } } catch {}
      })
    } else {
      bot.on('entityHurt', (e: any, source: any) => {
        if (e == null || e !== bot.entity) return
        recent(this.damageLog, { tick: this.now(), type: null, cause: this.entityFacts(source), direct: null, health: bot.health ?? null })
      })
    }
    bot.on('death', () => {
      try { this.death() } catch {}
    })
  }

  private entityFacts (e: any): EntityFacts | null {
    if (e == null) return null
    const me = this.bot.entity?.position
    return { id: e.id, name: e.name ?? e.username ?? 'unknown', type: e.type ?? 'unknown', pos: xyzOf(e.position), distance: me != null && e.position != null ? Math.round(me.distanceTo(e.position) * 10) / 10 : null }
  }

  /** a death report: the message, the last ticks of health, hits and reflexes, where, and what the bot had */
  private death (): SurvivalReport {
    const tick = this.now()
    // died again before the last death's recovery was done (on the way back to the spot)
    const before = (this.lastDeath?.record.report as SurvivalReport | undefined)?.death
    if (this.lastDeath != null && before?.recovery != null && before.recovery.done == null) {
      before.recovery = { ...before.recovery, deathSpot: before.recovery.deathSpot ?? 'failed: died again on the way', done: tick }
      this.rediagnose(this.lastDeath.record)
    }
    const since = tick - DEATH_TICKS
    const now = botState(this.bot)
    // (what it had: the inventory now when the server hasn't emptied it yet)
    const had = now.inventory.length > 0 ? now : (this.killedState != null && tick - this.killedState.tick <= 20 ? this.killedState.state : this.lastState ?? now)
    const damage = this.damageLog.filter(d => d.tick >= since)
    const attackers: Record<string, number> = {}
    for (const d of damage) if (d.cause != null) attackers[d.cause.name] = (attackers[d.cause.name] ?? 0) + 1
    const near: EntityFacts[] = []
    for (const e of Object.values(this.bot.entities ?? {}) as any[]) {
      if (e === this.bot.entity || e?.position == null || ['object', 'orb', 'projectile', 'other'].includes(e.type)) continue
      const f = this.entityFacts(e)
      if (f?.distance != null && f.distance <= 16) near.push(f)
    }
    near.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    const facts: DeathFacts = {
      message: [...this.deathLines].reverse().find(l => l.tick >= tick - 40)?.message ?? null,
      pos: xyzOf(this.bot.entity?.position),
      dimension: (this.bot.game as any)?.dimension ?? null,
      health: this.healthLog.filter((h, i, all) => h.tick >= since || all[i + 1]?.tick >= since),
      damage,
      attackers,
      reflexes: this.reflexLog.filter(r => r.tick >= since),
      near: near.slice(0, 12),
      had,
      dropped: had.inventory,
      recovery: null
    }
    const report = this.survivalReport('death', facts.message ?? 'died', { death: facts })
    const record = this.records.find(r => r.report === report)
    if (record != null) this.lastDeath = { record, tick }
    this.killedState = null
    // (a death message goes on one report)
    this.deathLines.length = 0
    return report
  }

  /** the last death's recovery, as the runner goes (the death spot, the kit, done): its report written again */
  recovery (update: Partial<Omit<Recovery, 'started'>>): void {
    const d = this.lastDeath
    const death = (d?.record.report as SurvivalReport | undefined)?.death
    if (d == null || death == null) return
    death.recovery = { started: this.now(), deathSpot: null, picked: null, kit: null, done: null, ...death.recovery, ...update }
    this.rediagnose(d.record)
    if (update.done != null) {
      // what's held now is the count to beat
      this.resetStock()
      this.progress('recovered')
    }
  }

  private rediagnose (record: ReportRecord): void {
    const report = record.report as SurvivalReport
    report.diagnosis = diagnoseSurvival(report)
    this.rewrite(record)
  }

  // --- the stall watchdog ---

  /**
   * Turns the watchdog on (play, an executor's obtain), counting from now; returns the call that turns it off. Nested
   * calls count: it stays on until the last is undone. The options, when given, replace the limits.
   */
  arm (options?: WatchdogOptions): () => void {
    if (this.armed++ === 0) {
      if (options != null) Object.assign(this.watchdog.options, options)
      this.watchdog.reset(this.now())
      this.highWater = this.stockCounts()
    }
    let done = false
    return () => {
      if (done) return
      done = true
      this.armed = Math.max(0, this.armed - 1)
    }
  }

  get watching (): boolean {
    return this.armed > 0
  }

  /** the work waits on purpose (the night down the mine): no stall for it; null when it goes on */
  wait (what: string | null): void {
    this.watchdog.waiting = what
    if (what == null) this.watchdog.progress(this.now(), 'waited')
  }

  /** something got done (an item gained, a chest stocked: any hook may say so) */
  progress (what: string): void {
    this.watchdog.progress(this.now(), what)
  }

  private physicsTick (): void {
    this.ticks++
    // the cheap part every tick: a counter; the rest every 20
    if (this.ticks % 20 !== 0) return
    // what the bot has, for a death report (the server empties the inventory before the health says it died)
    try { if (this.bot.entity != null && this.bot.health > 0) this.lastState = botState(this.bot) } catch {}
    if (this.armed === 0) return
    try {
      const tick = this.now()
      this.sampleStep()
      if (this.ticks % 100 === 0) this.checkStock()
      const trigger = this.watchdog.check(tick)
      if (trigger != null) this.stall(trigger, 'no progress')
    } catch {}
  }

  /** the step's farthest distance from where it started */
  private sampleStep (): void {
    const s = this.step
    const p = this.bot.entity?.position
    if (s == null || p == null || s.start == null) return
    const d = Math.hypot(p.x - s.start[0], p.y - s.start[1], p.z - s.start[2])
    if (d > s.distance) s.distance = Math.round(d)
  }

  /** what the bot holds and the remembered chests hold, by item */
  private stockCounts (): Map<string, number> {
    const out = new Map<string, number>()
    try {
      for (const it of this.bot.inventory?.items() ?? []) out.set(it.name, (out.get(it.name) ?? 0) + it.count)
      for (const slot of [5, 6, 7, 8, 45]) {
        const it = this.bot.inventory?.slots?.[slot]
        if (it != null) out.set(it.name, (out.get(it.name) ?? 0) + it.count)
      }
      for (const c of (this.bot as any).survival?.memory?.knownChests?.() ?? []) {
        for (const [name, n] of Object.entries(c.items as Record<string, number>)) out.set(`chest:${name}`, (out.get(`chest:${name}`) ?? 0) + n)
      }
    } catch {}
    return out
  }

  /** progress when the bot or its chests hold more of an item than they did before (eating and regaining isn't) */
  private checkStock (): void {
    const now = this.stockCounts()
    let gained: string | null = null
    for (const [name, n] of now) {
      if (n > (this.highWater.get(name) ?? 0)) {
        gained ??= name
        this.highWater.set(name, n)
      }
    }
    if (gained != null) this.progress(`more ${gained}`)
  }

  /** after a death the counts start from what's left (getting the kit back is progress) */
  resetStock (): void {
    this.highWater = this.stockCounts()
  }

  private noteError (entry: ErrorEntry): void {
    if (entry.freeSlots == null) {
      try {
        if (typeof this.bot.inventory?.emptySlotCount === 'function') entry.freeSlots = this.bot.inventory.emptySlotCount()
      } catch {}
    }
    this.errors.push(entry)
    if (this.errors.length > this.keepErrors) this.errors.splice(0, this.errors.length - this.keepErrors)
  }

  // --- what the runner tells ---

  milestoneStarted (id: string, title: string, goals: string[]): void {
    this.trace({ type: 'milestoneStarted', id, title, goals })
    if (this.milestone?.id !== id) this.milestone = { id, title, goals, since: this.now(), failures: 0 }
    else this.milestone.goals = goals
  }

  milestoneReached (id: string): void {
    this.trace({ type: 'milestoneReached', id })
    if (this.milestone?.id === id) this.milestone = null
    this.progress(`milestone ${id}`)
  }

  /** a try at the milestone failed: counted as a re-plan */
  milestoneFailed (id: string, err: unknown): void {
    this.trace({ type: 'milestoneFailed', id, error: err })
    if (this.milestone?.id === id) this.milestone.failures++
    this.noteError(errorEntry(this.now(), `milestone ${id}`, err))
    const trigger = this.watchdog.replanned(this.now(), `milestone ${id}`)
    if (trigger != null) this.stall(trigger, `milestone ${id} failed`)
  }

  // --- what the executor tells ---

  planMade (n: number, requests: string[], steps: Array<{ desc: string, blocks?: readonly string[] }>): void {
    this.trace({ type: 'planMade', n, requests, steps: steps.map(s => s.desc) })
    const blocks = [...new Set(steps.flatMap(s => s.blocks ?? []))]
    this.plan = { n, requests, steps: steps.map(s => s.desc), index: -1, blocks, since: this.now() }
    const trigger = this.watchdog.replanned(this.now(), this.milestone != null ? `milestone ${this.milestone.id}` : 'plan')
    if (trigger != null) this.stall(trigger, `plan ${n}`)
  }

  noPlan (requests: string[], err: unknown): void {
    this.trace({ type: 'noPlan', requests, error: err })
    this.plan = null
    this.noteError(errorEntry(this.now(), `plan for ${requests.join(', ')}`, err))
  }

  stepStarted (step: PlanStep, desc: string, index: number, state?: unknown): void {
    this.trace({ type: 'stepStarted', desc, index })
    const p = this.bot.entity?.position
    this.step = { ...stepFacts(step, desc), index, since: this.now(), start: xyzOf(p), distance: 0, state }
    if (this.plan != null) this.plan.index = index
  }

  stepDone (step: PlanStep, gained: number): void {
    this.trace({ type: 'stepDone', key: `${step.kind}:${step.item}`, gained })
    this.watchdog.stepDone(this.now(), `${step.kind}:${step.item}`, gained)
    if (this.step?.key === `${step.kind}:${step.item}`) this.step = null
  }

  /** a step threw: in the history, and a stall when it failed maxRepeats times in a row */
  stepFailed (step: PlanStep, desc: string, err: unknown, n: number): void {
    this.trace({ type: 'stepFailed', desc, error: err, n })
    const facts = stepFacts(step, desc)
    const entry = errorEntry(this.now(), desc, err, facts, n)
    this.noteError(entry)
    const trigger = this.watchdog.stepFailed(this.now(), facts.key)
    if (trigger != null) this.stall(trigger, `${desc} failed ${trigger.count} times`)
  }

  /** a stall report (the watchdog's trigger) */
  stall (trigger: StallTrigger, message: string): SurvivalReport {
    return this.survivalReport('stall', message, { trigger })
  }

  /** a skill (a foreground task) threw: its report, unless the same task failed the same way just now */
  skillFailed (name: string, err: unknown, info: { step?: PlanStep, desc?: string, args?: unknown } = {}): SurvivalReport | null {
    const e = err as any
    const code: string | undefined = e?.reason ?? e?.code
    const key = `${name}|${String(code)}`
    const tick = this.now()
    if (this.lastSkill?.key === key && tick - this.lastSkill.tick < SKILL_REPORT_TICKS) {
      const skill = (this.lastSkill.record.report as SurvivalReport).skill
      if (skill != null) skill.repeats = (skill.repeats ?? 0) + 1
      this.lastSkill.tick = tick
      return null
    }
    const step = info.step != null ? stepFacts(info.step, info.desc ?? name) : undefined
    const entry = errorEntry(tick, name, err, step)
    const skill: SkillFacts = {
      name,
      ...(step != null ? { step } : {}),
      ...(info.args !== undefined || info.step != null ? { args: plain(info.args ?? info.step, 2000) } : {}),
      ...(typeof e?.code === 'string' ? { code: e.code } : {}),
      ...(typeof e?.reason === 'string' ? { reason: e.reason } : {}),
      message: String(e?.message ?? e),
      ...(entry.diagnosis != null ? { diagnosis: entry.diagnosis } : {}),
      ...(e?.partial !== undefined ? { partial: plain(e.partial, 2000) } : {}),
      window: this.currentWindow(tick),
      target: this.target(),
      ...(info.step?.kind === 'craft' ? { recipe: plain(info.step.recipe, 2000) } : {})
    }
    // (a step's failure goes in the history from stepFailed, with its count)
    if (info.step == null) this.noteError(entry)
    const report = this.survivalReport('skill_failed', skill.message, { skill })
    const record = this.records.find(r => r.report === report)
    if (record != null) this.lastSkill = { key, tick, record }
    return report
  }

  private target (): SkillFacts['target'] {
    const dig = (this.bot as any).targetDigBlock
    if (dig?.position != null) return { pos: xyzOf(dig.position) as any, block: dig.name, source: 'dig' }
    try {
      const b = (this.bot as any).blockAtCursor?.(5)
      if (b != null) return { pos: xyzOf(b.position) as any, block: b.name, source: 'cursor' }
    } catch {}
    return null
  }

  private windowSnapshot (w: any, closedAt: number | null): WindowSnapshot {
    const start: number = typeof w?.inventoryStart === 'number' ? w.inventoryStart : (w?.slots?.length ?? 0)
    const slots: WindowSnapshot['slots'] = []
    for (let i = 0; i < start; i++) {
      const it = w.slots?.[i]
      if (it != null) slots.push({ slot: i, item: it.name, count: it.count })
    }
    const snap: WindowSnapshot = { id: w?.id ?? -1, type: String(w?.type ?? 'unknown'), title: typeof w?.title === 'string' ? w.title : JSON.stringify(w?.title ?? ''), slots, openedAt: this.window != null && this.window.live === w ? this.window.snapshot.openedAt : this.now(), closedAt }
    if ('fuel' in (w ?? {}) || /furnace|smoker/.test(snap.type)) {
      // (mineflayer's furnace window: fuel and progress 0..1 from craft_progress_bar; slots 0 input, 1 fuel, 2 output)
      const name = (i: number): string | null => w.slots?.[i] != null ? `${w.slots[i].name as string} x${w.slots[i].count as number}` : null
      snap.furnace = { fuel: w.fuel ?? null, progress: w.progress ?? null, input: name(0), fuelItem: name(1), output: name(2) }
    }
    return snap
  }

  private currentWindow (tick: number): WindowSnapshot | null {
    const live = (this.bot as any).currentWindow
    if (live != null) return this.windowSnapshot(live, null)
    const last = this.window?.snapshot
    if (last?.closedAt != null && tick - last.closedAt <= WINDOW_TICKS) return last
    return null
  }

  /** the queue of foreground tasks, and the reflex running */
  tasksSnapshot (): TasksSnapshot | null {
    const tasks = (this.bot as any).survival?.tasks
    if (tasks == null) return null
    const snap = typeof tasks.snapshot === 'function' ? tasks.snapshot() : { current: tasks.current, queue: (tasks.pending ?? []).map((name: string) => ({ name, priority: 0, attempt: 0, preempted: false })) }
    return { ...snap, reflex: (this.bot as any).survival?.reflexes?.current?.name ?? null }
  }

  private survivalReport (kind: SurvivalReportKind, message: string, extra: { trigger?: StallTrigger, skill?: SkillFacts, death?: DeathFacts }): SurvivalReport {
    const movement = this.history.filter(h => MOVEMENT_KINDS.includes(h.kind)).slice(-5)
    const needed = [...new Set([...(this.step?.blocks ?? []), ...(this.plan?.blocks ?? [])])]
    const report = buildSurvivalReport(this.bot, {
      kind,
      tick: this.now(),
      message,
      ...extra,
      work: {
        milestone: this.milestone != null ? { ...this.milestone } : null,
        plan: this.plan != null ? { ...this.plan, done: this.plan.steps.slice(0, Math.max(0, this.plan.index)), left: this.plan.steps.slice(Math.max(0, this.plan.index)) } : null,
        step: this.step != null ? { ...this.step, state: plain(this.step.state, 1000) } : null,
        tasks: this.tasksSnapshot(),
        waiting: this.watchdog.waiting,
        lastProgress: { tick: this.watchdog.lastProgress, what: this.watchdog.lastProgressWhat }
      },
      errors: this.errors.slice(),
      movement,
      needed
    })
    this.add(report)
    return report
  }
}

export type { ReportKind }
