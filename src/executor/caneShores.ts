// Sugar cane is found by water: vanilla's patch_sugar_cane feature (1.21.11 worldgen) puts its columns on grass, dirt
// or sand with water beside them (SugarCaneBlock.canSurvive), in a chunk 1 time in 6 in most biomes, 1 in 3 in a swamp.
// Inland, away from water, the feature's tries find no ground for it. So an exploring for cane goes along the shores:
// the river, beach and swamp chunks the biome survey has seen (BiomeSurvey: the loaded chunks' biomes, and the seed's),
// the nearest not looked at yet, the canes in sight noted at each (rememberCanes), not the spiral's land out over
// the hills.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { isAbort, throwIfAborted } from '../skills/errors'
import { CANE_SIGHT_RADIUS, rememberCanes } from '../skills/caneFarm'
import { travel } from '../skills/travel'
import { trace } from '../skills/util'
import type { Seed } from '../worldgen/random'
import { openSeedBiomes, type SeedBiomes } from '../worldgen/seedBiomes'
import { ringPoints, type BiomeSurvey, type ChunkSurface } from './foodLand'

/**
 * The biomes whose shores an exploring for cane goes to: the river's banks (patch_sugar_cane, 1 chunk in 6, and banks
 * all along it), the beaches' (the sea's edge) and the swamp's (patch_sugar_cane_swamp, 1 in 3, its pools all about)
 */
export const CANE_SHORE_BIOMES: ReadonlySet<string> = new Set(['river', 'beach', 'swamp', 'snowy_beach'])
/** a spot looked at for cane (its note: none) */
export const CANE_LOOKED_POI = 'cane_looked'
/** the seed's biomes read for shores about a home (the reads not made again) */
export const CANE_SEED_SURVEYED_POI = 'cane_seed_surveyed'
/** how far from home a shore is gone to */
export const CANE_SHORE_RANGE = 384
/** a shore within this of a spot looked at is passed over (the canes in sight there noted: CANE_SIGHT_RADIUS) */
export const CANE_LOOKED_RADIUS = 64
/** the shores gone to at most in one exploring */
export const CANE_SHORE_VISITS = 6
/** the rings of the seed's biomes read about home for shores, nearest first, and the points on each */
export const CANE_SEED_RINGS: ReadonlyArray<{ radius: number, points: number }> = [{ radius: 64, points: 8 }, { radius: 128, points: 12 }, { radius: 208, points: 16 }, { radius: 304, points: 20 }]

/**
 * The next shore to look at for cane: a chunk of CANE_SHORE_BIOMES the survey has (seen, or read from the seed) within
 * CANE_SHORE_RANGE of `home`, none within CANE_LOOKED_RADIUS of a spot looked at, the nearest to `from`
 */
export function nextCaneShore (survey: Pick<BiomeSurvey, 'chunks'>, memory: WorldMemory, home: { x: number, z: number }, from: { x: number, z: number }): ChunkSurface | null {
  const looked = memory.getPois(CANE_LOOKED_POI, { dimension: 'overworld' })
  let best: { s: ChunkSurface, d: number } | null = null
  for (const s of survey.chunks.values()) {
    if (!CANE_SHORE_BIOMES.has(s.biome)) continue
    if (Math.hypot(s.x - home.x, s.z - home.z) > CANE_SHORE_RANGE) continue
    if (looked.some(p => Math.hypot(p.x - s.x, p.z - s.z) <= CANE_LOOKED_RADIUS)) continue
    const d = Math.hypot(s.x - from.x, s.z - from.z)
    if (best == null || d < best.d) best = { s, d }
  }
  return best?.s ?? null
}

/**
 * The seed's surface biomes on CANE_SEED_RINGS about `center`, ring by ring until one has a shore (each noted in the
 * survey, as its food reads are); once a home (CANE_SEED_SURVEYED_POI). Resolves the points read.
 */
