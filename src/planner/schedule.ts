// The day and night schedule: the day for what the surface has (wood, food, the farm, the house), the night for
// mining, where the dark is the same at any hour and the surface's monsters aren't. A bed skips the night; with no
// pickaxe to dig down with the night is waited out in a shelter (the night reflex's), the fallback it always was.
import { Inventory } from '../core/inventory'
import { ENCHANTING_LAPIS, FOOD_POINTS, toolsAtLeast, type MilestoneId } from './progression'
import type { ObtainRequest } from './obtain'
import type { StockPlace } from './stock'

export type DayPhase = 'day' | 'dusk' | 'night'

/**
 * When the bot leaves surface work for the night: time enough to dig a staircase down (a block every 20 to 40 ticks)
 * before the monsters come out. Hostiles spawn at sky light 0 to 7 under Monster.isDarkEnoughToSpawn, from about
 * 13000; a bed works from 12542 (BedBlock, Level.isDarkOutside), the sky dark until 23460.
 */
export const DUSK_START = 11500
export const NIGHT_START = 12542
export const NIGHT_END = 23460

/** the phase of the day at a time of day (0 to 24000, sunrise at 0) */
export function dayPhase (timeOfDay: number): DayPhase {
  const t = ((timeOfDay % 24000) + 24000) % 24000
  if (t >= NIGHT_START && t < NIGHT_END) return 'night'
  if (t >= DUSK_START && t < NIGHT_START) return 'dusk'
  return 'day'
}

/** torches carried into the mine: one every TORCH_SPACING blocks of tunnel and staircase lights it (a coal is 4) */
export const TORCH_BUDGET = 16
export const TORCH_SPACING = 8

/** what to do with the night */
export type NightAction = 'work' | 'sleep' | 'mine' | 'shelter'

export interface NightInputs {
  phase: DayPhase
  /** the bot is in the overworld (the other dimensions have no night) */
  overworld: boolean
  /** a bed held, at the base, or standing nearby */
  bed: boolean
  /** the pickaxe carried, if any */
  pickaxe: string | null
  /** something to mine at night (nightGoals has goals) */
  goals: boolean
}

/**
 * The schedule's decision for now: by day, the work; from dusk, a bed when there's one (the night skipped), else down
 * into the mine with a pickaxe and something to mine there; else the shelter.
 */
export function nightAction (i: NightInputs): NightAction {
  if (i.phase === 'day' || !i.overworld) return 'work'
  if (i.bed && i.phase === 'night') return 'sleep'
  if (i.bed) return 'work'
  if (i.pickaxe != null && i.goals) return 'mine'
  return i.phase === 'night' ? 'shelter' : 'work'
}

/** iron for the iron milestone: a pickaxe 3, a sword 2, the armor 24, a shield 1 and a bucket 3 */
export const IRON_FOR_MILESTONE = 33
/** diamonds for a pickaxe and a sword */
export const DIAMONDS_FOR_MILESTONE = 5

/**
 * What the night's mining is for, from what's reached: torches first (coal, TORCH_BUDGET), then the iron the iron
 * milestone needs, then (with an iron pickaxe) the diamonds, then lapis for the enchanting. Each is optional: what
 * can't be had down there (sticks with no wood held) is left for the day.
 */
export function nightGoals (inv: Inventory, reached: readonly MilestoneId[]): ObtainRequest[] {
  const goals: ObtainRequest[] = []
  const torches = inv.count('torch')
  if (torches < TORCH_BUDGET) goals.push({ item: 'torch', count: TORCH_BUDGET, optional: true })
  const pickaxe = (material: 'stone' | 'iron'): boolean => inv.countAny(toolsAtLeast('pickaxe', material)) > 0
  if (!reached.includes('iron')) {
    if (!pickaxe('stone')) {
      goals.push({ item: toolsAtLeast('pickaxe', 'stone'), count: 1, optional: true })
      goals.push({ item: 'coal', count: inv.count('coal') + 8, optional: true })
      return goals
    }
    // the shield first, from the first iron ore: the skeletons of the caves shot 10 of the 17 deaths of the iron runs,
    // and the hostiles reflex blocks their arrows with one (it took to the end of the iron milestone before)
    if (inv.count('shield') === 0) goals.push({ item: 'shield', count: 1, optional: true })
    const iron = inv.count('iron_ingot') + inv.count('raw_iron')
    // coal for the iron's smelting (a coal burns 8 items): without it the logs carried down were burnt, and the
    // morning's plan climbed out for wood for the shield (seed 7, 15000 ticks)
    const coal = Math.ceil(Math.max(0, IRON_FOR_MILESTONE - inv.count('iron_ingot')) / 8)
    if (inv.count('coal') + inv.count('charcoal') < coal) goals.push({ item: 'coal', count: coal, optional: true })
    if (iron < IRON_FOR_MILESTONE) goals.push({ item: 'raw_iron', count: inv.count('raw_iron') + IRON_FOR_MILESTONE - iron, optional: true })
    return goals
  }
  if (!reached.includes('diamonds') && pickaxe('iron')) {
    if (inv.count('diamond') < DIAMONDS_FOR_MILESTONE) goals.push({ item: 'diamond', count: DIAMONDS_FOR_MILESTONE, optional: true })
    return goals
  }
  if (!reached.includes('enchanting') && pickaxe('stone') && inv.count('lapis_lazuli') < ENCHANTING_LAPIS) goals.push({ item: 'lapis_lazuli', count: ENCHANTING_LAPIS, optional: true })
  return goals
}

/** the hunger bar (the player's food level, 0 to 20) at which a bot with no food to eat leaves the mine */
export const HUNGRY = 6

/**
 * Whether the night's mining stops for the surface: the day is back, or the bot is hungry (HUNGRY) with less than a
 * quarter of FOOD_POINTS to eat (the restock is a surface trip). With a full bar it mines on without food: the bar
 * lasts a night's digging (FoodData's exhaustion: 0.005 a block broken)
 */
export function comeUp (phase: DayPhase, foodPoints: number, hunger = 20): boolean {
  return phase === 'day' || (hunger <= HUNGRY && foodPoints < FOOD_POINTS / 4)
}

/**
 * Where the stock's top-ups (planner/stock.ts) are got now: the surface's (wood, food, arrows) by day and dusk on the
 * surface, the mine's (stone, coal, the ores, torches) at night down the mine, and by day too when the bot is deep down
 * there already (under the surface's lowest y, where the iron's or the diamonds' work ended; not a pit or a hill's cave
 * by the surface): neither a climb up for logs from the mine nor a trip down for coal in the day's surface work.
 */
export function topUpPlaces (phase: DayPhase, deep: boolean): StockPlace[] {
  if (phase === 'night' || deep) return ['underground']
  return ['surface']
}
