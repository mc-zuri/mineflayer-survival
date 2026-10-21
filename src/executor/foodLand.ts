// Food land: where the bot's food is got when the land about its home has none. Vanilla's animals come with the land
// (the chunk's generation spawns them, NaturalSpawner.spawnMobsForChunkGeneration, by the biome's creature spawns), and
// so do its berries, mushrooms and apples (the biome's features): a home on the snowy peaks of seed 31337 (a grove's
// rabbits, foxes and wolves, the snowy slopes' goats and rabbits, the peaks' goats; no cow, pig, sheep or chicken, no
// berry bush, no mushroom, spruce leaves that drop no apple) has no food but the rabbits it starts with. A 26.3 bot there
// hunted them out, then explored the same 96 and 192 blocks for cows, carrots, zombies and salmon from t126906 to t221841
// for nothing, at food 0 to 6 and 2 health (full-26.3-s31337-h), while snowy taiga, taiga and a frozen river lay some 200
// blocks downhill to the east and the north.
//
// The loaded chunks' biomes (the server's chunk data: what the land spawns) are surveyed as the bot goes, the chunks of
// the biomes with farm animals noted in the memory (FOOD_BIOME_POI). When the food work starts on land with none of
// them about home, or on land whose animals the hunts found none of, the bot goes to the nearest food biome noted (or
// read from the seed: seedBiomes.ts; or scouted for, downhill), and the food work is done from there (FOOD_LAND_POI: the
// runner's home for it; the bot's home while it has no base).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { isAbort, throwIfAborted } from '../skills/errors'
import { travel } from '../skills/travel'
import { trace } from '../skills/util'
import type { Seed } from '../worldgen/random'
import { openSeedBiomes, type SeedBiomes } from '../worldgen/seedBiomes'

/**
 * The biomes whose creature spawns have cows, pigs, sheep or chickens (or mooshrooms, beef too): the natural_mob_spawns
 * of 26.3's worldgen/biome files (1.21.11's are the same but for the dappled forest, which it hasn't)
 */
export const MEAT_BIOMES: ReadonlySet<string> = new Set([
  'badlands', 'bamboo_jungle', 'birch_forest', 'cherry_grove', 'dappled_forest', 'dark_forest', 'eroded_badlands',
  'flower_forest', 'forest', 'jungle', 'meadow', 'mushroom_fields', 'old_growth_birch_forest', 'old_growth_pine_taiga',
  'old_growth_spruce_taiga', 'plains', 'savanna', 'savanna_plateau', 'snowy_taiga', 'sparse_jungle', 'sunflower_plains',
  'swamp', 'taiga', 'windswept_forest', 'windswept_gravelly_hills', 'windswept_hills', 'windswept_savanna', 'wooded_badlands'
])

/**
 * The biomes whose creature spawns have sheep (the wool of a bed): the food biomes but the mushroom fields (1.21.11's
 * and 26.3's worldgen/biome files)
 */
export const SHEEP_BIOMES: ReadonlySet<string> = new Set([...MEAT_BIOMES].filter(b => b !== 'mushroom_fields'))

/** the land animals the plans price by their biomes about (Sightings' mobLand), and the biomes each spawns in */
export const MOB_BIOMES: Readonly<Record<string, ReadonlySet<string>>> = { sheep: SHEEP_BIOMES }

/** how far about the bot an animal's biomes count as about (the exploring's 96 blocks and some) */
export const MOB_LAND_RANGE = 160

/**
 * The biomes whose features grow kelp: kelp_cold in the ocean, deep ocean, cold and deep cold ocean, kelp_warm in the
 * lukewarm and deep lukewarm ocean (1.21.11's and 26.3's worldgen/biome files; no kelp in the warm and frozen oceans,
 * nor in a river)
 */
export const KELP_BIOMES: ReadonlySet<string> = new Set(['ocean', 'deep_ocean', 'cold_ocean', 'deep_cold_ocean', 'lukewarm_ocean', 'deep_lukewarm_ocean'])

/** the meat animals whose misses (Sightings) say the land's hunted out */
export const LAND_ANIMALS = ['cow', 'pig', 'sheep', 'chicken']
/** the land's foods whose misses are forgotten on new land */
export const LAND_FOODS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'sweet_berry_bush', 'melon', 'carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block', 'kelp', 'kelp_plant', 'brown_mushroom', 'red_mushroom', 'oak_leaves', 'dark_oak_leaves', 'water', 'cod', 'salmon', 'zombie']

