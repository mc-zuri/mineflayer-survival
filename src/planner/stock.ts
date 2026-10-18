// The stock policy: what the bot keeps on hand for the phases ahead, not just the one item the next step needs. Each
// resource has a low and a high mark: below the low one a top-up is due, and it gathers up to the high one (the
// marks' gap is what can be spent before the next trip for it). The stock is what the bot carries and what the base's
// chests hold (the memory's chest contents). A trip carries the working set (the keep rule) and what the phase needs;
// the rest goes into the chests, so the high marks are reached over several trips, each as much as the free slots take.
// Pure, over item names and counts; the runner schedules the top-ups (surface ones by day, underground ones by night or
// down the mine) and gives each a tick budget, so one is done when its source is near, not at any cost.
import type { Inventory } from '../core/inventory'
import type { RegistryLike } from '../core/registry'
import { itemTags } from '../core/tags'
import { heldFor, unitValue, type ObtainRequest } from './obtain'
import { FOOD_GOAL, type MilestoneId } from './progression'

/** where a top-up's source is: on the surface (trees, animals: by day) or down a mine (stone, ores: by night) */
export type StockPlace = 'surface' | 'underground'

export interface StockMark {
  /** a name for the log and for the options' overrides ('wood', 'iron') */
  id: string
  /** what counts toward the stock, by item name or `#tag`, and what one is worth (a plank is a quarter of a log) */
  counts: Readonly<Record<string, number>>
  /** what a top-up gathers: an item name, a `#tag`, or alternatives */
  gather: string | readonly string[]
  /** what the marks count: items (the default), or the food's nutrition (vanilla FoodProperties.nutrition) */
  unit?: 'items' | 'nutrition'
  /** a top-up is due below this */
  low: number
  /** and gathers up to this */
  high: number
  /** the working set carried on a trip, by item name or `#tag` (the keep rule); the rest is stored at the base */
  keep?: Readonly<Record<string, number>>
  /** the mark applies once this milestone is reached (the tool that gets it: the iron after the stone pickaxe) */
  from?: MilestoneId
  where: StockPlace
  /**
   * The most a top-up may cost a unit gathered, in ticks: a plan dearer than that waits for a better time (the source
   * near, the bot down at its level), and the top-up stops when it has run that many ticks per unit wanted
   */
  ticksPerUnit: number
}

/** a stack of an item that stacks to 64 */
const STACK = 64

/**
 * The default marks. The basics (cobblestone or cobbled deepslate, which are the building blocks too, and torches): a
 * top-up below 3 stacks, to 5. Wood: a stack of logs, the planks and sticks made from it as needed, topped up below
 * half a stack. The rest from what the later phases take:
 * - coal: the smelting (an iron run's 33 ores are 5 coal, the food, glass) beside the torches' own stock;
 * - iron: the iron milestone's 33 and after it a spare pickaxe and sword (5), buckets for water and lava (6), shears
 *   (2), flint and steel (1), rails and an anvil (31);
 * - diamonds: a pickaxe and sword (5), the armor (24) and an enchanting table (2), the armor taken as they come;
 * - gold: golden boots for the piglins (4) and ingots to barter for pearls;
 * - redstone: a compass and a clock (1 each), rails and the odd dispenser;
 * - lapis: 3 a level-30 enchantment, for the pickaxe, sword, bow and armor and again later;
 * - obsidian: a nether portal (10) and an enchanting table (4);
 * - food: 3 stacks of steak would be some 1500 points, more than a run to the dragon eats: 60 to 120 points;
 * - arrows: the End's crystals and the dragon (the End kit's 64), from the diamonds on.
 */
