// The eyes milestone: eyes of ender crafted, thrown and watched (the flight model's direction from the positions the
// client sees), a second throw about 500 blocks to the side, the crossing of the two rays travelled to, throws near
// it until an eye comes down (the stronghold's corner is within 12 blocks), the way dug down to the stronghold's
// stone bricks, and its corridors walked until the portal room's frames are found.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { craft } from '../skills/craft'
import { pickupDrops } from '../skills/pickupDrops'
import { travel } from '../skills/travel'
import { moveNear } from '../skills/gridWalk'
import { tunnelTo } from '../skills/tunnel'
import { countItems, findInventoryItem, settleInventory, trace, waitTicks, waitUntil } from '../skills/util'
import type { Entity } from '../skills/combatUtil'
import { TOO_FAR_DISTANCE, inferThrowDirection, type ThrowDirection, type Vec } from './eye'
import { secondThrowPoint, triangulate, type EyeRay, type Triangulation, type XZ } from './triangulate'
import { guessFromOneThrow } from './stronghold'
import { analyzePortalRoom, findPortalFrames, type PortalRoom } from './portalRoom'
import { inWater, toShore } from '../executor/explore'

// ---- eyes

export interface CraftEyesArgs {
  /** eyes wanted in the inventory (default 12: a portal's frames) */
  count?: number
}

/** eyes of ender (ender_eye) from pearls and blaze powder, the powder from rods (2 a rod), in the inventory grid */
export async function craftEyes (bot: Bot, args: CraftEyesArgs = {}, signal?: AbortSignal): Promise<{ crafted: number, eyes: number }> {
  const wanted = args.count ?? 12
  const have = countItems(bot, 'ender_eye')
  const need = Math.max(0, wanted - have)
  if (need === 0) return { crafted: 0, eyes: have }
  const pearls = countItems(bot, 'ender_pearl')
  const powder = countItems(bot, 'blaze_powder') + 2 * countItems(bot, 'blaze_rod')
  const n = Math.min(need, pearls, powder)
  if (n === 0) throw new SkillError('MISSING_ITEMS', `no eyes to make: ${pearls} pearls, ${powder} blaze powder (with the rods)`)
  if (countItems(bot, 'blaze_powder') < n) {
    await craft(bot, { item: 'blaze_powder', count: n - countItems(bot, 'blaze_powder') }, signal)
  }
  await craft(bot, { item: 'ender_eye', count: n }, signal)
  const eyes = countItems(bot, 'ender_eye')
  if (eyes - have < n) throw new SkillError('VERIFY_FAILED', `${eyes - have} of ${n} eyes crafted`)
  return { crafted: eyes - have, eyes }
}

export interface ThrowEyeResult {
  /** the ray from the throw, for triangulate (null when the eye wasn't seen to fly) */
  ray: EyeRay | null
  direction: ThrowDirection | null
  /** the eye's spawn and the positions seen afterwards */
  spawn: Vec3 | null
  positions: Vec3[]
  /** the eye was picked up again (EyeOfEnder.surviveAfterDeath: 4 in 5) */
  recovered: boolean
  /** an eye that settled short of 12 blocks: the stronghold's locate pos is about there */
  near: XZ | null
  ticks: number
}

/**
 * Throws an eye and watches it: EnderEyeItem.use spawns an EyeOfEnder at the player's middle, flying toward the
 * nearest stronghold (or a point 12 blocks toward it) for 80 ticks, then dropped as an item 4 times in 5. The eye's
 * positions as the client sees them go to inferThrowDirection; the eye is picked up if it drops.
 */
