// enterNether / returnOverworld: walk into a nether portal and wait out the dimension change (the server's respawn
// packet into the other level, then its teleport), step out of the arrival portal, and remember both portals.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { normalizeDimension, type Dimension, type Poi } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { navigate, walkTo } from '../skills/navigate'
import { isSolid } from '../skills/placement'
import { travel } from '../skills/travel'
import { tunnelTo } from '../skills/tunnel'
import { trace, waitTicks, waitUntil } from '../skills/util'
import { portalDestination } from './coords'
import { blockGetter, buildPortal, lightPortal, type BuildPortalArgs } from './portalSkills'
import { checkPortalFrame, portalFrame, type PortalFrame } from './portal'
import { withNetherSafety } from './safety'
import { findBlocks } from '../core/findBlocks'

/** NetherPortalBlock.getPortalTransitionTime: a survival player stands in the portal 80 ticks (gamerule players_nether_portal_default_delay) */
export const PORTAL_TRANSITION_TICKS = 80

export interface PortalLink {
  dimension: Dimension
  pos: Vec3
}

/** a portal poi's note: how it came to be, and the portal it leads to ("built", "arrival", "link=the_nether:1,64,2") */
export function portalNote (origin: string, link?: PortalLink): string {
  return link == null ? origin : `${origin};link=${link.dimension}:${Math.floor(link.pos.x)},${Math.floor(link.pos.y)},${Math.floor(link.pos.z)}`
}

/** the other side of a remembered portal, from its note */
export function portalLinkOf (poi: Pick<Poi, 'note'>): PortalLink | null {
  const m = /link=([^:;]+):(-?\d+),(-?\d+),(-?\d+)/.exec(poi.note ?? '')
  return m == null ? null : { dimension: m[1], pos: new Vec3(Number(m[2]), Number(m[3]), Number(m[4])) }
}

export function dimensionOf (bot: Bot): Dimension {
  return normalizeDimension(bot.game?.dimension)
}

/** the portal's bottom cells: nether_portal blocks with something else below (where a player walks in) */
function portalFloor (bot: Bot, near: Vec3, radius = 4): Vec3[] {
  const id = bot.registry.blocksByName.nether_portal.id
  return findBlocks(bot, { point: near, matching: id, maxDistance: radius, count: 64 })
    .filter(p => bot.blockAt(p.offset(0, -1, 0))?.type !== id)
    .sort((a, b) => a.distanceTo(near) - b.distanceTo(near))
}

/** the nearest nether_portal block that stands on something, within `maxDistance` */
export function findPortal (bot: Bot, maxDistance = 32): Vec3 | null {
  const id = bot.registry.blocksByName.nether_portal.id
  const found = findBlocks(bot, { matching: id, maxDistance, count: 256 })
    .filter(p => bot.blockAt(p.offset(0, -1, 0))?.type !== id)
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  return found[0] ?? null
}

/** a whole 4 × 5 obsidian frame round `near` (a portal's remembered cell) with nothing in it, else null */
export function unlitFrameAt (bot: Bot, near: Vec3): PortalFrame | null {
  const getBlock = blockGetter(bot)
  for (const axis of ['x', 'z'] as const) {
    for (let du = -3; du <= 0; du++) {
      for (let dv = -2; dv <= 0; dv++) {
        const origin = axis === 'x' ? { x: near.x + du, y: near.y + dv, z: near.z } : { x: near.x, y: near.y + dv, z: near.z + du }
        const frame = portalFrame(origin, axis)
        if (checkPortalFrame(getBlock, frame).valid) return frame
      }
    }
  }
  return null
}

/** a cell the bot can stand in: solid below, two cells clear, not a portal, lava or fire */
function standable (bot: Bot, c: Vec3): boolean {
  const free = (p: Vec3): boolean => { const b = bot.blockAt(p); return b != null && !isSolid(b) && b.name !== 'nether_portal' && b.name !== 'lava' && b.name !== 'fire' }
  const below = bot.blockAt(c.offset(0, -1, 0))
  return free(c) && free(c.offset(0, 1, 0)) && below != null && isSolid(below)
}

function inPortal (bot: Bot): boolean {
  const p = bot.entity.position
  for (const dy of [0, 1]) {
    for (const x of [Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)]) {
      for (const z of [Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)]) {
        if (bot.blockAt(new Vec3(x, Math.floor(p.y) + dy, z))?.name === 'nether_portal') return true
      }
    }
  }
  return false
}

