import { burnTicks, FOODS, parseTool, TOOL_MATERIAL_RANK, toolKindForMaterial, type ToolKind } from './items'
import type { RegistryLike } from './registry'
import { itemTags, type ItemTags } from './tags'

export interface ItemCount {
  name: string
  count: number
}

/** what Inventory.fromBot reads off a mineflayer bot */
export interface BotInventoryLike {
  registry: RegistryLike
  inventory: {
    items: () => ItemCount[]
    emptySlotCount: () => number
  }
}

/** the 36 slots of the player's main inventory and hotbar */
export const PLAYER_SLOTS = 36

export interface InventoryOptions {
  /** slots the items may use (default 36) */
  slots?: number
  /** free slots as the real window counts them (split stacks), used until the inventory changes */
  freeSlots?: number
}

/**
 * Item counts by name, with `#tag` lookups, free slot estimates and best-tool choice. Built
 * from the bot's window, or by hand; the planner clones it to simulate a plan.
 */
export class Inventory {
  readonly registry: RegistryLike
  readonly tags: ItemTags
  readonly slots: number
  private readonly counts = new Map<string, number>()
  private knownFreeSlots: number | undefined

  constructor (registry: RegistryLike, items: Iterable<ItemCount> | Record<string, number> = [], opts: InventoryOptions = {}) {
    this.registry = registry
    this.tags = itemTags(registry)
    this.slots = opts.slots ?? PLAYER_SLOTS
    this.knownFreeSlots = opts.freeSlots
    const list: Iterable<ItemCount> = Symbol.iterator in items
      ? items
      : Object.entries(items).map(([name, count]) => ({ name, count }))
    for (const { name, count } of list) if (count > 0) this.counts.set(name, (this.counts.get(name) ?? 0) + count)
  }

  static fromBot (bot: BotInventoryLike): Inventory {
    return new Inventory(bot.registry, bot.inventory.items(), { freeSlots: bot.inventory.emptySlotCount() })
  }

  clone (): Inventory {
    const copy = new Inventory(this.registry, this.entries(), { slots: this.slots })
    copy.knownFreeSlots = this.knownFreeSlots
    return copy
  }

  /** how many of an item, or of all members of a `#tag` */
  count (nameOrTag: string): number {
    if (!nameOrTag.startsWith('#')) return this.counts.get(nameOrTag) ?? 0
    let n = 0
    for (const m of this.tags.members(nameOrTag)) n += this.counts.get(m) ?? 0
    return n
  }

  /** the sum over several names or tags (alternatives that all satisfy a need) */
  countAny (namesOrTags: readonly string[]): number {
    const seen = new Set<string>()
    let n = 0
    for (const nt of namesOrTags) {
      for (const m of this.tags.resolve(nt)) {
        if (seen.has(m)) continue
        seen.add(m)
        n += this.counts.get(m) ?? 0
      }
    }
    return n
  }

  has (nameOrTag: string, count = 1): boolean {
    return this.count(nameOrTag) >= count
  }

  /** the items held that match a name or `#tag`, most first */
  matching (nameOrTag: string): ItemCount[] {
    return this.tags.resolve(nameOrTag)
      .map(name => ({ name, count: this.counts.get(name) ?? 0 }))
      .filter(i => i.count > 0)
      .sort((a, b) => b.count - a.count)
  }

  add (name: string, count: number): void {
    if (count <= 0) return
    this.counts.set(name, (this.counts.get(name) ?? 0) + count)
    this.knownFreeSlots = undefined
  }

  /** takes `count` of an item; throws if there aren't that many */
  remove (name: string, count: number): void {
    if (count <= 0) return
    const have = this.counts.get(name) ?? 0
    if (have < count) throw new Error(`cannot remove ${count} ${name}: only ${have}`)
    if (have === count) this.counts.delete(name)
    else this.counts.set(name, have - count)
    this.knownFreeSlots = undefined
  }

  entries (): ItemCount[] {
    return [...this.counts].map(([name, count]) => ({ name, count }))
  }

  toRecord (): Record<string, number> {
    return Object.fromEntries(this.counts)
  }

  /** slots the items fill when stacked fully (vanilla stack sizes from the registry) */
  usedSlots (): number {
    let used = 0
    for (const [name, count] of this.counts) {
      const stack = this.registry.itemsByName[name]?.stackSize ?? 64
      used += Math.ceil(count / Math.max(1, stack))
    }
    return used
  }

  freeSlots (): number {
    return this.knownFreeSlots ?? Math.max(0, this.slots - this.usedSlots())
  }

  /**
   * The best tool of a kind held, or the best one for a block: one that harvests it (its
   * minecraft-data harvestTools), of the kind its material calls for. Ordered by harvest tier,
   * then mining speed (vanilla ToolMaterial). Null if none qualifies.
   */
  bestTool (kindOrBlock: ToolKind | string): string | null {
    const block = this.registry.blocksByName[kindOrBlock]
    let kind: ToolKind | null
    let harvest: Set<string> | null = null
    if (block != null && !['pickaxe', 'axe', 'shovel', 'hoe', 'sword'].includes(kindOrBlock)) {
      kind = toolKindForMaterial(block.material)
      if (block.harvestTools != null) {
        harvest = new Set(Object.keys(block.harvestTools).map(id => this.registry.items[Number(id)]?.name).filter((n): n is string => n != null))
      }
    } else {
      kind = kindOrBlock as ToolKind
    }
    let best: string | null = null
    let bestRank = -1
    for (const name of this.counts.keys()) {
      const tool = parseTool(name)
      if (tool == null) continue
      if (harvest != null ? !harvest.has(name) : tool.kind !== kind) continue
      // a tool of the block's kind wins over another that merely harvests it
      const rank = TOOL_MATERIAL_RANK.indexOf(tool.material) + (tool.kind === kind ? 100 : 0)
      if (rank > bestRank) { best = name; bestRank = rank }
    }
    return best
  }

  /** the furnace burn ticks of every fuel item held, minus the excluded ones */
  fuelTicks (exclude: readonly string[] = []): number {
    let ticks = 0
    for (const [name, count] of this.counts) if (!exclude.includes(name)) ticks += burnTicks(name) * count
    return ticks
  }

  /** total nutrition of the safe food held */
  foodPoints (): number {
    let points = 0
    for (const [name, count] of this.counts) {
      const food = FOODS[name]
      if (food != null && food.harmful !== true) points += food.nutrition * count
    }
    return points
  }
}
