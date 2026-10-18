/** the part of a minecraft-data registry (`bot.registry`, `require('minecraft-data')(version)`) this package reads */
export interface RegistryItem {
  id: number
  name: string
  stackSize: number
}

export interface RegistryBlock {
  id: number
  name: string
  hardness: number | null
  material?: string
  /** item ids (as keys) that harvest the block; absent when anything does */
  harvestTools?: { [id: string]: boolean }
}

export interface RegistryLike {
  items: { [id: number]: RegistryItem }
  itemsByName: { [name: string]: RegistryItem }
  itemsArray: RegistryItem[]
  blocksByName: { [name: string]: RegistryBlock }
  /** result item id → recipes, as minecraft-data stores them */
  recipes: { [id: number]: unknown }
  /** minecraft-data's foods (FoodProperties): nutrition (foodPoints) and saturation */
  foodsByName?: { [name: string]: { foodPoints: number, saturation: number } }
}

/** per-registry caches, so derived tables are built once per version */
export function cachedPerRegistry<T> (build: (registry: RegistryLike) => T): (registry: RegistryLike) => T {
  const cache = new WeakMap<object, T>()
  return (registry) => {
    let value = cache.get(registry)
    if (value === undefined) cache.set(registry, value = build(registry))
    return value
  }
}
