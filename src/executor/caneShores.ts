// Sugar cane is found by water: vanilla's patch_sugar_cane feature (1.21.11 worldgen) puts its columns on grass, dirt
// or sand with water beside them (SugarCaneBlock.canSurvive), in a chunk 1 time in 6 in most biomes, 1 in 3 in a swamp.
// Inland, away from water, the feature's tries find no ground for it. So an exploring for cane goes along the shores
// the biome survey noted (SHORE_POI: the river, beach and swamp chunks, and the land by a lake's or the sea's water, of
// the loaded chunks and the seed's reads), the nearest not looked at yet, the canes in sight noted at each
// (rememberCanes), not the spiral's land out over the hills.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { isAbort, throwIfAborted } from '../skills/errors'
import { CANE_SIGHT_RADIUS, rememberCanes } from '../skills/caneFarm'
import { travel } from '../skills/travel'
import { trace } from '../skills/util'
import type { Seed } from '../worldgen/random'
import { openSeedBiomes, type SeedBiomes } from '../worldgen/seedBiomes'
import { CANE_SHORE_BIOMES, SHORE_POI, SHORE_SPACING, type BiomeSurvey, type ChunkSurface } from './foodLand'

export { CANE_SHORE_BIOMES, SHORE_POI }
/** a spot looked at for cane (its note: none) */
export const CANE_LOOKED_POI = 'cane_looked'
/** the seed's biomes read for shores about a home (the reads not made again) */
export const CANE_SEED_SURVEYED_POI = 'cane_seed_surveyed'
/** how far from home a shore is gone to */
export const CANE_SHORE_RANGE = 384
/** a shore within this of a spot looked at is passed over (the canes in sight there noted: CANE_SIGHT_RADIUS) */
export const CANE_LOOKED_RADIUS = 64
/** the shores gone to at most in one exploring */
export const CANE_SHORE_VISITS = 10
/** the rings of the seed's biomes read about home for shores, nearest first, and the points on each */
export const CANE_SEED_RINGS: ReadonlyArray<{ radius: number, points: number }> = [{ radius: 64, points: 8 }, { radius: 128, points: 12 }, { radius: 208, points: 16 }, { radius: 304, points: 20 }]

export interface Shore {
  x: number
  y: number
  z: number
  /** the shore's biome, or 'water' for land by a lake's or the sea's */
  what: string
}

/**
 * The next shore to look at for cane: one the survey noted (SHORE_POI: seen, or read from the seed) within
 * CANE_SHORE_RANGE of `home`, none within CANE_LOOKED_RADIUS of a spot looked at, the nearest to `from`
 */
export function nextCaneShore (memory: WorldMemory, home: { x: number, z: number }, from: { x: number, z: number }): Shore | null {
  const looked = memory.getPois(CANE_LOOKED_POI, { dimension: 'overworld' })
  let best: { s: Shore, d: number } | null = null
  for (const p of memory.getPois(SHORE_POI, { dimension: 'overworld' })) {
    if (Math.hypot(p.x - home.x, p.z - home.z) > CANE_SHORE_RANGE) continue
    if (looked.some(l => Math.hypot(l.x - p.x, l.z - p.z) <= CANE_LOOKED_RADIUS)) continue
    const d = Math.hypot(p.x - from.x, p.z - from.z)
    if (best == null || d < best.d) best = { s: { x: p.x, y: p.y, z: p.z, what: p.note ?? 'shore' }, d }
  }
  return best?.s ?? null
}

/**
 * The seed's surface biomes on CANE_SEED_RINGS about `center`, ring by ring until one has a shore (each noted in the
 * survey, as its food reads are: a shore biome's noted a shore), a point of land beside a point of water on the ring
 * noted a shore too (a lake's, the sea's); once a home (CANE_SEED_SURVEYED_POI). Resolves the points read.
 */
export async function readShoresFromSeed (biomes: SeedBiomes, survey: BiomeSurvey, memory: WorldMemory, center: { x: number, z: number }, signal?: AbortSignal): Promise<number> {
  let n = 0
  for (const ring of CANE_SEED_RINGS) {
    let found = false
    const reads: ChunkSurface[] = []
    for (let i = 0; i < ring.points; i++) {
      throwIfAborted(signal)
      const a = 2 * Math.PI * i / ring.points
      const x = Math.round(center.x + Math.cos(a) * ring.radius)
      const z = Math.round(center.z + Math.sin(a) * ring.radius)
      const key = `${x},${z}`
      let s = survey.seedReads.get(key)
      if (s == null) {
        const r = await biomes.surface(x, z)
        s = { x: r.x, y: r.y - 1, z: r.z, biome: r.biome, water: r.water }
        survey.seedReads.set(key, s)
        n++
      }
      survey.note(s)
      reads.push(s)
      if (CANE_SHORE_BIOMES.has(s.biome)) found = true
    }
    // a lake's or the sea's water on the ring by a point of land: the land's a shore (the water in sight from it)
    for (let i = 0; i < reads.length; i++) {
      const a = reads[i]
      const b = reads[(i + 1) % reads.length]
      if (a.water == null || b.water == null || a.water === b.water) continue
      const land = a.water ? b : a
      if (!memory.getPois(SHORE_POI, { dimension: 'overworld' }).some(o => Math.hypot(o.x - land.x, o.z - land.z) < SHORE_SPACING)) memory.addPoi(SHORE_POI, { x: land.x, y: land.y, z: land.z }, 'overworld', 'water')
      found = true
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

/** times a trip to a shore may be cut off (a reflex's abort) before the shore is noted as looked at all the same */
export const CANE_SHORE_CUTOFFS = 3
/** each memory's shores whose trips were cut off, and how many times */
const cutoffs = new WeakMap<WorldMemory, Map<string, number>>()
function cutoffsOf (memory: WorldMemory): Map<string, number> {
  let m = cutoffs.get(memory)
  if (m == null) cutoffs.set(memory, m = new Map())
  return m
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
    let shore = nextCaneShore(memory, home, bot.entity.position)
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
      shore = nextCaneShore(memory, home, bot.entity.position)
    }
    if (shore == null) {
      log('sugar cane: no shore left to look at')
      return false
    }
    log(`sugar cane: to the ${shore.what === 'water' ? 'shore by the water' : shore.what} at ${shore.x} ${shore.z} (${Math.round(Math.hypot(shore.x - bot.entity.position.x, shore.z - bot.entity.position.z))} blocks)`)
    // (noted once the trip ended, there or failed: one cut off by a reflex, its abort, is the same shore's again next
    // time, up to CANE_SHORE_CUTOFFS times: a polar bear's fight cut a 1.21.11 bot's trips off every 50 ticks, each
    // shore noted before its trip, and the next went to shores out to 449 blocks, f6-1.21.11, t178981 to t179158)
    const key = `${shore.x},${shore.z}`
    const cut = cutoffsOf(memory)
    try {
      await go(new Vec3(shore.x, shore.y, shore.z))
    } catch (err) {
      if (isAbort(err)) {
        const n = (cut.get(key) ?? 0) + 1
        cut.set(key, n)
        if (n >= CANE_SHORE_CUTOFFS) memory.addPoi(CANE_LOOKED_POI, { x: shore.x, y: shore.y, z: shore.z }, 'overworld')
      }
      throw err
    }
    cut.delete(key)
    memory.addPoi(CANE_LOOKED_POI, { x: shore.x, y: shore.y, z: shore.z }, 'overworld')
    if (await look()) return true
  }
  return false
}