export interface EnterPortalArgs {
  /** a nether_portal block of the portal to take (default: the nearest within 32) */
  portal?: Vec3
  /** ticks to wait in the portal for the change (default 400) */
  maxTicks?: number
  /** remember both portals in bot.survival.memory (default true) */
  remember?: boolean
}

export interface EnterPortalResult {
  from: Dimension
  to: Dimension
  /** the portal block walked into */
  departure: Vec3
  /** a block of the portal the bot came out of (null when the bot arrived outside one) */
  arrival: Vec3 | null
  /** where the bot stands after stepping out */
  position: Vec3
  /** ticks from stepping in to standing outside the arrival portal */
  ticks: number
}

/**
 * Walks into the portal and stands still until the server moves the player to the other level (ServerPlayer.teleport:
 * a respawn packet for the new level, then the player's position), waits for the chunk it stands in, and walks out
 * of the arrival portal before its 80 ticks are up (it would send the bot back).
 */
export async function enterPortal (bot: Bot, args: EnterPortalArgs = {}, signal?: AbortSignal): Promise<EnterPortalResult> {
  throwIfAborted(signal)
  const from = dimensionOf(bot)
  const portal = args.portal?.floored() ?? findPortal(bot)
  if (portal == null) throw new SkillError('NOT_FOUND', `no nether portal near ${bot.entity.position.toString()}`)
  const floor = portalFloor(bot, portal, 6)[0] ?? portal
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  let changed = false
  let teleported = false
  const onRespawn = (): void => { if (dimensionOf(bot) !== from) changed = true }
  const onForcedMove = (): void => { if (changed) teleported = true }
  bot.on('respawn', onRespawn)
  bot.on('forcedMove', onForcedMove)
  try {
    let into = floor
    if (!inPortal(bot)) {
      // to a cell right beside the portal's bottom with the pathfinder, then the last step in by hand (the pathfinder
      // doesn't end moves in portal blocks)
      // (beside it on its level, or a step down: a frame built on the ground has its portal a block up)
      const besides = portalFloor(bot, floor, 3).flatMap(p => [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].flatMap(d => [p.plus(d), p.plus(d).offset(0, -1, 0)]))
        .filter(c => standable(bot, c))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      let beside: Vec3 | null = null
      for (const c of besides.slice(0, 4)) {
        try {
          await navigate(bot, { goal: new goals.GoalBlock(c.x, c.y, c.z), reached: () => inPortal(bot) || changed || bot.entity.position.floored().equals(c) }, signal)
          beside = c
          break
        } catch (err) {
          if (isAbort(err)) throw err
        }
      }
      // no path to a cell beside it (8 over a cave portal the searches timed out, 26.3): a stair dug down to the
      // nearest, then on as before
      if (beside == null && !inPortal(bot) && !changed && besides.length > 0) {
        const c = besides[0]
        trace('enterPortal: a tunnel to', c.toString())
        await tunnelTo(bot, { target: c, range: 1 }, signal).catch(err => { if (isAbort(err)) throw err; trace('enterPortal: the tunnel:', (err as Error).message) })
        if (bot.entity.position.floored().distanceTo(c) <= 1.5) beside = c
      }
      if (beside == null && !inPortal(bot) && !changed) throw new SkillError('NO_PATH', `no way to the portal at ${floor.toString()}`)
      into = beside == null ? floor : (portalFloor(bot, beside, 2).sort((a, b) => a.distanceTo(beside) - b.distanceTo(beside))[0] ?? floor)
      await walkTo(bot, into.offset(0.5, 0, 0.5), { within: 0.25, maxTicks: 60, until: () => inPortal(bot) || changed }, signal)
      if (!inPortal(bot) && !changed) throw new SkillError('NO_PATH', `couldn't step into the portal at ${floor.toString()} from ${bot.entity.position.toString()}`)
    }
    bot.clearControlStates()
    const maxTicks = args.maxTicks ?? 400
    // still in the portal: PortalProcessor counts the ticks inside it, and leaving resets them
    // (a player who came in on the portal's cooldown keeps it going while it stays, Entity.setAsInsidePortal:
    // isOnPortalCooldown, so after twice the wait the bot steps out and back in)
    let inside = 0
    let out = 0
    const went = await waitUntil(bot, () => {
      if (changed) return true
      if (out > 0) {
        out--
        bot.setControlState('back', out > 10)
        bot.setControlState('forward', false)
        if (out === 0) inside = 0
        return false
      }
      if (!inPortal(bot)) {
        void bot.lookAt(into.offset(0.5, 0.5, 0.5), true).then(() => bot.setControlState('forward', true))
      } else {
        bot.setControlState('forward', false)
        if (++inside > 2 * PORTAL_TRANSITION_TICKS) out = 30
      }
      return false
    }, maxTicks, signal)
    bot.clearControlStates()
    if (!went) throw new SkillError('TIMEOUT', `still in ${from} after ${maxTicks} ticks at the portal ${portal.toString()}`)
    const to = dimensionOf(bot)
    // the server's position in the new level, then the chunk under it
    const arrived = await waitUntil(bot, () => teleported && bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) != null, 400, signal)
    if (!arrived) throw new SkillError('TIMEOUT', `no position or chunks in ${to} after the portal`)
    // the pathfinder's block cache still holds the old level's blocks
    ;(bot.pathfinder as any)?.world?.clearCache?.()
    await waitTicks(bot, 2, signal)
    const arrivalFloor = portalFloor(bot, bot.entity.position, 3)[0] ?? null
    trace('enterPortal:', from, '->', to, 'at', bot.entity.position.toString(), 'arrival portal', arrivalFloor?.toString())
    if (arrivalFloor != null) await stepOutOfPortal(bot, signal)
    if (args.remember !== false && bot.survival?.memory != null) {
      const memory = bot.survival.memory
      const arrivalPos = arrivalFloor ?? bot.entity.position.floored()
      const old = memory.getPois('nether_portal', { dimension: from, near: floor }).find(p => Math.hypot(p.x - floor.x, p.z - floor.z) <= 4)
      const origin = old?.note?.split(';')[0] ?? 'found'
      if (old != null) memory.removePoi('nether_portal', old, from)
      memory.addPoi('nether_portal', floor, from, portalNote(origin, { dimension: to, pos: arrivalPos }))
      const there = memory.getPois('nether_portal', { dimension: to, near: arrivalPos }).find(p => Math.hypot(p.x - arrivalPos.x, p.z - arrivalPos.z) <= 4)
      if (there != null) memory.removePoi('nether_portal', there, to)
      memory.addPoi('nether_portal', arrivalPos, to, portalNote(there?.note?.split(';')[0] ?? 'arrival', { dimension: from, pos: floor }))
    }
    return { from, to, departure: floor, arrival: arrivalFloor, position: bot.entity.position.clone(), ticks }
  } finally {
    bot.off('physicsTick', onTick)
    bot.off('respawn', onRespawn)
    bot.off('forcedMove', onForcedMove)
    bot.clearControlStates()
  }
}

