import { Inventory } from '../core/inventory'
import { parseTool, TOOL_MATERIALS, type ToolKind } from '../core/items'
import type { WorldMemory } from '../core/memory'
import type { RegistryLike } from '../core/registry'
import { obtainAll, type ObtainOptions, type ObtainPlan, type ObtainRequest } from './obtain'
import type { Station } from './steps'
import { SMELTING } from './sources'

/** the plan's milestones, in order: wood → stone → food → base → iron → diamonds → enchanting → nether → eyes → end */
export type MilestoneId = 'wood' | 'stone' | 'food' | 'base' | 'iron' | 'diamonds' | 'enchanting' | 'nether' | 'eyes' | 'end'

export interface ProgressState {
  /** what the bot carries */
  inventory: Inventory
  /** worn armor and the offhand item */
  equipment?: string[]
  memory: WorldMemory
  /** stations placed at the base the bot can use */
  stations?: Station[]
  /** held or worn items that carry enchantments */
  enchanted?: string[]
  /** advancements earned, by vanilla id without the namespace ('end/kill_dragon') */
  advancements?: string[]
}

export interface Milestone {
  id: MilestoneId
  title: string
  done: (state: ProgressState) => boolean
  /** what to obtain for it, from where the state is */
  goals: (state: ProgressState) => ObtainRequest[]
}

/** eyes to have before looking for the stronghold: 12 for a frame with none filled, and 2 for the throws, which break 1 in 5 (vanilla EyeOfEnder) */
export const EYES_TARGET = 14
/** eyes left once the stronghold is found: enough for any frame */
export const EYES_FOR_FRAME = 12
/** bookshelves around the table for level 30 enchantments (vanilla EnchantmentHelper caps at 15), the most the milestone gets */
export const BOOKSHELVES = 15
/** logs the wood milestone cuts beyond its tools: the sticks and planks of the night down the mine */
export const SPARE_LOGS = 8

/** food points to carry before leaving the spawn area */
export const FOOD_POINTS = 40

/**
 * What the food milestone gathers its points from, by nutrition (vanilla Foods): the cooked meat and fish of the
 * furnace, bread and baked potatoes, and what is eaten as picked (sweet berries of the taiga, apples of oak and dark
 * oak leaves, melon slices of the jungle, a village's carrots, dried kelp of the sea). The raw meat isn't aimed for:
 * it cooks into twice the points (RAW_TO_COOKED), and the plan cooks what is held first.
 */
export const FOOD_GOAL = [
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'bread', 'baked_potato', 'sweet_berries', 'apple', 'melon_slice', 'carrot', 'beetroot', 'dried_kelp'
]

/** raw food a furnace cooks, to what (vanilla's food smelting recipes) */
export const RAW_TO_COOKED: Record<string, string> = Object.fromEntries(
  SMELTING.filter(r => FOOD_GOAL.includes(r.output) && r.output !== 'dried_kelp').map(r => [r.input[0], r.output])
)

/** the food milestone's goals: the raw food held cooked first (optional: without fuel it still counts), then the points */
export function foodGoals (inv: Inventory, points = FOOD_POINTS): ObtainRequest[] {
  const goals: ObtainRequest[] = []
  for (const [raw, cooked] of Object.entries(RAW_TO_COOKED)) {
    const n = inv.count(raw)
    if (n > 0) goals.push({ item: cooked, count: inv.count(cooked) + n, optional: true })
  }
  goals.push({ item: FOOD_GOAL, count: points, unit: 'nutrition' })
  return goals
}

const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'] as const
/** vanilla ArmorMaterials by defense, low to high */
const ARMOR_TIERS = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite']

/** tools of a kind at or above a material's harvest tier, the lowest first */
export function toolsAtLeast (kind: ToolKind, material: keyof typeof TOOL_MATERIALS): string[] {
  const tier = TOOL_MATERIALS[material].tier
  return (Object.keys(TOOL_MATERIALS) as Array<keyof typeof TOOL_MATERIALS>)
    .filter(m => TOOL_MATERIALS[m].tier >= tier && !(m === 'golden' && tier > 0))
    .sort((a, b) => (TOOL_MATERIALS[a].tier - TOOL_MATERIALS[b].tier) * 100 + TOOL_MATERIALS[a].speed - TOOL_MATERIALS[b].speed)
    .map(m => `${m}_${kind}`)
}

