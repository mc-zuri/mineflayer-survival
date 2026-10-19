// What the bot carries on a trip and what goes into the base's chests, and what it may throw away when the
// inventory is full far from the base. Pure, over item names and counts.
import { foodInfo, isBed, isSafeFood, parseTool, TOOL_MATERIALS, type ToolKind } from '../core/items'
import type { Inventory, ItemCount } from '../core/inventory'
import type { RegistryLike } from '../core/registry'
import { heldFor, unitValue, type ObtainRequest } from '../planner/obtain'
import { FOOD_GOAL, toolsAtLeast } from '../planner/progression'
import type { StockPolicy } from '../planner/stock'

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
  'cherry_sapling', 'mangrove_propagule', 'pale_oak_sapling', 'apple', 'stick',
  // the leaves a shears' dig drops (the bag of a 26.3 enchant run held 159 leaves and leaf litter, no room left for
  // the bookshelves' planks: 'crafting oak_planks x18 gave 0 of 72')
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves',
  'cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves', 'leaf_litter', 'wildflowers', 'bush',
  'firefly_bush', 'short_dry_grass', 'tall_dry_grass', 'vine', 'pale_hanging_moss'
])

/**
 * What is never thrown away, whatever room it takes (stored at the base or in a chest put down instead, or the bag left
 * full): gear, the crafted stations and containers, ores, raw metal, ingots and gems and their blocks, and the rare
 * drops and makings of the run (a forced room threw an enchanting table and a diamond away, and the gear's enchanting
 * failed at "can't craft 1 enchanting_table", 26.3). An enchanted stack is never thrown either (junkToToss).
 */
const VALUABLE = new Set([
  'shears', 'elytra', 'shield', 'bow', 'crossbow', 'trident', 'mace', 'fishing_rod', 'flint_and_steel', 'brush',
  'spyglass', 'compass', 'recovery_compass', 'clock', 'saddle', 'name_tag', 'lead', 'carrot_on_a_stick',
  'warped_fungus_on_a_stick', 'goat_horn',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'chipped_anvil', 'damaged_anvil', 'enchanting_table',
  'chest', 'trapped_chest', 'barrel', 'ender_chest', 'brewing_stand', 'smithing_table', 'grindstone', 'stonecutter',
  'loom', 'cartography_table', 'fletching_table', 'lectern', 'cauldron', 'bookshelf', 'chiseled_bookshelf', 'beacon',
  'respawn_anchor', 'lodestone', 'crafter', 'jukebox', 'hopper',
  'ancient_debris', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'amethyst_shard', 'netherite_scrap',
  'coal', 'charcoal', 'obsidian', 'crying_obsidian',
  'ender_pearl', 'ender_eye', 'blaze_rod', 'blaze_powder', 'breeze_rod', 'ghast_tear', 'nether_star', 'dragon_egg',
  'dragon_breath', 'totem_of_undying', 'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'experience_bottle',
  'potion', 'splash_potion', 'lingering_potion', 'book', 'enchanted_book', 'writable_book', 'written_book',
  'heart_of_the_sea', 'nautilus_shell', 'echo_shard', 'shulker_shell', 'trial_key', 'ominous_trial_key', 'heavy_core'
])
const VALUABLE_PATTERN = /(_ore|_ingot|_nugget|_shulker_box|_smithing_template|_horse_armor)$|^shulker_box$|^raw_(iron|gold|copper)(_block)?$|^(iron|gold|diamond|emerald|lapis|redstone|netherite|copper|coal|quartz|amethyst)_block$|^music_disc_/

/** never thrown away (VALUABLE): gear, stations, ores, metal and gems, the rare drops */
export function isValuable (name: string): boolean {
  return VALUABLE.has(name) || VALUABLE_PATTERN.test(name) || parseTool(name) != null || ARMOR.test(name) || isBed(name)
}

