// A sugar cane farm by water, the paper of the enchanting's books: canes planted on the ground beside water
// (SugarCaneBlock.canSurvive: the block under a cane is a cane, or dirt or sand with water or frosted ice on a side),
// a water hole dug and filled from a bucket where there's none, and the grown canes cut above their bottom block
// (harvestSugarCane's keepBase) so they grow again.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { findBlocks } from '../core/findBlocks'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { collectBlock, columnHarvestTarget } from './collectBlock'
import { navigateNear } from './navigate'
import { placeBlock } from './placeBlock'
import { countItems, findInventoryItem, trace, waitUntil } from './util'

/** BlockTags.DIRT and BlockTags.SAND: the ground a cane stands on */
export const CANE_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'moss_block', 'mud', 'muddy_mangrove_roots', 'pale_moss_block', 'sand', 'red_sand', 'suspicious_sand'])
const WATERS = new Set(['water', 'frosted_ice'])
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

export type CaneLookup = (pos: Vec3) => { name: string } | null

/** whether a cane can stand on the ground block at `ground`: cane ground, water on a side of it, room over it */
export function caneSpot (lookup: CaneLookup, ground: Vec3): boolean {
  const g = lookup(ground)?.name
  if (g == null || !CANE_GROUND.has(g)) return false
  const above = lookup(ground.offset(0, 1, 0))?.name
  if (above !== 'air' && above !== 'cave_air' && above !== 'short_grass' && above !== 'sugar_cane') return false
  return SIDES.some(s => WATERS.has(lookup(ground.plus(s))?.name ?? ''))
}

/**
 * the ground blocks within `radius` of `center` (`range`'s blocks under and over its height: 3 and 2 by default) a
 * cane can be planted on, nearest first
 */
export function caneSpots (lookup: CaneLookup, center: Vec3, radius = 12, range: { down: number, up: number } = { down: 3, up: 2 }): Vec3[] {
  const out: Vec3[] = []
  const c = center.floored()
  for (let dy = -range.down; dy <= range.up; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = c.offset(dx, dy, dz)
        if (caneSpot(lookup, p) && lookup(p.offset(0, 1, 0))?.name !== 'sugar_cane') out.push(p)
      }
    }
  }
  return out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c))
}

const AIRS = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'dandelion', 'poppy'])

/**
 * A cell to make a water hole in for a farm: a ground block with cane ground on 2 or more of its four sides (air or a
 * plant over them, the canes' cells) and something under it to hold the water, the most sides first, then the
 * nearest. (Level grass on all four sides found no site on a hillside's edge of a forest: no farm on 26.3 seed 2.)
 */
export function waterHoleSite (lookup: CaneLookup, center: Vec3, radius = 12): Vec3 | null {
  const c = center.floored()
  let best: { p: Vec3, sides: number } | null = null
  for (let dy = -3; dy <= 2; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy >= -1) continue
        const p = c.offset(dx, dy, dz)
        if (!CANE_GROUND.has(lookup(p)?.name ?? '') || !AIRS.has(lookup(p.offset(0, 1, 0))?.name ?? '')) continue
        const under = lookup(p.offset(0, -1, 0))?.name
        if (under == null || AIRS.has(under) || under === 'water' || under === 'lava') continue
        const sides = SIDES.filter(s => CANE_GROUND.has(lookup(p.plus(s))?.name ?? '') && AIRS.has(lookup(p.plus(s).offset(0, 1, 0))?.name ?? '')).length
        if (sides < 2) continue
        if (best == null || sides > best.sides || (sides === best.sides && p.distanceTo(c) < best.p.distanceTo(c))) best = { p, sides }
      }
    }
  }
  return best?.p ?? null
}

/** how far about the bot the loaded chunks' canes are noted (rememberCanes): a river's in sight from its bank */
export const CANE_SIGHT_RADIUS = 96

/**
 * The cane columns in the loaded chunks within `radius`, noted in the memory at their cuts (columnHarvestTarget: the
 * block a mine step breaks, the bottom one left to grow back), and the canes remembered there with nothing to cut now
 * (a column cut down to its bottom block, or gone) forgotten. The steps for paper walk to one noted, and the planner
 * prices it a walk: the canes went unseen, a mine step's own look 64 blocks round and an exploring's 48 at each leg's
 * end the only ones (f3-1.21.11: no cane remembered in all its game). Resolves the columns noted.
 */
