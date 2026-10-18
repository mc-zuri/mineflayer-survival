import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { chooseFood, type FoodChoiceOptions, type HungerState } from './food'
import { ALWAYS_EDIBLE } from '../core/items'
import { TaskError, type SkillOptions, waitTicks } from './combatUtil'

export interface EatOptions extends SkillOptions, FoodChoiceOptions {
  /** the food to eat; chosen by chooseFood when left out */
  food?: Item | string
  /** put back what was in the hand (default true) */
  restoreHand?: boolean
  /** ticks to wait for the server to finish the use (default 32 + 40: Consumable.consume_seconds 1.6 and latency) */
  maxTicks?: number
}

export interface EatResult {
  item: string
  foodBefore: number
  foodAfter: number
  saturationAfter: number
}

export function hungerState (bot: Bot): HungerState {
  return { food: bot.food, saturation: bot.foodSaturation, health: bot.health }
}

/** The food chooseFood picks from the bot's inventory, or null. */
export function bestFoodInInventory (bot: Bot, opts: FoodChoiceOptions = {}): Item | null {
  const items = bot.inventory.items()
  const offhand = bot.inventory.slots[45]
  if (offhand != null) items.push(offhand)
  return chooseFood(items, bot.registry.foodsByName as any, hungerState(bot), opts)
}

/**
 * Eats one food: equips it, uses it until the server finishes the use (Consumable.onConsume: the stack shrinks and
 * the food bar fills), and puts back the held item. Throws MISSING_ITEMS without food, FAILED with a full bar.
 */
export async function eat (bot: Bot, opts: EatOptions = {}): Promise<EatResult> {
  const signal = opts.signal
  let food: Item | null
  if (typeof opts.food === 'string') food = bot.inventory.items().find(i => i.name === opts.food) ?? null
  else food = opts.food ?? bestFoodInInventory(bot, opts)
  if (food == null) throw new TaskError('MISSING_ITEMS', 'no food to eat')
  if (bot.food >= 20 && !ALWAYS_EDIBLE.has(food.name)) {
    throw new TaskError('FAILED', 'the food bar is full')
  }

  const previous = bot.heldItem
  const name = food.name
  const foodBefore = bot.food
  const countBefore = countItem(bot, name)
  const offhand = bot.inventory.slots[45]?.name === name && bot.heldItem?.name !== name
  if (!offhand && bot.heldItem?.name !== name) await bot.equip(food, 'hand')

  let finished = false
  const onStatus = (packet: any): void => {
    // EntityEvent.USE_ITEM_COMPLETE (9): the server finished the use (LivingEntity.completeUsingItem)
    if (packet.entityId === bot.entity.id && packet.entityStatus === 9) finished = true
  }
  bot._client.on('entity_status', onStatus)
  try {
    bot.deactivateItem()
    bot.activateItem(offhand)
    const maxTicks = opts.maxTicks ?? 72
    for (let i = 0; i < maxTicks && !finished; i++) {
      await waitTicks(bot, 1, signal)
      if (countItem(bot, name) < countBefore || bot.food > foodBefore) finished = true
    }
    if (!finished) throw new TaskError('TIMEOUT', `eating ${name} never finished`)
    // the food bar comes with the next set_health
    if (foodBefore < 20) for (let i = 0; i < 5 && bot.food === foodBefore; i++) await waitTicks(bot, 1, signal)
  } finally {
    bot._client.off('entity_status', onStatus)
    if (!finished) bot.deactivateItem()
  }
  if (opts.restoreHand !== false && previous != null && previous.name !== name && !offhand) {
    const back = bot.inventory.items().find(i => i.type === previous.type)
    if (back != null) await bot.equip(back, 'hand').catch(() => {})
  }
  return { item: name, foodBefore, foodAfter: bot.food, saturationAfter: bot.foodSaturation }
}

function countItem (bot: Bot, name: string): number {
  let n = 0
  for (const slot of bot.inventory.slots) if (slot?.name === name) n += slot.count
  return n
}
