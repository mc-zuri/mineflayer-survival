// Food choice: what to eat given the hunger bar, as vanilla's FoodData.eat adds it up (nutrition capped at 20,
// saturation capped at the new food level), keeping the harmful foods for when the bot is starving and the golden
// apples for when its health is low.
import { HARMFUL_FOODS, NOT_EATEN, RESERVED_FOODS, TELEPORTING_FOODS } from '../core/items'

export interface FoodValues {
  name: string
  /** FoodProperties.nutrition */
  foodPoints: number
  /** FoodProperties.saturation (nutrition x modifier x 2) */
  saturation: number
}

export interface HungerState {
  food: number
  saturation: number
  health: number
}

export interface FoodChoiceOptions {
  /** food at or below which the harmful foods are eaten too (default 6: below it the player can't sprint) */
  starvingFood?: number
  /** health at or below which the reserved foods are eaten (default 8) */
  lowHealth?: number
  /** eaten only when starving (their effects: FoodProperties / Consumable on_consume_effects) */
  harmful?: string[]
  /** eaten only at low health */
  reserved?: string[]
  /** never eaten */
  banned?: string[]
  /** how much each point of nutrition beyond 20 counts against a food (default 0.5) */
  wastePenalty?: number
}

export const DEFAULT_FOOD_CHOICE: Required<FoodChoiceOptions> = {
  starvingFood: 6,
  lowHealth: 8,
  harmful: HARMFUL_FOODS,
  reserved: RESERVED_FOODS,
  banned: TELEPORTING_FOODS,
  wastePenalty: 0.5
}

// FoodProperties.canAlwaysEat: eaten even with a full bar
const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew'])

/** What eating the food leaves the bar at (FoodData.eat: food capped at 20, saturation at the new food level). */
export function afterEating (state: HungerState, food: FoodValues): { food: number, saturation: number } {
  const newFood = Math.min(state.food + food.foodPoints, 20)
  return { food: newFood, saturation: Math.min(state.saturation + food.saturation, newFood) }
}

/** The worth of eating it now: the hunger and saturation it fills, less the nutrition that goes past 20. */
export function foodScore (state: HungerState, food: FoodValues, wastePenalty = DEFAULT_FOOD_CHOICE.wastePenalty): number {
  const after = afterEating(state, food)
  const gained = (after.food - state.food) + (after.saturation - state.saturation)
  const wasted = Math.max(0, state.food + food.foodPoints - 20)
  return gained - wastePenalty * wasted
}

export function canEat (state: HungerState, name: string): boolean {
  return state.food < 20 || ALWAYS_EDIBLE.has(name)
}

/**
 * The best food of the candidates (inventory item names) for the hunger state, or null. Harmful foods only when
 * starving, reserved ones only at low health (and then first), banned never.
 */
export function chooseFood<T extends { name: string }> (
  candidates: T[],
  foods: Record<string, FoodValues | undefined>,
  state: HungerState,
  opts: FoodChoiceOptions = {}
): T | null {
  const o = { ...DEFAULT_FOOD_CHOICE, ...opts }
  const starving = state.food <= o.starvingFood
  const lowHealth = state.health <= o.lowHealth
  let best: T | null = null
  let bestScore = -Infinity
  for (const item of candidates) {
    const food = foods[item.name]
    if (food == null || NOT_EATEN.has(item.name) || o.banned.includes(item.name) || !canEat(state, item.name)) continue
    if (o.harmful.includes(item.name) && !starving) continue
    const reserved = o.reserved.includes(item.name)
    if (reserved && !lowHealth) continue
    // at low health a golden apple's absorption and regeneration beat any nutrition
    const score = foodScore(state, food, o.wastePenalty) + (reserved ? 1000 : 0) - (o.harmful.includes(item.name) ? 100 : 0)
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}
