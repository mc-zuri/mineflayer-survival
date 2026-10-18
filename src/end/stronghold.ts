import { STRONGHOLDS, locatePos, ringPositions, type ConcentricRingsPlacement, type RingPosition } from '../worldgen/placement'
import type { Seed } from '../worldgen/random'
import type { EyeRay, XZ } from './triangulate'

/** ChunkGeneratorStructureState.generateRingPositions: findBiomeHorizontal's search radius (blocks) */
export const BIOME_SNAP = 112

export interface StrongholdRing {
  ring: number
  /** strongholds on this ring */
  count: number
  /** distance of the locate pos from 0,0 in blocks, before and after the biome snap */
  minDistance: number
  maxDistance: number
}

/**
 * The rings generateRingPositions lays out: ring m is 4d + 6dm chunks out (d = 32), ±1.25d,
 * with 3 strongholds on the first and k += 2k / (m + 1) more each ring, until 128 are placed.
 * Distances include the biome snap (up to 112 blocks) and the chunk: the first ring comes out
 * at 1296-2816 blocks.
 */
export function strongholdRings (placement: ConcentricRingsPlacement = STRONGHOLDS.placement): StrongholdRing[] {
  const d = placement.distance
  const out: StrongholdRing[] = []
  let k = placement.spread
  let placed = 0
  for (let m = 0; placed < placement.count; m++) {
    const count = Math.min(k, placement.count - placed)
    const mid = 4 * d + d * m * 6
    out.push({ ring: m, count, minDistance: Math.max(0, (mid - 1.25 * d) * 16 - BIOME_SNAP), maxDistance: (mid + 1.25 * d) * 16 + BIOME_SNAP + 16 })
    placed += count
    k += Math.trunc(2 * k / (m + 2))
  }
  return out
}

export interface StrongholdGuess extends RingPosition {
  /** the locate pos eyes fly to (chunk corner, y 0), before the biome snap */
  block: { x: number, y: number, z: number }
  /** horizontal distance from the asking point */
  distance: number
}

/**
 * All 128 stronghold chunks for a known seed, nearest first. Each is where vanilla puts it
 * before moving it into a preferred biome, so the true one is within 112 blocks (7 chunks).
 */
export function strongholdsForSeed (levelSeed: Seed, from: XZ = { x: 0, z: 0 }, placement: ConcentricRingsPlacement = STRONGHOLDS.placement): StrongholdGuess[] {
  return ringPositions(placement, levelSeed)
    .map(p => {
      const block = locatePos(p)
      return { ...p, block, distance: Math.hypot(block.x - from.x, block.z - from.z) }
    })
    .sort((a, b) => a.distance - b.distance)
}

/**
 * The stronghold an eye thrown at `from` flies to, for a known seed: ChunkGenerator's
 * getNearestGeneratedStructure compares the chunks' middles at y 32 with the player.
 */
export function nearestStronghold (levelSeed: Seed, from: { x: number, y: number, z: number }): StrongholdGuess {
  let best: StrongholdGuess | null = null
  let bestD = Infinity
  for (const s of strongholdsForSeed(levelSeed, from)) {
    const dx = s.x * 16 + 8 - from.x
    const dy = 32 - from.y
    const dz = s.z * 16 + 8 - from.z
    const d = dx * dx + dy * dy + dz * dz
    if (d < bestD) { bestD = d; best = s }
  }
  return best as StrongholdGuess
}

export interface OneThrowGuess extends XZ {
  ring: number
  /** blocks along the ray to the near and far edge of the ring */
  near: number
  far: number
}

/**
 * With one throw and no seed: the stronghold is on the ray, inside one of the rings. The
 * nearest ring the ray passes through is the likeliest; the guess is the middle of the
 * stretch of ray inside it.
 */
export function guessFromOneThrow (ray: EyeRay, rings: StrongholdRing[] = strongholdRings()): OneThrowGuess | null {
  const l = Math.hypot(ray.direction.x, ray.direction.z)
  const d = { x: ray.direction.x / l, z: ray.direction.z / l }
  const o = ray.origin
  // |o + t d|² = r²  →  t² + 2 (o·d) t + |o|² - r² = 0
  const od = o.x * d.x + o.z * d.z
  const oo = o.x * o.x + o.z * o.z
  const hits = (r: number): [number, number] | null => {
    const disc = od * od - (oo - r * r)
    if (disc < 0) return null
    const s = Math.sqrt(disc)
    return [-od - s, -od + s]
  }
  let best: OneThrowGuess | null = null
  for (const ring of rings) {
    const outer = hits(ring.maxDistance)
    if (outer == null || outer[1] <= 0) continue
    const inner = hits(ring.minDistance)
    // the stretch of ray with minDistance ≤ |p| ≤ maxDistance and t > 0: the part of the outer chord outside the inner one
    const segments: Array<[number, number]> = inner == null ? [outer] : [[outer[0], inner[0]], [inner[1], outer[1]]]
    for (const [a, b] of segments) {
      const t0 = Math.max(0, a)
      if (b <= t0) continue
      const t = (t0 + b) / 2
      if (best == null || t0 < best.near) best = { x: o.x + d.x * t, z: o.z + d.z * t, ring: ring.ring, near: t0, far: b }
    }
    if (best != null) return best
  }
  return best
}