export async function throwEnderEye (bot: Bot, opts: { recover?: boolean } = {}, signal?: AbortSignal): Promise<ThrowEyeResult> {
  throwIfAborted(signal)
  const eye = findInventoryItem(bot, 'ender_eye')
  if (eye == null) throw new SkillError('MISSING_ITEMS', 'no eye of ender to throw')
  const dim = normalizeDimension(bot.game.dimension)
  if (dim !== 'overworld') throw new SkillError('VERIFY_FAILED', `eyes of ender only fly in the overworld, not ${dim}`)
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  let flying: Entity | null = null
  let spawn: Vec3 | null = null
  const positions: Vec3[] = []
  const before = bot.entity.position.clone()
  const onSpawn = (e: Entity): void => {
    if (flying == null && e.name === 'eye_of_ender' && e.position.distanceTo(before) < 4) {
      flying = e
      spawn = e.position.clone()
    }
  }
  bot.on('entitySpawn', onSpawn)
  try {
    await settleInventory(bot, signal)
    await bot.equip(eye, 'hand')
    // up into the air: a look at a block (an end portal frame) would use the eye on it instead (EnderEyeItem.useOn)
    await bot.look(bot.entity.yaw, Math.PI / 4, true)
    bot.activateItem()
    bot.deactivateItem()
    if (!await waitUntil(bot, () => flying != null, 20, signal)) {
      throw new SkillError('VERIFY_FAILED', 'no eye of ender flew (no stronghold in this world?)')
    }
    const e = flying as unknown as Entity
    let last = e.position.clone()
    await waitUntil(bot, () => {
      if (bot.entities[e.id] !== e) return true
      if (!e.position.equals(last)) {
        last = e.position.clone()
        positions.push(last)
      }
      return false
    }, 120, signal)
    const observed = { spawn: spawn != null ? toVec(spawn) : undefined, positions: positions.map(toVec) }
    const direction = inferThrowDirection(observed)
    const ray: EyeRay | null = direction == null ? null : { origin: direction.origin, direction: direction.direction }
    let recovered = false
    if (opts.recover !== false && positions.length > 0) {
      // the item drops where the eye was (EyeOfEnder.tick: spawnAtLocation at its position) and falls
      const at = positions[positions.length - 1]
      await waitTicks(bot, 3, signal)
      const had = countItems(bot, 'ender_eye')
      if (!overWater(p => bot.blockAt(p) as any, at)) {
        try {
          await pickupDrops(bot, { near: at, radius: 16, names: ['ender_eye'] }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
        }
      } else {
        trace('throwEnderEye: the eye came down into a frozen sea: left')
      }
      recovered = countItems(bot, 'ender_eye') > had
    }
    trace('throwEnderEye: from', before.toString(), 'yaw', direction?.yaw.toFixed(2), 'travelled', direction?.travelled.toFixed(1), 'near', direction?.near, 'recovered', recovered)
    return { ray, direction, spawn, positions, recovered, near: direction?.near ?? null, ticks }
  } finally {
    bot.off('physicsTick', onTick)
    bot.off('entitySpawn', onSpawn)
  }
}

/**
 * Whether an eye that dropped at `at` falls into a frozen sea: the first block under it that isn't air is water, and
 * the water's surface there has ice beside it (or over it). An eye in open water floats up to the surface and is
 * swum to; under a frozen sea it floats up under the ice, and the bot that dived after one on 26.3 drowned there.
 */
export function overWater (blockAt: (pos: Vec3) => { name: string } | null, at: Vec3): boolean {
  const start = at.floored()
  for (let dy = 0; dy >= -24; dy--) {
    const pos = start.offset(0, dy, 0)
    const name = blockAt(pos)?.name
    if (name == null) return false
    if (name === 'air' || name === 'cave_air') continue
    if (name !== 'water' && name !== 'bubble_column') return false
    // the surface: up from the first water block to the top of the water
    let top = pos
    for (let i = 0; i < 24 && blockAt(top.offset(0, 1, 0))?.name === 'water'; i++) top = top.offset(0, 1, 0)
    const ice = (p: Vec3): boolean => /ice$/.test(blockAt(p)?.name ?? '')
    return ice(top.offset(0, 1, 0)) || [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dz]) => ice(top.offset(dx, 0, dz)) || ice(top.offset(dx, 1, dz)))
  }
  return false
}