/** the ground's blocks and the plants a dig picks up, worth nothing: thrown first */
const TOSS_FIRST = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'gravel', 'sand', 'red_sand', 'granite', 'diorite', 'andesite', 'tuff', 'calcite',
  'netherrack', 'cobbled_deepslate', 'moss_block', 'dripstone_block', 'pointed_dripstone', 'glow_lichen', 'kelp',
  'seagrass', 'short_grass', 'tall_grass', 'fern', 'dead_bush', 'vine', 'pale_hanging_moss', 'leaf_litter', 'wildflowers',
  'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass'
])
/** the common stone, worth a little: after the junk, beyond the stock */
const COMMON_STONE = new Set([
  'cobblestone', 'stone', 'deepslate', 'blackstone', 'basalt', 'smooth_basalt', 'end_stone', 'sandstone', 'red_sandstone',
  'mud', 'soul_sand', 'soul_soil', 'magma_block', 'terracotta', 'clay', 'snow_block', 'ice'
])

/**
 * The order things are thrown away in, the least worth first: the ground's blocks and plants, the common stone, the
 * junk drops (seeds, rotten flesh, bones), then anything else not valuable; null for what is never thrown (isValuable)
 */
export function tossValue (name: string): number | null {
  if (isValuable(name)) return null
  if (TOSS_FIRST.has(name) || name.endsWith('_leaves')) return 0
  if (COMMON_STONE.has(name)) return 1
  if (JUNK.has(name)) return 2
  return 3
}

/**
 * The stone and ground a dug route (the staircase, the tunnels, the pathfinder's breaks on its way to an ore) brings
 * into the bag: its cells' drops, picked up as the bot walks into them (Player.aiStep touches them, ItemEntity.
 * playerTouch). What the bag carries of it beyond the keep count is no use once the stock has its high mark, and is
 * thrown away rather than stored (a 26.3 bag held 433 cobblestone down the diamonds' mine)
 */
export const ROUTE_STONE = new Set([
  'cobblestone', 'cobbled_deepslate', 'deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack',
  'blackstone', 'basalt', 'dirt', 'gravel'
])

/**
 * The blocks the pathfinder bridges, towers and plugs lava with: however much is thrown away, `keep` of them stay
 * (of all of `items` together)
 */
export interface ScaffoldKeep {
  items: readonly string[]
  keep: number
}

export interface SplitOptions {
  keep?: KeepRule
  /** the version's registry, for the keep rule */
  registry?: RegistryLike
  /** what the current goals need: never stored or thrown (on top of what `keep` keeps) */
  needed?: Record<string, number>
  /** what's never put away beside (protectedCounts): the farm's hoe, the arrows the stock wants */
  protect?: ProtectOptions
}

/** the tiers of the tools, the best first (a tool kind's best carried is never put away) */
const TOOL_ORDER = Object.entries(TOOL_MATERIALS).sort((a, b) => (b[1].tier - a[1].tier) || (b[1].speed - a[1].speed)).map(([m]) => m)

/** food points a bag keeps whatever is put away: the stock's food low mark (stock.ts: food 40-80) */
export const FOOD_WORKING_SET = 40

/** arrows a bag with a bow keeps whatever is put away */
export const ARROWS_KEPT = 32

export interface ProtectOptions {
  /** the bot farms: its best hoe kept too (default false) */
  farming?: boolean
  /** arrows kept with a bow (default ARROWS_KEPT; 0 when the stock wants none) */
  arrows?: number
  /** food points kept (default FOOD_WORKING_SET) */
  foodPoints?: number
}

/**
 * What a store, a stash, a depot or a throw for room never takes from the bag, whatever the keep rule says (a stock
 * policy's keep count over it): the best of each tool kind (pickaxe, axe, shovel, sword; the hoe when farming), a
 * shield, a bow and ARROWS_KEPT arrows with it, a water bucket, and food up to FOOD_WORKING_SET points, the most
 * filling first. (Worn armor and the off hand aren't in the bag's slots: no store moves them.) The obsidian of a 26.3
 * whole game was made by a bot whose diamond pickaxe a store could have left at the base 160 blocks off.
 */
