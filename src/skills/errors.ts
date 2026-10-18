// Coded failures of the gathering skills. A skill checks its result against the game (the inventory, the world) and
// throws a SkillError: a TaskError (core's codes, what the planner reacts to) with the skill's own finer reason, plus
// whatever it got done before it failed (`partial`).
import { TaskError, type TaskErrorCode } from '../core/errors'

export type SkillFailure =
  /** the AbortSignal fired */
  | 'ABORTED'
  /** the pathfinder found no path to the goal */
  | 'NO_PATH'
  /** the bot stopped making progress along its path */
  | 'STUCK'
  /** no block, entity or container of the kind asked for */
  | 'NOT_FOUND'
  /** the block needs a tool the bot doesn't have to drop anything */
  | 'NO_TOOL'
  /** the inventory lacks the items (or fuel) the skill needs */
  | 'MISSING_ITEMS'
  /** no room left: the bot's inventory, or the container */
  | 'NO_SPACE'
  /** the block can't be placed there (taken, no face to place against) */
  | 'CANNOT_PLACE'
  /** the game didn't end up in the state the skill aimed for */
  | 'VERIFY_FAILED'
  /** the game didn't get there within the skill's tick budget */
  | 'TIMEOUT'
  /** sleeping needs night or a thunderstorm */
  | 'NOT_NIGHT'
  /** the server refused (the bed is occupied, monsters are nearby, ...) */
  | 'REFUSED'

/** the TaskError code of each reason */
const TASK_CODES: Record<SkillFailure, TaskErrorCode> = {
  ABORTED: 'ABORTED',
  NO_PATH: 'NO_PATH',
  STUCK: 'NO_PATH',
  NOT_FOUND: 'NOT_FOUND',
  NO_TOOL: 'NO_TOOL',
  MISSING_ITEMS: 'MISSING_ITEMS',
  NO_SPACE: 'INVENTORY_FULL',
  CANNOT_PLACE: 'FAILED',
  VERIFY_FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  NOT_NIGHT: 'FAILED',
  REFUSED: 'FAILED'
}

export class SkillError<P = unknown> extends TaskError<P> {
  /** the skill's own reason, finer than `code` */
  readonly reason: SkillFailure

  constructor (reason: SkillFailure, message: string, partial?: P, options: { cause?: unknown } = {}) {
    super(TASK_CODES[reason], `${reason}: ${message}`, { partial, cause: options.cause })
    this.name = 'SkillError'
    this.reason = reason
  }
}

/** a SkillError, or a TaskError of the code the reason maps to */
export function isSkillError (err: unknown, reason?: SkillFailure): err is SkillError {
  return err instanceof SkillError && (reason == null || err.reason === reason)
}

/** whether the error is an abort (a SkillError, core's TaskError, or the AbortSignal's own reason) */
export function isAbort (err: unknown): boolean {
  return TaskError.is(err, 'ABORTED', 'PREEMPTED') || (err as Error)?.name === 'AbortError'
}

/**
 * The error a skill stops with when its signal fires: the signal's reason when it is a TaskError (the task runner's
 * ABORTED, or PREEMPTED for a reflex), with the skill's partial result; else an ABORTED SkillError.
 */
export function abortError (signal?: AbortSignal, partial?: unknown): TaskError {
  const reason = signal?.reason
  if (reason instanceof TaskError) return partial !== undefined ? reason.withPartial(partial) : reason
  return new SkillError('ABORTED', 'aborted', partial, { cause: reason })
}

export function throwIfAborted (signal?: AbortSignal, partial?: unknown): void {
  if (signal?.aborted === true) throw abortError(signal, partial)
}
