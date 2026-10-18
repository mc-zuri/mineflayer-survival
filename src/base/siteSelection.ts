import { BlockGetter, BlockRegistry, Vec, blockRegistry } from './blocks'
import { BlueprintOptions, generateBlueprint, planBuild } from './blueprint'

// Scores places to dig the storage room into: deep under solid stone, away from water and lava, and
// under level ground.

const STONE = new Set(['stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'cobblestone',
  'cobbled_deepslate', 'smooth_basalt', 'basalt', 'blackstone', 'netherrack', 'end_stone', 'dripstone_block'])

/** Natural stone and the ores in it: what the room wants above and around it. */
export function isNaturalStone (block: string): boolean {
  return STONE.has(block) || block.endsWith('_ore') || block === 'deepslate'
}

const FLUIDS = new Set(['water', 'lava', 'bubble_column'])

export interface SiteOptions extends BlueprintOptions {
  /** how far to look for water and lava around the design; default 8 */
  fluidRadius?: number
  /** stone cover above the roof beyond which more doesn't score; default 8 */
  maxCover?: number
  /** how far above the roof to look for the surface; default 64 */
  maxScan?: number
  /** columns around the footprint included in the flatness measure; default 2 */
  flatnessMargin?: number
}

export interface SiteScore {
  origin: Vec
  score: number
  /** natural stone blocks right above the roof, the fewest over the footprint (capped at maxScan) */
  stoneCover: number
  /** share of the shell already holding a block at least as blast resistant as the material */
  shellInPlace: number
  toPlace: number
  toDig: number
  /** from the design's box to the nearest water or lava (Infinity: none within fluidRadius; 0: inside) */
  fluidDistance: number
  /** highest minus lowest surface over the footprint and its margin (Infinity: no surface found) */
  surfaceRange: number
  reasons: string[]
}

/** Scores a site for the blueprint with its interior's min corner at `origin`. Higher is better. */
export function scoreSite (world: BlockGetter, origin: Vec, options: SiteOptions = {}): SiteScore {
  const registry = blockRegistry(options.version)
  const fluidRadius = options.fluidRadius ?? 8
  const maxCover = options.maxCover ?? 8
  const maxScan = options.maxScan ?? 64
  const margin = options.flatnessMargin ?? 2
  const blueprint = generateBlueprint({ ...options, origin })
  const { min, max } = blueprint.bounds
  const name = (x: number, y: number, z: number): string => BlockRegistry.nameOf(world(x, y, z))
  const reasons: string[] = []

  const plan = planBuild(blueprint, world, registry)
  const shell = blueprint.placements.filter(p => p.stage !== 'furniture')
  const shellLeft = plan.placements.filter(p => p.stage !== 'furniture').length
  const shellInPlace = shell.length === 0 ? 1 : 1 - shellLeft / shell.length

  // stone cover: natural stone stacked on each column of the roof
  let stoneCover = Infinity
  for (let x = min.x; x < max.x; x++) {
    for (let z = min.z; z < max.z; z++) {
      let n = 0
      while (n < maxScan && isNaturalStone(name(x, max.y + n, z))) n++
      stoneCover = Math.min(stoneCover, n)
    }
  }

  // flatness: the surface (first air above the roof) over the footprint and a margin around it
  let lowest = Infinity
  let highest = -Infinity
  for (let x = min.x - margin; x < max.x + margin; x++) {
    for (let z = min.z - margin; z < max.z + margin; z++) {
      for (let y = max.y; y < max.y + maxScan; y++) {
        if (registry.isAir(world(x, y, z))) {
          lowest = Math.min(lowest, y)
          highest = Math.max(highest, y)
          break
        }
      }
    }
  }
  const surfaceRange = highest >= lowest ? highest - lowest : Infinity

  // water and lava near the design
  let fluidDistance = Infinity
  for (let y = min.y - fluidRadius; y < max.y + fluidRadius; y++) {
    for (let z = min.z - fluidRadius; z < max.z + fluidRadius; z++) {
      for (let x = min.x - fluidRadius; x < max.x + fluidRadius; x++) {
        const block = world(x, y, z)
        if (!FLUIDS.has(BlockRegistry.nameOf(block)) && !(typeof block === 'object' && block != null && registry.hasFluid(block))) continue
        const dx = Math.max(min.x - x - 1, 0, x - max.x + 1)
        const dy = Math.max(min.y - y - 1, 0, y - max.y + 1)
        const dz = Math.max(min.z - z - 1, 0, z - max.z + 1)
        fluidDistance = Math.min(fluidDistance, Math.sqrt(dx * dx + dy * dy + dz * dz))
      }
    }
  }

  let score = 4 * Math.min(stoneCover, maxCover) + 20 * shellInPlace - 0.02 * plan.placements.length
  if (stoneCover < 3) reasons.push(`only ${stoneCover} stone over the roof`)
  if (fluidDistance === 0) {
    score -= 100
    reasons.push('water or lava inside the design')
  } else if (fluidDistance <= fluidRadius) {
    score -= 5 * (fluidRadius + 1 - fluidDistance)
    reasons.push(`water or lava ${fluidDistance.toFixed(1)} blocks away`)
  }
  if (Number.isFinite(surfaceRange)) score -= surfaceRange
  else {
    score -= maxScan
    reasons.push('no surface found above')
  }
  if (surfaceRange > 4 && Number.isFinite(surfaceRange)) reasons.push(`surface varies by ${surfaceRange} blocks`)
  if (shellInPlace < 0.5) reasons.push(`${shellLeft} shell blocks to place`)
  return { origin, score, stoneCover, shellInPlace, toPlace: plan.placements.length, toDig: plan.dig.length, fluidDistance, surfaceRange, reasons }
}

/** Scores every candidate origin, best first. */
export function selectSite (world: BlockGetter, candidates: Vec[], options: SiteOptions = {}): SiteScore[] {
  return candidates.map(c => scoreSite(world, c, options)).sort((a, b) => b.score - a.score)
}

/** Candidate origins on a grid around a point, `step` apart, at the given depths below it. */
export function siteCandidates (around: Vec, radius: number, step: number, depths: number[]): Vec[] {
  const out: Vec[] = []
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      for (const d of depths) out.push({ x: Math.floor(around.x) + dx, y: Math.floor(around.y) - d, z: Math.floor(around.z) + dz })
    }
  }
  return out
}
