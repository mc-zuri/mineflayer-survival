// End Cities out on the End's outer islands: where the seed puts them (RandomSpreadStructurePlacement's one chunk a
// region of 20 x 20 chunks, END_CITIES), and how they're told in the loaded world (their purpur, the ship's elytra in
// its item frame). EndCityStructure.findGenerationPoint places one at the chunk's block 7, 7 when the lowest of the 5 x
// 5 corners round it is 60 high or more (getLowestYIn5by5Box) and its biome takes it (#has_structure/end_city: the
// highlands, the midlands): the terrain decides, so a candidate is a maybe. The outer islands start some 1000 blocks
// out (DensityFunctions.EndIslandDensityFunction: none where x^2 + z^2 <= 4096 in its 8-block cells but the main one).
import { Vec3 } from 'vec3'
import { END_CITIES, getPotentialStructureChunk, type RandomSpreadPlacement, type Seed } from '../worldgen'
import type { Pos } from '../core/memory'

export const END_CITY_POI = 'end_city'
export const END_SHIP_POI = 'end_ship'
/** EndCityStructure.findGenerationPoint: the start's chunk block */
export const END_CITY_START_OFFSET = 7
/** findGenerationPoint: no city under this height */
export const END_CITY_MIN_HEIGHT = 60
/** no outer island this near 0, 0 (EndIslandDensityFunction's 64 cells of 8 blocks... and its falloff) */
export const OUTER_ISLANDS_RADIUS = 1000
/** the blocks a city is built of (EndCityPieces' templates: purpur, its pillars, stairs and slabs) */
export const PURPUR_BLOCKS = ['purpur_block', 'purpur_pillar', 'purpur_stairs', 'purpur_slab']

export interface EndCityCandidate {
  chunkX: number
  chunkZ: number
  /** the start's block (the chunk's 7, 7) */
  x: number
  z: number
  distance: number
}

/** the region's candidate chunks round `from` (`radius` regions each way), out on the outer islands, nearest first */
export function endCityCandidates (levelSeed: Seed, from: { x: number, z: number }, opts: { radius?: number, placement?: RandomSpreadPlacement } = {}): EndCityCandidate[] {
  const placement = opts.placement ?? END_CITIES.placement
  const radius = opts.radius ?? 2
  const rx0 = Math.floor(Math.floor(Math.floor(from.x) / 16) / placement.spacing)
  const rz0 = Math.floor(Math.floor(Math.floor(from.z) / 16) / placement.spacing)
  const out: EndCityCandidate[] = []
  for (let rx = rx0 - radius; rx <= rx0 + radius; rx++) {
    for (let rz = rz0 - radius; rz <= rz0 + radius; rz++) {
      const c = getPotentialStructureChunk(placement, levelSeed, rx * placement.spacing, rz * placement.spacing)
      const x = c.x * 16 + END_CITY_START_OFFSET
      const z = c.z * 16 + END_CITY_START_OFFSET
      if (Math.hypot(x, z) < OUTER_ISLANDS_RADIUS) continue
      out.push({ chunkX: c.x, chunkZ: c.z, x, z, distance: Math.hypot(x - from.x, z - from.z) })
    }
  }
  return out.sort((a, b) => a.distance - b.distance)
}

export interface PurpurCluster {
  /** the middle of its blocks on x and z, its lowest block's y */
  center: Vec3
  count: number
  minY: number
  maxY: number
}

/**
 * The purpur blocks seen, gathered into the cities they're of: a block within `gap` (on x and z) of a cluster's goes
 * in it. A city's towers and bridges are purpur all through; a lone block (a chorus? none is purpur) isn't one, so
 * clusters under `minCount` are left out. Biggest first.
 */
export function purpurClusters (points: Pos[], opts: { gap?: number, minCount?: number } = {}): PurpurCluster[] {
  const gap = opts.gap ?? 24
  const groups: Pos[][] = []
  for (const p of points) {
    const near = groups.filter(g => g.some(q => Math.abs(q.x - p.x) <= gap && Math.abs(q.z - p.z) <= gap))
    if (near.length === 0) { groups.push([p]); continue }
    const merged = near.flat()
    merged.push(p)
    for (const g of near) groups.splice(groups.indexOf(g), 1)
    groups.push(merged)
  }
  return groups
    .filter(g => g.length >= (opts.minCount ?? 8))
    .map(g => {
      const ys = g.map(p => p.y)
      const minY = Math.min(...ys)
      return {
        center: new Vec3(Math.round(g.reduce((s, p) => s + p.x, 0) / g.length), minY, Math.round(g.reduce((s, p) => s + p.z, 0) / g.length)),
        count: g.length,
        minY,
        maxY: Math.max(...ys)
      }
    })
    .sort((a, b) => b.count - a.count)
}

/** the item an item frame's metadata holds (ItemFrame.DATA_ITEM), by name, or null for an empty frame */
export function frameItemName (value: unknown, itemName: (id: number) => string | undefined): string | null {
  if (value == null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.name === 'string') return v.name
  const id = typeof v.itemId === 'number' ? v.itemId : typeof v.type === 'number' ? v.type : typeof v.id === 'number' ? v.id : null
  if (id == null || id < 0) return null
  if ((typeof v.itemCount === 'number' && v.itemCount <= 0) || (typeof v.count === 'number' && v.count <= 0)) return null
  return itemName(id) ?? null
}