export function protectedCounts (items: readonly ItemCount[], registry?: RegistryLike, opts: ProtectOptions = {}): Record<string, number> {
  const totals = new Map<string, number>()
  for (const it of items) totals.set(it.name, (totals.get(it.name) ?? 0) + it.count)
  const out: Record<string, number> = {}
  const keep = (name: string, n: number): void => { const c = Math.min(n, totals.get(name) ?? 0); if (c > 0) out[name] = Math.max(out[name] ?? 0, c) }
  const kinds: ToolKind[] = opts.farming === true ? ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'] : ['pickaxe', 'axe', 'shovel', 'sword']
  for (const kind of kinds) {
    const best = [...totals.keys()].map(n => ({ n, t: parseTool(n) })).filter(x => x.t?.kind === kind)
      .sort((a, b) => TOOL_ORDER.indexOf(a.t!.material) - TOOL_ORDER.indexOf(b.t!.material))[0]
    if (best != null) keep(best.n, 1)
  }
  keep('shield', 1)
  keep('water_bucket', 1)
  if ((totals.get('bow') ?? 0) > 0) {
    keep('bow', 1)
    keep('arrow', opts.arrows ?? ARROWS_KEPT)
  }
  if (registry != null) {
    const foods = [...totals.keys()].filter(n => isSafeFood(registry, n))
      .map(n => ({ n, points: foodInfo(registry, n)?.nutrition ?? 0 }))
      .sort((a, b) => b.points - a.points)
    let left = opts.foodPoints ?? FOOD_WORKING_SET
    for (const f of foods) {
      if (left <= 0 || f.points <= 0) break
      const n = Math.min(totals.get(f.n) ?? 0, Math.ceil(left / f.points))
      keep(f.n, n)
      left -= n * f.points
    }
  }
  return out
}

/**
 * The counts that may go into a chest of what's asked, leaving the bag what protectedCounts protects (`bag`: what it
 * carries now)
 */
export function storable (asked: readonly ItemCount[], bag: readonly ItemCount[], registry?: RegistryLike, opts: ProtectOptions = {}): ItemCount[] {
  const kept = protectedCounts(bag, registry, opts)
  const held = new Map<string, number>()
  for (const it of bag) held.set(it.name, (held.get(it.name) ?? 0) + it.count)
  const out: ItemCount[] = []
  for (const it of asked) {
    const n = Math.min(it.count, Math.max(0, (held.get(it.name) ?? 0) - (kept[it.name] ?? 0)))
    if (n > 0) out.push({ name: it.name, count: n })
  }
  return out
}

/** how many of each item to keep and how many to put away, from the inventory's counts (never what protectedCounts protects) */
export function splitInventory (items: readonly ItemCount[], opts: SplitOptions = {}): { keep: ItemCount[], store: ItemCount[] } {
  const keepRule = opts.keep ?? defaultKeep
  const totals = new Map<string, number>()
  for (const it of items) totals.set(it.name, (totals.get(it.name) ?? 0) + it.count)
  const guarded = protectedCounts(items, opts.registry, opts.protect)
  const keep: ItemCount[] = []
  const store: ItemCount[] = []
  for (const [name, count] of totals) {
    const rule = keepRule(name, opts.registry) ?? 0
    const kept = Math.min(count, Math.max(rule, opts.needed?.[name] ?? 0, guarded[name] ?? 0))
    if (kept > 0) keep.push({ name, count: kept })
    if (count - kept > 0) store.push({ name, count: count - kept })
  }
  return { keep, store }
}

/**
 * What to throw away to free `slots` slots, whole stacks, the least worth first (tossValue: the ground's blocks, the
 * common stone, the junk drops, the rest), the most of an item first: the junk; what `surplus` says may go beyond
 * what's kept (the stock over its working set with no base to store it in); and only when `anything` is set, what
 * `splitInventory` would store. Never what's kept or needed, nor a valuable (isValuable) or an enchanted stack, whatever
 * the room it takes: fewer stacks than asked for then, nor the building blocks `scaffold` keeps. Each entry is one stack.
 */