export function rememberCanes (bot: Bot, memory: WorldMemory, radius = CANE_SIGHT_RADIUS): number {
  const id = bot.registry.blocksByName.sugar_cane?.id
  if (id == null || bot.entity == null) return 0
  const dimension = normalizeDimension(bot.game?.dimension)
  if (dimension !== 'overworld') return 0
  const lookup: CaneLookup = p => bot.blockAt(p) as any
  const at = bot.entity.position
  for (const known of memory.findBlocks('sugar_cane', { dimension, near: at, maxDistance: radius })) {
    const p = new Vec3(known.x, known.y, known.z)
    // (a chunk not loaded: left as it was)
    if (bot.blockAt(p) == null) continue
    if (columnHarvestTarget(lookup, p)?.equals(p) !== true) memory.forgetBlock(p, dimension)
  }
  const cuts = new Map<string, Vec3>()
  for (const pos of findBlocks(bot, { matching: id, maxDistance: radius, count: 1024 })) {
    const cut = columnHarvestTarget(lookup, pos)
    if (cut != null) cuts.set(`${cut.x},${cut.y},${cut.z}`, cut)
  }
  for (const cut of cuts.values()) memory.rememberBlock('sugar_cane', cut, dimension)
  return cuts.size
}

/**
 * A water channel's cells in a row (the source poured in the middle: FlowingFluid spreads 7 blocks on the flat, so 4
 * each way stays water), and the banks either side the canes stand on: 2 a cell
 */
export const CANE_CHANNEL_LENGTH = 9
/**
 * how far under and over the center's height a farm's spots and channel are looked for (plantSugarCane): a base's door
 * by the sea at y 67 had its grass at 72 to 75 (f3-1.21.11), past the 2 over the spots and the channel were looked for
 */
export const CANE_SITE_RANGE = { down: 8, up: 10 }
/** a channel's cells where the level ground takes no CANE_CHANNEL_LENGTH */
export const CANE_SHORT_CHANNEL = 5
/** the spots a cane farm is planted on at most (a channel's two banks) */
export const CANE_FARM_SPOTS = 2 * CANE_CHANNEL_LENGTH
/** ticks a cane takes to grow a block (SugarCaneBlock.randomTick: 16 random ticks, a block's every 4096 / 3 ticks) */
export const CANE_GROW_TICKS = Math.round(16 * 4096 / 3)
/** a cane farm the memory keeps (a 'cane_farm' point of interest: its note, the spots' ground) */
export const CANE_FARM_POI = 'cane_farm'

export interface CaneChannelSite {
  /** the cells dug and filled with water, in a row; the source poured in the middle one */
  cells: Vec3[]
  /** the ground beside the cells the canes are planted on */
  banks: Vec3[]
}

const LIQUIDS = new Set(['water', 'lava', 'bubble_column'])

/**
 * A row of CANE_CHANNEL_LENGTH (or `length`) cells for a water channel within `radius` of `center` (2 up, 6 down): each
 * cell cane ground with room over it and a solid block under it (the water held), the cells beyond its ends solid too
 * (the water kept in), and cane ground with room over it on both sides (its banks); none of it `avoid`'s (the base's
 * walls) nor under the bot's feet. The nearest to `center`, or null.
 */
