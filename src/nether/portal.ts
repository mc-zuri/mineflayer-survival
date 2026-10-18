import type { Pos } from '../core/memory'

/**
 * Nether portal frames, and casting one from lava without a diamond pickaxe.
 *
 * PortalShape (the same in 26.3, whose #nether_portal_frame holds only obsidian) wants an obsidian rectangle round an
 * inside 2-21 wide and 3-21 tall that holds
 * only air, fire or portal blocks; the corners can be anything. A bucket of lava poured into a
 * frame cell turns to obsidian the moment water touches it from above or the side
 * (LiquidBlock.shouldSpreadLiquid, called from neighborChanged: a lava source next to water,
 * not below it, becomes obsidian; flowing lava becomes cobblestone), well inside the 30 ticks
 * lava waits before it spreads in the overworld (LavaFluid.getTickDelay; 10 in the nether).
 */

export type Axis = 'x' | 'z'

export interface BlockInfo {
  name: string
  properties?: Record<string, string | number | boolean>
}

/** the world as the plan sees it: null where unknown (unloaded) */
export type BlockGetter = (pos: Pos) => BlockInfo | null

export interface PortalFrame {
  /** the bottom corner cell (u 0, v 0) */
  origin: Pos
  /** the axis the frame runs along */
  axis: Axis
  width: number
  height: number
  /** the frame's own obsidian cells, bottom row, then the sides upwards, then the top */
  obsidian: Pos[]
  corners: Pos[]
  /** the inside (width - 2) × (height - 2) */
  interior: Pos[]
  /** flint and steel: use it on the top face of `against` (a bottom obsidian), fire appears at `fire` */
  light: { against: Pos, face: Pos, fire: Pos }
}

/** PortalShape limits */
export const PORTAL_MIN_WIDTH = 2
export const PORTAL_MAX_WIDTH = 21
export const PORTAL_MIN_HEIGHT = 3
export const PORTAL_MAX_HEIGHT = 21
/** LavaFluid.getTickDelay outside ultrawarm dimensions: the lava spreads after this, so the water has to be there first */
export const LAVA_TICK_DELAY = 30
/** WaterFluid.getTickDelay: flowing water moves one block per this many ticks */
export const WATER_TICK_DELAY = 5

/** the cell at frame coordinates (u along the axis, v up) */
export function frameCell (origin: Pos, axis: Axis, u: number, v: number, depth = 0): Pos {
  return axis === 'x'
    ? { x: origin.x + u, y: origin.y + v, z: origin.z + depth }
    : { x: origin.x + depth, y: origin.y + v, z: origin.z + u }
}

/** the step out of the frame's plane, to the side `depth` 1 is on */
export function frameNormal (axis: Axis): Pos {
  return axis === 'x' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }
}

/**
 * The frame blueprint: by default the minimal 4 × 5 frame, 10 obsidian without the corners
 * (inside 2 × 3).
 */
export function portalFrame (origin: Pos, axis: Axis = 'x', width = 4, height = 5): PortalFrame {
  if (width - 2 < PORTAL_MIN_WIDTH || width - 2 > PORTAL_MAX_WIDTH || height - 2 < PORTAL_MIN_HEIGHT || height - 2 > PORTAL_MAX_HEIGHT) {
    throw new RangeError(`a portal frame is 4-23 wide and 5-23 tall, not ${width} × ${height}`)
  }
  const at = (u: number, v: number): Pos => frameCell(origin, axis, u, v)
  const obsidian: Pos[] = []
  for (let u = 1; u < width - 1; u++) obsidian.push(at(u, 0))
  for (let v = 1; v < height - 1; v++) { obsidian.push(at(0, v)); obsidian.push(at(width - 1, v)) }
  for (let u = 1; u < width - 1; u++) obsidian.push(at(u, height - 1))
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  const interior: Pos[] = []
  for (let v = 1; v < height - 1; v++) for (let u = 1; u < width - 1; u++) interior.push(at(u, v))
  return { origin, axis, width, height, obsidian, corners, interior, light: { against: at(1, 0), face: { x: 0, y: 1, z: 0 }, fire: at(1, 1) } }
}

