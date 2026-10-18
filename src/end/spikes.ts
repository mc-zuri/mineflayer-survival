import type { Pos } from '../core/memory'
import { LegacyRandomSource, floor, shuffledRange, toLong, type Seed } from '../worldgen/random'

// SpikeFeature in 1.21.11, EndSpikeFeature in 26.3 (its SpikeFeature is a new, unrelated feature): the same layout,
// radii, heights, cages and crystals from the same seed. The exit portal (EndPodiumFeature) is the same too.

/** SpikeFeature.NUMBER_OF_SPIKES */
export const NUMBER_OF_SPIKES = 10
/** SpikeFeature.SPIKE_DISTANCE: the spikes' centers are on this circle around 0,0 */
export const SPIKE_DISTANCE = 42

/** SpikeFeature.EndSpike */
export interface EndSpike {
  /** the spike's place on the circle, 0 at +x, counting towards +z */
  index: number
  centerX: number
  centerZ: number
  radius: number
  /** the bedrock under the crystal is at this y; the obsidian ends one below */
  height: number
  /** caged in iron bars */
  guarded: boolean
}

export interface Box { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }

export interface SpikeCrystal {
  spike: EndSpike
  /** the end_crystal entity's position (its feet), as SpikeFeature.placeSpike puts it */
  position: Pos
  /** the middle of its 2×2×2 box, the point to aim at */
  center: Pos
  box: Box
  /** the bedrock block it sits on, and the fire block inside it */
  bedrock: Pos
  fire: Pos
}

/** the seed the spike layout is cached by: SpikeFeature.getSpikesForLevel */
export function spikeSeed (levelSeed: Seed): bigint {
  return new LegacyRandomSource(toLong(levelSeed)).nextLong() & 65535n
}

/**
 * SpikeFeature.getSpikesForLevel / SpikeCacheLoader.load: the radii and heights are dealt
 * from a shuffled 0-9 by the spike seed, so there are only 65536 layouts. The two spikes
 * dealt 1 and 2 (heights 79 and 82, radius 2) are the caged ones.
 */
export function getSpikesForLevel (levelSeed: Seed): EndSpike[] {
  const shuffled = shuffledRange(NUMBER_OF_SPIKES, new LegacyRandomSource(spikeSeed(levelSeed)))
  const out: EndSpike[] = []
  for (let i = 0; i < NUMBER_OF_SPIKES; i++) {
    const centerX = floor(42.0 * Math.cos(2.0 * (-Math.PI + (Math.PI / 10) * i)))
    const centerZ = floor(42.0 * Math.sin(2.0 * (-Math.PI + (Math.PI / 10) * i)))
    const l = shuffled[i]
    out.push({ index: i, centerX, centerZ, radius: 2 + Math.trunc(l / 3), height: 76 + l * 3, guarded: l === 1 || l === 2 })
  }
  return out
}

/** the spike centers without a seed: the circle is the same in every world, only radius, height and cage change */
export function spikeCenters (): Array<{ x: number, z: number }> {
  return getSpikesForLevel(0).map(s => ({ x: s.centerX, z: s.centerZ }))
}

/** the crystal SpikeFeature.placeSpike spawns on top of a spike */
export function spikeCrystal (spike: EndSpike): SpikeCrystal {
  const x = spike.centerX + 0.5
  const z = spike.centerZ + 0.5
  const y = spike.height + 1
  return {
    spike,
    position: { x, y, z },
    center: { x, y: y + 1, z },
    box: { minX: x - 1, minY: y, minZ: z - 1, maxX: x + 1, maxY: y + 2, maxZ: z + 1 },
    bedrock: { x: spike.centerX, y: spike.height, z: spike.centerZ },
    fire: { x: spike.centerX, y: spike.height + 1, z: spike.centerZ }
  }
}

/** the obsidian columns of a spike: cells within radius² + 1 of the center (BlockPos.distToLowCornerSqr), up to height - 1 */
export function spikeColumns (spike: EndSpike): Array<{ x: number, z: number }> {
  const r = spike.radius
  const out: Array<{ x: number, z: number }> = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz <= r * r + 1) out.push({ x: spike.centerX + dx, z: spike.centerZ + dz })
    }
  }
  return out
}

/** the iron bars SpikeFeature.placeSpike cages a guarded spike with: a 5×5 shell 4 high on top, with a roof */
export function cageBars (spike: EndSpike): Pos[] {
  if (!spike.guarded) return []
  const out: Pos[] = []
  for (let m = -2; m <= 2; m++) {
    for (let n = -2; n <= 2; n++) {
      for (let o = 0; o <= 3; o++) {
        if (Math.abs(m) === 2 || Math.abs(n) === 2 || o === 3) out.push({ x: spike.centerX + m, y: spike.height + o, z: spike.centerZ + n })
      }
    }
  }
  return out
}

/** the top of a spike, where a bot that pillared up stands: obsidian cells at y height - 1, so feet at height */
export function spikeTop (spike: EndSpike): Pos[] {
  return spikeColumns(spike)
    .filter(c => c.x !== spike.centerX || c.z !== spike.centerZ)
    .map(c => ({ x: c.x, y: spike.height, z: c.z }))
}

/**
 * EndPodiumFeature at the fight origin (0, portalY, 0): the exit portal ring (air while the
 * dragon lives, end_portal after), the bedrock rim round it, and the 4-high bedrock pillar.
 * The dragon lands on the pillar's top (DragonLandingPhase: the heightmap at the podium).
 */
export interface ExitPortal {
  origin: Pos
  /** the 20 cells dx² + dz² < 2.5² around the pillar, at portalY */
  portal: Pos[]
  /** bedrock rim cells (2.5² ≤ d² < 3.5²) at portalY; bedrock under the portal at portalY - 1 */
  rim: Pos[]
  pillar: Pos[]
  /** where the dragon's feet go when it perches: Vec3.atBottomCenterOf the heightmap at 0,0 */
  perch: Pos
}

export function exitPortal (portalY: number, origin: { x: number, z: number } = { x: 0, z: 0 }): ExitPortal {
  const portal: Pos[] = []
  const rim: Pos[] = []
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const d2 = dx * dx + dz * dz
      const p = { x: origin.x + dx, y: portalY, z: origin.z + dz }
      if (d2 < 6.25) { if (d2 > 0) portal.push(p) } else if (d2 < 12.25) rim.push(p)
    }
  }
  const pillar = [0, 1, 2, 3].map(i => ({ x: origin.x, y: portalY + i, z: origin.z }))
  return { origin: { x: origin.x, y: portalY, z: origin.z }, portal, rim, pillar, perch: { x: origin.x + 0.5, y: portalY + 4, z: origin.z + 0.5 } }
}