export const STOCK_MARKS: readonly StockMark[] = [
  { id: 'wood', counts: { '#logs_that_burn': 1, '#planks': 1 / 4, stick: 1 / 8 }, gather: '#logs_that_burn', low: 32, high: 64, keep: { '#logs_that_burn': 64 }, where: 'surface', ticksPerUnit: 100 },
  { id: 'stone', counts: { '#stone_crafting_materials': 1 }, gather: ['cobblestone', 'cobbled_deepslate'], low: 3 * STACK, high: 5 * STACK, keep: { cobblestone: STACK }, from: 'wood', where: 'underground', ticksPerUnit: 25 },
  { id: 'torch', counts: { torch: 1 }, gather: 'torch', low: 3 * STACK, high: 5 * STACK, keep: { torch: STACK }, from: 'stone', where: 'underground', ticksPerUnit: 20 },
  { id: 'coal', counts: { coal: 1, charcoal: 1, coal_block: 9 }, gather: ['coal', 'charcoal'], low: 32, high: 96, keep: { coal: 32, charcoal: 32 }, from: 'wood', where: 'underground', ticksPerUnit: 80 },
  { id: 'iron', counts: { iron_ingot: 1, raw_iron: 1, iron_block: 9, raw_iron_block: 9 }, gather: ['raw_iron', 'iron_ingot'], low: 32, high: 64, from: 'stone', where: 'underground', ticksPerUnit: 100 },
  { id: 'gold', counts: { gold_ingot: 1, raw_gold: 1, gold_block: 9, raw_gold_block: 9, gold_nugget: 1 / 9 }, gather: ['raw_gold', 'gold_ingot'], low: 16, high: 48, from: 'iron', where: 'underground', ticksPerUnit: 150 },
  { id: 'redstone', counts: { redstone: 1, redstone_block: 9 }, gather: 'redstone', low: 16, high: 64, from: 'iron', where: 'underground', ticksPerUnit: 70 },
  { id: 'lapis', counts: { lapis_lazuli: 1, lapis_block: 9 }, gather: 'lapis_lazuli', low: 27, high: 64, from: 'iron', where: 'underground', ticksPerUnit: 80 },
  { id: 'diamond', counts: { diamond: 1, diamond_block: 9 }, gather: 'diamond', low: 8, high: 24, from: 'iron', where: 'underground', ticksPerUnit: 900 },
  { id: 'obsidian', counts: { obsidian: 1 }, gather: 'obsidian', low: 14, high: 24, from: 'diamonds', where: 'underground', ticksPerUnit: 450 },
  { id: 'food', counts: { '#food': 1 }, gather: FOOD_GOAL, unit: 'nutrition', low: 60, high: 120, from: 'food', where: 'surface', ticksPerUnit: 50 },
  { id: 'arrow', counts: { arrow: 1 }, gather: 'arrow', low: 32, high: 64, keep: { arrow: Infinity }, from: 'diamonds', where: 'surface', ticksPerUnit: 150 }
]

/** slots a top-up leaves free for the work's own pickups (the milestone's items, the drops on the way) */
export const STOCK_RESERVE_SLOTS = 10

/** what createPlugin({ stock }) takes */
export interface StockOptions {
  /** false: no stock policy (the milestones get what they need and no more) */
  enabled?: boolean
  /** the marks, replacing STOCK_MARKS */
  marks?: readonly StockMark[]
  /** changes to some marks by id: { iron: { low: 16, high: 48 } } */
  overrides?: Readonly<Record<string, Partial<Omit<StockMark, 'id'>>>>
  /** the working set carried, by item name or `#tag`, over the marks' keep (and the executor's default keep rule) */
  keep?: Readonly<Record<string, number>>
  /** slots left free for the work (default STOCK_RESERVE_SLOTS) */
  reserveSlots?: number
}

/** a mark's level now */
export interface StockLevel {
  mark: StockMark
  /** carried and stored, in the mark's unit */
  have: number
  carried: number
  stored: number
}

/** a top-up to make: the request for the inventory, and the most ticks it may take */
export interface TopUp {
  mark: StockMark
  level: StockLevel
  /** units it gathers this trip (the room's share; the rest on a later one) */
  units: number
  request: ObtainRequest
  /** ticksPerUnit × units */
  budget: number
}

/** the marks of the options: the defaults or the options' own, with the overrides */
export function stockMarks (opts: StockOptions = {}): StockMark[] {
  return (opts.marks ?? STOCK_MARKS).map(m => ({ ...m, ...(opts.overrides?.[m.id] ?? {}) }))
}

/** what one of an item counts for in a mark (0: not in it) */
export function markValue (mark: StockMark, name: string, registry: RegistryLike): number {
  const tags = itemTags(registry)
  let weight = 0
  for (const [k, w] of Object.entries(mark.counts)) if (tags.matches(k, name)) weight = Math.max(weight, w)
  return weight * (mark.unit === 'nutrition' ? unitValue({ unit: 'nutrition' }, name, registry) : 1)
}

function value (mark: StockMark, items: Readonly<Record<string, number>>, registry: RegistryLike): number {
  let n = 0
  for (const [name, count] of Object.entries(items)) if (count > 0) n += count * markValue(mark, name, registry)
  return n
}

/** each mark's level: what the inventory (carried and worn) and the base's chests (their item counts summed) hold */
export function stockLevels (marks: readonly StockMark[], inventory: Inventory, stored: Readonly<Record<string, number>> = {}): StockLevel[] {
  const carriedItems = inventory.toRecord()
  return marks.map(mark => {
    const carried = value(mark, carriedItems, inventory.registry)
    const inChests = value(mark, stored, inventory.registry)
    return { mark, have: carried + inChests, carried, stored: inChests }
  })
}

/** whether a mark applies yet: its milestone reached */
export function markUnlocked (mark: StockMark, reached: readonly MilestoneId[]): boolean {
  return mark.from == null || reached.includes(mark.from)
}

/** a level as a log word: "iron 12+20/32-64" (carried + stored / low - high) */
export function describeLevel (l: StockLevel): string {
  const fmt = (n: number): string => String(Math.floor(n))
  return `${l.mark.id} ${fmt(l.carried)}${l.stored > 0 ? `+${fmt(l.stored)}` : ''}/${l.mark.low}-${l.mark.high}`
}

