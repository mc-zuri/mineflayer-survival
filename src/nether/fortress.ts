import type { Pos } from '../core/memory'
import { NETHER_COMPLEXES, getPotentialStructureChunk, selectStructure, type RandomSpreadPlacement } from '../worldgen/placement'
import type { Seed } from '../worldgen/random'

/** blocks only a nether fortress is built of (StructurePieceType NETHER_FORTRESS pieces: NetherFortressPieces) */
export const FORTRESS_BLOCKS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs']
/** NetherFortressStructure: the start piece is at chunk block (2, 64, 2), then the whole fortress is moved into y 48-70 */
export const FORTRESS_START_OFFSET = 2
export const FORTRESS_MIN_Y = 48
export const FORTRESS_MAX_Y = 70
/** a nether complex region is 27 × 27 chunks (432 blocks) */
export const COMPLEX_REGION_BLOCKS = NETHER_COMPLEXES.placement.spacing * 16

export interface ComplexCandidate {
  /** the region's candidate chunk */
  chunkX: number
  chunkZ: number
  regionX: number
  regionZ: number
  /** the fortress start piece's corner (NetherFortressPieces.StartPiece at the chunk's block 2, 2) */
  x: number
  z: number
  /**
   * which complex the chunk rolls. A bastion can't generate in basalt_deltas
   * (#has_structure/bastion_remnant), and then vanilla rolls again with only the fortress
   * left, so a 'bastion_remnant' here is a fortress when the chunk is basalt_deltas
   */
  structure: 'fortress' | 'bastion_remnant'
  /** the first roll: nextInt(5) < 2 is a fortress */
  roll: number
  /** blocks from the asking point to (x, z) */
  distance: number
}

export interface ComplexSearchOptions {
  /** regions out from the one `from` is in (default 3: a 7 × 7 grid of regions, about 3000 blocks across) */
  radius?: number
  /** the chunk's biome is basalt_deltas (bastions can't generate there), when known */
  isBasaltDeltas?: (chunkX: number, chunkZ: number) => boolean
  placement?: RandomSpreadPlacement
}

/**
 * The nether complexes around `from` (nether block coordinates) for a known seed: one per
 * region (RandomSpreadStructurePlacement, spacing 27, separation 4, salt 30084232), each a
 * fortress (weight 2) or a bastion (weight 3) by ChunkGenerator.createStructures' roll.
 * Nearest first.
 */
export function netherComplexes (levelSeed: Seed, from: { x: number, z: number }, opts: ComplexSearchOptions = {}): ComplexCandidate[] {
  const placement = opts.placement ?? NETHER_COMPLEXES.placement
  const radius = opts.radius ?? 3
  const cx = Math.floor(Math.floor(from.x) / 16)
  const cz = Math.floor(Math.floor(from.z) / 16)
  const rx0 = Math.floor(cx / placement.spacing)
  const rz0 = Math.floor(cz / placement.spacing)
  const out: ComplexCandidate[] = []
  for (let rx = rx0 - radius; rx <= rx0 + radius; rx++) {
    for (let rz = rz0 - radius; rz <= rz0 + radius; rz++) {
      const chunk = getPotentialStructureChunk(placement, levelSeed, rx * placement.spacing, rz * placement.spacing)
      const deltas = opts.isBasaltDeltas?.(chunk.x, chunk.z) ?? false
      const roll = selectStructure({ ...NETHER_COMPLEXES, placement }, levelSeed, chunk.x, chunk.z, s => !(deltas && s === 'bastion_remnant'))
      const x = chunk.x * 16 + FORTRESS_START_OFFSET
      const z = chunk.z * 16 + FORTRESS_START_OFFSET
      out.push({ chunkX: chunk.x, chunkZ: chunk.z, regionX: rx, regionZ: rz, x, z, structure: roll.structure as ComplexCandidate['structure'], roll: roll.roll, distance: Math.hypot(x - from.x, z - from.z) })
    }
  }
  return out.sort((a, b) => a.distance - b.distance)
}

/** the fortresses among the complexes around `from`, nearest first */
export function fortressCandidates (levelSeed: Seed, from: { x: number, z: number }, opts: ComplexSearchOptions = {}): ComplexCandidate[] {
  return netherComplexes(levelSeed, from, opts).filter(c => c.structure === 'fortress')
}

export interface ExploreWaypoint extends Pos {
  /** how far along the route */
  along: number
}

export interface ExploreOptions {
  /** the axis to walk along (default: the one `from` is nearer to, as most players do) */
  axis?: 'x' | 'z'
  /** +1 or -1 along the axis (default: away from 0) */
  direction?: 1 | -1
  /** blocks to walk (default two regions, 864) */
  length?: number
  /** blocks between scans (default 32: two chunks, inside a 64-block render distance) */
  step?: number
  /** the height to walk at (default 64: fortress decks are in 48-70) */
  y?: number
}

/**
 * The walk for an unknown seed: a straight line along the nether's x or z axis, scanning at
 * each waypoint. Every region (432 blocks) has a complex, 2 in 5 a fortress, and a fortress's
 * bridges run for a hundred blocks or more, so a straight line meets one within a few
 * regions.
 */
