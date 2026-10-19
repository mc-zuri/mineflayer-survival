import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension } from '../../core/memory'
import { TaskError, type SkillOptions, throwIfAborted, waitTicks, waitUntil, eyePosition } from '../../skills/combatUtil'
import { analyzePortalRoom, FACING_STEP, findPortalFrames, readPortalFrame, type PortalRoom } from '../portalRoom'
import { steerToward } from '../../skills/steer'
import { resyncInventory, trace } from '../../skills/util'
import { blockGetter, gotoBlock, gotoNear, groundY, type BlockGetter } from './world'

// enterEnd: the eyes the portal room's frames are missing put in (EnderEyeItem.useOn on each frame's top), then into
// the end_portal the 12th eye opens (EndPortalBlock.entityInside), and the arrival in the End awaited.

/** the block reach for using an item on a block (Attributes.BLOCK_INTERACTION_RANGE default 4.5) */
export const BLOCK_REACH = 4.5

export function isInEnd (bot: Bot): boolean {
  return normalizeDimension(bot.game?.dimension) === 'the_end'
}

/** the portal room around the bot, read from the end_portal_frame blocks within `radius` */
export function readPortalRoom (bot: Bot, radius = 12): PortalRoom | null {
  const frames = findPortalFrames(pos => bot.blockAt(new Vec3(pos.x, pos.y, pos.z)) as any, bot.entity.position, radius)
  return analyzePortalRoom(frames)
}

export interface EnterEndOptions extends SkillOptions {
  /** how far around the bot to look for the frames (default 12) */
  radius?: number
  /** ticks to wait for the End after stepping in (default 400) */
  arriveTicks?: number
}

export interface EnterEndResult {
  /** eyes put in */
  eyesPlaced: number
  /** where the bot came out (the obsidian platform, ServerLevel.END_SPAWN_POINT) */
  arrival: Vec3
}

/**
 * Where to step into the portal from: the cell outside each side's middle frame, at the frames' own level (on the
 * platform), nearest first
 */
export function portalApproach (room: PortalRoom, from: Vec3): Vec3[] {
  return room.expected
    .filter(f => f.pos.x === room.center.x || f.pos.z === room.center.z)
    .map(f => new Vec3(f.pos.x - FACING_STEP[f.facing].x, f.pos.y, f.pos.z - FACING_STEP[f.facing].z))
    .sort((a, b) => a.distanceTo(from) - b.distanceTo(from))
}

function framePos (p: { x: number, y: number, z: number }): Vec3 {
  return new Vec3(p.x, p.y, p.z)
}

/**
 * Fills the frames still missing an eye (nearest first, walking within reach of each), waits for the end_portal to
 * fill the 3×3 inside, and walks into it. Resolves once the bot is in the End and on the ground. Throws NOT_FOUND
 * without a whole frame around, MISSING_ITEMS short of eyes.
 */
/**
 * Where to stand to put an eye in a frame: outside the ring 1 or 2 blocks out from it (FACING points into the room), or
 * a block to the side of that, on ground at the frame's level or over it (the platform, where its top face is in
 * sight); else 2 out on whatever ground is there
 */
export function frameStandSpot (get: BlockGetter, pos: Vec3, out: { x: number, z: number }, not?: Vec3): { x: number, y: number, z: number } {
  const taken = (x: number, z: number): boolean => not != null && Math.floor(not.x) === x && Math.floor(not.z) === z
  const side = { x: out.z, z: out.x }
  for (const d of [2, 1]) {
    for (const s of [0, 1, -1]) {
      const x = pos.x - out.x * d + side.x * s
      const z = pos.z - out.z * d + side.z * s
      const y = groundY(get, x, z, pos.y + 3, pos.y - 4)
      if (y != null && y >= pos.y && y <= pos.y + 1 && !taken(x, z)) return { x, y, z }
    }
  }
  // no platform outside it: any ground within 3 at the frame's level or a block over (the ring's other frames, the
  // stairs' top), its top face in reach, the nearest
  let best: { x: number, y: number, z: number } | null = null
  let bestD = Infinity
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue
      const x = pos.x + dx
      const z = pos.z + dz
      const y = groundY(get, x, z, pos.y + 3, pos.y - 4)
      if (y == null || y < pos.y || y > pos.y + 1 || taken(x, z)) continue
      const d = Math.hypot(x + 0.5 - (pos.x + 0.5), y + 1.62 - (pos.y + 13 / 16), z + 0.5 - (pos.z + 0.5))
      // on another frame only when nothing else will do (the portal's pit beside it)
      const score = d + (get(new Vec3(x, y - 1, z))?.name === 'end_portal_frame' ? 3 : 0)
      if (d <= 4 && score < bestD) { bestD = score; best = { x, y, z } }
    }
  }
  if (best != null) return best
  const x = pos.x - out.x * 2
  const z = pos.z - out.z * 2
  return { x, y: groundY(get, x, z, pos.y + 3, pos.y - 4) ?? pos.y, z }
}

