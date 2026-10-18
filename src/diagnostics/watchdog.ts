// The stall watchdog: counters the runner and the executor feed (a milestone reached, an item gained, a step done or
// failed, a plan made) and one check of them every few ticks. It says when the work is stuck: no progress for
// stallTicks, the same step failing maxRepeats times in a row, or maxReplans plans with no progress between them. Each
// rule fires again at twice its count (or ticks), so a long stall makes a few reports, not one a tick.

export interface WatchdogOptions {
  /** ticks with no progress (a milestone, more of an item than held before, a step done) that make a stall (default 6000) */
  stallTicks?: number
  /** the same step failing this many times in a row, over plans and milestone retries (default 5) */
  maxRepeats?: number
  /** plans (and milestone retries) with no progress between them (default 12) */
  maxReplans?: number
}

export type StallRule = 'no_progress' | 'step_repeat' | 'replan_loop'

export interface StallTrigger {
  rule: StallRule
  /** the step's key (kind:item) for step_repeat, the milestone (or 'plan') for replan_loop, '' for no_progress */
  key: string
  /** failures, plans, or ticks without progress */
  count: number
  /** the tick the count started at (the last progress, or the first failure) */
  since: number
  tick: number
}

export const DEFAULT_STALL_TICKS = 6000
export const DEFAULT_MAX_REPEATS = 5
export const DEFAULT_MAX_REPLANS = 12

interface Counter { count: number, since: number, next: number }

export class StallWatchdog {
  readonly options: Required<WatchdogOptions>
  /** the tick of the last progress, and what it was */
  lastProgress = 0
  lastProgressWhat = 'start'
  /** set while the work waits on purpose (the night down the mine): no no_progress stall then */
  waiting: string | null = null
  private noProgressNext: number
  private readonly repeats = new Map<string, Counter>()
  private replans: Counter

  constructor (options: WatchdogOptions = {}) {
    this.options = {
      stallTicks: options.stallTicks ?? DEFAULT_STALL_TICKS,
      maxRepeats: options.maxRepeats ?? DEFAULT_MAX_REPEATS,
      maxReplans: options.maxReplans ?? DEFAULT_MAX_REPLANS
    }
    this.noProgressNext = this.options.stallTicks
    this.replans = { count: 0, since: 0, next: this.options.maxReplans }
  }

  /** the no-progress count starts over from `tick` (play starting); a step's failures in a row are kept */
  reset (tick: number): void {
    this.progress(tick, 'start')
  }

  /** something got done: the no-progress and re-plan counts start over */
  progress (tick: number, what: string): void {
    this.lastProgress = tick
    this.lastProgressWhat = what
    this.noProgressNext = this.options.stallTicks
    this.replans = { count: 0, since: tick, next: this.options.maxReplans }
  }

  /** a step ran to its end: its failures are forgotten, and it is progress when it gained anything */
  stepDone (tick: number, key: string, gained: number): void {
    this.repeats.delete(key)
    if (gained > 0) this.progress(tick, key)
  }

  /** a step failed: a stall when it failed maxRepeats times in a row (then 2x, 4x...) */
  stepFailed (tick: number, key: string): StallTrigger | null {
    let c = this.repeats.get(key)
    if (c == null) this.repeats.set(key, c = { count: 0, since: tick, next: this.options.maxRepeats })
    c.count++
    if (c.count < c.next) return null
    c.next *= 2
    return { rule: 'step_repeat', key, count: c.count, since: c.since, tick }
  }

  /** the failures of a step in a row so far */
  failures (key: string): number {
    return this.repeats.get(key)?.count ?? 0
  }

  /** a plan was made (or a milestone tried again): a stall when maxReplans came with no progress (then 2x, 4x...) */
  replanned (tick: number, key: string): StallTrigger | null {
    const c = this.replans
    c.count++
    if (c.count < c.next) return null
    c.next *= 2
    return { rule: 'replan_loop', key, count: c.count, since: c.since, tick }
  }

  /** the per-tick check: a stall when no progress came for stallTicks (then 2x, 4x...) */
  check (tick: number): StallTrigger | null {
    if (this.waiting != null) {
      // a wait isn't a stall: the count starts when it ends
      this.lastProgress = tick
      return null
    }
    const idle = tick - this.lastProgress
    if (idle < this.noProgressNext) return null
    this.noProgressNext *= 2
    return { rule: 'no_progress', key: '', count: idle, since: this.lastProgress, tick }
  }
}
