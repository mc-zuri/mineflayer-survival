// The way down: the cells the bot walked in the overworld since it last stood under the open sky, a point every
// WAY_STEP blocks, so a death down a cave or a mine is gone back to the way the bot went (the death spot's trip: a
// search for a spot 50 blocks under the ground times out, the way walked doesn't). A 26.3 bot slain by a zombie at
// y 20 with a diamond sword and pickaxe and iron armor left them (the death spot underground, skipped), and its game
// stalled at the enchanting with iron tools (ls-26.3, t100061).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension, type Pos } from '../core/memory'
import { openSky } from '../executor/explore'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { navigate } from './navigate'

/** blocks walked between two of the way's points */
export const WAY_STEP = 3
/** the way's points kept at most: a way longer than this is lost (none to go back by) */
export const WAY_KEPT = 400
/** ticks between the looks at where the bot is */
export const WAY_TICKS = 5

interface WayState { points: Pos[], lost: boolean }
const ways = new WeakMap<Bot, WayState>()

/**
 * Adds the bot's spot to the way: under the open sky it starts again there; down, the spot goes on when WAY_STEP or
 * more from the last (WAY_KEPT points at most, past which it's lost)
 */
export function extendWay (state: WayState, feet: Pos, sky: boolean): void {
  const p = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  if (sky) {
    state.points = [p]
    state.lost = false
    return
  }
  const last = state.points[state.points.length - 1]
  if (last != null && Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) < WAY_STEP) return
  if (state.points.length >= WAY_KEPT) { state.lost = true; return }
  state.points.push(p)
}

/** the way down to the bot's spot now: from the last spot under the open sky on, the spot itself last; null when lost or none */
export function wayDown (bot: Bot): Pos[] | null {
  const state = ways.get(bot)
  if (state == null || state.lost || state.points.length === 0 || bot.entity == null) return null
  const feet = bot.entity.position.floored()
  return [...state.points, { x: feet.x, y: feet.y, z: feet.z }]
}

/** Lays the way down as the bot walks the overworld, on the ground and alive. Once per bot. */
export function keepWayDown (bot: Bot): void {
  if (ways.has(bot)) return
  const state: WayState = { points: [], lost: true }
  ways.set(bot, state)
  let ticks = 0
  bot.on('physicsTick', () => {
    if (++ticks % WAY_TICKS !== 0 || bot.entity == null || bot.health <= 0 || !bot.entity.onGround) return
    if (normalizeDimension(bot.game?.dimension) !== 'overworld') { state.points = []; state.lost = true; return }
    const feet = bot.entity.position.floored()
    extendWay(state, feet, openSky((p: Vec3) => bot.blockAt(p) as any, feet))
  })
}

/** the way's length in blocks, from `from` to its first point and along it */
export function wayLength (way: Pos[], from: Pos): number {
  let length = 0
  let at = from
  for (const p of way) { length += Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z); at = p }
  return length
}

/** the farthest a hop along the way goes (its points WAY_STEP apart) */
export const WAY_HOP = 10

/**
 * Along the way's points from the bot, hop by hop: each to the farthest point on within WAY_HOP of the bot (a walk
 * near it, the pathfinder's), the cells walked before; a hop that fails is thrown
 */
export async function followWay (bot: Bot, way: Pos[], signal?: AbortSignal): Promise<void> {
  let i = 0
  while (i < way.length) {
    const pos = bot.entity.position
    let j = i
    for (let k = i; k < way.length && Math.hypot(way[k].x + 0.5 - pos.x, way[k].y - pos.y, way[k].z + 0.5 - pos.z) <= WAY_HOP; k++) j = k
    const p = way[j]
    await navigate(bot, { goal: new goals.GoalNear(p.x, p.y, p.z, 1), maxTicks: 600 }, signal)
    i = j + 1
  }
}
