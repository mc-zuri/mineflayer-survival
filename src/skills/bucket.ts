// bucket: fill a bucket from a water or lava source, empty one into a cell, and cast obsidian by pouring water where
// it reaches a lava source.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { navigate, navigateToReach } from './navigate'
import { findPlacementNear, isInteractive, isSolid } from './placement'
import { potionOf } from './potion'
import { breathable, isWaterCell } from './escape'
import { CARDINALS, FACES, blockAtOrThrow, blockReach, canSee, countItems, eyeHeight, eyePosition, findInventoryItem, settleInventory, waitUntil, withinReach, type Block } from './util'

export type Fluid = 'water' | 'lava'

/** a fluid's source block (LiquidBlock.LEVEL 0) */
export function isSource (block: { name: string, getProperties?: () => Record<string, unknown>, metadata?: number } | null, fluid: Fluid): boolean {
  if (block == null || block.name !== fluid) return false
  const level = block.getProperties?.().level ?? block.metadata
  return Number(level) === 0
}

/**
 * The water the bot's farms stand by, which a fill from the nearest source never takes (fillBucket without a `pos`):
 * the wheat farm's water ('farm' points of interest, at their water) and the cells by the cane farm's spots (its
 * channel's or holes' water). A wheat farm's water hole is a lone source: taken, it's gone, the farmland dries and its
 * crops all but stop (FarmBlock.randomTick, CropBlock.getGrowthSpeed). A 1.21.11 bot's obsidian cast filled its bucket at
 * its farm's hole by home, and the farm's 10 plots stood at ages 0 to 5 70000 ticks after the sowing, its bare rows grass
 * again (f5-1.21.11 resumed from its base, seed 671229120248951486, t79353 to t151571)
 */
export function keptWater (bot: Bot): (pos: Vec3) => boolean {
  const memory = (bot as any).survival?.memory
  if (memory == null || typeof memory.getPois !== 'function') return () => false
  const farms: Vec3[] = memory.getPois('farm', { dimension: 'overworld' }).map((p: any) => new Vec3(p.x, p.y, p.z))
  const spots: Vec3[] = []
  for (const poi of memory.getPois('cane_farm', { dimension: 'overworld' })) {
    try { for (const [x, y, z] of JSON.parse(poi.note ?? '').spots ?? []) spots.push(new Vec3(x, y, z)) } catch {}
  }
  // (but a farm's spring, its water a 2 by 2 of sources: one taken comes back, renewableWater)
  const lookup = (p: Vec3): any => typeof bot.blockAt === 'function' ? bot.blockAt(p) : null
  return pos => (farms.some(f => f.equals(pos)) || spots.some(s => s.y === pos.y && Math.abs(s.x - pos.x) + Math.abs(s.z - pos.z) === 1)) && !renewableWater(lookup, pos)
}

/**
 * The water a fill from the nearest source goes to first (fillBucket without a `pos`): a farm's spring within
 * `maxDistance` (its water a 2 by 2 of sources, makeFarmSpring: one taken comes back, renewableWater), the nearest;
 * null with none. The home's own water, never gone: a 1.21.11 bot by its farm found no water to fill its bucket from for
 * a second farm's hole but one under the rock it couldn't see ('no spot found to see (2, 48, 17)', f5-1.21.11 resumed
 * from its base, t151321)
 */
export function springNear (bot: Bot, maxDistance = 32): Vec3 | null {
  const memory = (bot as any).survival?.memory
  if (memory == null || typeof memory.getPois !== 'function' || bot.entity == null || typeof bot.blockAt !== 'function') return null
  const lookup = (p: Vec3): any => bot.blockAt(p)
  const cells: Vec3[] = []
  for (const p of memory.getPois('farm', { dimension: 'overworld' })) {
    const w = new Vec3(p.x, p.y, p.z)
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cells.push(w.offset(dx, 0, dz))
  }
  return cells.filter(c => c.distanceTo(bot.entity.position) <= maxDistance && renewableWater(lookup, c))
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] ?? null
}

export interface FillBucketArgs {
  fluid: Fluid
  /** the source to take (default: the nearest within `maxDistance`) */
  pos?: Vec3
  maxDistance?: number
}