const EMPTY = new Set(['air', 'cave_air', 'void_air'])
/** PortalShape.isEmpty: the inside may hold these */
const PORTAL_EMPTY = new Set([...EMPTY, 'fire', 'soul_fire', 'nether_portal'])
const NOT_SOLID = new Set([
  ...EMPTY, 'water', 'lava', 'fire', 'soul_fire', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'torch', 'wall_torch', 'redstone_torch', 'vine', 'sugar_cane', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'sweet_berry_bush',
  'brown_mushroom', 'red_mushroom', 'nether_portal', 'cobweb', 'bubble_column', 'light'
])
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])

export function isAir (b: BlockInfo | null): boolean {
  return b != null && EMPTY.has(b.name)
}

/** a full block to stand on or place against (leaves and saplings count as not solid; falling blocks as solid) */
export function isSolid (b: BlockInfo | null): boolean {
  return b != null && !NOT_SOLID.has(b.name) && !b.name.endsWith('_sapling') && !b.name.endsWith('_leaves') && !b.name.endsWith('_carpet')
}

export function isFluid (b: BlockInfo | null): boolean {
  return b != null && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column')
}

/** a lava source block (the `level` property 0) */
export function isLavaSource (b: BlockInfo | null): boolean {
  return b != null && b.name === 'lava' && Number(b.properties?.level ?? 0) === 0
}

export interface FrameCheck {
  /** PortalShape would accept it: obsidian all round, the inside empty */
  valid: boolean
  /** frame cells that aren't obsidian yet */
  missing: Pos[]
  /** inside cells that hold something */
  blocked: Pos[]
}

/** checks a built frame the way PortalShape does (corners ignored) */
export function checkPortalFrame (getBlock: BlockGetter, frame: PortalFrame): FrameCheck {
  const missing = frame.obsidian.filter(p => getBlock(p)?.name !== 'obsidian')
  const blocked = frame.interior.filter(p => { const b = getBlock(p); return b == null || !PORTAL_EMPTY.has(b.name) })
  return { valid: missing.length === 0 && blocked.length === 0, missing, blocked }
}

/** lava source blocks in a cube around `center` */
export function findLavaSources (getBlock: BlockGetter, center: Pos, radius = 16): Pos[] {
  const out: Pos[] = []
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
        if (isLavaSource(getBlock(p))) out.push(p)
      }
    }
  }
  return out
}

export type CastStep =
  /** place a block of `item` at `pos`, against `against`'s `face` */
  | { kind: 'place_block', item: string, pos: Pos, against: Pos, face: Pos, why: string }
  /** fill an empty bucket from the lava source at `pos` */
  | { kind: 'fill_lava', pos: Pos }
  /** pour lava into `pos` by using the bucket on `against`'s `face` */
  | { kind: 'place_lava', pos: Pos, against: Pos, face: Pos }
  /** pour the water bucket into `pos`, within `within` ticks of the lava it turns to obsidian */
  | { kind: 'place_water', pos: Pos, against: Pos, face: Pos, within: number, makes: Pos }
  /** scoop the water source back up before it flows far */
  | { kind: 'pickup_water', pos: Pos, within: number }
  | { kind: 'wait', ticks: number, why: string }
  /** flint and steel on `against`'s top face */
  | { kind: 'light', against: Pos, face: Pos, fire: Pos }

export interface LavaCastPlan {
  frame: PortalFrame
  /** the lava sources the plan takes, in the order it takes them */
  sources: Pos[]
  /** blocks the plan places as a mould behind the frame */
  scaffold: Pos[]
  scaffoldItem: string
  /** where the bot stands while pouring: in front of the frame */
  stand: Pos[]
  steps: CastStep[]
  /** empty buckets needed besides the water bucket */
  lavaBuckets: number
}