/** a chunk of a food biome seen, in the memory (its note: the biome) */
export const FOOD_BIOME_POI = 'food_biome'
/** where the food work is done from (its note: the biome) */
export const FOOD_LAND_POI = 'food_land'
/** a food land (or home) whose animals the hunts found none of: no food land within FAILED_LAND_RADIUS of it */
export const FOOD_LAND_FAILED_POI = 'food_land_failed'
/** a direction scouted for food land from a home (its note: the direction's index) */
export const FOOD_SCOUTED_POI = 'food_scouted'
/** the seed's biomes read about a home (the reads not made again) */
export const SEED_SURVEYED_POI = 'food_seed_surveyed'

/** how far about home the land is judged by (its chunks' biomes), and a food land kept to */
export const FED_RADIUS = 80
/** the chunks surveyed within FED_RADIUS that a judgement of the land needs (of some 80) */
export const MIN_SURVEYED = 12
/** food biome chunks are noted no nearer than this to each other */
export const FOOD_BIOME_SPACING = 32
/** the farthest a food land is gone to */
export const FOOD_TRIP_MAX = 640
/** no food land within this of one whose animals the hunts found none of (the hunt's 96 blocks walked and its sight) */
export const FAILED_LAND_RADIUS = 160
/** the rings of the seed's biomes read about home, nearest first (8 points a ring) */
export const SEED_RINGS = [128, 224, 320, 448]
/**
 * the food biome chunks within FOOD_PATCH_RADIUS of a food biome noted (of some 29) that make it wide enough to go to
 * before the others: a chunk's generation spawns its animals 1 time in 10 (MobCategory.CREATURE's spawn chance), and
 * the snowy taiga patches by seed 31337's peaks, 7 chunks of 29 at (-120, -40) and 7 of 32 by the frozen river at
 * (224, 0), had no cow (hunt2-b, hunt2-d), the taiga at (0, -224) 26 of 32
 */
export const FOOD_PATCH_CHUNKS = 14
export const FOOD_PATCH_RADIUS = 48
/** the seed's reads about a food biome ring point (at this offset) of which most are food biomes for a wide one */
export const SEED_PATCH_OFFSET = 40

/** how far a scouting walks out in its direction */
export const SCOUT_DISTANCE = 320
/** the walks a trip to food land takes at most, each while the last got the bot nearer */
export const FOOD_TRIP_TRIES = 4
/**
 * the food work's tries in a row that got no food after which the land's left (as one whose animals weren't found): a
 * hunt's exploring of its 96 blocks, cut into the meals' 6000 ticks, came to its NOT_FOUND only after some 20000, and
 * a 26.3 bot on a snowy taiga patch by seed 31337's peaks with no cow in it went from food 7 to 5 meanwhile (hunt2-d)
 */
export const FOOD_LAND_DRY_TRIES = 2
/** how many directions are scouted (the best first) */
export const SCOUT_DIRECTIONS = 8

const AIRS = new Set(['air', 'cave_air', 'void_air'])

/** the 8 directions, east first, clockwise (x, z) */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].map(([x, z]) => {
  const n = Math.hypot(x, z)
  return [x / n, z / n] as const
})

export interface ChunkSurface {
  x: number
  z: number
  y: number
  biome: string
  /** the top block is water (a lake's, a river's, the sea's) */
  water?: boolean
}

/**
 * The biomes whose shores an exploring for cane goes to: the river's banks (patch_sugar_cane, a chunk in 6, and banks
 * all along it), the beaches' (the sea's edge) and the swamp's (patch_sugar_cane_swamp, 1 in 3, its pools all about)
 */
export const CANE_SHORE_BIOMES: ReadonlySet<string> = new Set(['river', 'beach', 'swamp', 'snowy_beach'])
/** a shore seen (its note: the biome of a shore, or 'water' for land by a lake or the sea), for the cane */
export const SHORE_POI = 'shore'
/** shores are noted no nearer than this to each other */
export const SHORE_SPACING = 32