export function junkToToss (stacks: ReadonlyArray<{ name: string, count: number, enchanted?: boolean }>, slots: number, opts: SplitOptions & { anything?: boolean, surplus?: (name: string) => boolean, scaffold?: ScaffoldKeep } = {}): Array<{ name: string, count: number }> {
  const needed = opts.needed ?? {}
  const keepRule = opts.keep ?? defaultKeep
  const out: Array<{ name: string, count: number }> = []
  // the stacks beyond what's kept, smallest stacks last so a toss frees whole slots
  const left = new Map<string, number>()
  for (const s of stacks) left.set(s.name, (left.get(s.name) ?? 0) + s.count)
  const guarded = protectedCounts(stacks, opts.registry, opts.protect)
  const scaffoldItems = new Set(opts.scaffold?.items ?? [])
  let scaffoldLeft = [...left].reduce((n, [name, c]) => n + (scaffoldItems.has(name) ? c : 0), 0)
  const pick = (filter: (name: string) => boolean): void => {
    const candidates = [...stacks]
      .filter(s => s.enchanted !== true && tossValue(s.name) != null && filter(s.name))
      .sort((a, b) => {
        const value = (tossValue(a.name) ?? 0) - (tossValue(b.name) ?? 0)
        if (value !== 0) return value
        const most = (left.get(b.name) ?? 0) - (left.get(a.name) ?? 0)
        return most !== 0 ? most : b.count - a.count
      })
    for (const s of candidates) {
      if (out.length >= slots) return
      const total = left.get(s.name) ?? 0
      const keep = Math.max(keepRule(s.name, opts.registry) ?? 0, needed[s.name] ?? 0, guarded[s.name] ?? 0)
      // a stack may go when what's left of the item without it still covers what's kept
      if (total - s.count < Math.min(keep, total)) continue
      // and the building blocks left cover the pathfinder's bridges and towers (the dirt and andesite are, with no
      // cobblestone)
      const scaffold = scaffoldItems.has(s.name)
      if (scaffold && scaffoldLeft - s.count < (opts.scaffold?.keep ?? 0)) continue
      out.push({ name: s.name, count: s.count })
      left.set(s.name, total - s.count)
      if (scaffold) scaffoldLeft -= s.count
    }
  }
  pick(name => JUNK.has(name) || TOSS_FIRST.has(name) || opts.surplus?.(name) === true ||
    (opts.anything === true && (keepRule(name, opts.registry) ?? 0) !== Infinity))
  return out
}

/** the tool kinds a spare kit holds one of, at the tier of the best one carried */
export const SPARE_TOOLS: readonly ToolKind[] = ['pickaxe', 'sword', 'axe']

/** food points the spare kit holds */
export const SPARE_FOOD_POINTS = 20

/**
 * What the base's chests are short of for a spare kit, as requests on top of what the bot carries (the spare is made,
 * then stored): for each of SPARE_TOOLS a second tool at least as good as the best carried, and SPARE_FOOD_POINTS of
 * food, so a death on a dangerous trip is a re-kit at the base, not the tools and food gathered again.
 */
export function spareKitGoals (carried: Inventory, stored: Readonly<Record<string, number>>): ObtainRequest[] {
  const goals: ObtainRequest[] = []
  for (const kind of SPARE_TOOLS) {
    const best = carried.bestTool(kind)
    const tool = best == null ? null : parseTool(best)
    // a wooden or golden one is no loss
    if (tool == null || tool.kind !== kind || tool.material === 'wooden' || tool.material === 'golden') continue
    const alts = toolsAtLeast(kind, tool.material)
    if (alts.some(a => (stored[a] ?? 0) > 0)) continue
    goals.push({ item: alts, count: carried.countAny(alts) + 1 })
  }
  const storedPoints = Object.entries(stored).reduce((n, [name, c]) => n + c * unitValue({ unit: 'nutrition' }, name, carried.registry), 0)
  if (storedPoints < SPARE_FOOD_POINTS) {
    goals.push({ item: FOOD_GOAL, count: heldFor(carried, FOOD_GOAL, { unit: 'nutrition' }) + SPARE_FOOD_POINTS - storedPoints, unit: 'nutrition' })
  }
  return goals
}

/**
 * The keep rule with the stock policy's working set over it (its marks' keep and the options' keep list): a stack of
 * logs carried, say, where the default stores them; what the policy says nothing of goes by `base`
 */
export function stockKeepRule (policy: Pick<StockPolicy, 'keepCount'>, base: KeepRule = defaultKeep): KeepRule {
  return (name, registry) => policy.keepCount(name, registry) ?? base(name, registry)
}
