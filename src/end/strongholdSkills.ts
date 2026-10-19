// The eyes milestone: eyes of ender crafted, thrown and watched (the flight model's direction from the positions the
// client sees), a second throw about 500 blocks to the side, the crossing of the two rays travelled to, throws near
// it until an eye comes down (the stronghold's corner is within 12 blocks), the way dug down to the stronghold's
// stone bricks, and its corridors walked until the portal room's frames are found.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension, type Poi, type WorldMemory } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { craft } from '../skills/craft'
import { nearbyDrops, pickupDrops } from '../skills/pickupDrops'
import { travel, type TravelArgs } from '../skills/travel'
import { moveNear } from '../skills/gridWalk'
import { tunnelTo } from '../skills/tunnel'
import { countItems, findInventoryItem, settleInventory, trace, waitTicks, waitUntil } from '../skills/util'
import type { Entity } from '../skills/combatUtil'
import { TOO_FAR_DISTANCE, inferThrowDirection, type ThrowDirection, type Vec } from './eye'
import { secondThrowPoint, triangulate, type EyeRay, type Triangulation, type XZ } from './triangulate'
import { guessFromOneThrow, strongholdRings } from './stronghold'
import { analyzePortalRoom, findPortalFrames, type PortalRoom } from './portalRoom'
import { ensureSurface, inWater, onTheSurface, toShore } from '../executor/explore'
import { findBlocks } from '../core/findBlocks'

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

/** how long after the eye goes its item is looked for, how far from where it was last seen, and the walks after it */
export const EYE_DROP_TICKS = 30
export const EYE_DROP_RADIUS = 16
export const EYE_PICKUP_TRIES = 3