/** the surface of a loaded column: its top block's y and the biome there (the chunk data's: the server's), else null */
export function surfaceAt (bot: Bot, x: number, z: number): ChunkSurface | null {
  const world = bot.world as any
  const col = world?.getColumnAt?.(new Vec3(x, 0, z))
  if (col == null) return null
  const game = bot.game as any
  const minY = Number(game?.minY ?? 0)
  const height = Number(game?.height ?? 256)
  const p = new Vec3(x & 15, 0, z & 15)
  const blocks = bot.registry.blocksByStateId as Record<number, { name: string }>
  for (let y = minY + height - 1; y >= minY; y--) {
    p.y = y
    const name = blocks[col.getBlockStateId(p)]?.name ?? 'air'
    if (AIRS.has(name)) continue
    const id = col.getBiome(p)
    const biome = (bot.registry.biomes as any)?.[id]?.name
    return biome == null ? null : { x, z, y, biome: String(biome).replace(/^minecraft:/, ''), water: name === 'water' }
  }
  return null
}

/**
 * The surface biomes of the chunks the bot has loaded, each surveyed once (its middle column), the food biomes'
 * noted in the memory
 */
export class BiomeSurvey {
  /** by chunk "x,z": the middle column's surface */
  readonly chunks = new Map<string, ChunkSurface>()
  /** the seed's reads by "x,z" (surveySeed's: a survey cut off by a reflex and run again reads none twice) */
  readonly seedReads = new Map<string, ChunkSurface>()
  /** the seed's food biome points with most of the reads about them food biomes too (surveySeed's) */
  readonly seedWide: Array<{ x: number, z: number }> = []

  constructor (private readonly bot: Bot, private readonly memory: WorldMemory) {}

  /** the loaded chunks not surveyed yet, `max` at most: the number surveyed */
  survey (max = 400): number {
    const bot = this.bot
    if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return 0
    const world = bot.world as any
    const columns: Array<{ chunkX: string | number, chunkZ: string | number }> = typeof world?.getColumns === 'function' ? world.getColumns() : []
    let n = 0
    for (const c of columns) {
      if (n >= max) break
      const cx = Number(c.chunkX)
      const cz = Number(c.chunkZ)
      const key = `${cx},${cz}`
      if (this.chunks.has(key)) continue
      const s = surfaceAt(bot, cx * 16 + 8, cz * 16 + 8)
      if (s == null) continue
      n++
      this.note(s)
    }
    return n
  }

  /** a chunk's surface taken in (the survey's, or the seed's read) */
  note (s: ChunkSurface): void {
    this.chunks.set(`${Math.floor(s.x / 16)},${Math.floor(s.z / 16)}`, s)
    this.noteShores(s)
    if (!MEAT_BIOMES.has(s.biome)) return
    const near = this.memory.getPois(FOOD_BIOME_POI, { dimension: 'overworld' }).some(p => Math.hypot(p.x - s.x, p.z - s.z) < FOOD_BIOME_SPACING)
    if (!near) this.memory.addPoi(FOOD_BIOME_POI, { x: s.x, y: s.y, z: s.z }, 'overworld', s.biome)
  }