export function caneChannelSite (lookup: CaneLookup, center: Vec3, args: { length?: number, radius?: number, avoid?: (pos: Vec3) => boolean, range?: { down: number, up: number } } = {}): CaneChannelSite | null {
  const range = args.range ?? { down: 6, up: 2 }
  const length = args.length ?? CANE_CHANNEL_LENGTH
  const radius = args.radius ?? 16
  const avoid = args.avoid ?? (() => false)
  const c = center.floored()
  const name = (p: Vec3): string => lookup(p)?.name ?? ''
  const ground = (p: Vec3): boolean => CANE_GROUND.has(name(p)) && AIRS.has(name(p.offset(0, 1, 0))) && !avoid(p)
  const holds = (p: Vec3): boolean => { const n = name(p); return n !== '' && !AIRS.has(n) && !LIQUIDS.has(n) }
  const underBot = (p: Vec3): boolean => Math.abs(p.x - c.x) <= 1 && Math.abs(p.z - c.z) <= 1 && Math.abs(p.y - c.y) <= 2
  let best: { site: CaneChannelSite, d: number } | null = null
  for (const [dir, side] of [[new Vec3(1, 0, 0), new Vec3(0, 0, 1)], [new Vec3(0, 0, 1), new Vec3(1, 0, 0)]]) {
    for (let dy = -range.down; dy <= range.up; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const start = c.offset(dx, dy, dz)
          const d = start.plus(dir.scaled(Math.floor(length / 2))).distanceTo(c)
          if (best != null && d >= best.d) continue
          if (!ground(start) || !holds(start.minus(dir)) || !holds(start.plus(dir.scaled(length)))) continue
          const cells = Array.from({ length }, (_, i) => start.plus(dir.scaled(i)))
          if (!cells.every(p => ground(p) && holds(p.offset(0, -1, 0)) && !underBot(p))) continue
          const banks = cells.flatMap(p => [p.plus(side), p.minus(side)])
          if (!banks.every(ground)) continue
          best = { site: { cells, banks }, d }
        }
      }
    }
  }
  return best?.site ?? null
}

/**
 * Pours the water bucket held into the dug cell `hole` from beside it, looking down at its floor (a bucket is used on
 * what the look hits, BucketItem.use, the player's ray: from 3 blocks off it hit the hole's rim and the water went on
 * the ground beside it, 26.3). Resolves whether the cell holds water.
 */
async function pourInto (bot: Bot, hole: Vec3, signal?: AbortSignal): Promise<boolean> {
  const bucket = findInventoryItem(bot, 'water_bucket')
  if (bucket == null) return false
  await navigateNear(bot, hole, 1, signal).catch(err => { if (isAbort(err)) throw err })
  await bot.equip(bucket, 'hand')
  await bot.lookAt(hole.offset(0.5, 0.02, 0.5), true)
  bot.activateItem()
  await waitUntil(bot, () => bot.blockAt(hole)?.name === 'water', 20, signal)
  return bot.blockAt(hole)?.name === 'water'
}

/**
 * A water channel dug at `site` (caneChannelSite) and filled from the water bucket held, poured in its middle cell:
 * the water flows along the rest (FlowingFluid.spreadToSides, a block every 5 ticks). Resolves the cells that hold water
 * (VERIFY_FAILED with none).
 */
export async function makeCaneChannel (bot: Bot, site: CaneChannelSite, signal?: AbortSignal): Promise<Vec3[]> {
  if (countItems(bot, 'water_bucket') === 0) throw new SkillError('MISSING_ITEMS', 'no water bucket for the channel')
  trace('makeCaneChannel: from', site.cells[0].toString(), 'to', site.cells[site.cells.length - 1].toString())
  await collectBlock(bot, { positions: site.cells, pickup: false }, signal)
  const source = site.cells[Math.floor(site.cells.length / 2)]
  if (!await pourInto(bot, source, signal)) throw new SkillError('VERIFY_FAILED', `no water in the channel at ${source.toString()}`)
  const wet = (): Vec3[] => site.cells.filter(p => bot.blockAt(p)?.name === 'water')
  await waitUntil(bot, () => wet().length === site.cells.length, 5 * site.cells.length + 20, signal)
  return wet()
}

/**
 * A water hole dug where cane ground is about (waterHoleSite; or at `at`: a farm's, farmHoleSite) and filled from a
 * water bucket held (pourInto). Resolves the hole, null with no site or no bucket.
 */
