// Enchanting: the table and its 15 bookshelves set up where EnchantingTableBlock counts them, the three offers of the
// enchanting screen read (EnchantmentMenu's data slots), the offer chosen by its hint and a preference list for the
// item's kind, and the item enchanted; enchantGear does it for the bot's gear, gaining levels first.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { normalizeDimension, type WorldMemory } from '../core/memory'
import type { ObtainOptions, ObtainPlan, ObtainRequest } from '../planner/obtain'
import { obtainAll } from '../planner/obtain'
import type { RegistryLike } from '../core/registry'
import { SkillError, isAbort, isSkillError, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { craft } from './craft'
import { chooseBest, toolCategory, toolTier } from './equipBest'
import { navigateToReach } from './navigate'
import { placeBlock } from './placeBlock'
import { isFree, isSolid, type BlockLookup, type BlockView } from './placement'
import { experience, gainLevels, type GainLevelsArgs } from './xp'
import { REPLACEABLE_BLOCKS, countItems, inventoryItems, resyncInventory, settleInventory, trace, waitTicks, waitUntil, type Block } from './util'

// ---------------------------------------------------------------------------------------------------------------------
// The bookshelves

/** bookshelves the table counts at most (EnchantmentHelper.getEnchantmentCost caps them at 15) */
export const MAX_BOOKSHELVES = 15

/**
 * EnchantingTableBlock.BOOKSHELF_OFFSETS: BlockPos.betweenClosed(-2, 0, -2, 2, 1, 2) with |x| or |z| 2, the ring two
 * out from the table at its level and one up (32 cells), in that order (x, then y, then z, as betweenClosed walks).
 */
export const BOOKSHELF_OFFSETS: readonly Vec3[] = (() => {
  const out: Vec3[] = []
  for (let dz = -2; dz <= 2; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 || Math.abs(dz) === 2) out.push(new Vec3(dx, dy, dz))
      }
    }
  }
  return out
})()

/** the offsets as the runner's first take named them */
export function bookshelfOffsets (): Vec3[] {
  return BOOKSHELF_OFFSETS.map(o => o.clone())
}

/**
 * The cell between a bookshelf and the table that has to let the power through (EnchantingTableBlock.isValidBookShelf:
 * pos.offset(offset.getX() / 2, offset.getY(), offset.getZ() / 2), Java's division rounding toward 0).
 */
export function bookshelfGap (offset: Vec3): Vec3 {
  return new Vec3(Math.trunc(offset.x / 2) + 0, offset.y, Math.trunc(offset.z / 2) + 0)
}

/** BlockTags.ENCHANTMENT_POWER_PROVIDER (the bookshelf) */
export const isPowerProvider = (name: string | undefined): boolean => name === 'bookshelf'
/** BlockTags.ENCHANTMENT_POWER_TRANSMITTER: the replaceable blocks (air, grass, snow, water, ...) */
export const isPowerTransmitter = (name: string | undefined): boolean => name != null && REPLACEABLE_BLOCKS.has(name)

/** EnchantingTableBlock.isValidBookShelf */
export function isValidBookShelf (lookup: BlockLookup, table: Vec3, offset: Vec3): boolean {
  return isPowerProvider(lookup(table.plus(offset))?.name) && isPowerTransmitter(lookup(table.plus(bookshelfGap(offset)))?.name)
}

/** the bookshelves the table at `table` counts (EnchantmentMenu.slotsChanged), uncapped */
export function countBookshelves (lookup: BlockLookup, table: Vec3): number {
  return BOOKSHELF_OFFSETS.filter(o => isValidBookShelf(lookup, table, o)).length
}

/**
 * The range EnchantmentHelper.getEnchantmentCost puts an offer's cost in, for an item with some enchantability:
 * i = nextInt(8) + 1 + (shelves >> 1) + nextInt(shelves + 1); the top slot max(i, shelves × 2), the middle i × 2 / 3 + 1,
 * the first max(i / 3, 1). With 15 shelves the top offer is 30 whatever the rolls; with 14 it is 29 at most.
 */
export function offerCostRange (slot: 0 | 1 | 2, bookshelves: number): { min: number, max: number } {
  const b = Math.min(bookshelves, MAX_BOOKSHELVES)
  const lo = 1 + (b >> 1)
  const hi = 8 + (b >> 1) + b
  const cost = (i: number): number => slot === 0 ? Math.max(Math.trunc(i / 3), 1) : slot === 1 ? Math.trunc(i * 2 / 3) + 1 : Math.max(i, b * 2)
  return { min: cost(lo), max: cost(hi) }
}

/** whether a top offer's cost is one the table makes with that many shelves counted (offerCostRange) */
export function topOfferFits (cost: number, bookshelves: number): boolean {
  const range = offerCostRange(2, bookshelves)
  return cost >= range.min && cost <= range.max
}

