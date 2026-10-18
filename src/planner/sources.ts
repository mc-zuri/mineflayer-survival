import { WOOD_TYPES, NON_FLAMMABLE_WOOD } from '../core/items'
import type { Dimension } from '../core/memory'

/**
 * Where items come from besides crafting, as vanilla's loot tables and recipes have it.
 * minecraft-data's blockLoot/entityLoot flatten the loot tables (silk-touch alternatives
 * become 50% chances, uniform counts lose their zero), so the yields here are written out
 * from the vanilla tables, without Fortune or Looting. Costs are rough tick estimates:
 * `find` to reach the first one from a random spot, `each` to reach every further one.
 */

export interface Drop {
  item: string
  /** expected count per block or kill */
  count: number
}

export interface BlockSource {
  block: string
  drops: Drop[]
  dimension: Dimension
  find: number
  each: number
}

export interface MobSource {
  mob: string
  drops: Drop[]
  dimension: Dimension
  find: number
  each: number
}

export interface SmeltingRecipe {
  /** item names or `#tags` */
  input: string[]
  output: string
}

export interface BarterOffer {
  item: string
  /** expected items per gold ingot: weight / 459 × mean count (vanilla piglin_bartering) */
  perIngot: number
}

export interface FluidSource {
  item: 'water_bucket' | 'lava_bucket'
  fluid: 'water' | 'lava'
  dimension: Dimension
  find: number
}

function block (name: string, drops: Drop[] | string, find: number, each: number, dimension: Dimension = 'overworld'): BlockSource {
  return { block: name, drops: typeof drops === 'string' ? [{ item: drops, count: 1 }] : drops, dimension, find, each }
}

function logSources (): BlockSource[] {
  const out: BlockSource[] = []
  for (const wood of WOOD_TYPES) {
    if (wood === 'bamboo') continue
    if (NON_FLAMMABLE_WOOD.includes(wood)) {
      out.push(block(`${wood}_stem`, `${wood}_stem`, 400, 20, 'the_nether'))
      continue
    }
    const common = wood === 'oak' || wood === 'birch' || wood === 'spruce'
    out.push(block(`${wood}_log`, `${wood}_log`, common ? 100 : wood === 'pale_oak' ? 2000 : 600, 20))
  }
  return out
}

export const BLOCK_SOURCES: BlockSource[] = [
  ...logSources(),
  block('stone', 'cobblestone', 40, 6),
  block('deepslate', 'cobbled_deepslate', 900, 6),
  block('grass_block', 'dirt', 5, 5),
  block('dirt', 'dirt', 10, 5),
  block('short_grass', [{ item: 'wheat_seeds', count: 0.125 }], 10, 3),
  block('sand', 'sand', 300, 5),
  block('red_sand', 'red_sand', 3000, 5),
  block('gravel', [{ item: 'gravel', count: 0.9 }, { item: 'flint', count: 0.1 }], 200, 8),
  block('clay', [{ item: 'clay_ball', count: 4 }], 1200, 10),
  block('oak_leaves', [{ item: 'apple', count: 0.005 }, { item: 'oak_sapling', count: 0.05 }, { item: 'stick', count: 0.03 }], 100, 3),
  block('sugar_cane', 'sugar_cane', 600, 10),
  block('cactus', 'cactus', 3000, 10),
  block('pumpkin', 'pumpkin', 3000, 20),
  block('melon', [{ item: 'melon_slice', count: 5 }], 4000, 20),
  block('bamboo', 'bamboo', 4000, 5),
  block('kelp_plant', 'kelp', 1000, 5),
  block('coal_ore', 'coal', 300, 40),
  block('deepslate_coal_ore', 'coal', 1500, 40),
  block('iron_ore', 'raw_iron', 600, 40),
  block('deepslate_iron_ore', 'raw_iron', 900, 40),
  block('copper_ore', [{ item: 'raw_copper', count: 3.5 }], 500, 30),
  block('deepslate_copper_ore', [{ item: 'raw_copper', count: 3.5 }], 900, 30),
  block('gold_ore', 'raw_gold', 2000, 60),
  block('deepslate_gold_ore', 'raw_gold', 1800, 60),
  block('redstone_ore', [{ item: 'redstone', count: 4.5 }], 2500, 40),
  block('deepslate_redstone_ore', [{ item: 'redstone', count: 4.5 }], 2000, 40),
  block('lapis_ore', [{ item: 'lapis_lazuli', count: 6.5 }], 3000, 40),
  block('deepslate_lapis_ore', [{ item: 'lapis_lazuli', count: 6.5 }], 2500, 40),
  block('diamond_ore', 'diamond', 7000, 60),
  block('deepslate_diamond_ore', 'diamond', 6000, 60),
  block('emerald_ore', 'emerald', 15000, 200),
  block('obsidian', 'obsidian', 3000, 20),
  block('netherrack', 'netherrack', 5, 3, 'the_nether'),
  block('nether_gold_ore', [{ item: 'gold_nugget', count: 4 }], 300, 30, 'the_nether'),
  block('nether_quartz_ore', 'quartz', 400, 30, 'the_nether'),
  block('glowstone', [{ item: 'glowstone_dust', count: 3 }], 1500, 10, 'the_nether'),
  block('soul_sand', 'soul_sand', 300, 5, 'the_nether'),
  block('blackstone', 'blackstone', 2000, 5, 'the_nether'),
  block('basalt', 'basalt', 2000, 5, 'the_nether'),
  block('magma_block', 'magma_block', 600, 10, 'the_nether'),
  block('ancient_debris', 'ancient_debris', 20000, 2000, 'the_nether'),
  block('end_stone', 'end_stone', 5, 3, 'the_end')
]

