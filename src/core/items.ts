import { cachedPerRegistry, type RegistryLike } from './registry'

/**
 * Vanilla item constants that minecraft-data doesn't carry: furnace burn times, what foods do and tool materials.
 *
 * One table serves 1.21.11 and 26.3. Every item both versions have has the same burn time (1.21.11's
 * FuelValues.vanillaBurnTimes against 26.3's cooking_fuel item components), the same food (Foods; the values are read
 * from minecraft-data's foods, see foodsOf) and the same tool
 * material (ToolMaterial). The 26.3 items (poplar wood, wool slabs and stairs, cushions) are in it as well: an item a
 * version doesn't have never comes up there.
 */

/**
 * wood families, as the `<wood>_planks` items name them; 26.3 adds poplar (the users of this list keep to the woods the
 * version's registry has)
 */
export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo', 'crimson', 'warped'] as const
/** vanilla #non_flammable_wood: removed from the fuel map */
export const NON_FLAMMABLE_WOOD = ['crimson', 'warped']

/** the furnace cook time of one item, AbstractCookingRecipe default for smelting */
export const SMELT_TICKS = 200

const FIXED_BURN: Record<string, number> = {
  lava_bucket: 20000,
  coal_block: 16000,
  dried_kelp_block: 4001,
  blaze_rod: 2400,
  coal: 1600,
  charcoal: 1600,
  bamboo_mosaic: 300,
  bamboo_mosaic_stairs: 300,
  bamboo_mosaic_slab: 150,
  note_block: 300,
  bookshelf: 300,
  chiseled_bookshelf: 300,
  lectern: 300,
  jukebox: 300,
  chest: 300,
  trapped_chest: 300,
  crafting_table: 300,
  daylight_detector: 300,
  bow: 300,
  fishing_rod: 300,
  ladder: 300,
  crossbow: 300,
  mangrove_roots: 300,
  wooden_shovel: 200,
  wooden_sword: 200,
  wooden_hoe: 200,
  wooden_axe: 200,
  wooden_pickaxe: 200,
  bamboo_raft: 1200,
  bamboo_chest_raft: 1200,
  stick: 100,
  bowl: 100,
  dead_bush: 100,
  azalea: 100,
  flowering_azalea: 100,
  bamboo: 50,
  scaffolding: 50,
  wooden_spear: 200,
  loom: 300,
  barrel: 300,
  cartography_table: 300,
  fletching_table: 300,
  smithing_table: 300,
  composter: 300,
  short_dry_grass: 100,
  tall_dry_grass: 100,
  leaf_litter: 100
}

/** wooden item suffix → burn ticks, for every wood family that burns */
const WOOD_SUFFIX_BURN: Array<[string, number]> = [
  ['_hanging_sign', 800],
  ['_chest_boat', 1200],
  ['_boat', 1200],
  ['_planks', 300],
  ['_log', 300],
  ['_wood', 300],
  ['_stairs', 300],
  ['_slab', 150],
  ['_trapdoor', 300],
  ['_pressure_plate', 300],
  ['_fence_gate', 300],
  ['_fence', 300],
  ['_shelf', 300],
  ['_sign', 200],
  ['_door', 200],
  ['_button', 100],
  ['_sapling', 100]
]

/**
 * Burn time in ticks of one item in a furnace; 0 if it isn't fuel.
 * Matches vanilla FuelValues.vanillaBurnTimes (1.21.2+), including `.remove(#non_flammable_wood)`.
 */
export function burnTicks (name: string): number {
  const fixed = FIXED_BURN[name]
  if (fixed != null) return fixed
  if (name.endsWith('_wool')) return 100
  // 26.3: the wool slabs (cooking/time_wool_slabs) and the cushions 50, the wool stairs (cooking/time_wool) 100
  if (name.endsWith('_wool_slab') || name.endsWith('_cushion')) return 50
  if (name.endsWith('_wool_stairs')) return 100
  if (name.endsWith('_carpet') && name !== 'moss_carpet' && name !== 'pale_moss_carpet') return 67
  if (name.endsWith('_banner') && !name.endsWith('_wall_banner')) return 300
  if (name === 'bamboo_block' || name === 'stripped_bamboo_block') return 300
  const base = name.startsWith('stripped_') ? name.slice('stripped_'.length) : name
  for (const wood of WOOD_TYPES) {
    if (!base.startsWith(wood + '_')) continue
    if (NON_FLAMMABLE_WOOD.includes(wood)) return 0
    const rest = base.slice(wood.length)
    for (const [suffix, ticks] of WOOD_SUFFIX_BURN) if (rest === suffix) return ticks
  }
  if (name.endsWith('_sapling') || name === 'mangrove_propagule') return 100
  return 0
}

export interface FoodInfo {
  nutrition: number
  saturation: number
  /** poisons, hunger or worse: eaten only when starving */
  harmful?: boolean
}