export interface BucketResult {
  pos: Vec3
  /** the bucket now in the inventory */
  item: string
}

/**
 * Points on a source's shape (FlowingFluid.getShape: a box 8/9 of the block high), where a look at it hits it: the
 * surface first, then its sides and its bottom (BucketItem.use's ray, ClipContext.Fluid.SOURCE_ONLY, stops at any face
 * of the shape, so a source overhead is taken from below).
 */
export function surfacePoints (pos: Vec3): Vec3[] {
  const top = 8 / 9 - 0.02
  const points = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([x, z]) => pos.offset(x, top, z))
  for (const [x, z] of [[0.02, 0.5], [0.98, 0.5], [0.5, 0.02], [0.5, 0.98]]) points.push(pos.offset(x, 0.45, z))
  for (const [x, z] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8]]) points.push(pos.offset(x, 0.02, z))
  return points
}

/**
 * Goes where the bot sees what `aim` aims at (a point a look at hits, from the given eyes) within reach: closer step
 * by step when it doesn't, then to a spot near `pos` it sees it from (the nearest spot in reach can be behind a
 * block), and returns that point.
 */
async function approachToSee (bot: Bot, pos: Vec3, aim: (eye: Vec3) => Vec3 | null, signal?: AbortSignal): Promise<Vec3> {
  const reach = blockReach(bot)
  const inView = (): Vec3 | null => {
    const eye = eyePosition(bot)
    const point = withinReach(bot, pos) ? aim(eye) : null
    return point != null && point.distanceTo(eye) <= reach ? point : null
  }
  for (const range of [4, 3]) {
    const point = inView()
    if (point != null) return point
    await navigateToReach(bot, pos, signal, { reach: range })
  }
  let point = inView()
  if (point != null) return point
  const spots = viewSpots(bot, pos, eyeHeight(bot), eye => { const p = aim(eye); return p != null && p.distanceTo(eye) <= reach - 0.25 })
  for (const spot of spots.slice(0, 4)) {
    try {
      await navigate(bot, { goal: new goals.GoalBlock(spot.x, spot.y, spot.z) }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      continue
    }
    point = inView()
    if (point != null) return point
  }
  throw new SkillError('NO_PATH', `no spot found to see ${pos.toString()} from`)
}

/**
 * cells near `pos` the bot can stand in (solid below, two cells free of blocks and lava, the head's out of the water)
 * whose eyes pass `sees`, nearest the bot first. A stand with its head in the water is none: a 26.3 bot filling its
 * bucket went to the floor of a pool 3 deep, a 1-wide hole under a tunnel's end it never got out of again, and drowned
 * there a night later (full-26.3-fresh-z, t23631)
 */
export function viewSpots (bot: Bot, pos: Vec3, height: number, sees: (eye: Vec3) => boolean, radius = 4): Vec3[] {
  const out: Array<{ cell: Vec3, d: number }> = []
  const free = (p: Vec3): boolean => { const b = bot.blockAt(p); return b != null && !isSolid(b) && b.name !== 'lava' }
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -radius - 1; dy <= radius - 1; dy++) {
        const cell = pos.offset(dx, dy, dz)
        if (!free(cell) || !free(cell.offset(0, 1, 0)) || !isSolid(bot.blockAt(cell.offset(0, -1, 0)))) continue
        if (isWaterCell(bot.blockAt(cell.offset(0, 1, 0)) as any)) continue
        if (!sees(cell.offset(0.5, height, 0.5))) continue
        out.push({ cell, d: cell.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).map(c => c.cell)
}

/** ticks a cell a bucket's fill came back empty from counts as no source (noteNoSource) */
export const NO_SOURCE_TICKS = 6000

/** the cells each bot's fills came back empty from, by `x,y,z`, till the tick they count again */
const noSources = new WeakMap<Bot, Map<string, number>>()

function bucketTick (bot: Bot): number {
  return Number((bot as any).survival?.tasks?.tick ?? (bot as any).time?.age ?? 0)
}

/**
 * A cell a bucket's fill came back empty from, NO_SOURCE_TICKS long: no source there as the server sees it (a ghost
 * of a pour the client still holds, a flow the client took for a source). A 26.3 bot's water fill went to the same
 * cell at (-20, 101, 5) eight times in a row, 'no water_bucket after using the bucket on' it each time, and its casts
 * had no water after (f6-26.3, t227697 to t227928; again at (-19, 15, 43))
 */
export function noteNoSource (bot: Bot, pos: Vec3): void {
  let map = noSources.get(bot)
  if (map == null) noSources.set(bot, map = new Map())
  map.set(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`, bucketTick(bot) + NO_SOURCE_TICKS)
}

/** whether a fill came back empty from the cell lately (noteNoSource) */
export function knownNoSource (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  const until = noSources.get(bot)?.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
  return until != null && bucketTick(bot) < until
}

/**
 * A source a bucket fills from (isSource: the fluid's own block at level 0, not a waterlogged one), not one a fill came
 * back empty from lately (knownNoSource). A findBlock's matcher: a block with no position (its section's palette
 * asked first) matches on the block alone.
 */
export function fillableSource (bot: Bot, block: { name: string, position?: Vec3, getProperties?: () => Record<string, unknown>, metadata?: number } | null, fluid: Fluid): boolean {
  if (!isSource(block, fluid)) return false
  return block?.position == null || !knownNoSource(bot, block.position)
}

export async function fillBucket (bot: Bot, args: FillBucketArgs, signal?: AbortSignal): Promise<BucketResult> {
  throwIfAborted(signal)
  const { fluid } = args
  const bucket = findInventoryItem(bot, 'bucket')
  if (bucket == null) throw new SkillError('MISSING_ITEMS', 'no empty bucket in the inventory')
  let source: Block | null
  if (args.pos != null) {
    source = blockAtOrThrow(bot, args.pos.floored())
    if (!isSource(source, fluid)) throw new SkillError('NOT_FOUND', `no ${fluid} source at ${args.pos.toString()}`)
    if (knownNoSource(bot, args.pos)) throw new SkillError('NOT_FOUND', `no ${fluid} source at ${args.pos.toString()}: a fill came back empty from it lately`)
  } else {
    // (a farm's spring first, springNear; else the nearest one no fill came back empty from lately: the next after one
    // that did; never a farm's own lone water: taken it's gone, and its farm dries, keptWater)
    const spring = fluid === 'water' ? springNear(bot, args.maxDistance ?? 32) : null
    const kept = fluid === 'water' ? keptWater(bot) : () => false
    source = spring != null && !knownNoSource(bot, spring) ? bot.blockAt(spring) as Block : null
    source ??= bot.findBlock({ matching: (block: any) => fillableSource(bot, block, fluid) && (block?.position == null || !kept(block.position)), maxDistance: args.maxDistance ?? 32 })
    if (source == null) throw new SkillError('NOT_FOUND', `no ${fluid} source nearby`)
  }
  const pos = source.position
  // BucketItem.use: the server picks the source the player looks at (a raycast that stops at source fluids)
  const point = await approachToSee(bot, pos, eye => surfacePoints(pos).find(point => canSee(bot, point, undefined, eye)) ?? null, signal)

  const filled = `${fluid}_bucket`
  const before = countItems(bot, filled)
  await settleInventory(bot, signal)
  await bot.equip(bucket, 'hand')
  await bot.lookAt(point, true)
  bot.activateItem()
  const ok = await waitUntil(bot, () => countItems(bot, filled) > before, 10, signal)
  if (!ok) {
    noteNoSource(bot, pos)
    throw new SkillError('VERIFY_FAILED', `no ${filled} after using the bucket on ${pos.toString()}`)
  }
  return { pos, item: filled }
}

/** the water sources fillBottles finds no way to see before it pours the water bucket carried */
export const FILL_SOURCE_TRIES = 2

export interface FillBottlesArgs {
  /** bottles to fill (default: every glass bottle carried) */
  count?: number
  /** how far a water source may be (default 32) */
  maxDistance?: number
}

/**
 * Glass bottles filled with water, one a use, at the nearest water source (BottleItem.use: the ray from the eyes to a
 * source, ClipContext.Fluid.SOURCE_ONLY, gives a potion of water); resolves the bottles filled. In the nether there's
 * no water to fill them at (a bucket's evaporates: BucketItem, dimension ultraWarm)
 */
export async function fillBottles (bot: Bot, args: FillBottlesArgs = {}, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal)
  const want = args.count ?? countItems(bot, 'glass_bottle')
  const water = (): number => bot.inventory.items().filter(i => i.name === 'potion' && potionOf(i) === 0).length
  let filled = 0
  // no water near (or none the bot can get to see): the water bucket's poured by the bot for the while, and taken back
  // up after
  let poured: Vec3 | null = null
  // the sources there was no way to see (a pond under an overhang, a spring in a cliff: 'no spot found to see' it), not
  // gone for again: two 1.21.11 bots with a water bucket in the bag failed the nether's bowless gate for good so
  // (f3k-run5's (-272, 59, 12), f4-run2's (89, 51, -21))
  const unseen = new Set<string>()
  try {
    while (filled < want) {
      const bottle = findInventoryItem(bot, 'glass_bottle')
      if (bottle == null) break
      const source: Block | null = unseen.size >= FILL_SOURCE_TRIES && poured == null
        ? null
        : bot.findBlock({ matching: (block: any) => isSource(block, 'water'), useExtraInfo: (block: any) => !unseen.has(block.position.toString()), maxDistance: args.maxDistance ?? 32 } as any)
      if (source == null) {
        const cell: Vec3 | null = poured == null && findInventoryItem(bot, 'water_bucket') != null ? findPlacementNear(p => bot.blockAt(p), bot.entity.position) : null
        if (cell == null) throw new SkillError('NOT_FOUND', 'no water source nearby to fill the bottles at')
        await emptyBucket(bot, { pos: cell, fluid: 'water' }, signal)
        poured = cell
        continue
      }
      const pos: Vec3 = source.position
      let point: Vec3
      try {
        point = await approachToSee(bot, pos, eye => surfacePoints(pos).find(p => canSee(bot, p, undefined, eye)) ?? null, signal)
      } catch (err) {
        if (isAbort(err) || (poured != null && pos.equals(poured))) throw err
        unseen.add(pos.toString())
        continue
      }
      const before = water()
      await settleInventory(bot, signal)
      await bot.equip(bottle, 'hand')
      await bot.lookAt(point, true)
      bot.activateItem()
      if (!await waitUntil(bot, () => water() > before, 10, signal)) throw new SkillError('VERIFY_FAILED', `no water bottle after using a glass bottle on ${pos.toString()}`)
      filled++
    }
  } finally {
    if (poured != null && findInventoryItem(bot, 'bucket') != null) {
      await fillBucket(bot, { fluid: 'water', pos: poured }, signal).catch(err => { if (isAbort(err)) throw err })
    }
  }
  return filled
}

export interface EmptyBucketArgs {
  /** the cell to pour into */
  pos: Vec3
  fluid?: Fluid
}

/** prismarine's block faces by their index in a raycast's hit (0 down, 1 up, 2 north, 3 south, 4 west, 5 east) */
const HIT_FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]

/**
 * Whether the use ray from `eye` toward `point` lands where a full bucket's pour into `pos` needs it: the server's ray
 * ignores fluids and the liquid goes into the cell in front of the face it hits first (BucketItem.use), so the ray's
 * own first hit (the world's raycast, fluids passed through) has to be `block`'s face toward `pos`; and it crosses no
 * liquid on its way before `pos` (a pour whose ray went over lava would set a wall of obsidian along it as the water
 * spreads back). After mine-ai-mcp's pourAim (src/world/liquid.ts, MIT): picking the cell and then a face on it as two
 * guesses, a ray could hit the block's other face first and pour the water elsewhere.
 */
export function pourRayLands (bot: Bot, eye: Vec3, point: Vec3, block: Vec3, pos: Vec3): boolean {
  const delta = point.minus(eye)
  const dist = delta.norm()
  if (dist < 1e-6) return false
  const dir = delta.scaled(1 / dist)
  const hit: any = bot.world.raycast(eye, dir, dist + 0.5)
  if (hit == null || hit.position == null || !(hit.position as Vec3).equals(block)) return false
  const face = HIT_FACES[Number(hit.face ?? -1)]
  if (face == null || !block.plus(face).equals(pos)) return false
  for (let t = 0; t < dist; t += 0.05) {
    const cell = eye.plus(dir.scaled(t)).floored()
    if (cell.equals(pos)) break
    const name = bot.blockAt(cell)?.name
    if (name === 'water' || name === 'lava' || name === 'bubble_column') return false
  }
  return true
}

/**
 * A face to click to pour into `pos`: a solid neighbour's face toward it that the bot's eyes see, the use ray's first
 * hit that face (pourRayLands). BucketItem.use raycasts without fluids and pours on the clicked face's side (into the
 * block itself when it holds water, as a slab can, so those aren't used).
 */
export function pourPoint (bot: Bot, pos: Vec3, eye: Vec3 = eyePosition(bot)): Vec3 | null {
  for (const face of FACES) {
    const block = bot.blockAt(pos.minus(face))
    if (block == null || !isSolid(block) || isInteractive(block.name) || 'waterlogged' in (block.getProperties?.() ?? {})) continue
    // the face's middle, and points toward its corners
    const centre = block.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    const spread = [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]
    for (const [a, b] of spread) {
      const point = face.x !== 0 ? centre.offset(0, a, b) : face.y !== 0 ? centre.offset(a, 0, b) : centre.offset(a, b, 0)
      // the eyes on the face's outer side, the ray's first hit that face
      if (eye.minus(point).dot(face) <= 0) continue
      if (pourRayLands(bot, eye, point, block.position, pos)) return point
    }
  }
  return null
}

export async function emptyBucket (bot: Bot, args: EmptyBucketArgs, signal?: AbortSignal): Promise<BucketResult> {
  throwIfAborted(signal)
  const pos = args.pos.floored()
  const item = args.fluid != null ? findInventoryItem(bot, `${args.fluid}_bucket`) : findInventoryItem(bot, ['water_bucket', 'lava_bucket'])
  if (item == null) throw new SkillError('MISSING_ITEMS', `no ${args.fluid ?? 'water or lava'} bucket in the inventory`)
  const fluid = item.name === 'lava_bucket' ? 'lava' : 'water'
  const target = blockAtOrThrow(bot, pos)
  if (isSource(target, fluid)) return { pos, item: 'bucket' }
  if (isSolid(target)) throw new SkillError('CANNOT_PLACE', `${target.name} is at ${pos.toString()}`)

  const point = await approachToSee(bot, pos, eye => pourPoint(bot, pos, eye), signal)
    .catch(err => { throw new SkillError('CANNOT_PLACE', `no face in view to pour against at ${pos.toString()}`, undefined, { cause: err }) })

  await settleInventory(bot, signal)
  await bot.equip(item, 'hand')
  await bot.lookAt(point, true)
  bot.activateItem()
  const ok = await waitUntil(bot, () => isSource(bot.blockAt(pos), fluid), 10, signal)
  if (!ok) throw new SkillError('VERIFY_FAILED', `${bot.blockAt(pos)?.name ?? 'nothing'} at ${pos.toString()} after pouring ${fluid}`)
  return { pos, item: 'bucket' }
}

export interface CastObsidianArgs {
  /** the lava source to turn into obsidian */
  lava: Vec3
  /** take the water back up afterwards (default true) */
  recoverWater?: boolean
}

export interface CastObsidianResult {
  obsidian: Vec3
  /** where the water was poured */
  water: Vec3
  waterRecovered: boolean
}

/**
 * Cells to pour water into so it reaches the lava (LiquidBlock.shouldSpreadLiquid: a lava source with water beside or
 * above it turns to obsidian): beside it, above it, then above a block beside it (the water runs over the lava).
 */
export function castCandidates (lava: Vec3): Vec3[] {
  return [...CARDINALS.map(dir => lava.plus(dir)), lava.offset(0, 1, 0), ...CARDINALS.map(dir => lava.plus(dir).offset(0, 1, 0))]
}

export async function castObsidian (bot: Bot, args: CastObsidianArgs, signal?: AbortSignal): Promise<CastObsidianResult> {
  throwIfAborted(signal)
  const lava = args.lava.floored()
  if (!isSource(bot.blockAt(lava), 'lava')) throw new SkillError('NOT_FOUND', `no lava source at ${lava.toString()}`)
  if (findInventoryItem(bot, 'water_bucket') == null) throw new SkillError('MISSING_ITEMS', 'no water bucket in the inventory')

  let poured: Vec3 | null = null
  let lastError: unknown = null
  for (const cell of castCandidates(lava)) {
    const block = bot.blockAt(cell)
    if (block == null || isSolid(block) || block.name === 'lava') continue
    // over a block beside the lava, the water needs that block to stand on
    if (cell.y > lava.y && !cell.offset(0, -1, 0).equals(lava) && !isSolid(bot.blockAt(cell.offset(0, -1, 0)))) continue
    try {
      await emptyBucket(bot, { pos: cell, fluid: 'water' }, signal)
      poured = cell
      break
    } catch (err) {
      if (isAbort(err)) throw err
      lastError = err
    }
  }
  if (poured == null) throw new SkillError('CANNOT_PLACE', `no cell to pour water into next to the lava at ${lava.toString()}`, undefined, { cause: lastError })

  // water spreads every 5 ticks (WaterFluid.getTickDelay); a cell over a block beside the lava takes a step
  const cast = await waitUntil(bot, () => bot.blockAt(lava)?.name === 'obsidian', 60, signal)
  let waterRecovered = false
  if (args.recoverWater !== false) {
    try {
      await fillBucket(bot, { fluid: 'water', pos: poured }, signal)
      waterRecovered = true
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  const result = { obsidian: lava, water: poured, waterRecovered }
  if (!cast) throw new SkillError('VERIFY_FAILED', `${bot.blockAt(lava)?.name ?? 'nothing'} at ${lava.toString()} after pouring water at ${poured.toString()}`, result)
  return result
}

/**
 * Whether a water source is one a bucket can take and the water stays: two or more water sources beside it, across
 * (FlowingFluid.getNewLiquid: an empty cell with two sources beside it and one under or a block under turns to a
 * source), so the pool fills it again. A lone source, a farm's water hole, is gone once taken.
 */
export function renewableWater (lookup: (pos: Vec3) => { name: string, getProperties?: () => Record<string, unknown>, metadata?: number } | null, pos: Vec3): boolean {
  if (!isSource(lookup(pos), 'water')) return false
  let n = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isSource(lookup(pos.offset(dx, 0, dz)), 'water')) n++
  return n >= 2
}

/**
 * The source of these (nearest first) keepWaterBucket fills at: a renewable one at the water's top, open to the air
 * over it (one under the water is gone to through it: a 26.3 bot went down a pool 3 deep for one and never got out of
 * the hole, full-26.3-fresh-z, t23631)
 */
export function keepWaterSource (lookup: (pos: Vec3) => any, sources: Vec3[]): Vec3 | null {
  return sources.find(p => renewableWater(lookup, p) && breathable(lookup(p.offset(0, 1, 0)))) ?? null
}

/** how far a renewable water source is looked for to keep the water bucket filled */
export const KEEP_WATER_RANGE = 32

/**
 * The water bucket kept filled (the fall reflex's, a lava escape's): with an empty bucket and no water bucket, the
 * empty one filled at a renewable water source within KEEP_WATER_RANGE (renewableWater: never a farm's water hole).
 * Resolves whether it filled one. A 26.3 bot fell 35 blocks at 14 health with no reflex: its one bucket was empty
 * (full-26.3-fresh-r, t276348)
 */
export async function keepWaterBucket (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const water = bot.registry.blocksByName.water?.id
  if (countItems(bot, 'water_bucket') > 0 || findInventoryItem(bot, 'bucket') == null || typeof bot.findBlocks !== 'function' || water == null) return false
  const lookup = (p: Vec3): any => bot.blockAt(p)
  const source = keepWaterSource(lookup, bot.findBlocks({ matching: water, maxDistance: KEEP_WATER_RANGE, count: 256 }))
  if (source == null) return false
  try {
    await fillBucket(bot, { fluid: 'water', pos: source }, signal)
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    return false
  }
}

/** whether keepWaterBucket has something to do: an empty bucket and no water bucket in the bag */
export function waterBucketEmpty (bot: Bot): boolean {
  return countItems(bot, 'water_bucket') === 0 && findInventoryItem(bot, 'bucket') != null
}
