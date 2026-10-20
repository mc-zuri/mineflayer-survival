// travel: a long trip over ground the bot hasn't loaded, in hops the pathfinder can plan inside the loaded chunks,
// detouring sideways when a hop has no path (a lava lake, a ravine, the sea).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, isSkillError, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { gridWalk } from './gridWalk'
import { trace, waitTicks, waitUntil } from './util'
import { normalizeDimension } from '../core/memory'
import { trailRoute } from '../nether/trail'
import { MAX_TURN_BACKS, TURN_BACK_MIN_GAIN, landAt, scaffoldShort, turnBackForBlocks } from '../nether/restock'
import { FLY_MIN_DISTANCE, canFly, flyTo } from './elytra'

/** the heuristic's ticks a block of the pathfinder's goals (COST_HEURISTIC: 20 / 4.317, a sprint's) */
const HEURISTIC_PER_BLOCK = 20 / 4.317

/**
 * Near a point on x and z (as GoalNearXZ), with the feet within `band` blocks of a height: a nether hop's goal. On x
 * and z alone, the path ended where it was cheapest, and with the nether's ledges dear that was up in the rock under
 * the roof, 40 blocks over the fortress's decks and no way down to them (26.3)
 */
export class GoalNearXZBand extends goals.Goal {
  constructor (readonly x: number, readonly z: number, readonly distance: number, readonly y: number, readonly band: number) {
    super()
  }

  isEnd (node: { x: number, y: number, z: number }): boolean {
    return Math.abs(node.x - this.x) <= this.distance && Math.abs(node.z - this.z) <= this.distance && Math.abs(node.y - this.y) <= this.band
  }

  private off (node: { x: number, y: number, z: number }): number {
    return Math.hypot(this.x - node.x, this.z - node.z) + Math.max(0, Math.abs(node.y - this.y) - this.band)
  }

  heuristic (node: any): number {
    return this.off(node) * HEURISTIC_PER_BLOCK
  }

  distHeuristic (node: any): number {
    return this.off(node)
  }
}

/** how far over or under the target's height a nether hop may end (GoalNearXZBand) */
export const NETHER_HOP_BAND = 20

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
  /**
   * in the nether, go by the way walked there before when it runs from near the bot to near the target (the nether's
   * trail: trailRoute) (default true)
   */
  trail?: boolean
  /**
   * in the overworld, a trip of FLY_MIN_DISTANCE or more flies with the elytra and rockets when the bot has them
   * (skills/elytra canFly, flyTo), the rest walked (default true)
   */
  fly?: boolean
  /**
   * in the nether, a hop with no path while the bot holds fewer building blocks than the way ahead takes to cross
   * (nether/restock.ts scaffoldShort) turns back to firm ground along the trail, mines netherrack up to the working
   * set and plans again (turnBackForBlocks; MAX_TURN_BACKS a trip) (default true)
   */
  restock?: boolean
  /** the grid walk's cell cost on top (gridWalk's cellCost: a surface trip's, overland) */
  gridCellCost?: (c: Vec3) => number
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

/**
 * The trip by the points of the nether's trail (each to within 6 blocks, a point with no way to it passed over), then
 * on to the target; the hops, ticks and stop of them all
 */
async function travelAlong (bot: Bot, route: Vec3[], args: TravelArgs, signal?: AbortSignal): Promise<TravelResult> {
  trace('travel: along the nether trail,', route.length, 'points to', args.target.toString())
  let ticks = 0
  let hops = 0
  for (const point of route) {
    try {
      const leg = await travel(bot, { ...args, target: point, range: 6, exactY: false, trail: false, maxTicks: undefined }, signal)
      ticks += leg.ticks
      hops += leg.hops
      if (leg.stopped) return { ...leg, ticks, hops }
    } catch (err) {
      if (isAbort(err) || !isSkillError(err, 'NO_PATH')) throw err
      trace('travel: no way to the trail point', point.toString(), (err as Error).message)
    }
  }
  const last = await travel(bot, { ...args, trail: false }, signal)
  return { ...last, ticks: ticks + last.ticks, hops: hops + last.hops }
}