/** walks to the nearest cell next to the portal the bot can stand in (solid floor, two cells clear, no portal, no lava about) */
export async function stepOutOfPortal (bot: Bot, signal?: AbortSignal): Promise<void> {
  if (!inPortal(bot)) return
  const feet = bot.entity.position.floored()
  const free = (p: Vec3): boolean => { const b = bot.blockAt(p); return b != null && !isSolid(b) && b.name !== 'nether_portal' && b.name !== 'lava' && b.name !== 'fire' }
  const spots: Vec3[] = []
  for (let r = 1; r <= 3 && spots.length === 0; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (const dy of [0, -1, 1]) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const c = feet.offset(dx, dy, dz)
          const below = bot.blockAt(c.offset(0, -1, 0))
          if (!free(c) || !free(c.offset(0, 1, 0)) || below == null || !isSolid(below) || below.name === 'magma_block') continue
          spots.push(c)
        }
      }
    }
  }
  spots.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet))
  for (const spot of spots.slice(0, 4)) {
    try {
      await navigate(bot, { goal: new goals.GoalBlock(spot.x, spot.y, spot.z), reached: () => !inPortal(bot) }, signal)
      if (!inPortal(bot)) return
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  if (inPortal(bot)) throw new SkillError('NO_PATH', `no way out of the portal at ${feet.toString()}`)
}

export interface EnterNetherArgs extends EnterPortalArgs {
  /** build a portal when none is near or remembered (default true); its options */
  build?: boolean | BuildPortalArgs
}

/**
 * Into the nether: through the portal given, one in view, or the nearest remembered in this dimension (walked to),
 * else one the bot builds. The overworld portal and the nether one it came out of go into memory, each linked to the
 * other: returnOverworld takes the arrival portal back.
 */
export async function enterNether (bot: Bot, args: EnterNetherArgs = {}, signal?: AbortSignal): Promise<EnterPortalResult> {
  if (dimensionOf(bot) === 'the_nether') throw new SkillError('VERIFY_FAILED', 'already in the nether')
  return await takePortal(bot, 'the_nether', args, signal)
}

/** back to the overworld: through the remembered arrival portal (or the nearest in view, or one built here) */
export async function returnOverworld (bot: Bot, args: EnterNetherArgs = {}, signal?: AbortSignal): Promise<EnterPortalResult> {
  if (dimensionOf(bot) === 'overworld') throw new SkillError('VERIFY_FAILED', 'already in the overworld')
  return await takePortal(bot, 'overworld', args, signal)
}

async function takePortal (bot: Bot, to: Dimension, args: EnterNetherArgs, signal?: AbortSignal): Promise<EnterPortalResult> {
  const here = dimensionOf(bot)
  let portal = args.portal ?? findPortal(bot)
  if (portal == null && bot.survival?.memory != null) {
    // the remembered portal leading where we want, else any remembered here
    const pois = bot.survival.memory.getPois('nether_portal', { dimension: here, near: bot.entity.position })
    const poi = pois.find(p => portalLinkOf(p)?.dimension === to) ?? pois[0]
    if (poi != null) {
      const at = new Vec3(poi.x, poi.y, poi.z)
      trace('takePortal: walking to the remembered portal at', at.toString())
      // to its height too (exactY): a portal built in a cave lies under the ground the walk ends on, and the bot on
      // the surface 100 blocks over a 26.3 portal at y -43 saw none and built another ('0 lava sources found')
      // in the nether with its path settings (no lava edges, no magma, the deaths kept away from) and by its trail
      // (no path down the last blocks to it, the portal in a cave under the bot: a stair dug down to it, 8 blocks over
      // a 26.3 portal the walk gave up, 'no way on')
      const walk = async (): Promise<unknown> => await travel(bot, { target: at, range: 4, exactY: true }, signal).catch(async err => {
        if (isAbort(err) || Math.hypot(bot.entity.position.x - at.x, bot.entity.position.z - at.z) > 12) throw err
        trace('takePortal: down to the portal by a tunnel:', (err as Error).message)
        return await tunnelTo(bot, { target: at, range: 3 }, signal)
      })
      await (here === 'the_nether' ? withNetherSafety(bot, walk) : walk())
      portal = findPortal(bot, 16)
      // the frame there gone out (no portal blocks in it): lit again with the flint and steel (a 26.3 bot back from
      // three nights' pearl hunt found its portal out and tried to build another, five times at once)
      if (portal == null) {
        const frame = unlitFrameAt(bot, at)
        if (frame != null) {
          trace('takePortal: the frame at', at.toString(), 'is out: lighting it')
          await lightPortal(bot, frame, signal).catch(err => { if (isAbort(err)) throw err; trace('takePortal: not lit:', (err as Error).message) })
          portal = findPortal(bot, 16)
        }
      }
    }
  }
  if (portal == null) {
    if (args.build === false) throw new SkillError('NOT_FOUND', `no portal to ${to} known near ${bot.entity.position.toString()}`)
    const built = await buildPortal(bot, typeof args.build === 'object' ? args.build : {}, signal)
    portal = built.portal[0]
  }
  const result = await enterPortal(bot, { ...args, portal }, signal)
  if (result.to !== to) throw new SkillError('VERIFY_FAILED', `the portal took the bot to ${result.to}, not ${to}`, result)
  return result
}

/** where the portal at `pos` comes out on the other side, before PortalForcer's search (NetherPortalBlock.getPortalDestination) */
export function expectedArrival (pos: Vec3, from: Dimension, to: Dimension): Vec3 {
  const d = portalDestination(pos, from, to).block
  return new Vec3(d.x, d.y, d.z)
}
