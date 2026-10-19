import { LegacyRandomSource, setLargeFeatureSeed, setLargeFeatureWithSalt, toLong, type Seed } from './random'

export interface ChunkXZ { x: number, z: number }

/** RandomSpreadStructurePlacement: one candidate chunk per spacing × spacing region */
export interface RandomSpreadPlacement {
  spacing: number
  separation: number
  salt: number
  spreadType: 'linear' | 'triangular'
}

export interface StructureSelectionEntry {
  structure: string
  weight: number
}

export interface StructureSet<P> {
  placement: P
  structures: StructureSelectionEntry[]
}

/** data/minecraft/worldgen/structure_set/nether_complexes.json (1.21.11; the same in 26.3) */
export const NETHER_COMPLEXES: StructureSet<RandomSpreadPlacement> = {
  placement: { spacing: 27, separation: 4, salt: 30084232, spreadType: 'linear' },
  structures: [{ structure: 'fortress', weight: 2 }, { structure: 'bastion_remnant', weight: 3 }]
}

/** ConcentricRingsStructurePlacement: `count` positions on rings `distance` chunks apart */
export interface ConcentricRingsPlacement {
  distance: number
  spread: number
  count: number
}

/** data/minecraft/worldgen/structure_set/strongholds.json (1.21.11; the same in 26.3) */
export const STRONGHOLDS: StructureSet<ConcentricRingsPlacement> = {
  placement: { distance: 32, spread: 3, count: 128 },
  structures: [{ structure: 'stronghold', weight: 1 }]
}

/** RandomSpreadType.evaluate */
function evaluate (type: RandomSpreadPlacement['spreadType'], random: LegacyRandomSource, bound: number): number {
  return type === 'linear' ? random.nextInt(bound) : Math.trunc((random.nextInt(bound) + random.nextInt(bound)) / 2)
}

/** the region (spacing × spacing chunks) a chunk is in */
export function regionOf (placement: RandomSpreadPlacement, chunkX: number, chunkZ: number): ChunkXZ {
  return { x: Math.floor(chunkX / placement.spacing), z: Math.floor(chunkZ / placement.spacing) }
}

/** RandomSpreadStructurePlacement.getPotentialStructureChunk: the region's one candidate chunk */
export function getPotentialStructureChunk (placement: RandomSpreadPlacement, levelSeed: Seed, chunkX: number, chunkZ: number): ChunkXZ {
  const region = regionOf(placement, chunkX, chunkZ)
  const random = new LegacyRandomSource(0n)
  setLargeFeatureWithSalt(random, levelSeed, region.x, region.z, placement.salt)
  const bound = placement.spacing - placement.separation
  const ox = evaluate(placement.spreadType, random, bound)
  const oz = evaluate(placement.spreadType, random, bound)
  return { x: region.x * placement.spacing + ox, z: region.z * placement.spacing + oz }
}

export interface StructureRoll {
  /** the structure the chunk generates, or null when none of the set fits */
  structure: string | null
  /** the first nextInt(totalWeight) the selection rolled */
  roll: number
}

/**
 * ChunkGenerator.createStructures for a set with several structures: roll by weight with
 * setLargeFeatureSeed, and when the rolled structure can't generate there (its biome check
 * fails) drop it and roll again among the rest. `canGenerate` stands in for the biome check;
 * by default every structure can.
 */
export function selectStructure (set: StructureSet<unknown>, levelSeed: Seed, chunkX: number, chunkZ: number,
  canGenerate: (structure: string) => boolean = () => true): StructureRoll {
  const list = [...set.structures]
  if (list.length === 1) return { structure: canGenerate(list[0].structure) ? list[0].structure : null, roll: 0 }
  const random = new LegacyRandomSource(0n)
  setLargeFeatureSeed(random, levelSeed, chunkX, chunkZ)
  let total = list.reduce((sum, e) => sum + e.weight, 0)
  let first: number | null = null
  while (list.length > 0) {
    let j = random.nextInt(total)
    if (first == null) first = j
    let k = 0
    for (const e of list) {
      j -= e.weight
      if (j < 0) break
      k++
    }
    const picked = list[k]
    if (canGenerate(picked.structure)) return { structure: picked.structure, roll: first }
    list.splice(k, 1)
    total -= picked.weight
  }
  return { structure: null, roll: first ?? 0 }
}

export interface RingPosition extends ChunkXZ {
  /** 0 for the innermost ring */
  ring: number
}

/**
 * ChunkGeneratorStructureState.generateRingPositions, before the biome snap: vanilla then moves
 * each chunk to a preferred biome (#stronghold_biased_to) found within 112 blocks of the chunk's
 * middle, which needs the biome source, so the true chunk can be up to 7 chunks off.
 *
 * The same in 26.3: the rings are still around 0,0 (its new dimension origin, the spawn chunk, is read only by the
 * dimension_origin placement no vanilla structure set uses), and RandomSpreadStructurePlacement doesn't offset by it
 * either. #stronghold_biased_to has 26.3's sulfur_caves too, which can move the snapped chunk on some seeds.
 */
export function ringPositions (placement: ConcentricRingsPlacement, levelSeed: Seed): RingPosition[] {
  const { distance: i, count: j } = placement
  if (j === 0) return []
  const out: RingPosition[] = []
  let k = placement.spread
  const random = new LegacyRandomSource(0n)
  random.setSeed(toLong(levelSeed)) // RandomSource.create() then setSeed(concentricRingsSeed)
  let d = random.nextDouble() * Math.PI * 2
  let l = 0
  let m = 0
  for (let n = 0; n < j; n++) {
    const e = 4 * i + i * m * 6 + (random.nextDouble() - 0.5) * (i * 2.5)
    out.push({ x: Math.round(Math.cos(d) * e) + 0, z: Math.round(Math.sin(d) * e) + 0, ring: m })
    random.fork() // the biome search's own random, taken from this one
    d += (Math.PI * 2) / k
    if (++l === k) {
      m++
      l = 0
      k += Math.trunc(2 * k / (m + 1))
      k = Math.min(k, j - n)
      d += random.nextDouble() * Math.PI * 2
    }
  }
  return out
}

/** StructurePlacement.getLocatePos with no locate_offset: the chunk's minimum corner at y 0 */
export function locatePos (chunk: ChunkXZ): { x: number, y: number, z: number } {
  return { x: chunk.x * 16, y: 0, z: chunk.z * 16 }
}

/**
 * data/minecraft/worldgen/structure_set/end_cities.json (StructureSets: RandomSpreadStructurePlacement(20, 11,
 * TRIANGULAR, 10387313), the same in 1.21.11 and 26.3)
 */
export const END_CITIES: StructureSet<RandomSpreadPlacement> = {
  placement: { spacing: 20, separation: 11, salt: 10387313, spreadType: 'triangular' },
  structures: [{ structure: 'end_city', weight: 1 }]
}
