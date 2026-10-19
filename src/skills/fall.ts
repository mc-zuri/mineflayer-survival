// A fall broken with a water bucket (the "MLG"): water poured on the landing block just before the bot meets it, the
// fall's damage gone (LivingEntity.causeFallDamage: none landing in water), and the water scooped back up. A player
// takes fall damage past 3 blocks (a point a block more); a dragon's hit off a crystal's pillar dropped a bot 16
// blocks onto the End's island (26.3).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { throwIfAborted } from './errors'
import { findInventoryItem, waitTicks, waitUntil } from './util'

/** blocks fallen past which a fall is broken with water (one of 5 does 2 hearts) */
export const FALL_BREAK_BLOCKS = 5

/** the feet height of the first block with a collision box under the bot within `depth`, else null */
export function landingY (blockAt: (pos: Vec3) => { boundingBox: string, name: string } | null, pos: Vec3, depth = 40): number | null {
  const x = Math.floor(pos.x)
  const z = Math.floor(pos.z)
  for (let y = Math.floor(pos.y); y >= Math.floor(pos.y) - depth; y--) {
    const b = blockAt(new Vec3(x, y, z))
    if (b == null) return null
    if (b.name === 'water' || b.name === 'bubble_column') return null
    if (b.boundingBox === 'block') return y + 1
  }
  return null
}

/**
 * Whether a fall is to be broken now: falling (velocity under -0.5), FALL_BREAK_BLOCKS or more from where it began,
 * the landing within 3.5 blocks below (the bucket's reach) and over 1, a water bucket held, out of the nether (water
 * boils away there, DimensionType.ultraWarm)
 */
export function shouldBreakFall (state: { y: number, vy: number, onGround: boolean, fallStart: number, landing: number | null, hasBucket: boolean, nether: boolean }): boolean {
  if (state.onGround || state.vy > -0.5 || !state.hasBucket || state.nether || state.landing == null) return false
  if (state.fallStart - state.landing < FALL_BREAK_BLOCKS) return false
  const above = state.y - state.landing
  return above < 3.5 && above > 1
}

/** pours the water bucket on the landing below, waits to land, and takes the water back up */
export async function breakFall (bot: Bot, landing: number, signal?: AbortSignal): Promise<boolean> {
  const bucket = findInventoryItem(bot, 'water_bucket')
  if (bucket == null) return false
  if (bot.heldItem?.name !== 'water_bucket') await bot.equip(bucket, 'hand')
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  bot.activateItem()
  const cell = new Vec3(Math.floor(bot.entity.position.x), landing, Math.floor(bot.entity.position.z))
  await waitUntil(bot, () => bot.entity.onGround || bot.blockAt(bot.entity.position.floored())?.name === 'water', 40, signal)
  throwIfAborted(signal)
  await waitTicks(bot, 2, signal)
  // the water back into the bucket
  if (bot.blockAt(cell)?.name === 'water') {
    const empty = findInventoryItem(bot, 'bucket')
    if (empty != null) {
      if (bot.heldItem?.name !== 'bucket') await bot.equip(empty, 'hand')
      await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true)
      bot.activateItem()
      await waitTicks(bot, 2, signal)
    }
  }
  return true
}
