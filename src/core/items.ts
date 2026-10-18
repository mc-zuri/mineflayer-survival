/**
 * Vanilla item constants that minecraft-data doesn't carry (or doesn't carry for 1.21.11):
 * furnace burn times, food values and tool materials.
 */

/** wood families, as the `<wood>_planks` items name them */
export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'] as const
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

/** vanilla Foods: nutrition and saturation (nutrition × modifier × 2) */
export const FOODS: Record<string, FoodInfo> = {
  apple: { nutrition: 4, saturation: 2.4 },
  baked_potato: { nutrition: 5, saturation: 6 },
  beef: { nutrition: 3, saturation: 1.8 },
  beetroot: { nutrition: 1, saturation: 1.2 },
  beetroot_soup: { nutrition: 6, saturation: 7.2 },
  bread: { nutrition: 5, saturation: 6 },
  carrot: { nutrition: 3, saturation: 3.6 },
  chicken: { nutrition: 2, saturation: 1.2, harmful: true },
  chorus_fruit: { nutrition: 4, saturation: 2.4 },
  cod: { nutrition: 2, saturation: 0.4 },
  cooked_beef: { nutrition: 8, saturation: 12.8 },
  cooked_chicken: { nutrition: 6, saturation: 7.2 },
  cooked_cod: { nutrition: 5, saturation: 6 },
  cooked_mutton: { nutrition: 6, saturation: 9.6 },
  cooked_porkchop: { nutrition: 8, saturation: 12.8 },
  cooked_rabbit: { nutrition: 5, saturation: 6 },
  cooked_salmon: { nutrition: 6, saturation: 9.6 },
  cookie: { nutrition: 2, saturation: 0.4 },
  dried_kelp: { nutrition: 1, saturation: 0.6 },
  enchanted_golden_apple: { nutrition: 4, saturation: 9.6 },
  glow_berries: { nutrition: 2, saturation: 0.4 },
  golden_apple: { nutrition: 4, saturation: 9.6 },
  golden_carrot: { nutrition: 6, saturation: 14.4 },
  honey_bottle: { nutrition: 6, saturation: 1.2 },
  melon_slice: { nutrition: 2, saturation: 1.2 },
  mushroom_stew: { nutrition: 6, saturation: 7.2 },
  mutton: { nutrition: 2, saturation: 1.2 },
  poisonous_potato: { nutrition: 2, saturation: 1.2, harmful: true },
  porkchop: { nutrition: 3, saturation: 1.8 },
  potato: { nutrition: 1, saturation: 0.6 },
  pufferfish: { nutrition: 1, saturation: 0.2, harmful: true },
  pumpkin_pie: { nutrition: 8, saturation: 4.8 },
  rabbit: { nutrition: 3, saturation: 1.8 },
  rabbit_stew: { nutrition: 10, saturation: 12 },
  rotten_flesh: { nutrition: 4, saturation: 0.8, harmful: true },
  salmon: { nutrition: 2, saturation: 0.4 },
  spider_eye: { nutrition: 2, saturation: 3.2, harmful: true },
  suspicious_stew: { nutrition: 6, saturation: 7.2 },
  sweet_berries: { nutrition: 2, saturation: 0.4 },
  tropical_fish: { nutrition: 1, saturation: 0.2 }
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
