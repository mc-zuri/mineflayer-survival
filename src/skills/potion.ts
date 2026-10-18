// drinkPotion: a potion from the inventory by the effect it gives, drunk through (PotionItem: 32 ticks of use).
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { SkillError, throwIfAborted } from './errors'
import { settleInventory, waitTicks, waitUntil } from './util'

/** Potions' registration order on 1.21.11 (the potion_contents component's id): the ones the bot drinks */
export const POTION_IDS: Record<string, number[]> = {
  fire_resistance: [11, 12],
  swiftness: [13, 14, 15],
  regeneration: [28, 29, 30],
  strength: [31, 32, 33],
  healing: [21, 22],
  slow_falling: [41, 42]
}

/** the effect ids (MobEffects' order, minecraft-data's effects) */
const EFFECT_NAMES: Record<string, string> = { fire_resistance: 'FireResistance', swiftness: 'Speed', regeneration: 'Regeneration', strength: 'Strength', healing: 'InstantHealth', slow_falling: 'SlowFalling' }

export function potionOf (item: Item): number | null {
  if (item.name !== 'potion') return null
  const data = (item as any).componentMap?.get?.('potion_contents')?.data
  return typeof data?.potionId === 'number' ? data.potionId : null
}

export function findPotion (bot: Bot, effect: string): Item | null {
  const ids = POTION_IDS[effect] ?? []
  return bot.inventory.items().find(i => { const id = potionOf(i); return id != null && ids.includes(id) }) ?? null
}

/** whether the bot has the effect now (the server's update_mob_effect, mineflayer's entity.effects) */
export function hasEffect (bot: Bot, effect: string): boolean {
  const id = (bot.registry as any).effectsByName?.[EFFECT_NAMES[effect] ?? effect]?.id
  return id != null && (bot.entity as any).effects?.[id] != null
}

/** drinks a potion of the effect: held to the end of its 32 ticks of use (PotionItem.getUseDuration), checked by the effect */
export async function drinkPotion (bot: Bot, effect: string, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  if (hasEffect(bot, effect)) return true
  const potion = findPotion(bot, effect)
  if (potion == null) throw new SkillError('MISSING_ITEMS', `no potion of ${effect}`)
  await settleInventory(bot, signal)
  await bot.equip(potion, 'hand')
  bot.activateItem()
  try {
    await waitTicks(bot, 34, signal)
  } finally {
    bot.deactivateItem()
  }
  return await waitUntil(bot, () => hasEffect(bot, effect), 10, signal)
}
