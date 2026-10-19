// travel: a long trip over ground the bot hasn't loaded, in hops the pathfinder can plan inside the loaded chunks,
// detouring sideways when a hop has no path (a lava lake, a ravine, the sea).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { gridWalk } from './gridWalk'
import { trace, waitTicks, waitUntil } from './util'

/** hops in a row that leave the bot where it was before a trip is given up */
export const TRAVEL_STILL_HOPS = 8

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

const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

/** in water with water under the feet too: the sea or a lake, too deep to wade */
export function inDeepWater (lookup: (pos: Vec3) => { name: string } | null, pos: Vec3): boolean {
  const feet = pos.floored()
  return WATER.has(lookup(feet)?.name ?? '') && WATER.has(lookup(feet.offset(0, -1, 0))?.name ?? '')
}

/**
 * Swims at the surface toward a point: the jump held (a player in water rises with it, LivingEntity.jumpInLiquid),
 * facing the point level, until the bot stands on ground out of the deep water, has swum `range` blocks, or 20 ticks a
 * block and 200 more have gone
 */
export async function swimToward (bot: Bot, point: Vec3, range: number, signal?: AbortSignal): Promise<void> {
  const start = bot.entity.position.clone()
  const maxTicks = Math.ceil(range * 20 + 200)
  try {
    for (let t = 0; t < maxTicks; t++) {
      throwIfAborted(signal)
      const pos = bot.entity.position
      if (Math.hypot(point.x - pos.x, point.z - pos.z) < 1.5) break
      if (Math.hypot(pos.x - start.x, pos.z - start.z) >= range) break
      if (t > 10 && bot.entity.onGround && !inDeepWater(p => bot.blockAt(p) as any, pos)) break
      const yaw = Math.atan2(-(point.x - pos.x), -(point.z - pos.z))
      await bot.look(yaw, 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      await waitUntil(bot, () => false, 1, signal)
    }
  } finally {
    bot.clearControlStates()
  }
}

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
  // hops that left the bot where it was: a trip that makes none is given up, not spun (a grid walk of 0 cells over
  // and over kept a CPU core busy for 10 minutes with no game tick run, 26.3)
  let still = 0
  let lastPos: Vec3 | null = null
  try {
    for (;;) {
      throwIfAborted(signal, result())
      if (lost != null) throw new SkillError('VERIFY_FAILED', `the bot ${String(lost)} on the way to ${target.toString()}`, result())
      const pos = bot.entity.position
      const left = Math.hypot(target.x - pos.x, target.z - pos.z)
      if (left <= range && (args.exactY !== true || Math.abs(target.y - pos.y) <= range)) return result()
      // a tick each round at least (the hops may all return at once)
      if (lastPos != null) await waitTicks(bot, 1, signal)
      if (lastPos != null && bot.entity.position.distanceTo(lastPos) < 1) {
        if (++still >= TRAVEL_STILL_HOPS) throw new SkillError('NO_PATH', `no way on toward ${target.toString()}: ${still} hops left the bot at ${bot.entity.position.floored().toString()}`, result())
      } else still = 0
      lastPos = bot.entity.position.clone()
      if (ticks > maxTicks) throw new SkillError('TIMEOUT', `${Math.round(left)} blocks short after ${ticks} ticks`, result())
      // out at sea (deep water under the feet): swum at the surface toward the hop's point, not left to the
      // pathfinder, whose moves in deep water sank the bot ("bot is too low") until the drowning reflex cut each
      // hop off and the trip started over (1.21.11 seed 2, 8 minutes in one spot of the sea)
      if (inDeepWater(p => bot.blockAt(p) as any, bot.entity.position)) {
        const to = hopPoint(pos, target, hop)
        await swimToward(bot, new Vec3(to.x, pos.y, to.z), hop, signal)
        hops++
        if (args.onHop != null && await args.onHop(bot.entity.position.clone())) return result(true)
        continue
      }
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
            // the last hop to a height (exactY): the grid's walk is level, so the height is the pathfinder's (a kit
            // chest at y 50 under the bot at y 63 had the grid walk 0 cells over and over, the trip never ending)
            moved = !p.last || Math.abs(target.y - bot.entity.position.y) <= range
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
