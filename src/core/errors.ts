/**
 * Failure codes every task and skill throws with, so the planner can react to the cause
 * (replan, fetch a tool, empty the inventory) instead of parsing messages.
 */
export type TaskErrorCode =
  /** the pathfinder found no way to the goal */
  | 'NO_PATH'
  /** the block needs a tool tier the bot doesn't have */
  | 'NO_TOOL'
  /** no free slot for the result */
  | 'INVENTORY_FULL'
  /** ingredients, fuel or a station are missing */
  | 'MISSING_ITEMS'
  /** the task ran over its tick budget */
  | 'TIMEOUT'
  /** cancelled by its owner */
  | 'ABORTED'
  /** aborted so a higher-priority task (a reflex) can run; the runner re-queues it */
  | 'PREEMPTED'
  /** the bot died while the task ran */
  | 'DIED'
  /**
   * stopped by its owner because the held tool is about to break with no spare of its tier (the executor's wear
   * watch): the tool is replaced and the task run again
   */
  | 'TOOL_WORN'
  /** the block, entity or container wasn't found */
  | 'NOT_FOUND'
  /** anything else */
  | 'FAILED'

export interface TaskErrorOptions<P> {
  /** what the task got done before it failed (items collected, blocks mined, ...) */
  partial?: P
  cause?: unknown
}

export class TaskError<P = unknown> extends Error {
  readonly code: TaskErrorCode
  readonly partial: P | undefined
  readonly cause: unknown

  constructor (code: TaskErrorCode, message?: string, opts: TaskErrorOptions<P> = {}) {
    super(message ?? code)
    this.name = 'TaskError'
    this.code = code
    this.partial = opts.partial
    this.cause = opts.cause
  }

  /** true for a TaskError, optionally with one of the given codes */
  static is (err: unknown, ...codes: TaskErrorCode[]): err is TaskError {
    return err instanceof TaskError && (codes.length === 0 || codes.includes(err.code))
  }

  /** wraps anything thrown into a TaskError; an AbortSignal's reason passes through */
  static from (err: unknown, code: TaskErrorCode = 'FAILED'): TaskError {
    if (err instanceof TaskError) return err
    if (err instanceof Error) return new TaskError(code, err.message, { cause: err })
    return new TaskError(code, String(err), { cause: err })
  }

  /** a copy with the partial result attached (the original is kept as the cause) */
  withPartial<Q> (partial: Q): TaskError<Q> {
    return new TaskError<Q>(this.code, this.message, { partial, cause: this.cause ?? this })
  }
}