export interface LavaCastOptions {
  /** a site to use; otherwise one is chosen near the lava */
  origin?: Pos
  axis?: Axis
  /** how far from the lava to look for a site (default 12) */
  siteRadius?: number
  /** lava buckets carried per trip (default 1) */
  lavaBuckets?: number
  /** the mould's block (default cobblestone) */
  scaffoldItem?: string
  /** keep the frame this far from any lava, horizontally (default 4) */
  lavaClearance?: number
}

const UP: Pos = { x: 0, y: 1, z: 0 }

function add (a: Pos, b: Pos): Pos {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function sub (a: Pos, b: Pos): Pos {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function key (p: Pos): string {
  return `${p.x},${p.y},${p.z}`
}

interface SiteScore { origin: Pos, axis: Axis, normal: number, cost: number, scaffold: number }

/**
 * Checks a site for the cast: ground under the frame, the mould row behind it and the two
 * rows in front (where the bot stands); air, not fluid, in the frame, the inside and in front;
 * no fluid in the mould plane. Returns the mould blocks it would need, or null.
 */
function siteFits (getBlock: BlockGetter, origin: Pos, axis: Axis, back: number, lava: Pos[], clearance: number): number | null {
  // d -1 is the mould's plane (depth `back`), d 1 and 2 the rows in front
  const cell = (u: number, v: number, d: number): BlockInfo | null => getBlock(frameCell(origin, axis, u, v, -d * back))
  let scaffold = 0
  for (let u = 0; u < 4; u++) {
    for (let d = -1; d <= 2; d++) if (!isSolid(cell(u, -1, d))) return null
    for (let v = 0; v <= 5; v++) {
      for (let d = 0; d <= 2; d++) if (!isAir(cell(u, v, d))) return null
      const b = cell(u, v, -1)
      if (b == null || isFluid(b) || FALLING.has(b.name)) return null
      if (!isSolid(b)) { if (!isAir(b)) return null; scaffold++ }
    }
  }
  for (const l of lava) {
    for (let u = 0; u < 4; u++) {
      const p = frameCell(origin, axis, u, 0, 0)
      if (Math.abs(l.x - p.x) < clearance && Math.abs(l.z - p.z) < clearance && Math.abs(l.y - p.y) < 6) return null
    }
  }
  return scaffold
}

/**
 * Picks where to cast the frame: within `siteRadius` of the pool, on flat ground, with the
 * fewest mould blocks to place and the shortest walk to the lava. `back` is the mould's side
 * (-1 or 1 along the frame's normal); the bot stands on the other.
 */
export function chooseFrameSite (getBlock: BlockGetter, lava: Pos[], opts: LavaCastOptions = {}): { origin: Pos, axis: Axis, back: number } | null {
  if (lava.length === 0) return null
  const radius = opts.siteRadius ?? 12
  const clearance = opts.lavaClearance ?? 4
  const c = { x: 0, y: 0, z: 0 }
  for (const l of lava) { c.x += l.x / lava.length; c.y += l.y / lava.length; c.z += l.z / lava.length }
  const center = { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) }
  let best: SiteScore | null = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      // the ground: the highest solid block with air on top within 6 of the pool's height
      for (let dy = 6; dy >= -6; dy--) {
        const ground = { x: center.x + dx, y: center.y + dy, z: center.z + dz }
        if (!isSolid(getBlock(ground)) || !isAir(getBlock(add(ground, UP)))) continue
        const origin = add(ground, UP)
        for (const axis of (opts.axis != null ? [opts.axis] : ['x', 'z'] as Axis[])) {
          for (const back of [-1, 1]) {
            const scaffold = siteFits(getBlock, origin, axis, back, lava, clearance)
            if (scaffold == null) continue
            const walk = Math.min(...lava.map(l => Math.hypot(l.x - origin.x, l.y - origin.y, l.z - origin.z)))
            const cost = walk * 10 + scaffold * 3
            if (best == null || cost < best.cost) best = { origin, axis, normal: back, cost, scaffold }
          }
        }
        break
      }
    }
  }
  return best == null ? null : { origin: best.origin, axis: best.axis, back: best.normal }
}

