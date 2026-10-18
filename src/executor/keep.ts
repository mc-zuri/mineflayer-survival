// What the bot carries on a trip and what goes into the base's chests, and what it may throw away when the
// inventory is full far from the base. Pure, over item names and counts.
import { isBed, isSafeFood, parseTool } from '../core/items'
import type { ItemCount } from '../core/inventory'
import type { RegistryLike } from '../core/registry'

/** how many of an item to carry; Infinity: all of them (the registry: the version's, for what is food) */
export type KeepRule = (name: string, registry?: RegistryLike) => number | null

/** a carried stack of each: blocks to bridge, pillar and plug lava with, torches, a crafting table and a furnace */
export const KEEP_COUNTS: Record<string, number> = {
  cobblestone: 64,
  cobbled_deepslate: 0,
  torch: 64,
  crafting_table: 1,
  furnace: 1,
  coal: 32,
  charcoal: 32,
  stick: 16,
  arrow: Infinity,
  bucket: Infinity,
  water_bucket: Infinity,
  lava_bucket: Infinity,
  shield: Infinity,
  bow: Infinity,
  crossbow: Infinity,
  flint_and_steel: Infinity,
  totem_of_undying: Infinity,
  ender_pearl: Infinity,
  ender_eye: Infinity,
  blaze_rod: Infinity,
  blaze_powder: Infinity,
  golden_apple: Infinity,
  enchanted_golden_apple: Infinity
}

const ARMOR = /_(helmet|chestplate|leggings|boots)$/

/**
 * The default rule: every tool, weapon and armor piece, every safe food (of the registry's foods: none without one),
 * the beds, and the counts of KEEP_COUNTS. Anything else (ores, ingots, gems, building blocks over a stack) goes to the
 * base.
 */
export const defaultKeep: KeepRule = (name, registry) => {
  if (parseTool(name) != null || name === 'shears' || ARMOR.test(name) || name === 'elytra') return Infinity
  if (isBed(name)) return 1
  if (registry != null && isSafeFood(registry, name)) return Infinity
  return KEEP_COUNTS[name] ?? null
}

/** blocks and drops worth nothing to the plan, thrown away first when there's no room and no base near */
export const JUNK = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'gravel', 'sand', 'red_sand', 'granite', 'diorite', 'andesite', 'tuff', 'calcite',
  'netherrack', 'cobbled_deepslate', 'wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds', 'rotten_flesh',
  'poisonous_potato', 'spider_eye', 'bone', 'string', 'feather', 'egg', 'ink_sac', 'flint', 'clay_ball', 'moss_block',
  'dripstone_block', 'pointed_dripstone', 'glow_lichen', 'kelp', 'seagrass', 'short_grass', 'tall_grass', 'fern',
  'dead_bush', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling',
  'cherry_sapling', 'mangrove_propagule', 'pale_oak_sapling', 'apple', 'stick'
])

export interface SplitOptions {
  keep?: KeepRule
  /** the version's registry, for the keep rule */
  registry?: RegistryLike
  /** what the current goals need: never stored or thrown (on top of what `keep` keeps) */
  needed?: Record<string, number>
}

/** how many of each item to keep and how many to put away, from the inventory's counts */
export function splitInventory (items: readonly ItemCount[], opts: SplitOptions = {}): { keep: ItemCount[], store: ItemCount[] } {
  const keepRule = opts.keep ?? defaultKeep
  const totals = new Map<string, number>()
  for (const it of items) totals.set(it.name, (totals.get(it.name) ?? 0) + it.count)
  const keep: ItemCount[] = []
  const store: ItemCount[] = []
  for (const [name, count] of totals) {
    const rule = keepRule(name, opts.registry) ?? 0
    const kept = Math.min(count, Math.max(rule, opts.needed?.[name] ?? 0))
    if (kept > 0) keep.push({ name, count: kept })
    if (count - kept > 0) store.push({ name, count: count - kept })
  }
  return { keep, store }
}

/**
 * What to throw away to free `slots` slots: junk first, whole stacks, the most of an item first; then (only when
 * `anything` is set) what `splitInventory` would store, the cheapest blocks first. Each entry is one stack.
 */
export function junkToToss (stacks: ReadonlyArray<{ name: string, count: number }>, slots: number, opts: SplitOptions & { anything?: boolean } = {}): Array<{ name: string, count: number }> {
  const needed = opts.needed ?? {}
  const keepRule = opts.keep ?? defaultKeep
  const out: Array<{ name: string, count: number }> = []
  // the stacks beyond what's kept, smallest stacks last so a toss frees whole slots
  const left = new Map<string, number>()
  for (const s of stacks) left.set(s.name, (left.get(s.name) ?? 0) + s.count)
  const pick = (filter: (name: string) => boolean): void => {
    const candidates = [...stacks].filter(s => filter(s.name)).sort((a, b) => ((left.get(b.name) ?? 0) - (left.get(a.name) ?? 0)) !== 0 ? (left.get(b.name) ?? 0) - (left.get(a.name) ?? 0) : b.count - a.count)
    for (const s of candidates) {
      if (out.length >= slots) return
      const total = left.get(s.name) ?? 0
      const keep = Math.max(keepRule(s.name, opts.registry) ?? 0, needed[s.name] ?? 0)
      // a stack may go when what's left of the item without it still covers what's kept
      if (total - s.count < Math.min(keep, total)) continue
      out.push({ name: s.name, count: s.count })
      left.set(s.name, total - s.count)
    }
  }
  pick(name => JUNK.has(name))
  if (opts.anything === true) pick(name => !JUNK.has(name) && (keepRule(name, opts.registry) ?? 0) !== Infinity)
  return out
}
