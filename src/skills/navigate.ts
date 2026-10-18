// navigate: bot.pathfinder.goto with a goal, checked against where the bot ends up.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, abortError, throwIfAborted } from './errors'
import { eyeHeight, trace, waitUntil } from './util'

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

export async function navigate (bot: Bot, args: NavigateArgs, signal?: AbortSignal): Promise<NavigateResult> {
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

  const onTick = (): void => {
    ticks++
    if (!bot.pathfinder.isPathing) return
    const digging = (bot as any).targetDigBlock != null
    if (digging || bot.entity.position.distanceTo(anchor) >= 0.5) {
      anchor = bot.entity.position.clone()
      still = 0
      return
    }
    if (++still >= stuckTicks && !stuck) {
      stuck = true
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
  try {
    await bot.pathfinder.goto(goal)
  } catch (err) {
    error = err
  } finally {
    bot.off('physicsTick', onTick)
    bot.off('pathGenerated', onPath)
    signal?.removeEventListener('abort', onAbort)
  }

  const result: NavigateResult = { position: bot.entity.position.clone(), ticks }
  trace('navigate:', goal.constructor.name, 'ended at', result.position.toString(), 'after', ticks, 'ticks', aborted ? 'aborted' : stuck ? 'stuck' : '', error != null ? `error ${(error as Error).message}` : '')
  if (aborted) throw abortError(signal, result)
  if (stuck) throw new SkillError('STUCK', `no progress for ${stuckTicks} ticks at ${result.position.toString()}`, result)
  if (reached()) return result
  if (error != null) throw new SkillError('NO_PATH', `the pathfinder failed: ${(error as Error).message ?? String(error)}`, result, { cause: error })
  throw new SkillError('NO_PATH', pathFound ? `the path ended at ${result.position.toString()}, short of the goal` : 'no path to the goal', result)
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