export async function travel (bot: Bot, args: TravelArgs, signal?: AbortSignal): Promise<TravelResult> {
  throwIfAborted(signal)
  const memory = bot.survival?.memory
  if (args.trail !== false && memory != null && normalizeDimension(bot.game?.dimension) === 'the_nether') {
    const route = trailRoute(memory, bot.entity.position, args.target)
    if (route.length > 0) return await travelAlong(bot, route, args, signal)
  }
  const range = args.range ?? 3
  const hop = args.hop ?? 48
  const target = args.target
  let startDistance = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  // by air: the overworld's open sky, the elytra and rockets carried
  if (args.fly !== false && normalizeDimension(bot.game?.dimension) === 'overworld' && startDistance >= FLY_MIN_DISTANCE && canFly(bot)) {
    try {
      const res = await flyTo(bot, target, { signal, range })
      trace('travel: flew', Math.round(res.distance), 'blocks in', res.ticks, 'ticks with', res.rockets, 'rockets')
    } catch (err) {
      if (isAbort(err)) throw err
      trace('travel: the flight failed:', (err as Error).message)
    }
    startDistance = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  }
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
  // the nether's turn-backs for blocks (restock), and whether the last got any
  const tripStart = bot.entity.position.clone()
  let turnBacks = 0
  // (the ticks a turn-back takes aren't the trip's: maxTicks is the walk's)
  let turnBackTicks = 0
  const turnBack = async (): Promise<boolean> => {
    if (args.restock === false || turnBacks >= MAX_TURN_BACKS || normalizeDimension(bot.game?.dimension) !== 'the_nether') return false
    const short = scaffoldShort(bot, target)
    if (!short.short) return false
    turnBacks++
    const t0 = ticks
    trace('travel: no way on with', short.held, 'blocks held, the crossing ahead takes', short.need, '- back to firm ground for netherrack')
    const got = await turnBackForBlocks(bot, async (to) => await travel(bot, { target: to, range: 3, restock: false }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('travel: the way back to firm ground failed:', (err as Error).message)
    }), { fallback: tripStart, signal }).catch(err => {
      if (isAbort(err)) throw err
      trace('travel: no netherrack mined:', (err as Error).message)
      return 0
    })
    turnBackTicks += ticks - t0
    trace('travel: turned back for blocks in', ticks - t0, 'ticks, got', got, 'now', scaffoldShort(bot, target).held)
    if (got < TURN_BACK_MIN_GAIN) turnBacks = MAX_TURN_BACKS
    return got > 0
  }
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
      if (ticks - turnBackTicks > maxTicks) throw new SkillError('TIMEOUT', `${Math.round(left)} blocks short after ${ticks} ticks`, result())
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
      let restocked = false
      for (const [turn, scale] of DETOURS) {
        if (lost != null) break
        const p = hopPoint(pos, target, hop * scale, turn)
        const loaded = await waitUntil(bot, () => bot.world.getColumnAt?.(new Vec3(p.x, 0, p.z)) != null || (bot.world as any).getColumn?.(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4) != null, 100, signal)
        if (!loaded && !p.last) continue
        // in the nether, the hops end within NETHER_HOP_BAND of the target's height
        const nether = normalizeDimension(bot.game?.dimension) === 'the_nether'
        const near = (x: number, z: number, d: number): goals.Goal => nether
          ? new GoalNearXZBand(Math.floor(x), Math.floor(z), d, Math.floor(target.y), NETHER_HOP_BAND)
          : new goals.GoalNearXZ(Math.floor(x), Math.floor(z), d)
        const goal = p.last
          ? (args.exactY === true ? new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), range) : near(target.x, target.z, range))
          : near(p.x, p.z, Math.max(4, Math.round(hop * scale / 6)))
        const before = bot.entity.position.clone()
        // the grid walk first, over walkable ground (it walks block middle to block middle, where the pathfinder's
        // executor catches on corners), then the pathfinder, which also swims, digs and builds
        if (args.grid !== false) {
          const end = p.last ? new Vec3(target.x, bot.entity.position.y, target.z) : new Vec3(p.x, bot.entity.position.y, p.z)
          try {
            await gridWalk(bot, { target: end, range: p.last ? range : Math.max(range, 6), horizontal: args.exactY !== true, cellCost: args.gridCellCost }, signal)
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
            // in the nether, short of the blocks to cross off firm ground (a bridge, a ledge): back for netherrack at
            // once, not the detours first (a bridge's end with 4 blocks tried them all, again and again, 35000 ticks,
            // full-26.3-fresh-t); on firm ground the detours first, a way round with the blocks held
            if (!moved && lost == null && !landAt(p => bot.blockAt(p) as any, bot.entity.position) && await turnBack()) { restocked = true; break }
          }
        }
        if (moved) break
      }
      if (lost != null) continue
      // no detour either, short of the blocks to cross: back for them
      if (!moved && !restocked && await turnBack()) restocked = true
      // the blocks got: planned again from where the bot is
      if (restocked) { lastPos = null; still = 0; continue }
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
