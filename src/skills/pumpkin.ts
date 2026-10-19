// A carved pumpkin worn in the End: an enderman never takes a player wearing one for looking at it
// (EnderMan.isBeingStaredBy: the head slot's item in ItemTags.GAZE_DISGUISE_EQUIPMENT), and the island's endermen
// angered by the bow's and the walk's looks killed two bots that wore a helmet (26.3 and 1.21.11). Carved from a
// pumpkin placed and sheared (PumpkinBlock.useItemOn with shears: the carved block, 4 seeds dropped), then mined.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { placeBlock } from './placeBlock'
import { findPlacement } from './placement'
import { countItems, findInventoryItem, trace, waitUntil } from './util'

/** whether the head slot has a carved pumpkin on */
export function wearingPumpkin (bot: Bot): boolean {
  return bot.inventory.slots[bot.getEquipmentDestSlot('head')]?.name === 'carved_pumpkin'
}

/**
 * A carved pumpkin from a pumpkin and shears: the pumpkin put down by the bot, sheared, and the carved one mined back
 * into the inventory. Resolves the carved pumpkins held after.
 */
export async function carvePumpkin (bot: Bot, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal)
  if (countItems(bot, 'carved_pumpkin') > 0) return countItems(bot, 'carved_pumpkin')
  if (countItems(bot, 'pumpkin') === 0 || countItems(bot, 'shears') === 0) throw new SkillError('MISSING_ITEMS', 'no pumpkin and shears to carve one')
  const pos = findPlacement(p => bot.blockAt(p), bot.entity.position)
  if (pos == null) throw new SkillError('CANNOT_PLACE', 'no room to put a pumpkin down')
  await placeBlock(bot, { pos, item: 'pumpkin' }, signal)
  const shears = findInventoryItem(bot, 'shears')
  if (shears == null) throw new SkillError('MISSING_ITEMS', 'no shears')
  await bot.equip(shears, 'hand')
  const block = bot.blockAt(pos)
  if (block == null || block.name !== 'pumpkin') throw new SkillError('VERIFY_FAILED', `no pumpkin at ${pos.toString()} to carve`)
  // the face toward the bot: the carving faces the player (PumpkinBlock: the hit face, or the player's facing)
  const d = bot.entity.position.minus(pos.offset(0.5, 0.5, 0.5))
  const face = Math.abs(d.x) >= Math.abs(d.z) ? new Vec3(Math.sign(d.x), 0, 0) : new Vec3(0, 0, Math.sign(d.z))
  await bot.lookAt(pos.offset(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5), true)
  await bot.activateBlock(block as any, face, new Vec3(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5))
  if (!await waitUntil(bot, () => bot.blockAt(pos)?.name === 'carved_pumpkin', 20, signal)) throw new SkillError('VERIFY_FAILED', 'the pumpkin took no carving')
  await collectBlock(bot, { positions: [pos], pickup: true }, signal)
  trace('carvePumpkin:', countItems(bot, 'carved_pumpkin'), 'carved')
  return countItems(bot, 'carved_pumpkin')
}

/** puts a carved pumpkin on the head (the helmet back into the bag); resolves whether one is worn */
export async function wearPumpkin (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  if (wearingPumpkin(bot)) return true
  const pumpkin = findInventoryItem(bot, 'carved_pumpkin')
  if (pumpkin == null) return false
  await bot.equip(pumpkin, 'head')
  return await waitUntil(bot, () => wearingPumpkin(bot), 20, signal)
}