function mob (name: string, drops: Drop[], find: number, each: number, dimension: Dimension = 'overworld'): MobSource {
  return { mob: name, drops, dimension, find, each }
}

export const MOB_SOURCES: MobSource[] = [
  mob('cow', [{ item: 'beef', count: 2 }, { item: 'leather', count: 1 }], 400, 100),
  mob('pig', [{ item: 'porkchop', count: 2 }], 400, 100),
  mob('sheep', [{ item: 'mutton', count: 1.5 }, { item: 'white_wool', count: 1 }], 400, 100),
  mob('chicken', [{ item: 'chicken', count: 1 }, { item: 'feather', count: 1 }], 400, 100),
  mob('rabbit', [{ item: 'rabbit', count: 0.5 }, { item: 'rabbit_hide', count: 0.5 }, { item: 'rabbit_foot', count: 0.1 }], 1500, 200),
  mob('cod', [{ item: 'cod', count: 1 }], 800, 100),
  mob('salmon', [{ item: 'salmon', count: 1 }], 800, 100),
  mob('squid', [{ item: 'ink_sac', count: 2 }], 1000, 200),
  mob('spider', [{ item: 'string', count: 1 }, { item: 'spider_eye', count: 0.33 }], 1200, 300),
  mob('zombie', [{ item: 'rotten_flesh', count: 1 }], 600, 200),
  mob('skeleton', [{ item: 'bone', count: 1 }, { item: 'arrow', count: 1 }], 1200, 300),
  mob('creeper', [{ item: 'gunpowder', count: 1 }], 1500, 400),
  mob('slime', [{ item: 'slime_ball', count: 1 }], 6000, 300),
  mob('enderman', [{ item: 'ender_pearl', count: 0.5 }], 3000, 600),
  mob('blaze', [{ item: 'blaze_rod', count: 0.5 }], 8000, 300, 'the_nether'),
  mob('ghast', [{ item: 'ghast_tear', count: 0.5 }, { item: 'gunpowder', count: 1 }], 3000, 600, 'the_nether'),
  mob('wither_skeleton', [{ item: 'coal', count: 0.33 }, { item: 'bone', count: 1 }, { item: 'wither_skeleton_skull', count: 0.025 }], 8000, 400, 'the_nether')
]