/**
 * Foods minecraft-data lists that can't be eaten: the fish buckets carry a food component (Items: `.component(FOOD,
 * Foods.COD)`, 1.21.11 and 26.3) but no consumable one, so using one empties the fish out (MobBucketItem)
 */
export const NOT_EATEN = new Set(['cod_bucket', 'salmon_bucket', 'pufferfish_bucket', 'tropical_fish_bucket'])

/**
 * Foods whose consume effects hurt (Foods / Consumables): rotten_flesh 80% hunger, spider_eye poison,
 * poisonous_potato 60% poison, pufferfish poison, hunger and nausea, raw chicken 30% hunger. The same in 26.3.
 */
export const HARMFUL_FOODS = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']
/** the golden apples: their absorption and regeneration (Consumables.GOLDEN_APPLE, ENCHANTED_GOLDEN_APPLE) are kept for low health */
export const RESERVED_FOODS = ['golden_apple', 'enchanted_golden_apple']
/** chorus fruit teleports whoever eats it (Consumables: teleport_randomly) */
export const TELEPORTING_FOODS = ['chorus_fruit']

/**
 * The version's foods: nutrition and saturation from minecraft-data (FoodProperties: nutrition × modifier × 2 for
 * saturation; the same values in 1.21.11 and 26.3), less the ones that can't be eaten, with what they do.
 */
export const foodsOf = cachedPerRegistry((registry: RegistryLike): Record<string, FoodInfo> => {
  const out: Record<string, FoodInfo> = {}
  for (const [name, food] of Object.entries(registry.foodsByName ?? {})) {
    if (NOT_EATEN.has(name)) continue
    out[name] = { nutrition: food.foodPoints, saturation: food.saturation, ...(HARMFUL_FOODS.includes(name) ? { harmful: true } : {}) }
  }
  return out
})

/** a food of the version (nutrition, saturation, harmful), or null for anything that isn't eaten */
export function foodInfo (registry: RegistryLike, name: string): FoodInfo | null {
  return foodsOf(registry)[name] ?? null
}

/** a food the bot eats whenever hungry: edible and not harmful */
export function isSafeFood (registry: RegistryLike, name: string): boolean {
  const food = foodInfo(registry, name)
  return food != null && food.harmful !== true
}

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'
export type ToolMaterial = 'wooden' | 'stone' | 'copper' | 'iron' | 'golden' | 'diamond' | 'netherite'

export const TOOL_KINDS: readonly ToolKind[] = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']

/**
 * Vanilla ToolMaterial: `tier` is the harvest level (the incorrect_for_<material>_tool tags:
 * copper and gold mine what stone and wood mine), `speed` the mining speed on a correct block.
 */
export const TOOL_MATERIALS: Record<ToolMaterial, { tier: number, speed: number }> = {
  wooden: { tier: 0, speed: 2 },
  golden: { tier: 0, speed: 12 },
  stone: { tier: 1, speed: 4 },
  copper: { tier: 1, speed: 5 },
  iron: { tier: 2, speed: 6 },
  diamond: { tier: 3, speed: 8 },
  netherite: { tier: 4, speed: 9 }
}

/** order for "best tool": harvest tier first, then speed, gold last within its tier for its low durability */
export const TOOL_MATERIAL_RANK: readonly ToolMaterial[] = ['golden', 'wooden', 'stone', 'copper', 'iron', 'diamond', 'netherite']

export function parseTool (name: string): { material: ToolMaterial, kind: ToolKind } | null {
  const i = name.lastIndexOf('_')
  if (i < 0) return null
  const material = name.slice(0, i) as ToolMaterial
  const kind = name.slice(i + 1) as ToolKind
  if (TOOL_MATERIALS[material] == null || !TOOL_KINDS.includes(kind)) return null
  return { material, kind }
}

/** the tool kind that mines a block faster, from its minecraft-data `material` ("mineable/pickaxe", "leaves;mineable/hoe", ...) */
export function toolKindForMaterial (material: string | undefined): ToolKind | null {
  if (material == null) return null
  for (const part of material.split(';')) {
    if (part.startsWith('mineable/')) {
      const kind = part.slice('mineable/'.length) as ToolKind
      if (TOOL_KINDS.includes(kind)) return kind
    }
  }
  if (material.includes('sword_instantly_mines') || material === 'coweb') return 'sword'
  return null
}

/**
 * A bed the bot carries, sleeps in and builds into its base, its spawn point: a `<colour>_bed` (BedBlock). Not 26.3's
 * straw_bed (StrawBedBlock): in the overworld it lets you sleep when it's dark but sets no spawn and is gone once you
 * get up (STRAW_BED_RULE DESTROY_ON_LEAVE), and elsewhere it breaks when used (DESTROY_ON_USE).
 */
export function isBed (name: string): boolean {
  return name.endsWith('_bed') && name !== 'straw_bed'
}