/** armor for a slot at or above a material */
export function armorAtLeast (slot: typeof ARMOR_SLOTS[number], material: string): string[] {
  return ARMOR_TIERS.slice(ARMOR_TIERS.indexOf(material)).map(m => `${m}_${slot}`)
}

/** carried and worn items together */
function owned (state: ProgressState): Inventory {
  const inv = state.inventory.clone()
  for (const e of state.equipment ?? []) inv.add(e, 1)
  return inv
}

function ownsAny (state: ProgressState, names: readonly string[]): boolean {
  return owned(state).countAny(names) > 0
}

function hasStation (state: ProgressState, station: Station): boolean {
  return state.stations?.includes(station) === true || state.inventory.has(station)
}

/** eyes the bot has or can craft from what it has */
export function eyesAvailable (state: ProgressState): number {
  const inv = state.inventory
  const powder = inv.count('blaze_powder') + 2 * inv.count('blaze_rod')
  return inv.count('ender_eye') + Math.min(powder, inv.count('ender_pearl'))
}

const portalKnown = (state: ProgressState): boolean => state.memory.getPois('nether_portal').length > 0

export const MILESTONES: readonly Milestone[] = [
  {
    id: 'wood',
    title: 'logs, planks, a crafting table and a wooden pickaxe',
    done: s => ownsAny(s, toolsAtLeast('pickaxe', 'wooden')) && hasStation(s, 'crafting_table'),
    goals: s => [
      ...(hasStation(s, 'crafting_table') ? [] : [{ item: 'crafting_table', count: 1 }]),
      { item: toolsAtLeast('pickaxe', 'wooden'), count: 1 },
      // wood to spare, for the sticks of the night's torches and tools down the mine, where no tree grows
      { item: '#logs_that_burn', count: SPARE_LOGS, optional: true }
    ]
  },
  {
    id: 'stone',
    title: 'stone tools and a furnace',
    done: s => ownsAny(s, toolsAtLeast('pickaxe', 'stone')) && ownsAny(s, toolsAtLeast('sword', 'stone')) &&
      ownsAny(s, toolsAtLeast('axe', 'stone')) && hasStation(s, 'furnace'),
    goals: s => [
      { item: toolsAtLeast('pickaxe', 'stone'), count: 1 },
      { item: toolsAtLeast('sword', 'stone'), count: 1 },
      { item: toolsAtLeast('axe', 'stone'), count: 1 },
      ...(hasStation(s, 'furnace') ? [] : [{ item: 'furnace', count: 1 }])
    ]
  },
  {
    id: 'food',
    title: 'food: meat cooked, berries, apples, melons, crops or fish',
    done: s => s.inventory.foodPoints() >= FOOD_POINTS,
    goals: s => foodGoals(s.inventory)
  },
  {
    id: 'base',
    title: 'a minimal house: dug in, a door, the table and a furnace, chests, lit, a bed with wool',
    // the base skill builds it (HOUSE_BLUEPRINT); the goals are its materials
    done: s => s.memory.base != null,
    goals: () => [
      { item: '#stone_crafting_materials', count: 48 },
      { item: 'torch', count: 8 },
      { item: 'chest', count: 2 }
    ]
  },
  {
    id: 'iron',
    title: 'iron pickaxe, sword, armor, a shield and a bucket',
    done: s => ownsAny(s, toolsAtLeast('pickaxe', 'iron')) && ownsAny(s, toolsAtLeast('sword', 'iron')) &&
      ARMOR_SLOTS.every(slot => ownsAny(s, armorAtLeast(slot, 'iron'))) && ownsAny(s, ['shield']) &&
      ownsAny(s, ['bucket', 'water_bucket', 'lava_bucket']),
    goals: () => [
      { item: toolsAtLeast('pickaxe', 'iron'), count: 1 },
      { item: toolsAtLeast('sword', 'iron'), count: 1 },
      ...ARMOR_SLOTS.map(slot => ({ item: armorAtLeast(slot, 'iron'), count: 1 })),
      { item: 'shield', count: 1 },
      { item: ['bucket', 'water_bucket', 'lava_bucket'], count: 1 }
    ]
  },
  {
    id: 'diamonds',
    title: 'a diamond pickaxe and sword, armor when there are enough diamonds',
    done: s => ownsAny(s, toolsAtLeast('pickaxe', 'diamond')) && ownsAny(s, toolsAtLeast('sword', 'diamond')),
    goals: s => diamondGoals(s)
  },
  {
    id: 'enchanting',
    title: 'an enchanting table with 15 bookshelves, and enchanted gear',
    done: s => s.memory.getPois('enchanting_table').length > 0 && (s.enchanted ?? []).some(n => parseTool(n)?.kind === 'pickaxe'),
    // (the bookshelves are the handler's: as many as the world gives within a budget, up to BOOKSHELVES)
    goals: s => [
      ...(s.memory.getPois('enchanting_table').length > 0 ? [] : [{ item: 'enchanting_table', count: 1 }]),
      { item: 'lapis_lazuli', count: 9 }
    ]
  },
  {
    id: 'nether',
    title: 'a portal, blaze rods from a fortress and ender pearls',
    done: s => eyesAvailable(s) >= EYES_TARGET,
    goals: s => {
      const inv = s.inventory
      const eyes = inv.count('ender_eye')
      const powder = inv.count('blaze_powder')
      const goals: ObtainRequest[] = []
      if (!portalKnown(s)) goals.push({ item: 'obsidian', count: 10 }, { item: 'flint_and_steel', count: 1 })
      const rods = Math.max(0, Math.ceil((EYES_TARGET - eyes - powder) / 2))
      const pearls = Math.max(0, EYES_TARGET - eyes)
      if (rods > 0) goals.push({ item: 'blaze_rod', count: rods })
      if (pearls > 0) goals.push({ item: 'ender_pearl', count: pearls })
      return goals
    }
  },
  {
    id: 'eyes',
    title: 'craft the eyes and triangulate the stronghold',
    done: s => s.memory.getPois('stronghold').length > 0 && s.inventory.count('ender_eye') >= EYES_FOR_FRAME,
    goals: () => [{ item: 'ender_eye', count: EYES_TARGET }]
  },
  {
    id: 'end',
    title: 'fill the portal, destroy the crystals and kill the dragon',
    done: s => (s.advancements ?? []).includes('end/kill_dragon'),
    goals: () => [
      { item: 'bow', count: 1 },
      { item: 'arrow', count: 64 },
      { item: '#stone_crafting_materials', count: 64 },
      { item: 'water_bucket', count: 1 },
      { item: '#cooked_food', count: 16 }
    ]
  }
]