/** vanilla furnace recipes (data/minecraft/recipe/*_from_smelting and the plain smelting ones) */
export const SMELTING: SmeltingRecipe[] = [
  { input: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'], output: 'iron_ingot' },
  { input: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'], output: 'gold_ingot' },
  { input: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'], output: 'copper_ingot' },
  { input: ['coal_ore', 'deepslate_coal_ore'], output: 'coal' },
  { input: ['diamond_ore', 'deepslate_diamond_ore'], output: 'diamond' },
  { input: ['lapis_ore', 'deepslate_lapis_ore'], output: 'lapis_lazuli' },
  { input: ['redstone_ore', 'deepslate_redstone_ore'], output: 'redstone' },
  { input: ['emerald_ore', 'deepslate_emerald_ore'], output: 'emerald' },
  { input: ['nether_quartz_ore'], output: 'quartz' },
  { input: ['ancient_debris'], output: 'netherite_scrap' },
  { input: ['#logs_that_burn'], output: 'charcoal' },
  { input: ['cobblestone'], output: 'stone' },
  { input: ['stone'], output: 'smooth_stone' },
  { input: ['cobbled_deepslate'], output: 'deepslate' },
  { input: ['#smelts_to_glass'], output: 'glass' },
  { input: ['clay_ball'], output: 'brick' },
  { input: ['clay'], output: 'terracotta' },
  { input: ['netherrack'], output: 'nether_brick' },
  { input: ['stone_bricks'], output: 'cracked_stone_bricks' },
  { input: ['wet_sponge'], output: 'sponge' },
  { input: ['cactus'], output: 'green_dye' },
  { input: ['sea_pickle'], output: 'lime_dye' },
  { input: ['kelp'], output: 'dried_kelp' },
  { input: ['chorus_fruit'], output: 'popped_chorus_fruit' },
  { input: ['beef'], output: 'cooked_beef' },
  { input: ['porkchop'], output: 'cooked_porkchop' },
  { input: ['mutton'], output: 'cooked_mutton' },
  { input: ['chicken'], output: 'cooked_chicken' },
  { input: ['rabbit'], output: 'cooked_rabbit' },
  { input: ['cod'], output: 'cooked_cod' },
  { input: ['salmon'], output: 'cooked_salmon' },
  { input: ['potato'], output: 'baked_potato' }
]

/** 1 gold ingot per trade; the bot must wear a piece of gold armor or piglins attack */
export const BARTER: BarterOffer[] = [
  { item: 'ender_pearl', perIngot: 10 / 459 * 3 },
  { item: 'string', perIngot: 20 / 459 * 6 },
  { item: 'obsidian', perIngot: 40 / 459 * 1 },
  { item: 'crying_obsidian', perIngot: 40 / 459 * 2 },
  { item: 'leather', perIngot: 40 / 459 * 3 },
  { item: 'fire_charge', perIngot: 40 / 459 * 1 },
  { item: 'iron_nugget', perIngot: 10 / 459 * 23 },
  { item: 'quartz', perIngot: 20 / 459 * 12 },
  { item: 'gravel', perIngot: 40 / 459 * 12 },
  { item: 'soul_sand', perIngot: 40 / 459 * 5 },
  { item: 'blackstone', perIngot: 40 / 459 * 12 }
]
export const BARTER_FIND = 1500
/** PiglinAi.ADMIRE_DURATION: a piglin looks at the ingot for 119 ticks before it throws the loot */
export const BARTER_TICKS_PER_INGOT = 120
export const GOLD_ARMOR = ['golden_boots', 'golden_helmet', 'golden_leggings', 'golden_chestplate']

export const FLUIDS: FluidSource[] = [
  { item: 'water_bucket', fluid: 'water', dimension: 'overworld', find: 200 },
  { item: 'lava_bucket', fluid: 'lava', dimension: 'overworld', find: 1500 }
]

/**
 * Fuels the planner will burn or make for burning, with the value it puts on one item burnt
 * out of the inventory (what replacing it would roughly cost, in ticks). Anything else that
 * burns (tools, chests, the crafting table, blaze rods...) is kept.
 */
export const FUELS: Array<{ item: string, value: number, obtain: boolean }> = [
  { item: 'coal', value: 80, obtain: true },
  { item: 'charcoal', value: 80, obtain: true },
  { item: '#planks', value: 15, obtain: true },
  { item: '#logs_that_burn', value: 60, obtain: true },
  { item: 'stick', value: 8, obtain: true },
  { item: 'coal_block', value: 720, obtain: false },
  { item: 'dried_kelp_block', value: 300, obtain: false },
  { item: '#wooden_slabs', value: 8, obtain: false },
  { item: '#saplings', value: 1, obtain: false },
  { item: 'bamboo', value: 1, obtain: false }
]

/** ticks for one crafting action at a grid (open, place the recipe, take the result) */
export const CRAFT_TICKS = 10
/** ticks to walk to the drop and pick it up after a block breaks or a mob dies */
export const PICKUP_TICKS = 5
/** ticks for one fight, on top of reaching the mob */
export const FIGHT_TICKS = 100
/** ticks to fill one bucket at a known fluid */
export const FILL_TICKS = 10
/** ticks per block walked, at the vanilla walking speed (4.3 blocks/s) */
export const WALK_TICKS_PER_BLOCK = 5
/** ticks for going to another dimension the first time in a plan */
export const DIMENSION_TRAVEL = 3000
