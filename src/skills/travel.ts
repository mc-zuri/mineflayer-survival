// travel: a long trip over ground the bot hasn't loaded, in hops the pathfinder can plan inside the loaded chunks,
// detouring sideways when a hop has no path (a lava lake, a ravine, the sea).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { gridWalk } from './gridWalk'
import { trace, waitUntil } from './util'

export interface TravelArgs {
  /** where to go (y is used only for the last hop when `exactY`) */
  target: Vec3
  /** done within this many blocks horizontally (default 3) */
  range?: number
  /** blocks per hop (default 48: well inside a 6-chunk view distance) */
  hop?: number
  /** end at the target's y too (GoalNear), not only its x and z (default false) */
  exactY?: boolean
  /** give up after this many ticks (default 20 ticks a block, and 2400 more) */
  maxTicks?: number
  /** called after each hop, with the bot's position; returning true ends the trip there (something found on the way) */
  onHop?: (pos: Vec3) => boolean | Promise<boolean>
  /** fall back on a grid walk for a hop the pathfinder fails (default true) */
  grid?: boolean
}

export interface TravelResult {
  position: Vec3
  ticks: number
  hops: number
  /** a hop's onHop ended the trip */
  stopped: boolean
}

/** the hop's goal: `hop` blocks along the way (turned by `turn` radians), or the target itself when it's nearer */
export function hopPoint (from: { x: number, z: number }, target: { x: number, z: number }, hop: number, turn = 0): { x: number, z: number, last: boolean } {
  const dx = target.x - from.x
  const dz = target.z - from.z
  const d = Math.hypot(dx, dz)
  if (d <= hop && turn === 0) return { x: target.x, z: target.z, last: true }
  const a = Math.atan2(dz, dx) + turn
  const step = Math.min(hop, d)
  return { x: from.x + Math.cos(a) * step, z: from.z + Math.sin(a) * step, last: false }
}

/** detours tried when a hop has no path: straight on, then turned 30°, 60° and 90° either way, and shorter */
const DETOURS: Array<[number, number]> = [[0, 1], [Math.PI / 6, 1], [-Math.PI / 6, 1], [Math.PI / 3, 0.75], [-Math.PI / 3, 0.75], [Math.PI / 2, 0.5], [-Math.PI / 2, 0.5], [0, 0.4]]

export async function travel (bot: Bot, args: TravelArgs, signal?: AbortSignal): Promise<TravelResult> {
  throwIfAborted(signal)
  const range = args.range ?? 3
  const hop = args.hop ?? 48
  const target = args.target
  const startDistance = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  const maxTicks = args.maxTicks ?? Math.ceil(startDistance * 20 + 2400)
  let ticks = 0
  let hops = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  // a death (or a portal on the way) ends the trip: the world the target was in is gone from under the bot
  let lost: string | null = null
  const onDeath = (): void => { lost = 'died'; void bot.pathfinder?.cancel() }
  const onRespawn = (): void => { lost = lost ?? 'changed dimension'; void bot.pathfinder?.cancel() }
  bot.on('death', onDeath)
  bot.on('respawn', onRespawn)
  // partial paths: the bot sets off along the best part of a route while the rest is searched (a long search over
  // rough ground can run on for minutes without one)
  const pathfinderSettings = { ...(bot.pathfinder as any).pathfinderSettings }
  bot.pathfinder.setOptions({ ...pathfinderSettings, partialPathProducer: true })
  // no drops past maxDropDown on a long trip, not even toward water: a cliff's foot seen from the top is often a pool
  // too shallow to land in, or the edge of one
  const moveSettings = { ...(bot.pathfinder as any).defaultMoveSettings }
  bot.pathfinder.setMoveOptions({ ...moveSettings, infiniteLiquidDropdownDistance: false })
  const result = (stopped = false): TravelResult => ({ position: bot.entity.position.clone(), ticks, hops, stopped })
  try {
    for (;;) {
      throwIfAborted(signal, result())
      if (lost != null) throw new SkillError('VERIFY_FAILED', `the bot ${String(lost)} on the way to ${target.toString()}`, result())
      const pos = bot.entity.position
      const left = Math.hypot(target.x - pos.x, target.z - pos.z)
      if (left <= range && (args.exactY !== true || Math.abs(target.y - pos.y) <= range)) return result()
      if (ticks > maxTicks) throw new SkillError('TIMEOUT', `${Math.round(left)} blocks short after ${ticks} ticks`, result())
      // the chunks ahead come in as the bot moves; wait for the one under the next hop
      let moved = false
      let lastError: unknown = null
      for (const [turn, scale] of DETOURS) {
        if (lost != null) break
        const p = hopPoint(pos, target, hop * scale, turn)
        const loaded = await waitUntil(bot, () => bot.world.getColumnAt?.(new Vec3(p.x, 0, p.z)) != null || (bot.world as any).getColumn?.(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4) != null, 100, signal)
        if (!loaded && !p.last) continue
        const goal = p.last
          ? (args.exactY === true ? new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), range) : new goals.GoalNearXZ(Math.floor(target.x), Math.floor(target.z), range))
          : new goals.GoalNearXZ(Math.floor(p.x), Math.floor(p.z), Math.max(4, Math.round(hop * scale / 6)))
        const before = bot.entity.position.clone()
        // the grid walk first, over walkable ground (it walks block middle to block middle, where the pathfinder's
        // executor catches on corners), then the pathfinder, which also swims, digs and builds
        if (args.grid !== false) {
          const end = p.last ? new Vec3(target.x, bot.entity.position.y, target.z) : new Vec3(p.x, bot.entity.position.y, p.z)
          try {
            await gridWalk(bot, { target: end, range: p.last ? range : Math.max(range, 6), horizontal: args.exactY !== true }, signal)
            if (p.last && args.exactY !== true) return result()
            moved = true
          } catch (err) {
            if (isAbort(err)) throw err
            trace('travel: grid walk', turn.toFixed(2), scale, 'failed:', (err as Error).message)
            if (bot.entity.position.distanceTo(before) > 8) moved = true
          }
        }
        if (!moved) {
          try {
            await navigate(bot, { goal, stuckTicks: 100, unstick: 0, planTicks: 400 }, signal)
            // the last hop's goal held: there (the goal's own measure of near)
            if (p.last) return result()
            moved = true
          } catch (err) {
            if (isAbort(err)) throw err
            lastError = err
            trace('travel: hop', turn.toFixed(2), scale, 'failed:', (err as Error).message)
            // a hop that got some way still counts
            if (bot.entity.position.distanceTo(before) > 8) moved = true
          }
        }
        if (moved) break
      }
      if (lost != null) continue
      if (!moved) throw new SkillError('NO_PATH', `no way on toward ${target.toString()} from ${bot.entity.position.toString()}`, result(), { cause: lastError })
      hops++
      if (args.onHop != null && await args.onHop(bot.entity.position.clone())) return result(true)
    }
  } finally {
    bot.pathfinder.setOptions(pathfinderSettings)
    bot.pathfinder.setMoveOptions(moveSettings)
    bot.off('physicsTick', onTick)
    bot.off('death', onDeath)
    bot.off('respawn', onRespawn)
  }
}
