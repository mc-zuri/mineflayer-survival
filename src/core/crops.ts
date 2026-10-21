// Plants that drop their food only once grown: the age a block of them has to be at for its loot table to give it.

/**
 * The youngest age at which breaking the block drops its food (vanilla's loot tables, the block_state_property
 * conditions): a sweet berry bush from age 2 (1 to 2 berries; 2 to 3 at age 3), the crops at their CropBlock max age
 * (wheat, carrots and potatoes 7, beetroots 3). A younger one drops a seed or nothing.
 */
export const GROWN_AGE: Readonly<Record<string, number>> = {
  sweet_berry_bush: 2,
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3
}

export interface AgedBlock {
  name: string
  getProperties?: () => Record<string, unknown>
}

/** whether breaking the block now drops what it grows (true for any block that doesn't grow) */
export function isGrown (block: AgedBlock | null | undefined): boolean {
  if (block == null) return false
  const age = GROWN_AGE[block.name]
  if (age == null) return true
  const props = block.getProperties?.() ?? {}
  return Number(props.age ?? 0) >= age
}

/** whether any of the blocks grows (its blocks are passed over until grown) */
export function growsAny (names: readonly string[]): boolean {
  return names.some(n => GROWN_AGE[n] != null)
}

/**
 * Average ticks for a crop sown on hydrated farmland in a row to grow up: CropBlock.randomTick grows a stage with
 * chance 1 / (floor(25 / speed) + 1), speed about 5.5 in a single row by water (getGrowthSpeed), a block's random tick
 * coming every 4096 / 3 ticks on average (randomTickSpeed 3); 7 stages. The random ticks come only within the
 * simulation distance of a player (ServerChunkCache.tickChunks): a farm left far behind doesn't grow meanwhile.
 */
export const GROW_TICKS = 48000

/** plots a farm is sown with at its start (the harvests' seeds grow it on: FARM_TARGET_PLOTS) */
export const FARM_PLOTS = 12

/** a farm the bot sowed, as its memory keeps it (a 'farm' point of interest at the water, this as the note) */
export interface FarmRecord {
  crop: string
  /** the farmland */
  cells: Array<[number, number, number]>
  /** the world's age (bot.time.age) at the sowing */
  sown: number
}
