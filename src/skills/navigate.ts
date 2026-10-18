// navigate: bot.pathfinder.goto with a goal, checked against where the bot ends up.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, abortError, isSkillError, throwIfAborted } from './errors'
import { eyeHeight, trace, waitUntil } from './util'
import type { ReportKind } from '../diagnostics/report'

type Goal = goals.Goal

export interface NavigateArgs {
  goal: Goal
  /**
   * The bot is stuck when it hasn't moved half a block for this many ticks while the pathfinder runs and the bot
   * isn't digging (default 200, ten seconds of game time).
   */
  stuckTicks?: number
  /**
   * Whether the bot got there, checked once goto returns. By default the goal's isEnd at the bot's block; goals whose
   * onFinish changes the world (GoalMineBlock digs its block) pass their own check.
   */
  reached?: () => boolean
  /**
   * Give up when no path has come (and the bot hasn't moved) for this many ticks (default 600): the search runs over
   * the ticks, and in some terrain it never ends.
   */
  planTicks?: number
  /**
   * The most ticks a trip takes before it's given up (default MAX_TRIP_TICKS): one that keeps moving and searching
   * again (a bot bobbing in the sea after a respawn, searching for the surface) never counts as stuck
   */
  maxTicks?: number
  /** goes again this many times after getting stuck (default 2) */
  unstick?: number
}

export interface NavigateResult {
  position: Vec3
  /** client ticks the trip took */
  ticks: number
}

/** the bot's block, as the pathfinder's Move puts it (floored) */
export function botNode (bot: Bot): { x: number, y: number, z: number } {
  const pos = bot.entity.position
  return { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-6), z: Math.floor(pos.z) }
}

/**
 * Whether the goal holds where the bot stands: at its block, or at a block its feet overlap (the pathfinder ends a
 * move when the bot is near the node, not always over its block)
 */
export function goalReached (bot: Bot, goal: Goal): boolean {
  const node = botNode(bot)
  if (goal.isEnd(node as any)) return true
  const pos = bot.entity.position
  for (const x of new Set([Math.floor(pos.x - 0.3), Math.floor(pos.x + 0.3)])) {
    for (const z of new Set([Math.floor(pos.z - 0.3), Math.floor(pos.z + 0.3)])) {
      if ((x !== node.x || z !== node.z) && goal.isEnd({ x, y: node.y, z } as any)) return true
    }
  }
  return false
}

/**
 * Ticks goto gets to return once navigate called the trip off: a goto that doesn't (the pathfinder held up in its
 * end) is left behind rather than holding the skill, and with it the task, for good
 */
export const CANCEL_TICKS = 100

/** the most ticks a navigate's trip takes (NavigateArgs.maxTicks): 5000 ticks walk about 1000 blocks */
export const MAX_TRIP_TICKS = 5000

/** how many times the stuck ticks a dig of one block may hold the bot still (a stone block by hand takes 150 ticks) */
export const DIG_STUCK_FACTOR = 5

/**
 * goto, checked. A bot pressed into a corner beside its path (the executor steers at the next node, not back onto the
 * line, so a bot off its block's middle catches on the corner of a wall it passes) is stuck: it steps back to the
 * middle of its block and goes again, `unstick` times.
 */
export async function navigate (bot: Bot, args: NavigateArgs, signal?: AbortSignal): Promise<NavigateResult> {
  const tries = 1 + Math.max(0, args.unstick ?? 2)
  let ticks = 0
  for (let i = 1; ; i++) {
    try {
      const res = await navigateOnce(bot, args, signal)
      return { ...res, ticks: ticks + res.ticks }
    } catch (err) {
      if (!isSkillError(err, 'STUCK') || i >= tries) throw err
      ticks += (err.partial as NavigateResult | undefined)?.ticks ?? 0
      const pos = bot.entity.position
      const middle = new Vec3(Math.floor(pos.x) + 0.5, pos.y, Math.floor(pos.z) + 0.5)
      trace('navigate: stuck at', pos.toString(), 'stepping to', middle.toString(), 'and going again')
      await walkTo(bot, middle, { within: 0.1, maxTicks: 20 }, signal)
    }
  }
}

/** what a failed trip's stuck report said, on the error navigate throws */
export interface NavigateDiagnosis {
  diagnosis: string
  /** the report's file (bot.survival.diagnostics' dir), if it was written */
  reportFile: string | null
}

/** a stuck report of the trip (bot.survival.diagnostics), when the plugin's loaded */
function stuckReport (bot: Bot, kind: ReportKind, goal: Goal, message: string, error?: unknown): NavigateDiagnosis | null {
  const diagnostics = (bot as any).survival?.diagnostics
  if (diagnostics == null || bot.entity == null) return null
  try {
    const report = diagnostics.report({ kind, goal, message, error })
    const file: string | null = diagnostics.fileOf(report)
    trace('navigate:', kind, 'diagnosis:', report.diagnosis, file != null ? `(report ${file})` : '')
    return { diagnosis: report.diagnosis, reportFile: file }
  } catch (err) {
    trace('navigate: the stuck report failed:', (err as Error).message)
    return null
  }
}