function toVec (p: Vec3): Vec {
  return { x: p.x, y: p.y, z: p.z }
}

// ---- triangulation

export interface LocateStrongholdArgs {
  /** blocks to walk sideways before the second throw (default 500) */
  sideways?: number
  /** blocks per travel hop (default 48) */
  hop?: number
}

export interface LocateStrongholdResult {
  estimate: Triangulation | null
  /** the point to head for: the crossing, or the ring prior's guess along one ray */
  target: XZ
  throws: ThrowEyeResult[]
  ticks: number
}

/**
 * Where the stronghold is: an eye thrown here, then another `sideways` blocks off to the side of its flight, and the
 * crossing of the two rays (triangulate). When they don't cross well, the first ray's stretch through the stronghold
 * rings (guessFromOneThrow) stands in. The estimate goes into memory as stronghold_estimate.
 */
export async function locateStronghold (bot: Bot, args: LocateStrongholdArgs = {}, signal?: AbortSignal): Promise<LocateStrongholdResult> {
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    const throws: ThrowEyeResult[] = []
    const first = await throwReadable(bot, signal)
    throws.push(first)
    if (first.near != null) return done(bot, null, first.near, throws, ticks)
    if (first.ray == null) throw new SkillError('VERIFY_FAILED', 'the first eye flew no way to read')
    const side = secondThrowPoint(first.ray, args.sideways ?? 500)
    trace('locateStronghold: second throw from', side)
    await travel(bot, { target: new Vec3(side.x, bot.entity.position.y, side.z), range: 8, hop: args.hop }, signal)
    const second = await throwReadable(bot, signal)
    throws.push(second)
    if (second.near != null) return done(bot, null, second.near, throws, ticks)
    const rays = throws.map(t => t.ray).filter((r): r is EyeRay => r != null)
    const estimate = triangulate(rays)
    if (estimate != null && estimate.crossingAngle > 2) return done(bot, estimate, estimate, throws, ticks)
    const guess = guessFromOneThrow(rays[rays.length - 1])
    if (guess == null) throw new SkillError('VERIFY_FAILED', 'the eyes\' rays neither cross nor meet a stronghold ring')
    return done(bot, estimate, guess, throws, ticks)
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/**
 * A throw whose flight could be read (the bot settled first; another eye when one wasn't seen to fly), 3 tries. From
 * the shore when the bot is in the water (a point 500 blocks off is often out at sea): swimming, it never settles, and
 * the eyes drop into the sea round it.
 */
async function throwReadable (bot: Bot, signal?: AbortSignal): Promise<ThrowEyeResult> {
  let last: ThrowEyeResult | null = null
  if (inWater(bot)) await toShore(bot, signal)
  for (let i = 0; i < 3; i++) {
    await waitUntil(bot, () => bot.entity.onGround && bot.entity.velocity.norm() < 0.1, 40, signal)
    last = await throwEnderEye(bot, {}, signal)
    if (last.ray != null || last.near != null) return last
    trace('locateStronghold: the eye\'s flight was not read; another')
  }
  return last as ThrowEyeResult
}

function done (bot: Bot, estimate: Triangulation | null, target: XZ, throws: ThrowEyeResult[], ticks: number): LocateStrongholdResult {
  bot.survival?.memory.addPoi('stronghold_estimate', { x: target.x, y: 0, z: target.z }, 'overworld', estimate != null ? `error=${Math.round(estimate.error)}` : 'eye')
  return { estimate, target: { x: target.x, z: target.z }, throws, ticks }
}

export interface ReachStrongholdArgs {
  /** the estimate (default: the remembered stronghold_estimate) */
  target?: XZ
  /** rays thrown so far, crossed with the new ones */
  rays?: EyeRay[]
  /** throws near the estimate before giving up (default 6) */
  maxThrows?: number
  hop?: number
}

export interface ReachStrongholdResult {
  /** where the eye came down: the stronghold's locate pos, within a block or so */
  spot: XZ
  throws: number
  ticks: number
}

/**
 * Goes to the estimate and throws again from there, crossing every ray so far, until a throw lands short of 12 blocks
 * (EyeOfEnder.signalTo aims at the locate pos itself then, and the eye comes down there): that's the spot.
 */
export async function reachStronghold (bot: Bot, args: ReachStrongholdArgs = {}, signal?: AbortSignal): Promise<ReachStrongholdResult> {
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    const remembered = bot.survival?.memory.getPois('stronghold_estimate', { dimension: 'overworld', near: bot.entity.position })[0]
    let target: XZ | null = args.target ?? (remembered != null ? { x: remembered.x, z: remembered.z } : null)
    if (target == null) throw new SkillError('NOT_FOUND', 'no stronghold estimate to go to')
    const rays: EyeRay[] = [...(args.rays ?? [])]
    for (let n = 1; n <= (args.maxThrows ?? 6); n++) {
      throwIfAborted(signal)
      const d = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
      if (d > 6) {
        trace('reachStronghold: to', target, Math.round(d), 'blocks')
        try {
          await travel(bot, { target: new Vec3(target.x, bot.entity.position.y, target.z), range: 4, hop: args.hop }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('reachStronghold: travel stopped:', (err as Error).message)
        }
      }
      if (inWater(bot)) await toShore(bot, signal)
      const t = await throwEnderEye(bot, {}, signal)
      if (t.near != null) {
        bot.survival?.memory.addPoi('stronghold', { x: t.near.x, y: 0, z: t.near.z }, 'overworld', 'eye came down')
        return { spot: t.near, throws: n, ticks }
      }
      if (t.ray == null) continue
      rays.push(t.ray)
      const est = rays.length >= 2 ? triangulate(rays) : null
      // the crossing when it's ahead and well conditioned, else on along this ray (the eye was 12+ blocks short)
      if (est != null && est.crossingAngle > 5 && Math.hypot(est.x - bot.entity.position.x, est.z - bot.entity.position.z) > 2) target = est
      else target = { x: t.ray.origin.x + t.ray.direction.x * Math.max(TOO_FAR_DISTANCE * 2, d / 2), z: t.ray.origin.z + t.ray.direction.z * Math.max(TOO_FAR_DISTANCE * 2, d / 2) }
    }
    throw new SkillError('NOT_FOUND', 'no eye came down near the estimate')
  } finally {
    bot.off('physicsTick', onTick)
  }
}

// ---- in the stronghold

/** blocks only strongholds are built of in the overworld's depths (StrongholdPieces' smooth stone blocks) */
export const STRONGHOLD_BLOCKS = ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks', 'iron_bars', 'end_portal_frame']

export function strongholdBlocksNear (bot: Bot, point: Vec3, maxDistance = 96, count = 2048): Vec3[] {
  const ids = STRONGHOLD_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n != null)
  return bot.findBlocks({ point, matching: ids, maxDistance, count })
}