export async function readShoresFromSeed (biomes: SeedBiomes, survey: BiomeSurvey, memory: WorldMemory, center: { x: number, z: number }, signal?: AbortSignal): Promise<number> {
  let n = 0
  for (const ring of CANE_SEED_RINGS) {
    let found = false
    for (let i = 0; i < ring.points; i++) {
      throwIfAborted(signal)
      const a = 2 * Math.PI * i / ring.points
      const x = Math.round(center.x + Math.cos(a) * ring.radius)
      const z = Math.round(center.z + Math.sin(a) * ring.radius)
      const key = `${x},${z}`
      let s = survey.seedReads.get(key)
      if (s == null) {
        const r = await biomes.surface(x, z)
        s = { x: r.x, y: r.y - 1, z: r.z, biome: r.biome }
        survey.seedReads.set(key, s)
        n++
      }
      survey.note(s)
      if (CANE_SHORE_BIOMES.has(s.biome)) found = true
    }
    if (found) break
  }
  memory.addPoi(CANE_SEED_SURVEYED_POI, { x: Math.round(center.x), y: 0, z: Math.round(center.z) }, 'overworld')
  return n
}

export interface CaneShoresArgs {
  /** the executor's (Executor.biomes) */
  survey: BiomeSurvey
  memory: WorldMemory
  /** where the shores are gone to about (the base; else the bot) */
  home?: Vec3 | null
  /** whether a cane to cut is near now (the mine step's) */
  found: () => boolean
  /** the world's seed: its biomes read for shores when the survey has none */
  seed?: Seed
  log?: (line: string) => void
  /** the trips (default the travel skill's, ending within 16 blocks) */
  travel?: (target: Vec3) => Promise<void>
  /** the seed's biomes (default openSeedBiomes: the minecraft-java-worldgen package's) */
  openSeed?: (seed: Seed, version: string) => Promise<SeedBiomes | null>
}

/**
 * Explores the shores for cane: to the nearest shore not looked at (nextCaneShore; the seed's read for some when the
 * survey has none), the canes in sight noted there, and to the nearest one noted; CANE_SHORE_VISITS shores at most.
 * Resolves true once a cane to cut is near (`found`), false when the shores ran out.
 */
export async function exploreCaneShores (bot: Bot, args: CaneShoresArgs, signal?: AbortSignal): Promise<boolean> {
  const { survey, memory } = args
  const log = args.log ?? (() => {})
  const home = args.home ?? bot.entity.position.floored()
  const go = args.travel ?? (async (target: Vec3): Promise<void> => {
    await travel(bot, { target, range: 16 }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('caneShores: the trip to', target.toString(), (err as Error).message)
    })
  })
  // the canes in sight noted, and the spot looked at; a cane noted near enough walked to
  const look = async (): Promise<boolean> => {
    survey.survey()
    rememberCanes(bot, memory)
    const here = bot.entity.position.floored()
    memory.addPoi(CANE_LOOKED_POI, here, 'overworld')
    if (args.found()) return true
    const known = memory.findBlocks('sugar_cane', { dimension: 'overworld', near: bot.entity.position, count: 1, maxDistance: CANE_SIGHT_RADIUS })[0]
    if (known == null) return false
    log(`sugar cane seen at ${known.x} ${known.y} ${known.z}`)
    await go(new Vec3(known.x, known.y, known.z))
    return args.found()
  }
  if (await look()) return true
  for (let visits = 0; visits < CANE_SHORE_VISITS; visits++) {
    throwIfAborted(signal)
    let shore = nextCaneShore(survey, memory, home, bot.entity.position)
    const seed = args.seed
    if (shore == null && seed != null && !memory.getPois(CANE_SEED_SURVEYED_POI, { dimension: 'overworld' }).some(p => Math.hypot(p.x - home.x, p.z - home.z) <= CANE_LOOKED_RADIUS)) {
      const biomes = await (args.openSeed ?? openSeedBiomes)(seed, bot.version).catch(() => null)
      if (biomes != null) {
        try {
          const n = await readShoresFromSeed(biomes, survey, memory, home, signal)
          trace('caneShores: read', n, 'of the seed\'s biomes about', home.x, home.z)
        } finally {
          await biomes.dispose().catch(() => {})
        }
      }
      shore = nextCaneShore(survey, memory, home, bot.entity.position)
    }
    if (shore == null) {
      log('sugar cane: no shore left to look at')
      return false
    }
    log(`sugar cane: to the ${shore.biome} at ${shore.x} ${shore.z} (${Math.round(Math.hypot(shore.x - bot.entity.position.x, shore.z - bot.entity.position.z))} blocks)`)
    // (noted before the trip: one cut off goes to the next shore, not the same one again)
    memory.addPoi(CANE_LOOKED_POI, { x: shore.x, y: shore.y, z: shore.z }, 'overworld')
    await go(new Vec3(shore.x, shore.y, shore.z))
    if (await look()) return true
  }
  return false
}