/** waits up to EYE_DROP_TICKS for an eye of ender item near where the thrown eye was last seen; resolves whether one came */
export async function awaitEyeDrop (bot: Bot, at: Vec3, signal?: AbortSignal): Promise<boolean> {
  return await waitUntil(bot, () => nearbyDrops(bot, at, EYE_DROP_RADIUS, ['ender_eye']).length > 0, EYE_DROP_TICKS, signal)
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
    // what the throw told, remembered before the walk after the eye: a reflex that preempts the walk (the drowning
    // reflex out at sea) runs the search again from the start, and the ray it had not kept was thrown for again, over
    // and over, the eyes going one by one (26.3 seed 2)
    const memory = bot.survival?.memory
    if (direction?.near != null) memory?.addPoi(STRONGHOLD_SPOT, { x: direction.near.x, y: 0, z: direction.near.z }, 'overworld', 'eye came down')
    else if (ray != null) rememberRay(memory, ray)
    let recovered = false
    if (opts.recover !== false && positions.length > 0) {
      // the item drops where the eye was (EyeOfEnder.tick: spawnAtLocation at its position) and falls
      const at = positions[positions.length - 1]
      const had = countItems(bot, 'ender_eye')
      if (!overWater(p => bot.blockAt(p) as any, at)) {
        // the item comes a tick or more after the eye goes, its stack in the entity data after that: waited for (the
        // first throw at seed 2's spawn looked 3 ticks after and found none), and gone after again from where the
        // first walk got to when the way there (a hill, a ledge) ran out
        const seen = await awaitEyeDrop(bot, at, signal)
        if (!seen) trace('throwEnderEye: no eye came down (it broke: 1 in 5)')
        for (let i = 0; seen && i < EYE_PICKUP_TRIES && countItems(bot, 'ender_eye') <= had; i++) {
          if (nearbyDrops(bot, at, EYE_DROP_RADIUS, ['ender_eye']).length === 0) break
          try {
            await pickupDrops(bot, { near: at, radius: EYE_DROP_RADIUS, names: ['ender_eye'] }, signal)
          } catch (err) {
            if (isAbort(err)) throw err
          }
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

/**
 * Where the eye came down by the stronghold (reachStronghold), a point of interest of its own: the milestone's
 * 'stronghold' is the portal room, once found
 */
export const STRONGHOLD_SPOT = 'stronghold_spot'
/** an eye's flight as a point of interest: the throw's spot, the direction in the note */
export const EYE_RAY = 'eye_ray'

/** remembers a throw's ray (the search goes on from it after a reflex or a death cut it off) */
export function rememberRay (memory: WorldMemory | undefined, ray: EyeRay): void {
  memory?.addPoi(EYE_RAY, { x: Math.round(ray.origin.x), y: 0, z: Math.round(ray.origin.z) }, 'overworld', `ray=${ray.direction.x.toFixed(5)},${ray.direction.z.toFixed(5)}`)
}

/** the rays remembered, oldest first */
export function rememberedRays (memory: WorldMemory | undefined): EyeRay[] {
  const out: EyeRay[] = []
  for (const p of memory?.getPois(EYE_RAY, { dimension: 'overworld' }) ?? []) {
    const m = /^ray=(-?[\d.]+),(-?[\d.]+)/.exec(p.note ?? '')
    if (m != null) out.push({ origin: { x: p.x, z: p.z }, direction: { x: Number(m[1]), z: Number(m[2]) } })
  }
  return out
}

/** the remembered estimate (stronghold_estimate), replaced */
function rememberEstimate (memory: WorldMemory | undefined, target: XZ, note: string): void {
  memory?.removePoi('stronghold_estimate')
  memory?.addPoi('stronghold_estimate', { x: Math.round(target.x), y: 0, z: Math.round(target.z) }, 'overworld', note)
}

/** blocks off the second throw's line the third throw is made from, when the first two disagree */
export const THIRD_SIDEWAYS = 300

/**
 * The crossing of two rays that agree, the newest pairs first: ahead of both throws, crossing at 2 degrees or more,
 * and in a stronghold ring's band of distances from 0, 0 (strongholdRings). Rays to two strongholds cross behind a
 * throw, or far off the rings, and are no estimate.
 */
export function consistentCrossing (rays: readonly EyeRay[]): Triangulation | null {
  const rings = strongholdRings()
  for (let j = rays.length - 1; j >= 1; j--) {
    for (let i = j - 1; i >= 0; i--) {
      const t = triangulate([rays[i], rays[j]])
      if (t == null || t.crossingAngle <= 2) continue
      const r = Math.hypot(t.x, t.z)
      if (rings.some(ring => r >= ring.minDistance && r <= ring.maxDistance)) return t
    }
  }
  return null
}

export interface LocateStrongholdArgs {
  /** blocks to walk sideways before the second throw (default 500) */
  sideways?: number
  /** blocks off the second throw's line for a third when the two disagree (default THIRD_SIDEWAYS) */
  thirdSideways?: number
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
    const memory = bot.survival?.memory
    // a first throw made before a reflex or a death cut the search off: on from it to the side
    const known = rememberedRays(memory)
    const crossing = consistentCrossing(known)
    if (crossing != null) return done(bot, crossing, crossing, throws, ticks)
    let firstRay: EyeRay | null = known[known.length - 1] ?? null
    if (firstRay == null) {
      const first = await throwReadable(bot, signal)
      throws.push(first)
      if (first.near != null) return done(bot, null, first.near, throws, ticks)
      if (first.ray == null) throw new SkillError('VERIFY_FAILED', 'the first eye flew no way to read')
      firstRay = first.ray
      rememberRay(memory, firstRay)
    } else {
      trace('locateStronghold: on from the throw remembered at', firstRay.origin)
    }
    const side = secondThrowPoint(firstRay, args.sideways ?? 500)
    trace('locateStronghold: second throw from', side)
    await overland(bot, { target: new Vec3(side.x, bot.entity.position.y, side.z), range: 8, hop: args.hop }, signal)
    const second = await throwReadable(bot, signal)
    throws.push(second)
    if (second.near != null) return done(bot, null, second.near, throws, ticks)
    if (second.ray != null) rememberRay(memory, second.ray)
    let estimate = consistentCrossing(rememberedRays(memory))
    if (estimate != null) return done(bot, estimate, estimate, throws, ticks)
    // the rays don't agree (an eye flies to the stronghold nearest the throw, and the step sideways crossed over to
    // another's side: seed 2's first throw went south, the second east): a third throw off the second's line, and the
    // pair that agrees
    let last = second.ray ?? firstRay
    if (second.ray != null) {
      const third = secondThrowPoint(second.ray, args.thirdSideways ?? THIRD_SIDEWAYS)
      trace('locateStronghold: the rays disagree: a third throw from', third)
      await overland(bot, { target: new Vec3(third.x, bot.entity.position.y, third.z), range: 8, hop: args.hop }, signal)
      const t3 = await throwReadable(bot, signal)
      throws.push(t3)
      if (t3.near != null) return done(bot, null, t3.near, throws, ticks)
      if (t3.ray != null) { rememberRay(memory, t3.ray); last = t3.ray }
      estimate = consistentCrossing(rememberedRays(memory))
      if (estimate != null) return done(bot, estimate, estimate, throws, ticks)
    }
    const guess = guessFromOneThrow(last)
    if (guess == null) throw new SkillError('VERIFY_FAILED', 'the eyes\' rays neither cross nor meet a stronghold ring')
    return done(bot, estimate, guess, throws, ticks)
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/**
 * A trip over the surface: up out of a cave or a mine first (a trip set off from the bottom of a night's mine went on
 * through the caves at y 8 at 30 ticks a second, the pathfinder finding no way on hop after hop: 26.3 seed 2), then
 * travel with the surface's step costs (onTheSurface)
 */
export async function overland (bot: Bot, args: TravelArgs, signal?: AbortSignal): Promise<void> {
  await ensureSurface(bot, signal)
  // to a height (exactY): over the surface to above it, then down to it with the pathfinder's own costs (the surface's
  // keep it from digging down: a kit chest 13 blocks under the ground was never reached)
  await onTheSurface(bot, async () => await travel(bot, { ...args, exactY: false, range: Math.max(args.range ?? 3, 3) }, signal))
  if (args.exactY !== true) return
  try {
    await travel(bot, args, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    // no path down to it (65 blocks under the ground over a cave's portal, 26.3): a stair tunnel down
    trace('overland: down by a tunnel:', (err as Error).message)
    await tunnelTo(bot, { target: args.target, range: Math.max(2, args.range ?? 2) }, signal)
  }
}

/**
 * Out to where a thrown eye can be had back: out of the water to the shore, and up to the open sky from a cave or a
 * mine (an eye flies through the rock, EyeOfEnder having no collision, and came down out of reach in the rock over
 * the bot: 8 eyes lost on 26.3 seed 2, thrown from y -22 to -2 by the stronghold)
 */
export async function toThrowingSpot (bot: Bot, signal?: AbortSignal): Promise<void> {
  if (inWater(bot)) await toShore(bot, signal)
  await ensureSurface(bot, signal)
}

/**
 * A throw whose flight could be read (the bot settled first; another eye when one wasn't seen to fly), 3 tries. From
 * the shore when the bot is in the water (a point 500 blocks off is often out at sea): swimming, it never settles, and
 * the eyes drop into the sea round it.
 */
async function throwReadable (bot: Bot, signal?: AbortSignal): Promise<ThrowEyeResult> {
  let last: ThrowEyeResult | null = null
  await toThrowingSpot(bot, signal)
  for (let i = 0; i < 3; i++) {
    await waitUntil(bot, () => bot.entity.onGround && bot.entity.velocity.norm() < 0.1, 40, signal)
    // in the water still (no shore near): an eye coming down is in the sea, and isn't swum after
    last = await throwEnderEye(bot, { recover: !inWater(bot) }, signal)
    if (last.ray != null || last.near != null) return last
    trace('locateStronghold: the eye\'s flight was not read; another')
  }
  return last as ThrowEyeResult
}

function done (bot: Bot, estimate: Triangulation | null, target: XZ, throws: ThrowEyeResult[], ticks: number): LocateStrongholdResult {
  rememberEstimate(bot.survival?.memory, target, estimate != null ? `error=${Math.round(estimate.error)}` : 'eye')
  return { estimate, target: { x: target.x, z: target.z }, throws, ticks }
}

/** the search along the eyes' flight near the stronghold: the last ray and the step taken along it */
export interface AlongRay {
  ray: EyeRay
  step: number
  target: XZ
}

/**
 * The next place to throw from near the stronghold: the rays' crossing when it is well conditioned and ahead, else on
 * along the eye's flight, the step doubling while the eyes fly on the same way (32, 64, 128...) and halving back once
 * one flies back (the stronghold passed): a fixed step of 12 to 24 blocks crept along for 6 throws on 26.3 seed 2 with
 * the stronghold 100 blocks further on, and ran out of eyes
 */
export function nextAlongRay (prev: AlongRay | null, ray: EyeRay, crossing: Triangulation | null): AlongRay {
  const dir = { x: ray.direction.x / Math.hypot(ray.direction.x, ray.direction.z), z: ray.direction.z / Math.hypot(ray.direction.x, ray.direction.z) }
  if (crossing != null && crossing.crossingAngle > 5) {
    const ahead = (crossing.x - ray.origin.x) * dir.x + (crossing.z - ray.origin.z) * dir.z
    if (ahead > 2) return { ray, step: ahead, target: { x: crossing.x, z: crossing.z } }
  }
  let step = 32
  if (prev != null) {
    const pd = Math.hypot(prev.ray.direction.x, prev.ray.direction.z)
    const back = (prev.ray.direction.x * dir.x + prev.ray.direction.z * dir.z) / pd < 0
    step = back ? Math.max(TOO_FAR_DISTANCE, prev.step / 2) : Math.min(256, prev.step * 2)
  }
  return { ray, step, target: { x: ray.origin.x + dir.x * step, z: ray.origin.z + dir.z * step } }
}

export interface ReachStrongholdArgs {
  /** the estimate (default: the remembered stronghold_estimate) */
  target?: XZ
  /** rays thrown so far, crossed with the new ones */
  rays?: EyeRay[]
  /** throws near the estimate before giving up (default 8) */
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
    let along: AlongRay | null = null
    for (let n = 1; n <= (args.maxThrows ?? 8); n++) {
      throwIfAborted(signal)
      const d = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
      if (d > 6) {
        trace('reachStronghold: to', target, Math.round(d), 'blocks')
        try {
          const to = new Vec3(target.x, bot.entity.position.y, target.z)
          await overland(bot, { target: to, range: 4, hop: args.hop }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('reachStronghold: travel stopped:', (err as Error).message)
        }
      }
      await toThrowingSpot(bot, signal)
      const t = await throwEnderEye(bot, { recover: !inWater(bot) }, signal)
      if (t.near != null) {
        bot.survival?.memory.addPoi(STRONGHOLD_SPOT, { x: t.near.x, y: 0, z: t.near.z }, 'overworld', 'eye came down')
        return { spot: t.near, throws: n, ticks }
      }
      if (t.ray == null) continue
      rays.push(t.ray)
      rememberRay(bot.survival?.memory, t.ray)
      const est = consistentCrossing(rays)
      along = nextAlongRay(along, t.ray, est)
      target = along.target
      rememberEstimate(bot.survival?.memory, target, 'reach')
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
  return findBlocks(bot, { point, matching: ids, maxDistance, count })
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
    const remembered = bot.survival?.memory.getPois(STRONGHOLD_SPOT, { dimension: 'overworld', near: bot.entity.position })[0]
    const center = args.near ?? (remembered != null ? { x: remembered.x, z: remembered.z } : { x: bot.entity.position.x, z: bot.entity.position.z })
    const frameId = bot.registry.blocksByName.end_portal_frame.id
    const visited: Vec3[] = []
    let bricks = 0
    for (let trip = 0; trip < (args.maxTrips ?? 8); trip++) {
      throwIfAborted(signal)
      const frames = findBlocks(bot, { matching: frameId, maxDistance: 128, count: 12 })
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
  const frameNear = (): boolean => p.distanceTo(bot.entity.position) > 12 && findBlocks(bot, { matching: frameId, maxDistance: 10, count: 1 }).length > 0
  try {
    await tunnelTo(bot, { target: p, range, until: frameNear }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('findPortalRoom: dig to', p.toString(), 'stopped:', (err as Error).message)
  }
}

/** how far from the stronghold a resumed search travels back to it before looking for the room */
export const ROOM_TRAVEL_RANGE = 64

/** the whole milestone after the eyes are made: locate, reach, and find the portal room */
export async function strongholdToPortalRoom (bot: Bot, args: LocateStrongholdArgs = {}, signal?: AbortSignal): Promise<{ located: LocateStrongholdResult | null, reached: ReachStrongholdResult | null, room: FindPortalRoomResult }> {
  // on from where the search got to, as the memory has it: the task runs again from the start after a reflex
  // preempts it (a zombie on the way), and each start threw a new first eye and set off sideways again (all 14 eyes
  // gone on 26.3 seed 2, the stronghold never reached)
  const memory = bot.survival?.memory
  // the room or the spot over it known (a trip back for more eyes since): there on the surface first, a walk of
  // thousands of blocks being travel's, not the room search's
  const knownRoom = memory?.getPois('end_portal', { dimension: 'overworld', near: bot.entity.position })[0]
  const spot = knownRoom ?? memory?.getPois(STRONGHOLD_SPOT, { dimension: 'overworld', near: bot.entity.position })[0]
  if (spot != null) {
    if (Math.hypot(spot.x - bot.entity.position.x, spot.z - bot.entity.position.z) > ROOM_TRAVEL_RANGE) {
      trace('strongholdToPortalRoom: back to the stronghold at', spot.x, spot.z)
      const to = new Vec3(spot.x, bot.entity.position.y, spot.z)
      await overland(bot, { target: to, range: 8, hop: args.hop }, signal)
    }
    return { located: null, reached: null, room: await findPortalRoom(bot, { near: { x: spot.x, z: spot.z } }, signal) }
  }
  const estimate = memory?.getPois('stronghold_estimate', { dimension: 'overworld', near: bot.entity.position })[0]
  const located = estimate == null ? await locateStronghold(bot, args, signal) : null
  const target = located?.target ?? { x: (estimate as Poi).x, z: (estimate as Poi).z }
  const reached = await reachStronghold(bot, { target, rays: rememberedRays(memory) }, signal)
  const room = await findPortalRoom(bot, { near: reached.spot }, signal)
  return { located, reached, room }
}