export interface FindPortalRoomArgs {
  /** where the stronghold is (default: the remembered stronghold, else the bot) */
  near?: XZ
  /** trips through the stronghold before giving up (default 8) */
  maxTrips?: number
}

export interface FindPortalRoomResult {
  room: PortalRoom
  /** stronghold blocks seen on the way */
  bricks: number
  ticks: number
}

/**
 * Down into the stronghold and to its portal room. The client has every block of the chunks it loaded, so the bot
 * looks for end_portal_frame blocks there first; until it sees one it digs down to the nearest stone bricks (stairs
 * down, the pathfinder digging) and walks the corridors toward the bricks it hasn't been near, looking again after
 * each trip. Done when it stands by the frames: the room read with analyzePortalRoom.
 */
export async function findPortalRoom (bot: Bot, args: FindPortalRoomArgs = {}, signal?: AbortSignal): Promise<FindPortalRoomResult> {
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    const remembered = bot.survival?.memory.getPois('stronghold', { dimension: 'overworld', near: bot.entity.position })[0]
    const center = args.near ?? (remembered != null ? { x: remembered.x, z: remembered.z } : { x: bot.entity.position.x, z: bot.entity.position.z })
    const frameId = bot.registry.blocksByName.end_portal_frame.id
    const visited: Vec3[] = []
    let bricks = 0
    for (let trip = 0; trip < (args.maxTrips ?? 8); trip++) {
      throwIfAborted(signal)
      const frames = bot.findBlocks({ matching: frameId, maxDistance: 128, count: 12 })
      if (frames.length > 0) {
        const f = frames.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
        trace('findPortalRoom: frames seen at', f.toString())
        await toward(bot, f, 3, signal)
        if (bot.entity.position.distanceTo(f) > 8) continue
        const room = analyzePortalRoom(findPortalFrames(p => bot.blockAt(new Vec3(p.x, p.y, p.z)) as any, f, 8))
        if (room == null) throw new SkillError('VERIFY_FAILED', `no portal frames to read at ${f.toString()}`)
        bot.survival?.memory.addPoi('end_portal', room.center, 'overworld', `eyes=${room.eyesNeeded}`)
        return { room, bricks, ticks }
      }
      // the stronghold's bricks, nearest the center first; one not yet been near is the next stop
      const here = new Vec3(center.x, Math.min(bot.entity.position.y, 40), center.z)
      const seen = strongholdBlocksNear(bot, here, 96)
      bricks = Math.max(bricks, seen.length)
      if (seen.length === 0) {
        // nothing in the loaded chunks yet: down where the eye came down, to 20 under sea level
        trace('findPortalRoom: no stronghold bricks in view: digging down at', center)
        const minY: number = (bot.game as any).minY ?? 0
        await toward(bot, new Vec3(center.x, Math.max(minY + 8, 20), center.z), 2, signal)
        continue
      }
      const next = seen
        .filter(b => visited.every(v => v.distanceTo(b) > 24))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
      if (next == null) break
      visited.push(next)
      trace('findPortalRoom: to the bricks at', next.toString(), 'of', seen.length)
      await toward(bot, next.offset(0, 1, 0), 2, signal)
    }
    throw new SkillError('NOT_FOUND', `no portal room found (${bricks} stronghold blocks seen)`)
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/**
 * To within `range` of a point: walked (the pathfinder, digging as it sees fit, then the grid walk), else dug to (a
 * staircase down, a tunnel along), stopping as soon as a portal frame is near. A failed trip ends where it got to.
 */
async function toward (bot: Bot, p: Vec3, range: number, signal?: AbortSignal): Promise<void> {
  try {
    await moveNear(bot, p, range, signal)
    return
  } catch (err) {
    if (isAbort(err)) throw err
    trace('findPortalRoom: walk to', p.toString(), 'failed:', (err as Error).message, '- digging')
  }
  const frameId = bot.registry.blocksByName.end_portal_frame.id
  const frameNear = (): boolean => p.distanceTo(bot.entity.position) > 12 && bot.findBlocks({ matching: frameId, maxDistance: 10, count: 1 }).length > 0
  try {
    await tunnelTo(bot, { target: p, range, until: frameNear }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('findPortalRoom: dig to', p.toString(), 'stopped:', (err as Error).message)
  }
}

/** the whole milestone after the eyes are made: locate, reach, and find the portal room */
export async function strongholdToPortalRoom (bot: Bot, args: LocateStrongholdArgs = {}, signal?: AbortSignal): Promise<{ located: LocateStrongholdResult, reached: ReachStrongholdResult, room: FindPortalRoomResult }> {
  const located = await locateStronghold(bot, args, signal)
  const reached = await reachStronghold(bot, { target: located.target, rays: located.throws.map(t => t.ray).filter((r): r is EyeRay => r != null) }, signal)
  const room = await findPortalRoom(bot, { near: reached.spot }, signal)
  return { located, reached, room }
}