export async function makeWaterHole (bot: Bot, center: Vec3, signal?: AbortSignal, at?: Vec3 | null): Promise<Vec3 | null> {
  const lookup: CaneLookup = p => bot.blockAt(p) as any
  const hole = at !== undefined ? at : waterHoleSite(lookup, center)
  if (hole == null || countItems(bot, 'water_bucket') === 0) return null
  trace('makeWaterHole: at', hole.toString())
  await collectBlock(bot, { positions: [hole], pickup: false }, signal)
  if (findInventoryItem(bot, 'water_bucket') == null) return null
  if (!await pourInto(bot, hole, signal)) throw new SkillError('VERIFY_FAILED', `no water in the hole at ${hole.toString()}`)
  return hole
}

/** a cane farm: the ground its canes are planted on */
export interface CaneFarm {
  /** where it is (over its first spot) */
  at: Vec3
  spots: Vec3[]
}

/** the cane farm the memory has, or null (one kept before its spots were: the canes standing about its point) */
export function knownCaneFarm (memory: WorldMemory, lookup?: CaneLookup): CaneFarm | null {
  const poi = memory.getPois(CANE_FARM_POI, { dimension: 'overworld' })[0]
  if (poi == null) return null
  const at = new Vec3(poi.x, poi.y, poi.z)
  try {
    const spots = (JSON.parse(poi.note ?? '') as { spots: Array<[number, number, number]> }).spots.map(([x, y, z]) => new Vec3(x, y, z))
    return { at, spots }
  } catch {}
  return { at, spots: lookup != null ? canesAbout(lookup, at) : [at.offset(0, -1, 0)] }
}

/** the ground of the canes standing about `center` (8 round, 2 up and down): an old farm's spots */
function canesAbout (lookup: CaneLookup, center: Vec3): Vec3[] {
  const out: Vec3[] = []
  for (let dy = -3; dy <= 1; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        const p = center.offset(dx, dy, dz)
        if (lookup(p.offset(0, 1, 0))?.name === 'sugar_cane' && CANE_GROUND.has(lookup(p)?.name ?? '')) out.push(p)
      }
    }
  }
  return out
}

/** the farm's spots kept in the memory (its point over the first) */
export function rememberCaneFarm (memory: WorldMemory, spots: readonly Vec3[]): void {
  if (spots.length === 0) return
  for (const p of memory.getPois(CANE_FARM_POI, { dimension: 'overworld' })) memory.removePoi(CANE_FARM_POI, p, 'overworld')
  memory.addPoi(CANE_FARM_POI, spots[0].offset(0, 1, 0), 'overworld', JSON.stringify({ spots: spots.map(p => [p.x, p.y, p.z]) }))
}

/** the blocks to cut of the farm's canes grown (columnHarvestTarget: the second block up, the bottom one kept) */
export function grownCanes (lookup: CaneLookup, farm: CaneFarm): Vec3[] {
  return farm.spots.map(s => columnHarvestTarget(lookup, s.offset(0, 1, 0))).filter((p): p is Vec3 => p != null)
}

/** the farm's spots with no cane on them, still by water (caneSpot) */
export function emptyCaneSpots (lookup: CaneLookup, farm: CaneFarm): Vec3[] {
  return farm.spots.filter(s => lookup(s.offset(0, 1, 0))?.name !== 'sugar_cane' && caneSpot(lookup, s))
}

export interface CaneFarmResult {
  /** the cells of water made */
  water: Vec3[]
  /** the canes planted */
  planted: Vec3[]
}

/**
 * Plants up to `count` canes (default 8) by water near `center` (default the bot): where the spots by water are too few,
 * a water channel dug and filled from the water bucket held (caneChannelSite: 2 spots a cell), else water holes (4 spots
 * round each), then a cane on each spot, the nearest first; none in `avoid` (the base's walls). Remembered as the cane
 * farm (rememberCaneFarm), the spots planted added to those it had. Throws MISSING_ITEMS without canes.
 */
