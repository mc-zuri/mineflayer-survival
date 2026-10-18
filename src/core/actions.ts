// The bot's hands, as vanilla's player uses them: only what the crosshair hits is dug, placed against or attacked
// (Minecraft.hitResult: MultiPlayerGameMode.startDestroyBlock, useItemOn and attack take its block and face, or its
// entity). A log behind leaves has the leaves broken first, a block goes against a face in sight, and a mob behind a
// block isn't hit. With mineflayer-mouse loaded a dig is its left click (its own packets and the client's animations).
// mineflayer's bot.dig, bot.placeBlock and bot.attack alone act on anything in reach, whatever is in front of it.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { blockReach, crosshairBlock, digInSight } from '@nxg-org/mineflayer-pathfinder'
import type { Block } from '../skills/util'

export interface DigOptions {
  signal?: AbortSignal
  /** whether a block in the crosshair's way may be broken first (default: any that breaks but a fluid or the floor) */
  digObstruction?: (block: Block) => boolean
}

/** digs the block through the crosshair (digInSight); resolves when it is gone */
export async function dig (bot: Bot, block: Block, options: DigOptions = {}): Promise<void> {
  await digInSight(bot, block as any, { signal: options.signal, digObstruction: options.digObstruction as any })
}

// prismarine-world's BlockFace of a face's direction (0 down, 1 up, 2 north, 3 south, 4 west, 5 east)
function faceNumber (face: Vec3): number {
  if (face.y < 0) return 0
  if (face.y > 0) return 1
  if (face.z < 0) return 2
  if (face.z > 0) return 3
  if (face.x < 0) return 4
  return 5
}

/**
 * Turns the bot toward a point of the block's face that the crosshair hits it at (the face's centre first): the point,
 * relative to the block (what a place sends as its cursor), or null when no point of that face is in sight from here
 */
export async function aimAtFace (bot: Bot, block: Block, face: Vec3): Promise<Vec3 | null> {
  if (typeof bot.lookAt !== 'function' || bot.entity?.position == null) return null
  const reach = blockReach(bot)
  const want = faceNumber(face)
  const ts = [0.5, 0.25, 0.75, 0.1, 0.9]
  for (const u of ts) {
    for (const v of ts) {
      // the point on the face: its axis at the face's side, the other two at u and v
      const rel = face.x !== 0
        ? new Vec3(face.x > 0 ? 1 : 0, u, v)
        : face.y !== 0
          ? new Vec3(u, face.y > 0 ? 1 : 0, v)
          : new Vec3(u, v, face.z > 0 ? 1 : 0)
      await bot.lookAt(block.position.plus(rel), true)
      const hit = crosshairBlock(bot, reach)
      if (hit != null && hit.block.position.equals(block.position) && hit.face === want) return rel
    }
  }
  return null
}

/**
 * Places the held block against the face of `against`, with the crosshair on that face as vanilla's use is
 * (useItemOn with the hit's block, face and point). False when no point of the face is in sight: nothing is placed.
 */
export async function placeAgainst (bot: Bot, against: Block, face: Vec3): Promise<boolean> {
  const delta = await aimAtFace(bot, against, face)
  if (delta == null) return false
  await (bot as any)._placeBlockWithOptions(against, face, { delta, forceLook: true, swingArm: 'right' })
  return true
}

/**
 * Whether the crosshair is on the entity (LocalPlayer.raycastHitResult: an entity in front of the first block within
 * reach): an attack goes only to it. True for a bot with no view to check (no mineflayer raycast, an entity with no
 * position, as a dragon's part is)
 */
export function entityInCrosshair (bot: Bot, entity: { id: number, position?: Vec3 }): boolean {
  const raycast = (bot as any).raycastHitResult
  if (typeof raycast !== 'function' || entity.position == null || bot.entity?.position == null) return true
  const hit = raycast(blockReach(bot), 3)
  return hit.type === 'entity' && hit.entity?.id === entity.id
}