/**
 * Plans the cast: the mould (a wall right behind the frame, 4 wide and 6 high, built
 * bottom-up wherever the world isn't solid already), then for each frame cell bottom row
 * first, the sides upwards, the top last: fetch lava, pour it into the cell against the
 * mould, pour water into the cell above it (also against the mould) so the lava turns to
 * obsidian at once, scoop the water back up. Then wait for the last water to drain and
 * light the frame. Null when there is no lava or no site.
 */
export function planLavaCast (getBlock: BlockGetter, lava: Pos[], opts: LavaCastOptions = {}): LavaCastPlan | null {
  const sources = lava.filter(p => isLavaSource(getBlock(p)))
  let site: { origin: Pos, axis: Axis, back: number } | null
  if (opts.origin != null) {
    const axis = opts.axis ?? 'x'
    const back = [-1, 1].find(b => siteFits(getBlock, opts.origin as Pos, axis, b, sources, 0) != null)
    site = back != null ? { origin: opts.origin, axis, back } : null
  } else {
    site = chooseFrameSite(getBlock, sources, opts)
  }
  if (site == null) return null
  const { origin, axis, back } = site
  const frame = portalFrame(origin, axis)
  if (sources.length < frame.obsidian.length) return null
  const scaffoldItem = opts.scaffoldItem ?? 'cobblestone'
  const perTrip = Math.max(1, opts.lavaBuckets ?? 1)
  const n = frameNormal(axis)
  const toBack = { x: n.x * back, y: 0, z: n.z * back }
  const toFront = { x: -toBack.x, y: 0, z: -toBack.z }
  const steps: CastStep[] = []
  const scaffold: Pos[] = []
  const solid = new Set<string>()
  // the mould: bottom-up, each block against the one under it (the ground for the first row)
  for (let v = 0; v <= 5; v++) {
    for (let u = 0; u < 4; u++) {
      const m = add(frameCell(origin, axis, u, v), toBack)
      if (isSolid(getBlock(m))) { solid.add(key(m)); continue }
      const below = sub(m, UP)
      steps.push({ kind: 'place_block', item: scaffoldItem, pos: m, against: below, face: UP, why: 'mould behind the frame' })
      scaffold.push(m)
      solid.add(key(m))
    }
  }
  // nearest lava first from the site
  const ordered = [...sources].sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) - Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z))
  const used = ordered.slice(0, frame.obsidian.length)
  for (let i = 0; i < frame.obsidian.length; i += perTrip) {
    const batch = frame.obsidian.slice(i, i + perTrip)
    batch.forEach((_, j) => steps.push({ kind: 'fill_lava', pos: used[i + j] }))
    for (const cell of batch) {
      const water = add(cell, UP)
      steps.push({ kind: 'place_lava', pos: cell, against: add(cell, toBack), face: toFront })
      steps.push({ kind: 'place_water', pos: water, against: add(water, toBack), face: toFront, within: LAVA_TICK_DELAY, makes: cell })
      steps.push({ kind: 'pickup_water', pos: water, within: WATER_TICK_DELAY })
    }
  }
  // flowing water left in the frame drains a level every 5 ticks
  steps.push({ kind: 'wait', ticks: 8 * WATER_TICK_DELAY, why: 'let the water drain from the inside' })
  steps.push({ kind: 'light', against: frame.light.against, face: frame.light.face, fire: frame.light.fire })
  const stand = [1, 2].map(u => add(frameCell(origin, axis, u, 0), { x: toFront.x * 2, y: 0, z: toFront.z * 2 }))
  return { frame, sources: used, scaffold, scaffoldItem, stand, steps, lavaBuckets: perTrip }
}