/** the bottom ring's middle cells: one is left out as the way in to the table */
const DOORS = [new Vec3(0, 0, -2), new Vec3(0, 0, 2), new Vec3(-2, 0, 0), new Vec3(2, 0, 0)]

/**
 * Where to put the bookshelves still needed around a table: the bottom ring first (16 cells, one left out as the way
 * in: the door), then the ring above it over the shelves below. Cells already holding a counted shelf are skipped; a
 * cell is used only when it is free and the gap to the table lets the power through. Returns the offsets, in order.
 */
export function bookshelfLayout (lookup: BlockLookup, table: Vec3, door: Vec3 = DOORS[0], needed = MAX_BOOKSHELVES - countBookshelves(lookup, table)): Vec3[] {
  if (needed <= 0) return []
  const out: Vec3[] = []
  const usable = (o: Vec3): boolean => isFree(lookup(table.plus(o))) && isPowerTransmitter(lookup(table.plus(bookshelfGap(o)))?.name)
  const bottom = BOOKSHELF_OFFSETS.filter(o => o.y === 0 && !o.equals(door))
  for (const o of bottom) if (out.length < needed && usable(o)) out.push(o)
  const shelfBelow = (o: Vec3): boolean => isPowerProvider(lookup(table.plus(o).offset(0, -1, 0))?.name) || out.some(p => p.equals(o.offset(0, -1, 0)))
  for (const o of BOOKSHELF_OFFSETS.filter(o => o.y === 1 && !o.equals(door.offset(0, 1, 0)))) {
    if (out.length < needed && usable(o) && (shelfBelow(o) || isSolid(lookup(table.plus(o).offset(0, -1, 0))))) out.push(o)
  }
  return out
}

/** the door nearest a point (the way the bot comes in from) */
export function nearestDoor (table: Vec3, from: Vec3): Vec3 {
  return [...DOORS].sort((a, b) => table.plus(a).distanceTo(from) - table.plus(b).distanceTo(from))[0]
}

// ---------------------------------------------------------------------------------------------------------------------
// The site

/** blocks the site's clearing may break: the ground and what grows on it (not anything built) */
const NATURAL = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|sand|red_sand|gravel|stone|deepslate|tuff|granite|diorite|andesite|calcite|netherrack|end_stone|snow_block|moss_block|moss_carpet|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|sweet_berry_bush|.*_leaves|.*_sapling|.*_mushroom|pumpkin|melon)$/

export interface EnchantingSite {
  /** the table's cell */
  table: Vec3
  /** blocks to break first: in the 5 × 5 around the table, at its level and one up */
  dig: Vec3[]
  /** floor cells to fill under the 5 × 5 */
  fill: Vec3[]
  /** the cost the choice ranked it by */
  score: number
}

export interface SiteOptions {
  /** how far from `around` the table may go, horizontally (default 12) */
  radius?: number
  /** levels up and down from `around` (default 3) */
  dy?: number
  /** cells not to break (the base's walls) */
  keep?: (pos: Vec3) => boolean
}

/**
 * The best spot for the table near `around`: its 5 × 5 × 2 free of anything but the plants and ground the bot may
 * clear (or holding shelves already), on a floor that is solid or can be filled from below; least work first, then
 * the nearest. Null when there's none.
 */
export function chooseEnchantingSite (lookup: (pos: Vec3) => BlockView | null, around: Vec3, opts: SiteOptions = {}): EnchantingSite | null {
  const radius = opts.radius ?? 12
  const levels = opts.dy ?? 3
  const centre = around.floored()
  let best: EnchantingSite | null = null
  for (let dy = -levels; dy <= levels; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const table = centre.offset(dx, dy, dz)
        const site = siteAt(lookup, table, opts.keep)
        if (site == null) continue
        site.score += Math.hypot(dx, dz) * 0.25 + Math.abs(dy) * 1.5
        if (best == null || site.score < best.score) best = site
      }
    }
  }
  return best
}

function siteAt (lookup: (pos: Vec3) => BlockView | null, table: Vec3, keep?: (pos: Vec3) => boolean): EnchantingSite | null {
  const dig: Vec3[] = []
  const fill: Vec3[] = []
  for (let y = 1; y >= 0; y--) {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        const pos = table.offset(x, y, z)
        const block = lookup(pos)
        if (block == null) return null
        if (x === 0 && z === 0 && y === 0 && block.name === 'enchanting_table') continue
        if ((Math.abs(x) === 2 || Math.abs(z) === 2) && block.name === 'bookshelf') continue
        if (block.name === 'water' || block.name === 'lava') return null
        if (isFree(block)) continue
        if (!NATURAL.test(block.name) || keep?.(pos) === true) return null
        dig.push(pos)
      }
    }
  }
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      const pos = table.offset(x, -1, z)
      const floor = lookup(pos)
      if (floor == null) return null
      if (isSolid(floor)) continue
      if (!isFree(floor) && !NATURAL.test(floor.name)) return null
      // a hole one deep is filled; a deeper one makes a poor site
      if (!isSolid(lookup(pos.offset(0, -1, 0)))) return null
      if (!isFree(floor)) dig.push(pos)
      fill.push(pos)
    }
  }
  return { table, dig, fill, score: dig.length * 3 + fill.length * 2 }
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials

/** the planner's requests for a table with 15 shelves and lapis for `enchants` enchantments at the top offer */
export function enchantingRequests (opts: { bookshelves?: number, table?: boolean, enchants?: number } = {}): ObtainRequest[] {
  const out: ObtainRequest[] = []
  if (opts.table !== false) out.push({ item: 'enchanting_table', count: 1 })
  const shelves = opts.bookshelves ?? MAX_BOOKSHELVES
  if (shelves > 0) out.push({ item: 'bookshelf', count: shelves })
  const enchants = opts.enchants ?? 3
  if (enchants > 0) out.push({ item: 'lapis_lazuli', count: enchants * 3 })
  return out
}

/** the plan for the whole setup from what the options say the bot has: sugar cane, paper, leather, books, planks, shelves, diamonds, obsidian */
export function planEnchantingSetup (registry: RegistryLike, opts: ObtainOptions & { bookshelves?: number, table?: boolean, enchants?: number } = {}): ObtainPlan {
  return obtainAll(registry, enchantingRequests(opts), opts)
}

/** blocks to fill floor holes with, the ones least worth keeping first */
const FILLERS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'sand', 'gravel']

// ---------------------------------------------------------------------------------------------------------------------
// Offers

export interface EnchantOffer {
  slot: 0 | 1 | 2
  /** EnchantmentMenu.costs: the level the offer needs (0 when there is none) */
  cost: number
  /** EnchantmentMenu.enchantClue: one of the enchantments it gives, by name (null when none shows) */
  hint: string | null
  /** EnchantmentMenu.levelClue */
  hintLevel: number
}

export type ItemKind = 'sword' | 'axe' | 'pickaxe' | 'shovel' | 'hoe' | 'helmet' | 'chestplate' | 'leggings' | 'boots' | 'bow' |
'crossbow' | 'trident' | 'mace' | 'fishing_rod' | 'book' | 'other'