/** diamonds each piece takes (vanilla's recipes) */
const DIAMOND_COST: Record<string, number> = { pickaxe: 3, sword: 2, helmet: 5, chestplate: 8, leggings: 7, boots: 4 }

/**
 * The diamonds milestone's goals: the pickaxe and the sword, and the armor pieces the diamonds held beyond those pay
 * for, cheapest first, as optional goals; not armor planned from diamonds yet to be found: the plan for all of it mined
 * 14 diamonds, at 600 ticks of strip mining each, where 5 make the milestone
 */
export function diamondGoals (s: ProgressState): ObtainRequest[] {
  const goals: ObtainRequest[] = [
    { item: toolsAtLeast('pickaxe', 'diamond'), count: 1 },
    { item: toolsAtLeast('sword', 'diamond'), count: 1 }
  ]
  let spare = s.inventory.count('diamond')
  for (const kind of ['pickaxe', 'sword'] as const) if (!ownsAny(s, toolsAtLeast(kind, 'diamond'))) spare -= DIAMOND_COST[kind]
  for (const slot of [...ARMOR_SLOTS].sort((a, b) => DIAMOND_COST[a] - DIAMOND_COST[b])) {
    if (ownsAny(s, armorAtLeast(slot, 'diamond')) || spare < DIAMOND_COST[slot]) continue
    spare -= DIAMOND_COST[slot]
    goals.push({ item: armorAtLeast(slot, 'diamond'), count: 1, optional: true })
  }
  return goals
}

export function milestone (id: MilestoneId): Milestone {
  return MILESTONES.find(m => m.id === id) as Milestone
}

/** the first milestone not done yet, or null once the dragon is dead */
export function nextMilestone (state: ProgressState): Milestone | null {
  return MILESTONES.find(m => !m.done(state)) ?? null
}

/** plans a milestone's goals from the state (worn armor counts as held) */
export function planMilestone (registry: RegistryLike, m: Milestone, state: ProgressState, opts: Omit<ObtainOptions, 'inventory' | 'memory' | 'stations'> = {}): ObtainPlan {
  return obtainAll(registry, m.goals(state), { ...opts, inventory: owned(state), memory: state.memory, stations: state.stations })
}
