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