/** the error with its report's diagnosis on it (err.diagnosis, err.reportFile) and in its message */
function withDiagnosis<E extends Error> (err: E, diag: NavigateDiagnosis | null): E {
  if (diag == null) return err
  Object.assign(err, diag)
  err.message = `${err.message} [diagnosis: ${diag.diagnosis}${diag.reportFile != null ? `; report ${diag.reportFile}` : ''}]`
  return err
}

async function navigateOnce (bot: Bot, args: NavigateArgs, signal?: AbortSignal): Promise<NavigateResult> {
  throwIfAborted(signal)
  const { goal } = args
  const stuckTicks = args.stuckTicks ?? 200
  const reached = args.reached ?? (() => goalReached(bot, goal))

  let ticks = 0
  let still = 0
  let anchor = bot.entity.position.clone()
  let stuck = false
  let aborted = false
  let pathFound = false
  let moved = false
  let planning = false
  const start = bot.entity.position.clone()
  const planTicks = args.planTicks ?? 600
  const maxTicks = args.maxTicks ?? MAX_TRIP_TICKS
  let overTime = false

  let digAt: string | null = null
  // the stuck report, made when the bot is seen stuck (its move, its keys, its dig as they are then)
  let diag: NavigateDiagnosis | null = null
  const onTick = (): void => {
    ticks++
    if (ticks >= maxTicks && !overTime && !stuck && !aborted) {
      overTime = true
      if (!reached()) diag = stuckReport(bot, 'stuck', goal, `no arrival in ${maxTicks} ticks`)
      void bot.pathfinder.cancel()
    }
    if (!moved && bot.entity.position.distanceTo(start) >= 0.5) moved = true
    // (the search runs over many ticks before the first path comes: the bot standing still then isn't stuck)
    if (!pathFound && !moved) {
      if (ticks >= planTicks && !planning && bot.pathfinder.isPathing) {
        planning = true
        void bot.pathfinder.cancel()
      }
      return
    }
    if (!bot.pathfinder.isPathing) return
    // a block being dug holds the bot still for a while: a new block starts the count again, the same one gets
    // DIG_STUCK_FACTOR times the ticks (a dig that never ends, or a dig target left set, is stuck too)
    const dig = (bot as any).targetDigBlock?.position?.toString() ?? null
    if (bot.entity.position.distanceTo(anchor) >= 0.5 || (dig != null && dig !== digAt)) {
      anchor = bot.entity.position.clone()
      still = 0
      digAt = dig
      return
    }
    if (++still >= stuckTicks * (dig != null ? DIG_STUCK_FACTOR : 1) && !stuck) {
      stuck = true
      const move = bot.pathfinder.currentMove
      trace('navigate: stuck in', move?.moveType?.constructor?.name ?? 'no move', move != null ? `${move.entryPos.toString()} -> ${move.exitPos.toString()}` : '',
        'dig', dig ?? 'none', 'collided', (bot.entity as any).isCollidedHorizontally === true)
      diag = stuckReport(bot, 'stuck', goal, `no progress for ${stuckTicks} ticks at ${bot.entity.position.toString()}`)
      void bot.pathfinder.cancel()
    }
  }
  const onPath = (): void => { pathFound = true }
  const onAbort = (): void => {
    aborted = true
    void bot.pathfinder.cancel()
  }
  bot.on('physicsTick', onTick)
  bot.on('pathGenerated', onPath)
  signal?.addEventListener('abort', onAbort, { once: true })

  let error: unknown = null
  // once navigate has called the trip off (stuck, aborted, no path in time), goto gets CANCEL_TICKS to return
  let cancelledFor = 0
  let hung = false
  const onCancelTick = (): void => { if (stuck || aborted || planning || overTime) cancelledFor++ }
  bot.on('physicsTick', onCancelTick)
  const stopWaiting = new AbortController()
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      waitUntil(bot, () => cancelledFor >= CANCEL_TICKS, Number.MAX_SAFE_INTEGER, stopWaiting.signal).then(() => { hung = true }, () => {})
    ])
  } catch (err) {
    error = err
  } finally {
    stopWaiting.abort()
    if (hung) trace('navigate: goto did not return', CANCEL_TICKS, 'ticks after it was called off: left behind')
    bot.off('physicsTick', onTick)
    bot.off('physicsTick', onCancelTick)
    bot.off('pathGenerated', onPath)
    signal?.removeEventListener('abort', onAbort)
  }

  const result: NavigateResult = { position: bot.entity.position.clone(), ticks }
  trace('navigate:', goal.constructor.name, 'ended at', result.position.toString(), 'after', ticks, 'ticks', aborted ? 'aborted' : stuck ? 'stuck' : '', error != null ? `error ${(error as Error).message}` : '')
  if (aborted) throw abortError(signal, result)
  if (stuck) throw withDiagnosis(new SkillError('STUCK', `no progress for ${stuckTicks} ticks at ${result.position.toString()}`, result), diag)
  if (overTime && !reached()) throw withDiagnosis(new SkillError('STUCK', `no arrival in ${maxTicks} ticks, at ${result.position.toString()}`, result), diag)
  if (planning && !reached()) {
    const message = `no path found in ${planTicks} ticks`
    throw withDiagnosis(new SkillError('NO_PATH', message, result), stuckReport(bot, 'no_path', goal, message))
  }
  if (reached()) return result
  if (error != null) {
    const err = new SkillError('NO_PATH', `the pathfinder failed: ${(error as Error).message ?? String(error)}`, result, { cause: error })
    throw withDiagnosis(err, stuckReport(bot, 'goto_failed', goal, err.message, err))
  }
  const message = pathFound ? `the path ended at ${result.position.toString()}, short of the goal` : 'no path to the goal'
  throw withDiagnosis(new SkillError('NO_PATH', message, result), stuckReport(bot, 'no_path', goal, message))
}

