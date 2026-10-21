// Silverfish are fled, not fought or walled in among: each infested block about hides one, a hurt silverfish calls
// out those in the infested blocks round it (Silverfish's WakeUpFriendsGoal: within 10 across and 5 up and down of
// it), and one in the rock breaks out of an infested block again and again (SilverfishMergeWithStoneGoal). A 26.3 bot
// mining iron at y 29 walled in among a nest, fought twice and was slain by 9 silverfish in an iron helmet with an
// iron sword (f5-26.3). The bot goes more than NEST_KEEP_OFF from the infested blocks and the silverfish (they are
// slow: 0.25 a tick at most, a sprint 0.28), by the pathfinder, else by a run from them.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { findBlocks } from '../core/findBlocks'
import { isInfested } from '../core/infested'
import { isAlive, type Entity } from './combatUtil'
import { isAbort, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { fleeFrom } from './escape'
import { trace } from './util'

/** blocks off the nest (its infested blocks and its silverfish) the bot goes: more than 8 */
export const NEST_KEEP_OFF = 9

/** legs of a flight from the nest at most */
const NEST_LEGS = 3

/** the infested blocks within `radius` of `point` */
export function infestedNear (bot: Bot, radius: number, point: Vec3 = bot.entity.position): Vec3[] {
  const ids = Object.values(bot.registry.blocksByName as Record<string, { id: number, name: string }>).filter(b => isInfested(b.name)).map(b => b.id)
  if (ids.length === 0) return []
  try {
    return findBlocks(bot, { matching: ids, maxDistance: radius, count: 64, point })
  } catch {
    return []
  }
}

/** the live silverfish within `radius` */
export function silverfishNear (bot: Bot, radius: number): Entity[] {
  return Object.values(bot.entities).filter(e => e !== bot.entity && e.name === 'silverfish' && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= radius)
}

/** the nest's middle and how far its furthest part is from it: the infested blocks and silverfish within NEST_KEEP_OFF */
export function nestAbout (bot: Bot): { center: Vec3, spread: number } | null {
  const parts = [
    ...infestedNear(bot, NEST_KEEP_OFF).map(p => p.offset(0.5, 0.5, 0.5)),
    ...silverfishNear(bot, NEST_KEEP_OFF).map(e => e.position)
  ]
  if (parts.length === 0) return null
  const center = parts.reduce((s, p) => s.plus(p), new Vec3(0, 0, 0)).scaled(1 / parts.length)
  const spread = Math.max(...parts.map(p => p.distanceTo(center)))
  return { center, spread }
}

/**
 * Away from the silverfish nest: until no infested block nor silverfish is within NEST_KEEP_OFF, the pathfinder's way
 * out of a sphere round the nest's middle (GoalInvert of a GoalNear), else a run from the silverfish (fleeFrom).
 * Throws the run's error when the bot is cornered.
 */
export async function fleeNest (bot: Bot, opts: { signal?: AbortSignal, maxTicks?: number } = {}): Promise<void> {
  for (let leg = 0; leg < NEST_LEGS; leg++) {
    throwIfAborted(opts.signal)
    const nest = nestAbout(bot)
    if (nest == null) return
    const c = nest.center.floored()
    trace('silverfish: away from the nest at', c.toString(), 'spread', nest.spread.toFixed(1))
    try {
      await navigate(bot, { goal: new goals.GoalInvert(new goals.GoalNear(c.x, c.y, c.z, Math.ceil(NEST_KEEP_OFF + nest.spread))) as any, maxTicks: opts.maxTicks ?? 300, planTicks: 60 }, opts.signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('silverfish: no way off the nest by the pathfinder:', (err as Error).message)
      await fleeFrom(bot, () => silverfishNear(bot, 16), { signal: opts.signal, distance: NEST_KEEP_OFF, maxTicks: opts.maxTicks ?? 300 })
    }
  }
}