  /**
   * The shores a chunk's surface shows, noted in the memory (SHORE_POI, SHORE_SPACING apart) for the cane, which grows by
   * water only: a chunk of a shore biome (CANE_SHORE_BIOMES), and a land chunk with a water chunk beside it or the
   * other way round (the land's: a lake's or the sea's shore, whatever its biome). A 1.21.11 game's nearest canes stood
   * by the lakes of the plains about its home (f3-1.21.11, seed 4261406750935072801: (-193, 63, -3), (-106, 63, -57)).
   */
  private noteShores (s: ChunkSurface): void {
    const shore = (p: ChunkSurface, why: string): void => {
      if (this.memory.getPois(SHORE_POI, { dimension: 'overworld' }).some(o => Math.hypot(o.x - p.x, o.z - p.z) < SHORE_SPACING)) return
      this.memory.addPoi(SHORE_POI, { x: p.x, y: p.y, z: p.z }, 'overworld', why)
    }
    if (CANE_SHORE_BIOMES.has(s.biome)) shore(s, s.biome)
    if (s.water == null) return
    const cx = Math.floor(s.x / 16)
    const cz = Math.floor(s.z / 16)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = this.chunks.get(`${cx + dx},${cz + dz}`)
      if (n?.water == null || n.water === s.water) continue
      shore(s.water ? n : s, 'water')
    }
  }

  /** the chunks surveyed within `radius` of `center`, and those of a food biome */
  land (center: { x: number, z: number }, radius = FED_RADIUS): { chunks: number, meat: number } {
    let chunks = 0
    let meat = 0
    for (const s of this.chunks.values()) {
      if (Math.hypot(s.x - center.x, s.z - center.z) > radius) continue
      chunks++
      if (MEAT_BIOMES.has(s.biome)) meat++
    }
    return { chunks, meat }
  }

  /** whether a chunk of one of `biomes` was surveyed (or read from the seed: noted the same) within `radius` of `center` */
  near (biomes: ReadonlySet<string>, center: { x: number, z: number }, radius: number): boolean {
    for (const s of this.chunks.values()) {
      if (biomes.has(s.biome) && Math.hypot(s.x - center.x, s.z - center.z) <= radius) return true
    }
    return false
  }

  /** the seed's reads under way: about a home, their promise */
  private seedRun: { center: { x: number, z: number }, done: Promise<void>, read: boolean } | null = null
  /** the scouting under way (seekFoodLand's): from a home, its direction */
  scouting: { center: { x: number, z: number }, i: number } | null = null

  /** whether the seed's reads about `center` are in */
  seedRead (center: { x: number, z: number }): boolean {
    const run = this.seedRun
    return run != null && run.read && Math.hypot(run.center.x - center.x, run.center.z - center.z) <= FED_RADIUS
  }

  /**
   * The seed's biomes read about `center` in the background (surveySeed with the generator `open` gives): the reads
   * under way about it if there are any, else new ones; resolves once they're in (never rejects)
   */
  readSeed (center: { x: number, z: number }, open: () => Promise<SeedBiomes | null>): Promise<void> {
    const run = this.seedRun
    if (run != null && Math.hypot(run.center.x - center.x, run.center.z - center.z) <= FED_RADIUS) return run.done
    const done = (async () => {
      const biomes = await open().catch(() => null)
      if (biomes == null) return
      try {
        const n = await surveySeed(biomes, this, this.memory, center)
        trace('foodLand: read', n, 'of the seed\'s biomes about', Math.round(center.x), Math.round(center.z))
      } catch (err) {
        trace('foodLand: the seed\'s biomes', (err as Error).message)
      } finally {
        await biomes.dispose().catch(() => {})
      }
    })()
    const record = { center: { x: center.x, z: center.z }, done, read: false }
    void done.then(() => { record.read = true })
    this.seedRun = record
    return done
  }

  /** the food biome chunks surveyed within FOOD_PATCH_RADIUS of a point */
  patchSize (p: { x: number, z: number }): number {
    let n = 0
    for (const s of this.chunks.values()) if (MEAT_BIOMES.has(s.biome) && Math.hypot(s.x - p.x, s.z - p.z) <= FOOD_PATCH_RADIUS) n++
    return n
  }

  /** whether a food biome noted is a wide one: FOOD_PATCH_CHUNKS of them surveyed about it, or the seed's reads say so */
  wide (p: { x: number, z: number }): boolean {
    return this.patchSize(p) >= FOOD_PATCH_CHUNKS || this.seedWide.some(w => Math.hypot(w.x - p.x, w.z - p.z) <= FOOD_BIOME_SPACING)
  }

  /** the mean surface height of the chunks surveyed in a direction (DIRECTIONS[i]) from `center`, out to `radius` */
  heightToward (center: { x: number, z: number }, i: number, radius = FED_RADIUS * 1.5): number | null {
    const [dx, dz] = DIRECTIONS[i]
    let sum = 0
    let n = 0
    for (const s of this.chunks.values()) {
      const ox = s.x - center.x
      const oz = s.z - center.z
      const d = Math.hypot(ox, oz)
      if (d < 24 || d > radius) continue
      // within the direction's 45 degrees
      if ((ox * dx + oz * dz) / d < Math.cos(Math.PI / 8)) continue
      sum += s.y
      n++
    }
    return n === 0 ? null : sum / n
  }
}