export function itemKind (name: string): ItemKind {
  if (name === 'book') return 'book'
  if (name === 'turtle_helmet') return 'helmet'
  const m = /(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$/.exec(name)
  if (m != null) return (name.endsWith('pickaxe') ? 'pickaxe' : m[1]) as ItemKind
  if (['bow', 'crossbow', 'trident', 'mace', 'fishing_rod'].includes(name)) return name as ItemKind
  return 'other'
}

/** the enchantments wanted on each kind of item, the most wanted first */
export const ENCHANT_PREFERENCES: Record<ItemKind, readonly string[]> = {
  sword: ['sharpness', 'looting', 'sweeping_edge', 'unbreaking', 'fire_aspect', 'smite', 'bane_of_arthropods'],
  axe: ['efficiency', 'sharpness', 'unbreaking', 'fortune', 'silk_touch'],
  pickaxe: ['efficiency', 'unbreaking', 'fortune', 'silk_touch'],
  shovel: ['efficiency', 'unbreaking', 'fortune', 'silk_touch'],
  hoe: ['efficiency', 'unbreaking', 'fortune'],
  helmet: ['protection', 'unbreaking', 'respiration', 'aqua_affinity', 'blast_protection', 'projectile_protection', 'fire_protection'],
  chestplate: ['protection', 'unbreaking', 'blast_protection', 'projectile_protection', 'fire_protection'],
  leggings: ['protection', 'unbreaking', 'blast_protection', 'projectile_protection', 'fire_protection'],
  boots: ['feather_falling', 'protection', 'unbreaking', 'depth_strider', 'blast_protection', 'projectile_protection', 'fire_protection'],
  bow: ['power', 'infinity', 'unbreaking', 'punch', 'flame'],
  crossbow: ['quick_charge', 'multishot', 'piercing', 'unbreaking'],
  trident: ['loyalty', 'impaling', 'unbreaking', 'channeling', 'riptide'],
  mace: ['density', 'breach', 'unbreaking', 'wind_burst'],
  fishing_rod: ['luck_of_the_sea', 'lure', 'unbreaking'],
  book: ['protection', 'sharpness', 'efficiency', 'feather_falling', 'power', 'unbreaking', 'looting', 'fortune'],
  other: ['unbreaking']
}

export interface OfferChoiceContext {
  /** the bot's level */
  level: number
  /** lapis in the table's slot (an offer takes its slot + 1) */
  lapis: number
  /** the enchantments wanted, the most wanted first */
  preference: readonly string[]
  /** wait for the top offer (the 30 of 15 shelves) when the bot can't pay for it yet, instead of taking a lower one */
  waitForTop?: boolean
  /** creative players pay nothing (EnchantmentMenu.clickMenuButton) */
  creative?: boolean
}

export type OfferChoice =
  | { action: 'enchant', slot: 0 | 1 | 2, offer: EnchantOffer, score: number }
  /** the top offer needs more levels: gain them and come back */
  | { action: 'wait', needLevels: number, offer: EnchantOffer }
  | { action: 'none', reason: string }

/** what an offer is worth: its cost (a higher cost rolls more and stronger enchantments), more for a wanted hint */
export function offerScore (offer: EnchantOffer, preference: readonly string[]): number {
  if (offer.cost <= 0) return -Infinity
  const rank = offer.hint == null ? -1 : preference.indexOf(offer.hint)
  const wanted = rank < 0 ? 0 : 6 * (preference.length - rank) / preference.length + offer.hintLevel
  return offer.cost + wanted
}

/**
 * The offer to take, as EnchantmentMenu.clickMenuButton allows it (the levels of its cost, its slot + 1 lapis): the
 * best scored of the ones the bot can pay for. With waitForTop, an unaffordable top offer means waiting for levels.
 */
export function chooseOffer (offers: readonly EnchantOffer[], ctx: OfferChoiceContext): OfferChoice {
  const available = offers.filter(o => o.cost > 0)
  if (available.length === 0) return { action: 'none', reason: 'the item has no offers (not enchantable)' }
  const affordable = (o: EnchantOffer): boolean => ctx.creative === true || (ctx.level >= o.cost && ctx.lapis >= o.slot + 1)
  if (ctx.waitForTop === true) {
    const top = available.reduce((a, b) => b.cost > a.cost || (b.cost === a.cost && b.slot > a.slot) ? b : a)
    if (!affordable(top) && ctx.lapis >= top.slot + 1) return { action: 'wait', needLevels: top.cost, offer: top }
  }
  let best: { offer: EnchantOffer, score: number } | null = null
  for (const offer of available) {
    if (!affordable(offer)) continue
    const score = offerScore(offer, ctx.preference)
    if (best == null || score > best.score || (score === best.score && offer.slot > best.offer.slot)) best = { offer, score }
  }
  if (best == null) {
    const cheapest = available.reduce((a, b) => b.cost < a.cost ? b : a)
    return ctx.lapis < cheapest.slot + 1
      ? { action: 'none', reason: `${ctx.lapis} lapis, the cheapest offer needs ${cheapest.slot + 1}` }
      : { action: 'none', reason: `level ${ctx.level}, the cheapest offer needs ${cheapest.cost}` }
  }
  return { action: 'enchant', slot: best.offer.slot, offer: best.offer, score: best.score }
}

/** the three offers of an open enchanting window (mineflayer's enchantment_table plugin keeps the data slots) */
export function readOffers (bot: Bot, window: any): EnchantOffer[] {
  return [0, 1, 2].map(slot => {
    const e = window.enchantments?.[slot] ?? { level: 0, expected: { enchant: -1, level: -1 } }
    const id: number = e.expected?.enchant ?? -1
    const hint = id >= 0 ? (bot.registry as any).enchantments?.[id]?.name ?? null : null
    const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, n) : 0 }
    return { slot: slot as 0 | 1 | 2, cost: num(e.level), hint, hintLevel: num(e.expected?.level) }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The table in the world

function memoryOf (bot: Bot, memory?: WorldMemory): WorldMemory | undefined {
  return memory ?? (bot as any).survival?.memory
}

const blockLookup = (bot: Bot): BlockLookup => pos => bot.blockAt(pos) as BlockView | null

/** the enchanting table to use: the one given, a remembered one still there, or one within `maxDistance` */
export function findEnchantingTable (bot: Bot, opts: { table?: Vec3, memory?: WorldMemory, maxDistance?: number } = {}): Block | null {
  const tableId = bot.registry.blocksByName.enchanting_table.id
  if (opts.table != null) {
    const block = bot.blockAt(opts.table.floored())
    return block?.type === tableId ? block : null
  }
  const dimension = normalizeDimension(bot.game?.dimension)
  for (const poi of memoryOf(bot, opts.memory)?.getPois('enchanting_table', { dimension, near: bot.entity.position }) ?? []) {
    const block = bot.blockAt(new Vec3(poi.x, poi.y, poi.z))
    if (block?.type === tableId) return block
  }
  return bot.findBlock({ matching: tableId, maxDistance: opts.maxDistance ?? 32 })
}

/** an item to read the offers with: a book, else any unenchanted item that takes enchantments */
function probeItem (bot: Bot): Item | null {
  const plain = inventoryItems(bot).filter(i => (i.enchants?.length ?? 0) === 0)
  return plain.find(i => i.name === 'book') ?? plain.find(i => itemKind(i.name) !== 'other' && i.name !== 'book') ?? null
}

/**
 * Puts the item in the open table and waits for its offers: the server's EnchantmentMenu.slotsChanged sends the
 * costs once the slot changes (the window opens with all three at 0, the first cost of an enchantable item is >= 1).
 */
async function offersFor (bot: Bot, window: any, pick: (item: Item) => boolean, signal?: AbortSignal): Promise<EnchantOffer[]> {
  // the window's own slots (its player inventory starts at 2, not 9)
  const item: Item | undefined = window.items().find(pick)
  if (item == null) throw new SkillError('MISSING_ITEMS', 'the item to enchant is not in the inventory')
  await window.putTargetItem(item)
  await waitUntil(bot, () => readOffers(bot, window)[0].cost > 0, 40, signal)
  // the hints come in the same broadcast; a tick more for the lapis slot's own change
  await waitTicks(bot, 2, signal)
  return readOffers(bot, window)
}

/**
 * The offers the table makes for an item, read and the item taken back: with 15 shelves counted, the top offer is 30.
 */
export async function readTableOffers (bot: Bot, table: Vec3, item: Item, signal?: AbortSignal): Promise<EnchantOffer[]> {
  await navigateToReach(bot, table, signal)
  await settleInventory(bot, signal)
  const block = bot.blockAt(table)
  if (block?.name !== 'enchanting_table') throw new SkillError('NOT_FOUND', `no enchanting table at ${table.toString()}`)
  const window: any = await bot.openEnchantmentTable(block as any)
  try {
    const offers = await offersFor(bot, window, i => i.name === item.name && (i.enchants?.length ?? 0) === 0, signal)
    if (window.targetItem() != null) await window.takeTargetItem()
    return offers
  } finally {
    window.close()
    await settleInventory(bot, signal)
  }
}

export interface SetupEnchantingArgs {
  /** where the table goes (or is); default: an existing one, else a site near the base, else near the bot */
  table?: Vec3
  memory?: WorldMemory
  /** craft the table and shelves from the parts held when they aren't (default true) */
  craft?: boolean
  /** read the offers to check the shelves (default true, when the bot holds something to read them with) */
  verify?: boolean
  /** how far from the base or the bot to look for a site (default 12) */
  radius?: number
  /**
   * the shelves to have round the table (default MAX_BOOKSHELVES): fewer when the world gave fewer (the sugar cane and
   * leather of 15 are 135 canes and 45 cows), the offers' costs lower (offerCostRange)
   */
  bookshelves?: number
}

export interface SetupEnchantingResult {
  table: Vec3
  /** shelves the table counts */
  bookshelves: number
  placedTable: boolean
  placedShelves: number
  dug: number
  filled: number
  /** the offered costs the check read (null when not checked) */
  costs: number[] | null
}

/**
 * Sets up an enchanting table with 15 bookshelves: the table remembered or nearby, or one placed at a site near the
 * base (WorldMemory.base) or the bot, its 5 × 5 cleared and floored; the shelves put where
 * EnchantingTableBlock.BOOKSHELF_OFFSETS counts them with the gap to the table left free, the bottom ring first with
 * a way in left open. Checked against the world, then by the offers: a level-30 offer means 15 shelves.
 */
export async function setupEnchanting (bot: Bot, args: SetupEnchantingArgs = {}, signal?: AbortSignal): Promise<SetupEnchantingResult> {
  throwIfAborted(signal)
  const memory = memoryOf(bot, args.memory)
  const dimension = normalizeDimension(bot.game?.dimension)
  const lookup = blockLookup(bot)
  const res: SetupEnchantingResult = { table: bot.entity.position.floored(), bookshelves: 0, placedTable: false, placedShelves: 0, dug: 0, filled: 0, costs: null }

  let table = findEnchantingTable(bot, { table: args.table, memory, maxDistance: 16 })?.position ?? null
  const shelvesHeld = (): number => countItems(bot, 'bookshelf')
  const target = Math.max(0, Math.min(MAX_BOOKSHELVES, args.bookshelves ?? MAX_BOOKSHELVES))
  const needed = (): number => Math.max(0, target - (table == null ? 0 : countBookshelves(lookup, table)))

  // the items: the table and the shelves still to put down
  if (table == null && countItems(bot, 'enchanting_table') === 0) {
    if (args.craft === false) throw new SkillError('MISSING_ITEMS', 'no enchanting table', res)
    await craft(bot, { item: 'enchanting_table' }, signal)
  }
  if (shelvesHeld() < needed()) {
    if (args.craft === false) throw new SkillError('MISSING_ITEMS', `${shelvesHeld()} bookshelves, ${needed()} needed`, res)
    try {
      await craft(bot, { item: 'bookshelf', count: needed() - shelvesHeld() }, signal)
    } catch (err) {
      if (isSkillError(err, 'MISSING_ITEMS')) throw new SkillError('MISSING_ITEMS', `${shelvesHeld()} bookshelves, ${needed()} needed: ${(err as Error).message}`, res, { cause: err })
      throw err
    }
  }

  if (table == null) {
    // a site near the base, keeping off its walls, else near the bot
    const base = memory?.base != null && normalizeDimension(memory.base.dimension) === dimension ? new Vec3(memory.base.x, memory.base.y, memory.base.z) : null
    const keep = base == null ? undefined : (pos: Vec3): boolean => Math.max(Math.abs(pos.x - base.x), Math.abs(pos.z - base.z)) <= 12 && Math.abs(pos.y - base.y) <= 8
    const around = args.table ?? base ?? bot.entity.position
    const site = (args.table != null ? chooseEnchantingSite(lookup, around, { radius: 0, dy: 0, keep }) : null) ??
      chooseEnchantingSite(lookup, around, { radius: args.radius ?? 12, keep }) ??
      (base != null ? chooseEnchantingSite(lookup, bot.entity.position, { radius: args.radius ?? 12 }) : null)
    if (site == null) throw new SkillError('CANNOT_PLACE', `no room for an enchanting table and its shelves near ${around.toString()}`, res)
    trace('setupEnchanting: site', site.table.toString(), 'dig', site.dig.length, 'fill', site.fill.length)
    if (site.dig.length > 0) {
      const dug = await collectBlock(bot, { positions: site.dig, pickup: true }, signal)
      res.dug = dug.mined
    }
    for (const pos of site.fill) {
      if (isSolid(lookup(pos))) continue
      const filler = FILLERS.find(name => countItems(bot, name) > 0)
      if (filler == null) throw new SkillError('MISSING_ITEMS', `nothing to fill the floor at ${pos.toString()} with`, res)
      await placeBlock(bot, { pos, item: filler }, signal)
      res.filled++
    }
    await placeBlock(bot, { pos: site.table, item: 'enchanting_table' }, signal)
    table = site.table
    res.placedTable = true
  }
  res.table = table
  memory?.addPoi('enchanting_table', table, dimension)

  // the shelves, a pass more for any the pathfinder took or a placement missed
  for (let pass = 0; pass < 3 && needed() > 0 && shelvesHeld() > 0; pass++) {
    const door = nearestDoor(table, bot.entity.position)
    for (const offset of bookshelfLayout(lookup, table, door, Math.min(needed(), shelvesHeld()))) {
      throwIfAborted(signal, res)
      const pos = table.plus(offset)
      try {
        const placed = await placeBlock(bot, { pos, item: 'bookshelf' }, signal)
        if (placed.placed) res.placedShelves++
      } catch (err) {
        if (isAbort(err)) throw err
        trace('setupEnchanting: a shelf at', pos.toString(), 'failed:', (err as Error).message)
      }
    }
  }
  res.bookshelves = countBookshelves(lookup, table)
  if (res.bookshelves < target) {
    throw new SkillError(shelvesHeld() > 0 ? 'VERIFY_FAILED' : 'MISSING_ITEMS', `the table at ${table.toString()} counts ${res.bookshelves} bookshelves of ${target}`, res)
  }

  // the table's own count: the top offer for anything enchantable is 30 with 15 shelves, in offerCostRange's range
  // with fewer
  const probe = args.verify === false ? null : probeItem(bot)
  if (probe != null) {
    const offers = await readTableOffers(bot, table, probe, signal)
    res.costs = offers.map(o => o.cost)
    trace('setupEnchanting: offers for', probe.name, res.costs)
    if (!topOfferFits(offers[2].cost, res.bookshelves)) {
      const range = offerCostRange(2, res.bookshelves)
      throw new SkillError('VERIFY_FAILED', `the table's top offer for ${probe.name} is ${offers[2].cost}, not ${range.min === range.max ? range.min : `${range.min} to ${range.max}`} (${res.bookshelves} shelves)`, res)
    }
  }
  return res
}

// ---------------------------------------------------------------------------------------------------------------------
// Enchanting

/** where a worn armor piece goes back to */
const ARMOR_DESTINATIONS: Partial<Record<ItemKind, 'head' | 'torso' | 'legs' | 'feet'>> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

export interface EnchantArgs {
  /** the item: a name (an unenchanted one held or worn), or the item itself */
  item: string | Item
  /** the enchantments wanted, the most wanted first (default ENCHANT_PREFERENCES of its kind) */
  preference?: readonly string[]
  /** wait for the top offer: throws MISSING_ITEMS with `needLevels` when the levels aren't there yet (default false) */
  waitForTop?: boolean
  /** the table (default: findEnchantingTable) */
  table?: Vec3
  memory?: WorldMemory
}

export interface EnchantResult {
  item: string
  slot: 0 | 1 | 2
  cost: number
  hint: string | null
  offers: EnchantOffer[]
  /** what the item came out with */
  enchants: Array<{ name: string | null, lvl: number }>
  levelBefore: number
  levelAfter: number
  lapisUsed: number
}

export interface EnchantWaitPartial {
  needLevels: number
  offers: EnchantOffer[]
}

/**
 * Enchants an item at the table: the item and lapis in, the three offers read, the one chooseOffer picks by its hint
 * and the preference list clicked (EnchantmentMenu.clickMenuButton), the item checked for its enchantments and taken
 * back (and worn again if it was worn).
 */
export async function enchant (bot: Bot, args: EnchantArgs, signal?: AbortSignal): Promise<EnchantResult> {
  throwIfAborted(signal)
  const block = findEnchantingTable(bot, { table: args.table, memory: args.memory })
  if (block == null) throw new SkillError('NOT_FOUND', 'no enchanting table nearby')
  const tablePos = block.position
  const name = typeof args.item === 'string' ? args.item : args.item.name
  const kind = itemKind(name)
  const preference = args.preference ?? ENCHANT_PREFERENCES[kind]

  // the item: held, or worn (taken off for it)
  const plain = (i: Item | null | undefined): i is Item => i != null && i.name === name && (i.enchants?.length ?? 0) === 0
  let worn: 'head' | 'torso' | 'legs' | 'feet' | null = null
  if (inventoryItems(bot).find(plain) == null) {
    const dest = ARMOR_DESTINATIONS[kind]
    if (dest != null && plain(bot.inventory.slots[bot.getEquipmentDestSlot(dest)])) {
      await settleInventory(bot, signal)
      await bot.unequip(dest)
      worn = dest
    }
  }
  if (inventoryItems(bot).find(plain) == null) throw new SkillError('MISSING_ITEMS', `no unenchanted ${name}`)
  if (countItems(bot, 'lapis_lazuli') === 0) throw new SkillError('MISSING_ITEMS', 'no lapis lazuli')

  await navigateToReach(bot, tablePos, signal)
  await settleInventory(bot, signal)
  const levelBefore = experience(bot).level
  const lapisBefore = countItems(bot, 'lapis_lazuli')
  const window: any = await bot.openEnchantmentTable(block as any)
  let result: EnchantResult | null = null
  try {
    const lapis: Item | undefined = window.items().find((i: Item) => i.name === 'lapis_lazuli')
    if (lapis == null) throw new SkillError('MISSING_ITEMS', 'no lapis to enchant with')
    await window.putLapis(lapis)
    const offers = await offersFor(bot, window, plain, signal)
    const lapisIn = window.slots[1]?.name === 'lapis_lazuli' ? window.slots[1].count as number : 0
    const choice = chooseOffer(offers, { level: experience(bot).level, lapis: lapisIn, preference, waitForTop: args.waitForTop, creative: bot.game.gameMode === 'creative' })
    trace('enchant:', name, 'offers', offers.map(o => `${o.cost}:${o.hint ?? '?'} ${o.hintLevel}`).join(', '), '->', JSON.stringify(choice))
    if (choice.action === 'wait') {
      throw new SkillError<EnchantWaitPartial>('MISSING_ITEMS', `the top offer for ${name} needs level ${choice.needLevels}, the bot is ${experience(bot).level}`, { needLevels: choice.needLevels, offers })
    }
    if (choice.action === 'none') throw new SkillError('MISSING_ITEMS', `no offer to take for ${name}: ${choice.reason}`, { offers })

    // ServerboundContainerButtonClickPacket with the slot; the server answers with the enchanted item in slot 0
    const enchanted = (): boolean => (window.slots[0]?.enchants?.length ?? 0) > 0 || window.slots[0]?.name === 'enchanted_book'
    bot.clickEnchantment(choice.slot, window)
    if (!await waitUntil(bot, enchanted, 40, signal)) {
      throw new SkillError('VERIFY_FAILED', `the table didn't enchant ${name} with offer ${choice.slot} (cost ${choice.offer.cost})`, { offers })
    }
    const out: Item = window.slots[0]
    // the levels and lapis taken: slot + 1 of each (Player.onEnchantmentPerformed)
    await waitUntil(bot, () => experience(bot).level < levelBefore || bot.game.gameMode === 'creative', 20, signal)
    result = {
      item: out.name,
      slot: choice.slot,
      cost: choice.offer.cost,
      hint: choice.offer.hint,
      offers,
      enchants: out.enchants ?? [],
      levelBefore,
      levelAfter: experience(bot).level,
      lapisUsed: 0
    }
    await window.takeTargetItem()
  } finally {
    // the lapis left comes back with the close (EnchantmentMenu.removed: clearContainer)
    window.close()
    await settleInventory(bot, signal)
    await resyncInventory(bot, signal)
    if (worn != null) {
      const back = inventoryItems(bot).find(i => i.name === name || (result != null && i.name === result.item))
      if (back != null) await bot.equip(back, worn).catch(() => {})
    }
  }
  result.lapisUsed = lapisBefore - countItems(bot, 'lapis_lazuli')
  if ((result.enchants.length === 0 && result.item !== 'enchanted_book')) throw new SkillError('VERIFY_FAILED', `${name} came out with no enchantments`, result)
  return result
}

// ---------------------------------------------------------------------------------------------------------------------
// The milestone

/** the gear enchanted first: the pickaxe (the milestone's own check), then the sword and the armor */
export const GEAR_ORDER: readonly ItemKind[] = ['pickaxe', 'sword', 'chestplate', 'leggings', 'helmet', 'boots', 'bow', 'axe']

/** the best unenchanted item of a kind, held or worn */
export function gearToEnchant (bot: Bot, kind: ItemKind): Item | null {
  const plain = (i: Item | null | undefined): i is Item => i != null && (i.enchants?.length ?? 0) === 0 && itemKind(i.name) === kind
  const items = inventoryItems(bot).filter(plain)
  const dest = ARMOR_DESTINATIONS[kind]
  const wornItem = dest != null ? bot.inventory.slots[bot.getEquipmentDestSlot(dest)] : null
  if (plain(wornItem)) items.push(wornItem)
  return bestOfKind(items)
}

/** armor materials best first (ArmorMaterials by defense, then durability) */
const ARMOR_MATERIALS = ['netherite', 'diamond', 'iron', 'chainmail', 'turtle', 'golden', 'copper', 'leather']

/** the best of some items of one kind: the best tool tier (equipBest's choice), the best armor material */
export function bestOfKind (items: Item[]): Item | null {
  if (items.length === 0) return null
  const category = toolCategory(items[0].name)
  if (category != null) return chooseBest(items, category)
  const rank = (n: string): number => { const r = ARMOR_MATERIALS.indexOf(n.split('_')[0]); return r < 0 ? toolTier(n) : r }
  return [...items].sort((a, b) => rank(a.name) - rank(b.name))[0]
}

export interface EnchantGearOptions {
  /** the runner's executor: its memory is used */
  executor?: { memory?: WorldMemory }
  memory?: WorldMemory
  /** the kinds to enchant, in order (default GEAR_ORDER) */
  categories?: readonly ItemKind[]
  /** the level to gain before the first enchant (default the dearest top offer of the shelves set up: 30 with 15; 0 for none) */
  targetLevel?: number
  /** the shelves to set up round the table (setupEnchanting's; default 15) */
  bookshelves?: number
  /** how the levels are gained (gainLevels' options) */
  xp?: Omit<GainLevelsArgs, 'level'>
  signal?: AbortSignal
}

export interface EnchantGearResult {
  setup: SetupEnchantingResult
  enchanted: EnchantResult[]
}

/**
 * The enchanting milestone: the table and shelves set up, levels gained up to the top offer, then the gear enchanted
 * in order (the best offer the levels and lapis pay for each, the first at the top offer).
 */
export async function enchantAll (bot: Bot, opts: EnchantGearOptions = {}): Promise<EnchantGearResult> {
  const signal = opts.signal
  const memory = opts.memory ?? opts.executor?.memory
  const setup = await setupEnchanting(bot, { memory, bookshelves: opts.bookshelves }, signal)
  const target = opts.targetLevel ?? offerCostRange(2, setup.bookshelves).max
  if (experience(bot).level < target) {
    try {
      await gainLevels(bot, { ...opts.xp, level: target }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('enchantGear: levels:', (err as Error).message)
    }
  }
  const enchanted: EnchantResult[] = []
  for (const kind of opts.categories ?? GEAR_ORDER) {
    throwIfAborted(signal)
    if (countItems(bot, 'lapis_lazuli') === 0 || experience(bot).level < 1) break
    const item = gearToEnchant(bot, kind)
    if (item == null) continue
    try {
      enchanted.push(await enchant(bot, { item: item.name, table: setup.table, memory }, signal))
    } catch (err) {
      if (isAbort(err) || !isSkillError(err, 'MISSING_ITEMS')) throw err
      trace('enchantGear:', item.name, (err as Error).message)
    }
  }
  return { setup, enchanted }
}

/** enchantAll for the runner: resolves the first item enchanted, or null */
export async function enchantGear (bot: Bot, opts: EnchantGearOptions = {}): Promise<string | null> {
  const { enchanted } = await enchantAll(bot, opts)
  return enchanted[0]?.item ?? null
}
