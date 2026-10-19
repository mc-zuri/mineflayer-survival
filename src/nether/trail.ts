// The nether's trail: where the bot has walked there and lived, a point every TRAIL_STEP blocks ('nether_trail' points in
// memory, numbered in the order walked), and the way along it from near one place to near another. A trip that has been
// walked once (the arrival portal to the fortress, the fortress back to the portal) is walked again the same way, not
// on a straight line the bot hasn't tried: a 26.3 bot's way back to its fortress after a death cut across the lava sea
// the first walk had gone round, and five deaths there followed.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension, type Pos, type WorldMemory } from '../core/memory'

export const NETHER_TRAIL = 'nether_trail'
/** blocks walked between two of the trail's points */
export const TRAIL_STEP = 12
/** the trail's points kept (the oldest dropped first) */
export const TRAIL_KEPT = 400
/** a trail point within this many blocks of a death there is dropped (the walk there wasn't safe) */
export const TRAIL_DEATH_RADIUS = 10
/** how near the trail a trip's start and end must be for it to go along it */
export const TRAIL_NEAR = 24
/** the farthest a trail's points are skipped to along it (a loop the walk made, cut short) */
export const TRAIL_SKIP = 16
/** a way along the trail is taken when it is at most this many times the straight way (and 48 blocks) */
export const TRAIL_DETOUR = 2.5

interface TrailPoint extends Pos { n: number }

/** the trail's points in the order walked */
export function trailPoints (memory: WorldMemory): TrailPoint[] {
  return memory.getPois(NETHER_TRAIL, { dimension: 'the_nether' })
    .map(p => ({ x: p.x, y: p.y, z: p.z, n: Number(/^n=(\d+)/.exec(p.note ?? '')?.[1] ?? 0) }))
    .sort((a, b) => a.n - b.n)
}

/** adds the bot's spot to the trail when it is TRAIL_STEP or more from the last point (true when it did) */
export function extendTrail (memory: WorldMemory, pos: Pos): boolean {
  const points = trailPoints(memory)
  const last = points[points.length - 1]
  if (last != null && Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z) < TRAIL_STEP) return false
  const n = (last?.n ?? 0) + 1
  memory.addPoi(NETHER_TRAIL, { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, 'the_nether', `n=${n}`)
  for (const old of points.slice(0, Math.max(0, points.length + 1 - TRAIL_KEPT))) memory.removePoi(NETHER_TRAIL, old, 'the_nether')
  return true
}

/** drops the trail's points near a death (the walk by there wasn't safe after all) */
export function pruneTrail (memory: WorldMemory, death: Pos): void {
  for (const p of trailPoints(memory)) {
    if (Math.hypot(p.x - death.x, p.y - death.y, p.z - death.z) <= TRAIL_DEATH_RADIUS) memory.removePoi(NETHER_TRAIL, p, 'the_nether')
  }
}

/**
 * The way along the trail from near `from` to near `to` (both within TRAIL_NEAR of a point of it), as the points to go
 * by, the last the one nearest `to`, the loops it made cut short (on from each point to the farthest one along within
 * TRAIL_SKIP); [] when the trail doesn't pass near both, or the way along it is over TRAIL_DETOUR times the straight
 * one
 */
export function trailRoute (memory: WorldMemory, from: Pos, to: Pos): Vec3[] {
  const points = trailPoints(memory)
  if (points.length < 2) return []
  const nearest = (p: Pos): number => {
    let best = -1
    let bestD = Infinity
    points.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z); if (d < bestD) { bestD = d; best = i } })
    return bestD <= TRAIL_NEAR ? best : -1
  }
  const i = nearest(from)
  const j = nearest(to)
  if (i < 0 || j < 0 || i === j) return []
  const step = j > i ? 1 : -1
  const route: Vec3[] = []
  let k = i
  while (k !== j) {
    // the farthest point on toward j still within TRAIL_SKIP of this one
    let next = k + step
    for (let m = next; m !== j + step; m += step) {
      const a = points[k]
      const b = points[m]
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= TRAIL_SKIP) next = m
    }
    k = next
    if (k !== j) route.push(new Vec3(points[k].x, points[k].y, points[k].z))
  }
  route.push(new Vec3(points[j].x, points[j].y, points[j].z))
  // no great way round: within TRAIL_DETOUR times the straight way, and 48 blocks
  let length = 0
  let at: Pos = from
  for (const p of [...route, to]) { length += Math.hypot(p.x - at.x, p.z - at.z); at = p }
  if (length > TRAIL_DETOUR * Math.hypot(to.x - from.x, to.z - from.z) + 48) return []
  return route
}

/**
 * Lays the trail as the bot walks the nether: its spot every 10 ticks, on the ground and out of lava and fire, added
 * when TRAIL_STEP from the last; a death there drops the points near it. Once per bot.
 */
export function keepNetherTrail (bot: Bot, memory: WorldMemory): void {
  if ((bot as any)._survivalTrail === true) return
  ;(bot as any)._survivalTrail = true
  let ticks = 0
  bot.on('physicsTick', () => {
    if (++ticks % 10 !== 0 || bot.entity == null) return
    if (normalizeDimension(bot.game?.dimension) !== 'the_nether' || !bot.entity.onGround || bot.health <= 0) return
    const e = bot.entity as any
    if (e.isInLava === true || (e.metadata?.[0] ?? 0) & 1) return
    extendTrail(memory, bot.entity.position)
  })
}