/** waits for `p`, or throws when `signal` aborts first */
async function untilDone (p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal == null) return await p
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void p.then(() => { signal.removeEventListener('abort', onAbort); resolve() })
  })
}

/** whether the land about `center` has no food biome, by the chunks surveyed (null: too few surveyed to say) */
export function landBarren (survey: BiomeSurvey, center: { x: number, z: number }): boolean | null {
  const land = survey.land(center)
  if (land.meat > 0) return false
  return land.chunks >= MIN_SURVEYED ? true : null
}

/** the food land the food work is done from, if any */
export function foodLandOf (memory: WorldMemory): Vec3 | null {
  const p = memory.getPois(FOOD_LAND_POI, { dimension: 'overworld' })[0]
  return p == null ? null : new Vec3(p.x, p.y, p.z)
}

/**
 * The nearest food biome noted to `from` within FOOD_TRIP_MAX, none near a land whose animals weren't found
 * (FOOD_LAND_FAILED_POI) nor within FED_RADIUS of `away` (the land being left)
 */
export function nearestFoodBiome (memory: WorldMemory, from: { x: number, z: number }, away?: { x: number, z: number }, only: (p: { x: number, z: number }) => boolean = () => true): { pos: Vec3, biome: string } | null {
  const failed = memory.getPois(FOOD_LAND_FAILED_POI, { dimension: 'overworld' })
  let best: { pos: Vec3, biome: string, d: number } | null = null
  for (const p of memory.getPois(FOOD_BIOME_POI, { dimension: 'overworld' })) {
    if (failed.some(f => Math.hypot(f.x - p.x, f.z - p.z) <= FAILED_LAND_RADIUS)) continue
    if (away != null && Math.hypot(away.x - p.x, away.z - p.z) <= FED_RADIUS) continue
    if (!only(p)) continue
    const d = Math.hypot(p.x - from.x, p.z - from.z)
    if (d > FOOD_TRIP_MAX || (best != null && d >= best.d)) continue
    best = { pos: new Vec3(p.x, p.y, p.z), biome: p.note ?? '?', d }
  }
  return best == null ? null : { pos: best.pos, biome: best.biome }
}

/** the ring points about `center` (8 a ring) */
export function ringPoints (center: { x: number, z: number }, radius: number): Array<{ x: number, z: number }> {
  return DIRECTIONS.map(([dx, dz]) => ({ x: Math.round(center.x + dx * radius), z: Math.round(center.z + dz * radius) }))
}

/**
 * The seed's surface biomes on SEED_RINGS about `center`, ring by ring until one has a food biome, each noted
 * (BiomeSurvey.note); once a home (SEED_SURVEYED_POI). Resolves the points read.
 */
export async function surveySeed (biomes: SeedBiomes, survey: BiomeSurvey, memory: WorldMemory, center: { x: number, z: number }, signal?: AbortSignal): Promise<number> {
  let n = 0
  const read = async (x: number, z: number): Promise<ChunkSurface> => {
    throwIfAborted(signal)
    const key = `${x},${z}`
    let s = survey.seedReads.get(key)
    if (s == null) {
      const r = await biomes.surface(x, z)
      s = { x: r.x, y: r.y - 1, z: r.z, biome: r.biome }
      survey.seedReads.set(key, s)
      n++
    }
    survey.note(s)
    return s
  }
  for (const r of SEED_RINGS) {
    let found = false
    for (const p of ringPoints(center, r)) {
      if (!MEAT_BIOMES.has((await read(p.x, p.z)).biome)) continue
      // (wide: most of the reads about it food biomes too)
      let meat = 1
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (MEAT_BIOMES.has((await read(p.x + dx * SEED_PATCH_OFFSET, p.z + dz * SEED_PATCH_OFFSET)).biome)) meat++
      }
      if (meat >= 3) {
        survey.seedWide.push(p)
        found = true
      }
    }
    if (found) break
  }
  memory.addPoi(SEED_SURVEYED_POI, { x: Math.round(center.x), y: 0, z: Math.round(center.z) }, 'overworld')
  return n
}