export async function plantSugarCane (bot: Bot, args: { count?: number, center?: Vec3, memory?: WorldMemory, avoid?: (pos: Vec3) => boolean, radius?: number } = {}, signal?: AbortSignal): Promise<CaneFarmResult> {
  const count = Math.min(args.count ?? 8, countItems(bot, 'sugar_cane'))
  if (count <= 0) throw new SkillError('MISSING_ITEMS', 'no sugar cane to plant')
  const center = args.center ?? bot.entity.position
  const radius = args.radius ?? 16
  const lookup: CaneLookup = p => bot.blockAt(p) as any
  const avoid = args.avoid ?? (() => false)
  // (a channel's banks first: it was dug for them, out to the radius)
  let banks: Vec3[] = []
  const spots = (): Vec3[] => {
    const own = banks.filter(p => caneSpot(lookup, p) && lookup(p.offset(0, 1, 0))?.name !== 'sugar_cane')
    return [...own, ...caneSpots(lookup, center, radius, CANE_SITE_RANGE).filter(p => !avoid(p) && !own.some(o => o.equals(p)))]
  }
  const water: Vec3[] = []
  // water where there's too little: a channel dug and a bucket poured in it, else holes (4 spots round each)
  if (spots().length < count && countItems(bot, 'water_bucket') > 0) {
    // (a shorter one where the level ground takes no full one: a hillside's grass)
    const site = caneChannelSite(lookup, center, { avoid, radius, range: CANE_SITE_RANGE }) ?? caneChannelSite(lookup, center, { avoid, radius, range: CANE_SITE_RANGE, length: CANE_SHORT_CHANNEL })
    if (site != null) {
      try {
        water.push(...await makeCaneChannel(bot, site, signal))
        banks = site.banks
      } catch (err) {
        if (isAbort(err)) throw err
        trace('plantSugarCane: the channel failed:', (err as Error).message)
      }
    }
  }
  while (spots().length < count && countItems(bot, 'water_bucket') > 0) {
    throwIfAborted(signal)
    const hole = await makeWaterHole(bot, center, signal)
    if (hole == null) break
    water.push(hole)
  }
  const planted: Vec3[] = []
  for (const spot of spots().slice(0, count)) {
    throwIfAborted(signal)
    if (await plantCane(bot, spot, signal)) planted.push(spot)
  }
  if (planted.length > 0 && args.memory != null) {
    const old = knownCaneFarm(args.memory)?.spots ?? []
    rememberCaneFarm(args.memory, [...old, ...planted.filter(p => !old.some(o => o.equals(p)))])
  }
  trace('plantSugarCane:', planted.length, 'canes,', water.length, 'water cells')
  return { water, planted: planted.map(p => p.offset(0, 1, 0)) }
}

/** a cane put on the ground at `spot`; resolves whether one stands there */
async function plantCane (bot: Bot, spot: Vec3, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await placeBlock(bot, { pos: spot.offset(0, 1, 0), item: 'sugar_cane', against: spot }, signal)
    return res.placed || bot.blockAt(spot.offset(0, 1, 0))?.name === 'sugar_cane'
  } catch (err) {
    if (isAbort(err)) throw err
    trace('plantSugarCane: a cane on', spot.toString(), 'failed:', (err as Error).message)
    return false
  }
}

export interface CaneHarvest {
  /** canes got */
  canes: number
  /** spots planted again */
  replanted: number
}

/**
 * The cane farm tended: its grown canes cut above their bottom blocks (they grow again: SugarCaneBlock.randomTick up to
 * 3 high), and its empty spots planted again from the canes held beyond `keep`. Resolves the canes got and the spots
 * planted.
 */
export async function tendCaneFarm (bot: Bot, farm: CaneFarm, args: { keep?: number } = {}, signal?: AbortSignal): Promise<CaneHarvest> {
  const lookup: CaneLookup = p => bot.blockAt(p) as any
  const before = countItems(bot, 'sugar_cane')
  const cuts = grownCanes(lookup, farm)
  if (cuts.length > 0) {
    await collectBlock(bot, { names: ['sugar_cane'], positions: cuts }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('tendCaneFarm: the harvest:', (err as Error).message)
    })
  }
  const canes = countItems(bot, 'sugar_cane') - before
  let replanted = 0
  for (const spot of emptyCaneSpots(lookup, farm)) {
    throwIfAborted(signal)
    if (countItems(bot, 'sugar_cane') <= (args.keep ?? 0)) break
    if (await plantCane(bot, spot, signal)) replanted++
  }
  trace('tendCaneFarm:', canes, 'canes got,', replanted, 'spots planted again')
  return { canes, replanted }
}