export async function enterEnd (bot: Bot, opts: EnterEndOptions = {}): Promise<EnterEndResult> {
  const signal = opts.signal
  if (isInEnd(bot)) return { eyesPlaced: 0, arrival: bot.entity.position.clone() }
  const room = readPortalRoom(bot, opts.radius ?? 12)
  if (room == null) throw new TaskError('NOT_FOUND', 'no end portal frame around')
  if (room.unseen.length > 0) throw new TaskError('NOT_FOUND', `${room.unseen.length} of the portal's 12 frames aren't there`)
  const eyes = bot.inventory.items().filter(i => i.name === 'ender_eye').reduce((n, i) => n + i.count, 0)
  if (eyes < room.missing.length) throw new TaskError('MISSING_ITEMS', `${room.missing.length} eyes needed, ${eyes} in the inventory`)

  let placed = 0
  const left = [...room.missing]
  while (left.length > 0) {
    throwIfAborted(signal)
    left.sort((a, b) => framePos(a.pos).distanceTo(bot.entity.position) - framePos(b.pos).distanceTo(bot.entity.position))
    const frame = left.shift() as typeof left[number]
    const pos = framePos(frame.pos)
    // the top face's middle, within reach of the eyes
    const top = pos.offset(0.5, 13 / 16, 0.5)
    // or from below it (down by the room's lava, its top face out of sight: the eye never went in, 1.21.11 seed 2)
    if (eyePosition(bot).distanceTo(top) > BLOCK_REACH - 0.5 || eyePosition(bot).y < top.y) {
      // from outside the ring, two blocks out from the frame (FACING points into the room)
      const out = FACING_STEP[frame.facing]
      const spot = frameStandSpot(blockGetter(bot), pos, out)
      await gotoBlock(bot, spot, { signal })
    }
    const block = bot.blockAt(pos)
    if (block == null || readPortalFrame(block as any, pos) == null) throw new TaskError('NOT_FOUND', `the frame at ${pos.toString()} is gone`)
    if (readPortalFrame(block as any, pos)?.eye === true) continue
    // three tries: the eye taken in hand again (the held item the client shows may not be the server's, after the kit's
    // chest and bed: a 1.21.11 bot's eye went into no frame five times over from a spot the same click works from), and
    // the last from the next spot to stand at
    let filled = false
    for (let attempt = 0; attempt < 3 && !filled; attempt++) {
      const eye = bot.inventory.items().find(i => i.name === 'ender_eye')
      if (eye == null) throw new TaskError('MISSING_ITEMS', 'out of eyes of ender')
      if (attempt === 2) {
        const out = FACING_STEP[frame.facing]
        await gotoBlock(bot, frameStandSpot(blockGetter(bot), pos, out, bot.entity.position), { signal })
      }
      // the server's inventory sent again first (resyncInventory): after a bed's placement failed by the kit, the clicks
      // that took the eye in hand went by a stale state and the server's hand held something else, 1.21.11
      if (attempt > 0) await resyncInventory(bot, signal)
      if (bot.heldItem?.name !== 'ender_eye' || attempt > 0) await bot.equip(bot.inventory.items().find(i => i.name === 'ender_eye') ?? eye, 'hand')
      if (attempt > 0) await waitTicks(bot, 5, signal)
      await bot.lookAt(top, true)
      await bot.activateBlock(block, new Vec3(0, 1, 0), new Vec3(0.5, 13 / 16, 0.5))
      filled = await waitUntil(bot, () => {
        const b = bot.blockAt(pos)
        return b != null && readPortalFrame(b as any, pos)?.eye === true
      }, 20, signal)
      if (!filled) trace(`enterEnd: no eye in ${pos.toString()} (try ${attempt + 1}) from ${bot.entity.position.toString()}, holding ${bot.heldItem?.name ?? 'nothing'}`)
    }
    if (!filled) throw new TaskError('NO_PATH', `the eye didn't go into the frame at ${pos.toString()}`)
    placed++
  }

  // EnderEyeItem.useOn: the last eye fills the inside with end_portal at once
  const center = framePos(room.center)
  const open = await waitUntil(bot, () => bot.blockAt(center)?.name === 'end_portal', 20, signal)
  if (!open) throw new TaskError('NO_PATH', 'the frames are full but no portal opened')

  // up beside a frame in the middle of a side, onto it (13/16 high) and off it into the portal: the frames stand on the
  // room's platform, a block over its floor (StrongholdPieces.PortalRoom: the stairs lead up to it), and steered at
  // from the floor at a corner the bot jumped against the frames for 200 ticks (26.3 seed 2)
  try {
    let at = false
    for (const spot of portalApproach(room, bot.entity.position)) {
      try {
        await gotoBlock(bot, spot, { signal })
        at = true
        break
      } catch (err) {
        if (TaskError.is(err) && ['ABORTED', 'DIED'].includes(err.code)) throw err
        if (signal?.aborted === true) throw err
      }
    }
    if (!at && bot.entity.position.distanceTo(center.offset(0.5, 0, 0.5)) > 4) await gotoNear(bot, center.offset(0.5, 0, 0.5), 2.5, { signal })
    for (let t = 0; t < 200 && !isInEnd(bot); t++) {
      steerToward(bot, center.offset(0.5, 0, 0.5), { sprint: false })
      if (t % 20 === 0) trace('enterEnd: into the portal at', center.toString(), 'from', bot.entity.position.toString(), 'on ground', bot.entity.onGround, 'feet in', bot.blockAt(bot.entity.position)?.name, 'below', bot.blockAt(bot.entity.position.offset(0, -0.5, 0))?.name)
      await waitTicks(bot, 1, signal)
    }
    bot.clearControlStates()
    if (!isInEnd(bot)) throw new TaskError('NO_PATH', 'walked into the portal and stayed in the overworld')
    // the End's spawn platform: wait for its chunks and the bot to land
    const landed = await waitUntil(bot, () => isInEnd(bot) && bot.entity.onGround, opts.arriveTicks ?? 400, signal)
    if (!landed) throw new TaskError('TIMEOUT', 'in the End but not on the ground')
  } finally {
    bot.clearControlStates()
  }
  return { eyesPlaced: placed, arrival: bot.entity.position.clone() }
}