/** the direction to scout first from `center`: downhill (the lowest of the chunks surveyed that way), not scouted yet */
export function scoutDirection (survey: BiomeSurvey, memory: WorldMemory, center: Vec3): number | null {
  const scouted = new Set(memory.getPois(FOOD_SCOUTED_POI, { dimension: 'overworld' })
    .filter(p => Math.hypot(p.x - center.x, p.z - center.z) <= FED_RADIUS)
    .map(p => Number(p.note)))
  let best: { i: number, y: number } | null = null
  for (let i = 0; i < DIRECTIONS.length; i++) {
    if (scouted.has(i)) continue
    const y = survey.heightToward(center, i) ?? center.y
    if (best == null || y < best.y) best = { i, y }
  }
  return best?.i ?? null
}

export interface FoodLandArgs {
  /** the executor's (Executor.biomes) */
  survey: BiomeSurvey
  memory: WorldMemory
  /** where the food work would be done from now (the runner's home) */
  home: Vec3 | null
  /** the misses in a row of a food lately (Sightings.misses) */
  misses: (name: string) => number
  /** the land's misses forgotten: on new land (Sightings.forget, the explorations' progress) */
  forgetLand: () => void
  /** the world's seed (the seed's biomes read when the survey knows of no food land) */
  seed?: Seed
  log?: (line: string) => void
  /**
   * the food work's tries in a row about home that got no food (the runner's): FOOD_LAND_DRY_TRIES of them leave the
   * land as one whose animals weren't found
   */
  dryTries?: number
  /** the trips (default the travel skill's) */
  travel?: (target: Vec3, onHop?: () => boolean) => Promise<void>
  /** the seed's biomes (default openSeedBiomes: the minecraft-java-worldgen package's) */
  openSeed?: (seed: Seed, version: string) => Promise<SeedBiomes | null>
}

/**
 * Goes to food land when the land about home has none (no food biome among the chunks surveyed about it) or its
 * animals were hunted for and none found (LAND_ANIMALS each missed): to the nearest food biome noted, else read from
 * the seed, else scouted for (a walk out downhill, surveying as it goes), and notes it the food land. Resolves the food
 * land gone to, or null when the land about home will do (or no food land was found).
 */