/** slots one unit of a mark takes: a gathered item's stack (64 or 16), a food's nutrition for a nutrition mark */
function unitsPerSlot (mark: StockMark, registry: RegistryLike): number {
  const tags = itemTags(registry)
  const first = (typeof mark.gather === 'string' ? [mark.gather] : mark.gather).flatMap(g => [...tags.resolve(g)])[0]
  const stack = (first != null ? registry.itemsByName[first]?.stackSize : undefined) ?? STACK
  return mark.unit === 'nutrition' ? stack * Math.max(1, first != null ? unitValue({ unit: 'nutrition' }, first, registry) : 1) : stack
}

/**
 * The stock policy: the marks, the working set they keep, and which marks are being topped up. A mark under its low
 * mark is due until it reaches its high one (the hysteresis: between the two nothing is due unless a top-up began
 * below the low one and hasn't got to the high one yet).
 */
export class StockPolicy {
  readonly marks: StockMark[]
  readonly reserveSlots: number
  /** the marks a top-up is under way for (fell below low, not back to high yet) */
  readonly active = new Set<string>()
  private readonly keepList: Readonly<Record<string, number>>

  constructor (readonly options: StockOptions = {}) {
    this.marks = stockMarks(options)
    this.reserveSlots = options.reserveSlots ?? STOCK_RESERVE_SLOTS
    const keep: Record<string, number> = {}
    for (const m of this.marks) for (const [k, n] of Object.entries(m.keep ?? {})) keep[k] = Math.max(keep[k] ?? 0, n)
    this.keepList = { ...keep, ...(options.keep ?? {}) }
  }

  /** the levels, and which marks are due now: below low starts a top-up, at high ends it */
  update (inventory: Inventory, stored: Readonly<Record<string, number>>, reached: readonly MilestoneId[]): StockLevel[] {
    const levels = stockLevels(this.marks, inventory, stored)
    for (const l of levels) {
      if (!markUnlocked(l.mark, reached)) { this.active.delete(l.mark.id); continue }
      if (l.have < l.mark.low) this.active.add(l.mark.id)
      else if (l.have >= l.mark.high) this.active.delete(l.mark.id)
    }
    return levels
  }

  /**
   * The top-ups due at these places (the schedule's: the surface by day, underground by night or down the mine), the
   * lowest first (by level over low). Each gathers to its high mark, as much as fits this trip: the slots free beyond
   * reserveSlots, shared out among the top-ups due (the rest comes on a later trip, the chests holding what's
   * gathered between). Updates the levels first.
   */
  topUps (inventory: Inventory, stored: Readonly<Record<string, number>>, reached: readonly MilestoneId[], places: readonly StockPlace[]): TopUp[] {
    const levels = this.update(inventory, stored, reached)
    const due = levels
      .filter(l => this.active.has(l.mark.id) && places.includes(l.mark.where))
      .sort((a, b) => a.have / a.mark.low - b.have / b.mark.low)
    if (due.length === 0) return []
    const room = Math.max(0, inventory.slots - inventory.usedSlots() - this.reserveSlots)
    const share = Math.floor(room / due.length)
    const tags = itemTags(inventory.registry)
    const out: TopUp[] = []
    for (const level of due) {
      const mark = level.mark
      const fits = Math.max(share, 0) * unitsPerSlot(mark, inventory.registry)
      const units = Math.ceil(Math.min(mark.high - level.have, fits))
      if (units <= 0) continue
      const alts = (typeof mark.gather === 'string' ? [mark.gather] : mark.gather).flatMap(g => [...tags.resolve(g)])
      const held = heldFor(inventory, alts, { unit: mark.unit })
      const request: ObtainRequest = { item: mark.gather, count: held + units, ...(mark.unit != null ? { unit: mark.unit } : {}) }
      out.push({ mark, level, units, request, budget: Math.ceil(units * mark.ticksPerUnit) })
    }
    return out
  }

  /**
   * How many of an item the working set carries (the marks' keep and the options' keep list), or null when the list
   * says nothing of it: the executor's keep rule over its default (src/executor/keep.ts defaultKeep)
   */
  keepCount (name: string, registry?: RegistryLike): number | null {
    if (this.keepList[name] != null) return this.keepList[name]
    if (registry == null) return null
    const tags = itemTags(registry)
    let n: number | null = null
    for (const [k, c] of Object.entries(this.keepList)) if (k.startsWith('#') && tags.matches(k, name)) n = Math.max(n ?? 0, c)
    return n
  }
}

/** the base's chests' contents summed, by item (the memory's: what was seen or stored last) */
export function storedAtBase (chests: ReadonlyArray<{ items: Readonly<Record<string, number>> } | undefined>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of chests) for (const [name, n] of Object.entries(c?.items ?? {})) out[name] = (out[name] ?? 0) + n
  return out
}
