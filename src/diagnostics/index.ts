// bot.survival.diagnostics: stuck reports (report.ts) kept in memory for a client to show (lastReports, onReport) and,
// in Node, written as JSON files to a directory (SURVIVAL_STUCK_DIR, or the options' dir).
import type { Bot } from 'mineflayer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildReport, type BuildReportOptions, type ReportKind, type StuckReport } from './report'

export * from './report'

export interface DiagnosticsOptions {
  /** where the reports are written (Node only); null for nowhere. Default: SURVIVAL_STUCK_DIR, else nowhere */
  dir?: string | null
  /** reports kept in memory (default 20) */
  keep?: number
  /** keep the pathfinder's movement check on at all times, not only while a path executes (default false) */
  alwaysOn?: boolean
  /** the fewest ticks between two reports of failed moves (default 100): a goto searches again after each */
  moveFailedEvery?: number
}

export interface ReportRecord {
  report: StuckReport
  /** the file it was written to, if it was */
  file: string | null
}

function envDir (): string | null {
  const dir = typeof process !== 'undefined' ? process.env?.SURVIVAL_STUCK_DIR : undefined
  return dir != null && dir !== '' ? dir : null
}

export class Diagnostics {
  readonly dir: string | null
  private readonly keep: number
  private readonly records: ReportRecord[] = []
  private readonly listeners = new Set<(report: StuckReport, file: string | null) => void>()
  private readonly moveFailedEvery: number
  private lastMoveFailedTick = -Infinity
  private written = 0

  constructor (private readonly bot: Bot, opts: DiagnosticsOptions = {}) {
    this.dir = opts.dir !== undefined ? opts.dir : envDir()
    this.keep = opts.keep ?? 20
    this.moveFailedEvery = opts.moveFailedEvery ?? 100
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
  }

  /** the reports kept, oldest first (the last `n` of them) */
  lastReports (n = this.keep): StuckReport[] {
    return this.records.slice(-n).map((r) => r.report)
  }

  /** the reports kept, with the files they went to */
  lastRecords (n = this.keep): ReportRecord[] {
    return this.records.slice(-n)
  }

  /** calls `cb` with each report made from now on; returns the call to stop */
  onReport (cb: (report: StuckReport, file: string | null) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** a report of the bot as it is now, kept, written and handed to the listeners */
  report (opts: BuildReportOptions): StuckReport {
    const report = buildReport(this.bot, opts)
    this.add(report)
    return report
  }

  /** a report on request (a client's /survival dump) */
  dump (message = 'dump'): StuckReport {
    return this.report({ kind: 'manual', message })
  }

  /** the file the report was written to, if it was */
  fileOf (report: StuckReport): string | null {
    return this.records.find((r) => r.report === report)?.file ?? null
  }

  /** keeps a report built elsewhere (navigate builds one when it sees the bot stuck, before the trip unwinds) */
  add (report: StuckReport): ReportRecord {
    const file = this.write(report)
    const record = { report, file }
    this.records.push(record)
    if (this.records.length > this.keep) this.records.splice(0, this.records.length - this.keep)
    for (const cb of this.listeners) {
      try {
        cb(report, file)
      } catch {}
    }
    return record
  }

  private write (report: StuckReport): string | null {
    if (this.dir == null || typeof fs.writeFileSync !== 'function') return null
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const stamp = report.time.replace(/[:.]/g, '-')
      const file = path.join(this.dir, `${stamp}-${this.bot.username}-${report.kind}-${++this.written}.json`)
      fs.writeFileSync(file, JSON.stringify(report, null, 1))
      // (a log line for each: the diagnosis, and where the rest is)
      console.error(`[survival] ${report.kind} report: ${report.diagnosis} (${file})`)
      return file
    } catch {
      return null
    }
  }
}

export type { ReportKind }
