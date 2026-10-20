// Food choice: what to eat given the hunger bar, as vanilla's FoodData.eat adds it up (nutrition capped at 20,
// saturation capped at the new food level), keeping the harmful foods for when the bot is starving and the golden
// apples for when its health is low.
import { ALWAYS_EDIBLE, HARMFUL_FOODS, NOT_EATEN, RESERVED_FOODS, TELEPORTING_FOODS } from '../core/items'

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

/** FoodData.tick heals the bot only with the bar at 18 or more (slowly, of the bar; quickly at 20, of the saturation) */
export const HEAL_FOOD = 18
/** at or under this health a meal is eaten whether it fits the bar or not (the eat reflex's own health mark) */
export const MEAL_URGENT_HEALTH = 10

/** whether a meal of `nutrition` goes into the bar whole (FoodData.eat: the food level capped at 20) */
export function mealFits (food: number, nutrition: number): boolean {
  return food + nutrition <= 20
}

/** the marks mealWorthIt goes by */
export interface MealMarks {
  /** hurt at or under this health, a meal that doesn't fit is eaten once the bar is under HEAL_FOOD */
  hurtAt: number
  /** at or under this health one is eaten whatever the bar (default MEAL_URGENT_HEALTH) */
  urgentAt?: number
  /** at or under this food level one is eaten whatever (default 6: no sprinting under it) */
  starving?: number
}

/**
 * Whether a meal of `nutrition` is worth eating now, as FoodData adds it up: one that fits the bar whole (nutrition
 * over 20 is lost, FoodData.eat), or one the health needs: at `urgentAt` health whatever the bar, or hurt at `hurtAt`
 * with the bar under HEAL_FOOD (FoodData.tick heals nothing under 18: the bar's top and the saturation are what heal,
 * so a meal at 17 heals as much as one at 12), or starving. A 26.3 bot in the blaze nook ate a porkchop at food 18
 * and 19 each time its health was 14 or under, most of its 8 nutrition over the bar, some 71% of its food's worth
 * got, and its 15 porkchops were gone before its 2 rods (tests/integration/blaze BLAZE_BREW=1).
 */
export function mealWorthIt (state: Pick<HungerState, 'food' | 'health'>, nutrition: number, marks: MealMarks): boolean {
  if (state.food >= 20) return false
  if (mealFits(state.food, nutrition)) return true
  if (state.food <= (marks.starving ?? DEFAULT_FOOD_CHOICE.starvingFood)) return true
  if (state.health <= (marks.urgentAt ?? MEAL_URGENT_HEALTH)) return true
  return state.food < HEAL_FOOD && state.health <= marks.hurtAt
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