export function explorationRoute (from: Pos, opts: ExploreOptions = {}): ExploreWaypoint[] {
  const axis = opts.axis ?? (Math.abs(from.z) <= Math.abs(from.x) ? 'x' : 'z')
  const along0 = axis === 'x' ? from.x : from.z
  const direction = opts.direction ?? (along0 < 0 ? -1 : 1)
  const length = opts.length ?? 2 * COMPLEX_REGION_BLOCKS
  const step = opts.step ?? 32
  const y = opts.y ?? 64
  const out: ExploreWaypoint[] = []
  for (let t = step; t <= length; t += step) {
    out.push(axis === 'x'
      ? { x: Math.floor(from.x) + direction * t, y, z: Math.floor(from.z), along: t }
      : { x: Math.floor(from.x), y, z: Math.floor(from.z) + direction * t, along: t })
  }
  return out
}

export interface FortressSighting {
  /** fortress blocks seen */
  count: number
  /** fence blocks: only fortresses have them, so one is enough */
  fences: number
  /** the middle of what was seen */
  center: Pos
  /** the bounds of what was seen */
  min: Pos
  max: Pos
}

/**
 * Recognises a fortress from scanned blocks: any nether_brick_fence, or a handful of
 * nether_bricks (bastions and ruined portals don't use them). Null when it's not one.
 */
export function recognizeFortress (blocks: Iterable<{ name: string, pos: Pos }>, minBricks = 8): FortressSighting | null {
  let count = 0
  let fences = 0
  const sum = { x: 0, y: 0, z: 0 }
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const b of blocks) {
    if (!FORTRESS_BLOCKS.includes(b.name)) continue
    count++
    if (b.name === 'nether_brick_fence') fences++
    sum.x += b.pos.x; sum.y += b.pos.y; sum.z += b.pos.z
    min.x = Math.min(min.x, b.pos.x); min.y = Math.min(min.y, b.pos.y); min.z = Math.min(min.z, b.pos.z)
    max.x = Math.max(max.x, b.pos.x); max.y = Math.max(max.y, b.pos.y); max.z = Math.max(max.z, b.pos.z)
  }
  if (fences === 0 && count < minBricks) return null
  return { count, fences, center: { x: Math.round(sum.x / count), y: Math.round(sum.y / count), z: Math.round(sum.z / count) }, min, max }
}

/** BaseSpawner defaults: mobs appear within spawnRange 4 horizontally and 1 vertically of the spawner */
export const SPAWNER_RANGE = 4
/** NetherFortressPieces.MonsterThrone: the blaze spawner is at piece (3, 5, 5), five above the bridge deck */
export const THRONE_SPAWNER_HEIGHT = 5

export interface SpawnerEstimate extends Pos {
  /** spawner: the block was seen. blazes: the middle of a cluster of blazes. explore: no clue yet, a place to look */
  source: 'spawner' | 'blazes' | 'explore'
  /** 0-1 */
  confidence: number
}

export interface SpawnerClues {
  /** spawner blocks seen in the nether */
  spawners?: Pos[]
  /** blazes seen (positions, any number of sightings) */
  blazes?: Pos[]
  /** the fortress as seen so far */
  fortress?: FortressSighting | null
  /** where the bot is, to break ties */
  from?: Pos
}

/**
 * Where the blaze spawner probably is. A seen spawner block wins (fortress spawners are all
 * blaze spawners, on the MonsterThrone pieces). Otherwise the densest cluster of blazes: a
 * spawner keeps 2-4 blazes within a few blocks of itself (blazes also spawn anywhere in the
 * fortress, but scattered). Otherwise a look round the fortress's raised parts: the throne
 * stands 5 above the deck at the end of a bridge, so the highest brick seen is a fair guess.
 */
export function estimateBlazeSpawner (clues: SpawnerClues): SpawnerEstimate | null {
  const from = clues.from
  const dist = (p: Pos): number => from == null ? 0 : Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z)
  // bastions have magma cube spawners: keep to the fortress when its extent is known
  const f = clues.fortress
  const inFortress = (p: Pos): boolean => f == null || (p.x >= f.min.x - 16 && p.x <= f.max.x + 16 && p.z >= f.min.z - 16 && p.z <= f.max.z + 16)
  const spawners = (clues.spawners ?? []).filter(inFortress).sort((a, b) => dist(a) - dist(b))
  if (spawners.length > 0) return { ...spawners[0], source: 'spawner', confidence: 1 }
  const blazes = clues.blazes ?? []
  if (blazes.length > 0) {
    const r = SPAWNER_RANGE * 2
    let best: { center: Pos, n: number } | null = null
    for (const b of blazes) {
      const near = blazes.filter(o => Math.hypot(o.x - b.x, o.z - b.z) <= r && Math.abs(o.y - b.y) <= r)
      if (best == null || near.length > best.n) {
        const c = { x: 0, y: 0, z: 0 }
        for (const o of near) { c.x += o.x / near.length; c.y += o.y / near.length; c.z += o.z / near.length }
        best = { center: c, n: near.length }
      }
    }
    if (best != null && best.n >= 2) {
      // blazes hover; the spawner sits about at their lowest height
      const c = best.center
      return { x: Math.floor(c.x), y: Math.floor(c.y) - 1, z: Math.floor(c.z), source: 'blazes', confidence: Math.min(0.9, 0.3 + 0.15 * best.n) }
    }
  }
  if (f != null) {
    return { x: f.center.x, y: Math.min(f.max.y, FORTRESS_MAX_Y + 10), z: f.center.z, source: 'explore', confidence: 0.1 }
  }
  return null
}
