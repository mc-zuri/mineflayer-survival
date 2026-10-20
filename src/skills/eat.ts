import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { chooseFood, type FoodChoiceOptions, type HungerState } from './food'
import { ALWAYS_EDIBLE, foodInfo } from '../core/items'
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

/**
 * Food kept for a trip (the nether gate's points): the eat reflex eats into it only in need (starving, or hurt), so
 * the food got for the trip isn't eaten as fast as it's got. A 26.3 bot gathering the gate's 120 points ate its 12
 * porkchops and all it cooked on 32000 ticks of exploring for melons, and was at 1 health and no food at the end
 * (full-26.3-fresh-m). Held until the tick `until` (the bot's task clock), in the overworld only.
 */
export interface FoodReserve { points: number, until: number }
const reserves = new WeakMap<Bot, FoodReserve>()

const clock = (bot: Bot): number => Number((bot as any).survival?.tasks?.tick ?? 0)

/** keeps `points` of food for `ticks` (0 points: none kept) */
export function setFoodReserve (bot: Bot, points: number, ticks: number): void {
  if (points <= 0) reserves.delete(bot)
  else reserves.set(bot, { points, until: clock(bot) + ticks })
}

/** the food points kept now (0 when none, out of time, or out of the overworld) */
export function foodReserve (bot: Bot): number {
  const r = reserves.get(bot)
  if (r == null || clock(bot) >= r.until) return 0
  if (bot.game?.dimension != null && !/overworld/.test(String(bot.game.dimension))) return 0
  return r.points
}

/** the nutrition of the safe food in the bag (the off hand's too) */
export function heldFoodPoints (bot: Bot): number {
  const items = [...bot.inventory.items(), ...(bot.inventory.slots[45] != null ? [bot.inventory.slots[45]] : [])]
  let points = 0
  for (const it of items) {
    const food = foodInfo(bot.registry as any, it.name)
    if (food != null && food.harmful !== true) points += food.nutrition * it.count
  }
  return points
}

/** whether eating `item` leaves the reserve whole */
export function reserveAllows (bot: Bot, item: Pick<Item, 'name'>): boolean {
  const kept = foodReserve(bot)
  if (kept <= 0) return true
  const food = foodInfo(bot.registry as any, item.name)
  return heldFoodPoints(bot) - (food?.nutrition ?? 0) >= kept
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