export async function seekFoodLand (bot: Bot, args: FoodLandArgs, signal?: AbortSignal): Promise<Vec3 | null> {
  if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return null
  const { survey, memory } = args
  const log = args.log ?? (() => {})
  const go = args.travel ?? (async (target: Vec3, onHop?: () => boolean): Promise<void> => {
    await travel(bot, { target, range: 8, onHop }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('foodLand: the trip to', target.toString(), (err as Error).message)
    })
  })
  // (again while a trip gets the bot nearer: one from the bottom of the night's mine on seed 31337 ended 40 ticks in)
  const goNear = async (to: Vec3): Promise<void> => {
    for (let i = 0; i < FOOD_TRIP_TRIES; i++) {
      const from = bot.entity.position.clone()
      await go(to)
      const left = Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z)
      trace('foodLand: the trip', i + 1, 'ended', Math.round(left), 'blocks from the food land')
      if (left <= FED_RADIUS / 2 || bot.entity.position.distanceTo(from) < 8) break
    }
  }
  survey.survey()
  const center = args.home ?? bot.entity.position.floored()
  const barren = landBarren(survey, center)
  const hunted = LAND_ANIMALS.every(m => args.misses(m) > 0) || (args.dryTries ?? 0) >= FOOD_LAND_DRY_TRIES
  if (barren !== true && !hunted) {
    // the food land far off (the bot respawned at the world's spawn, or back from a trip): there by travel's hops
    // first, not by the explorations' first leg, a pathfinder's walk of 230 blocks over seed 31337's peaks that went
    // the other way (hunt2-c)
    const land = foodLandOf(memory)
    if (land != null && land.equals(center) && Math.hypot(land.x - bot.entity.position.x, land.z - bot.entity.position.z) > FED_RADIUS) {
      log(`to the food land at ${land.x} ${land.z} (${Math.round(Math.hypot(land.x - bot.entity.position.x, land.z - bot.entity.position.z))} blocks)`)
      await goNear(land)
      return land
    }
    return null
  }
  // the land left: not gone back to for food a while (a food land's own animals not found)
  if (hunted) {
    const land = foodLandOf(memory)
    if (land != null && Math.hypot(land.x - center.x, land.z - center.z) <= FED_RADIUS) memory.removePoi(FOOD_LAND_POI, land, 'overworld')
    if (memory.getPois(FOOD_LAND_FAILED_POI, { dimension: 'overworld' }).every(f => Math.hypot(f.x - center.x, f.z - center.z) > FED_RADIUS)) memory.addPoi(FOOD_LAND_FAILED_POI, center, 'overworld')
  }
  const why = barren === true ? 'no food biome about home' : LAND_ANIMALS.every(m => args.misses(m) > 0) ? `no ${LAND_ANIMALS.join(', ')} found about ${center.toString()}` : `no food got about ${center.toString()} in ${args.dryTries ?? 0} tries`
  // a wide food land first (FOOD_PATCH_CHUNKS), the seed's read for one, then a narrow one, then a scouting
  const wide = (p: { x: number, z: number }): boolean => survey.wide(p)
  let dest = nearestFoodBiome(memory, bot.entity.position, center, wide)
  // scouted for: out downhill, the chunks surveyed after each hop, until `enough`; false with no direction left
  // (the scouting under way taken up again after a preemption, not the next direction: a 26.3 bot's fights at night
  // had it start all 8 of seed 31337's directions within 4000 ticks, none walked, hunt2-e)
  const scout = async (enough: () => boolean): Promise<boolean> => {
    const under = survey.scouting
    const i = under != null && Math.hypot(under.center.x - center.x, under.center.z - center.z) <= FED_RADIUS ? under.i : scoutDirection(survey, memory, center)
    if (i == null) return false
    survey.scouting = { center: { x: center.x, z: center.z }, i }
    const [dx, dz] = DIRECTIONS[i]
    const target = new Vec3(Math.round(center.x + dx * SCOUT_DISTANCE), center.y, Math.round(center.z + dz * SCOUT_DISTANCE))
    if (under?.i !== i) log(`${why}: scouting for food land toward ${target.x} ${target.z}`)
    await go(target, () => {
      survey.survey()
      return enough()
    })
    survey.scouting = null
    memory.addPoi(FOOD_SCOUTED_POI, center.offset(i, 0, 0), 'overworld', String(i))
    survey.survey()
    return true
  }
  // the seed's biomes, once a home, read in the background (some 2.4 s of the worker's a read, 20 to 40 reads: 15000
  // ticks of a lockstep server's while the bot stood, seed 31337), the bot scouting downhill meanwhile
  const seed = args.seed
  if (dest == null && seed != null && !memory.getPois(SEED_SURVEYED_POI, { dimension: 'overworld' }).some(p => Math.hypot(p.x - center.x, p.z - center.z) <= FED_RADIUS)) {
    const reads = survey.readSeed(center, async () => await (args.openSeed ?? openSeedBiomes)(seed, bot.version))
    const read = (): boolean => survey.seedRead(center)
    if (!read()) await scout(() => read() || nearestFoodBiome(memory, bot.entity.position, center, wide) != null)
    await untilDone(reads, signal)
    dest = nearestFoodBiome(memory, bot.entity.position, center, wide)
  }
  dest ??= nearestFoodBiome(memory, bot.entity.position, center)
  for (let tries = 0; dest == null && tries < SCOUT_DIRECTIONS; tries++) {
    if (!await scout(() => nearestFoodBiome(memory, bot.entity.position, center) != null)) break
    dest = nearestFoodBiome(memory, bot.entity.position, center)
  }
  if (dest == null) {
    log(`${why}: no food land found`)
    return null
  }
  log(`${why}: to the ${dest.biome} at ${dest.pos.x} ${dest.pos.z} for food (${Math.round(Math.hypot(dest.pos.x - bot.entity.position.x, dest.pos.z - bot.entity.position.z))} blocks)`)
  // (noted before the trip: one cut off (a night's shelter, its ticks out) leaves the food work's explorations going
  // out about it, not home: a 26.3 bot's trip to a snowy taiga 120 blocks off over seed 31337's peaks ran out of its
  // ticks with the night, and its meal explored for cows about home again)
  for (const p of memory.getPois(FOOD_LAND_POI, { dimension: 'overworld' })) memory.removePoi(FOOD_LAND_POI, p, 'overworld')
  memory.addPoi(FOOD_LAND_POI, dest.pos, 'overworld', dest.biome)
  args.forgetLand()
  await goNear(dest.pos)
  return dest.pos
}