/**
 * Walks straight at a point a short way off, the way a player holds forward toward it (jumping when it bumps into a
 * step), for when the pathfinder can't end on it (a goal it sees as taken, a world cache behind the server's).
 * Resolves whether it got within `within` blocks (horizontally) or `until` held.
 */
export async function walkTo (bot: Bot, target: Vec3, opts: { within?: number, maxTicks?: number, until?: () => boolean } = {}, signal?: AbortSignal): Promise<boolean> {
  const within = opts.within ?? 0.3
  const close = (): boolean => {
    const pos = bot.entity.position
    return Math.hypot(target.x - pos.x, target.z - pos.z) < within
  }
  try {
    return await waitUntil(bot, () => {
      if (opts.until?.() === true || close()) return true
      const pos = bot.entity.position
      void bot.look(Math.atan2(-(target.x - pos.x), -(target.z - pos.z)), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', (bot.entity as any).isCollidedHorizontally === true)
      return false
    }, opts.maxTicks ?? 40, signal)
  } finally {
    bot.clearControlStates()
  }
}

/** navigate to within `range` blocks (a box, as GoalNear) of a position */
export async function navigateNear (bot: Bot, pos: Vec3, range: number, signal?: AbortSignal): Promise<NavigateResult> {
  const goal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), range)
  return await navigate(bot, { goal }, signal)
}

/** ticks to walk a block (the pathfinder's COST_HEURISTIC: 20 / the walking speed of 4.317 blocks a second) */
const COST_HEURISTIC = 20 / 4.317

/**
 * A goal to stand where the bot can click a block: its eyes within `reach` of the block's box, and its body out of
 * the block (to place in it, or to keep from standing on a container it opens).
 */
export class GoalReachBlock extends goals.Goal {
  constructor (public readonly pos: Vec3, public readonly reach = 4, public readonly eyeHeight = 1.62, public readonly outside = true) {
    super()
  }

  isEnd (node: { x: number, y: number, z: number }): boolean {
    const { pos } = this
    if (this.outside && node.x === pos.x && node.z === pos.z && (node.y === pos.y || node.y + 1 === pos.y)) return false
    const ex = node.x + 0.5
    const ey = node.y + this.eyeHeight
    const ez = node.z + 0.5
    const dx = Math.max(pos.x - ex, 0, ex - (pos.x + 1))
    const dy = Math.max(pos.y - ey, 0, ey - (pos.y + 1))
    const dz = Math.max(pos.z - ez, 0, ez - (pos.z + 1))
    return dx * dx + dy * dy + dz * dz <= this.reach * this.reach
  }

  heuristic (node: { x: number, y: number, z: number }): number {
    return this.distHeuristic(node) * COST_HEURISTIC
  }

  distHeuristic (node: { x: number, y: number, z: number }): number {
    const dx = this.pos.x + 0.5 - (node.x + 0.5)
    const dy = this.pos.y + 0.5 - (node.y + this.eyeHeight)
    const dz = this.pos.z + 0.5 - (node.z + 0.5)
    return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - this.reach)
  }
}

/** navigate to where the bot can click the block at `pos` (no trip when it already can) */
export async function navigateToReach (bot: Bot, pos: Vec3, signal?: AbortSignal, opts: { reach?: number, outside?: boolean } = {}): Promise<NavigateResult> {
  const goal = new GoalReachBlock(pos.floored(), opts.reach ?? 4, eyeHeight(bot), opts.outside ?? true)
  if (goalReached(bot, goal)) return { position: bot.entity.position.clone(), ticks: 0 }
  return await navigate(bot, { goal }, signal)
}
