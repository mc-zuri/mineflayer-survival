// Food land: the loaded chunks' surface biomes surveyed, the food biomes noted, and the trip to one from a home whose
// land has none (seed 31337's snowy peaks: a grove's, the snowy slopes', the peaks' chunks only), or whose animals the
// hunts found none of.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import {
  BiomeSurvey, FAILED_LAND_RADIUS, FOOD_BIOME_POI, FOOD_LAND_FAILED_POI, FOOD_LAND_POI, MEAT_BIOMES, MIN_SURVEYED, SEED_RINGS, foodLandOf,
  landBarren, nearestFoodBiome, scoutDirection, seekFoodLand, surfaceAt, surveySeed
} from '../../src/executor/foodLand'
import { VERSIONS } from '../versions'

/* eslint-disable @typescript-eslint/no-var-requires */
const registryOf = (v: string): any => require('minecraft-data')(v)

type Land = (x: number, z: number) => { biome: string, y: number }

/** a bot whose loaded chunks are those within `view` chunks of it, their columns of snow (or grass) to `land`'s y */
function fakeBot (version: string, land: Land, view = 6): any {
  const registry = registryOf(version)
  const bot: any = { registry, version, game: { dimension: 'overworld', minY: -64, height: 384 }, entity: { position: new Vec3(0, 100, 0) } }
  const column = (cx: number, cz: number): any => ({
    getBlockStateId: (p: Vec3) => {
      const { y, biome } = land(cx * 16 + p.x, cz * 16 + p.z)
      if (p.y > y) return 0
      return registry.blocksByName[MEAT_BIOMES.has(biome) ? 'grass_block' : 'snow_block'].defaultState
    },
    getBiome: (p: Vec3) => registry.biomesByName[land(cx * 16 + p.x, cz * 16 + p.z).biome].id
  })
  const loaded = (cx: number, cz: number): boolean => {
    const bx = Math.floor(bot.entity.position.x / 16)
    const bz = Math.floor(bot.entity.position.z / 16)
    return Math.abs(cx - bx) <= view && Math.abs(cz - bz) <= view
  }
  bot.world = {
    getColumnAt: (p: Vec3) => { const cx = Math.floor(p.x / 16); const cz = Math.floor(p.z / 16); return loaded(cx, cz) ? column(cx, cz) : undefined },
    getColumns: () => {
      const out: any[] = []
      const bx = Math.floor(bot.entity.position.x / 16)
      const bz = Math.floor(bot.entity.position.z / 16)
      for (let cx = bx - view; cx <= bx + view; cx++) for (let cz = bz - view; cz <= bz + view; cz++) out.push({ chunkX: String(cx), chunkZ: String(cz), column: column(cx, cz) })
      return out
    }
  }
  return bot
}

/** seed 31337 in small: grove about home, up to the east (x 0 to 150) at y 120 and over, a snowy taiga down at 70 past x 200 */
const peaks: Land = (x, z) => x > 200 ? { biome: 'snowy_taiga', y: 70 } : x < -60 ? { biome: 'snowy_slopes', y: 140 - Math.min(0, z) * 0 } : { biome: 'grove', y: 120 - Math.max(0, x) / 10 }

for (const version of VERSIONS) {
  test(`${version}: surfaceAt reads a loaded column's top block and the chunk data's biome there; null out of the loaded chunks`, () => {
    const bot = fakeBot(version, (x) => x > 40 ? { biome: 'plains', y: 64 } : { biome: 'grove', y: 110 })
    assert.deepEqual(surfaceAt(bot, 8, 8), { x: 8, z: 8, y: 110, biome: 'grove' })
    assert.deepEqual(surfaceAt(bot, 72, -8), { x: 72, z: -8, y: 64, biome: 'plains' })
    assert.equal(surfaceAt(bot, 500, 0), null)
  })
}

test('the survey: each loaded chunk once, its food biome noted in the memory no nearer than FOOD_BIOME_SPACING; the land about home barren or not', () => {
  const bot = fakeBot('26.3', (x) => x > 40 ? { biome: 'plains', y: 64 } : { biome: 'grove', y: 110 })
  const memory = new WorldMemory()
  const survey = new BiomeSurvey(bot, memory)
  assert.equal(survey.survey(), 13 * 13)
  assert.equal(survey.survey(), 0)
  const noted = memory.getPois(FOOD_BIOME_POI)
  assert.ok(noted.length > 0 && noted.every(p => p.x > 40 && p.note === 'plains'))
  for (const a of noted) for (const b of noted) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 32)
  // plains 48 blocks east: fed; the grove 60 west of home has none within FED_RADIUS
  assert.equal(landBarren(survey, { x: 0, z: 0 }), false)
  assert.equal(landBarren(survey, { x: -60, z: 0 }), true)
  // too few chunks surveyed about a place to say
  assert.equal(landBarren(survey, { x: -400, z: 0 }), null)
  assert.ok(MIN_SURVEYED > 1)
})

test('nearestFoodBiome: the nearest noted, none by a land whose animals were not found nor by the land left', () => {
  const memory = new WorldMemory()
  memory.addPoi(FOOD_BIOME_POI, { x: 100, y: 70, z: 0 }, 'overworld', 'taiga')
  memory.addPoi(FOOD_BIOME_POI, { x: -200, y: 70, z: 0 }, 'overworld', 'plains')
  assert.equal(nearestFoodBiome(memory, { x: 0, z: 0 })?.biome, 'taiga')
  assert.equal(nearestFoodBiome(memory, { x: 0, z: 0 }, { x: 90, z: 10 })?.biome, 'plains')
  memory.addPoi(FOOD_LAND_FAILED_POI, { x: 150, y: 70, z: 60 })
  assert.equal(nearestFoodBiome(memory, { x: 0, z: 0 })?.biome, 'plains')
  assert.equal(nearestFoodBiome(memory, { x: 1000, z: 0 }), null, 'past FOOD_TRIP_MAX')
})

test('scoutDirection: downhill first, a direction scouted from home not again', () => {
  const bot = fakeBot('26.3', peaks)
  const memory = new WorldMemory()
  const survey = new BiomeSurvey(bot, memory)
  survey.survey()
  // the grove slopes down to the east (x / 10), the snowy slopes up west at 140
  assert.equal(scoutDirection(survey, memory, new Vec3(0, 120, 0)), 0)
  memory.addPoi('food_scouted', { x: 0, y: 120, z: 0 }, 'overworld', '0')
  const next = scoutDirection(survey, memory, new Vec3(0, 120, 0))
  assert.ok(next === 1 || next === 7, String(next))
})

test('seekFoodLand: a home of grove scouts downhill east, sees the snowy taiga, goes there, notes it the food land, the land\'s misses forgotten', async () => {
  const bot = fakeBot('26.3', peaks)
  const memory = new WorldMemory()
  const survey = new BiomeSurvey(bot, memory)
  const trips: string[] = []
  let forgot = 0
  const lines: string[] = []
  const land = await seekFoodLand(bot, {
    survey,
    memory,
    home: new Vec3(0, 120, 0),
    misses: () => 0,
    forgetLand: () => { forgot++ },
    log: l => lines.push(l),
    // the walk: the bot moved along in hops of 48, onHop ending it
    travel: async (target, onHop) => {
      trips.push(`${target.x} ${target.z}`)
      const from = bot.entity.position.clone()
      const d = Math.hypot(target.x - from.x, target.z - from.z)
      for (let s = Math.min(48, d); ; s = Math.min(s + 48, d)) {
        bot.entity.position = new Vec3(from.x + (target.x - from.x) * s / d, 100, from.z + (target.z - from.z) * s / d)
        if (s >= d || onHop?.() === true) break
      }
    }
  })
  assert.ok(land != null, lines.join(' | '))
  assert.ok(land.x > 200, land.toString())
  assert.equal(trips[0], '320 0', 'scouted east, downhill')
  assert.equal(trips.length, 2, 'then to the taiga seen')
  assert.ok(foodLandOf(memory)?.equals(land))
  assert.equal(memory.getPois(FOOD_LAND_POI)[0].note, 'snowy_taiga')
  assert.equal(forgot, 1)
  assert.ok(lines.some(l => /no food biome about home: scouting/.test(l)), lines.join(' | '))
  // there: the land's fed, nothing more to do
  assert.equal(await seekFoodLand(bot, { survey, memory, home: land, misses: () => 0, forgetLand: () => {}, travel: async () => { throw new Error('no trip') } }), null)
})

test('seekFoodLand: fed land stays; its animals hunted for and none found, the nearest other food biome, the land left marked', async () => {
  const bot = fakeBot('26.3', () => ({ biome: 'plains', y: 64 }))
  const memory = new WorldMemory()
  const survey = new BiomeSurvey(bot, memory)
  const go = async (target: Vec3): Promise<void> => { bot.entity.position = target.clone() }
  assert.equal(await seekFoodLand(bot, { survey, memory, home: new Vec3(0, 64, 0), misses: () => 0, forgetLand: () => {}, travel: go }), null)
  memory.addPoi(FOOD_BIOME_POI, { x: 300, y: 64, z: 0 }, 'overworld', 'plains')
  const land = await seekFoodLand(bot, { survey, memory, home: new Vec3(0, 64, 0), misses: m => m === 'rabbit' ? 0 : 1, forgetLand: () => {}, travel: go })
  // (the plains noted about home itself are its hunted-out land's)
  assert.ok(land != null && Math.hypot(land.x, land.z) > FAILED_LAND_RADIUS, String(land))
  assert.equal(memory.getPois(FOOD_LAND_FAILED_POI).length, 1)
})

test('seekFoodLand with the seed: the rings read about home until one has a food biome, gone to; the reads not made again', async () => {
  // all grove in the loaded chunks; the seed's land has taiga 224 north
  const bot = fakeBot('26.3', () => ({ biome: 'grove', y: 120 }))
  const memory = new WorldMemory()
  const survey = new BiomeSurvey(bot, memory)
  const reads: string[] = []
  const seedLand = { surface: async (x: number, z: number) => { reads.push(`${x} ${z}`); return { x, z, y: 80, biome: z <= -200 && Math.abs(x) < 60 ? 'taiga' : 'grove' } }, dispose: async () => {} }
  const go = async (target: Vec3): Promise<void> => { bot.entity.position = target.clone() }
  const land = await seekFoodLand(bot, { survey, memory, home: new Vec3(0, 120, 0), misses: () => 0, forgetLand: () => {}, travel: go, seed: '31337', openSeed: async () => seedLand })
  assert.ok(land != null && land.z === -SEED_RINGS[1] && land.x === 0, String(land))
  assert.equal(reads.length, 20, 'two rings of 8, and the 4 about the taiga read (wide: 3 of the 4 taiga too)')
  // read once: a survey run again (a reflex's preemption) reads nothing again
  assert.equal(await surveySeed(seedLand, survey, memory, { x: 0, z: 0 }), 0)
  assert.equal(reads.length, 20)
})

test('seekFoodLand notes the food land before the trip there: one cut off still has the food work go out about it', async () => {
  const bot = fakeBot('1.21.11', () => ({ biome: 'grove', y: 120 }))
  const memory = new WorldMemory()
  memory.addPoi(FOOD_BIOME_POI, { x: -200, y: 80, z: 0 }, 'overworld', 'snowy_taiga')
  const survey = new BiomeSurvey(bot, memory)
  let noted: Vec3 | null = null
  const land = await seekFoodLand(bot, { survey, memory, home: new Vec3(0, 120, 0), misses: () => 0, forgetLand: () => {}, travel: async () => { noted = foodLandOf(memory); throw new Error('cut off') } }).catch(() => null)
  assert.equal(land, null)
  assert.ok(noted != null && (noted as Vec3).x === -200, String(noted))
  assert.ok(foodLandOf(memory)?.x === -200)
})

test('seekFoodLand walks again while a trip that ended short got the bot nearer, and stops when one got it nowhere', async () => {
  for (const step of [30, 0]) {
    const bot = fakeBot('26.3', () => ({ biome: 'grove', y: 120 }))
    const memory = new WorldMemory()
    memory.addPoi(FOOD_BIOME_POI, { x: -200, y: 80, z: 0 }, 'overworld', 'snowy_taiga')
    let trips = 0
    const go = async (): Promise<void> => { trips++; bot.entity.position = bot.entity.position.offset(-step, 0, 0) }
    await seekFoodLand(bot, { survey: new BiomeSurvey(bot, memory), memory, home: new Vec3(0, 120, 0), misses: () => 0, forgetLand: () => {}, travel: go })
    // 30 a walk: 4 walks (to x -120, 160 blocks short of 40 of it, the tries' end); none: 1
    assert.equal(trips, step > 0 ? 4 : 1)
  }
})

test('seekFoodLand goes to a wide food land (FOOD_PATCH_CHUNKS surveyed about it) over a nearer patch of a few chunks; the patch when none is wide', async () => {
  // a snowy taiga patch of 4 chunks 110 west, plains wide 300 east
  const land: Land = (x, z) => x > 280 ? { biome: 'plains', y: 64 } : (x > -130 && x < -90 && z > -16 && z < 16) ? { biome: 'snowy_taiga', y: 90 } : { biome: 'grove', y: 120 }
  for (const plains of [true, false]) {
    const bot = fakeBot('26.3', land, 30)
    const memory = new WorldMemory()
    const survey = new BiomeSurvey(bot, memory)
    survey.survey(4000)
    if (!plains) for (const p of memory.getPois(FOOD_BIOME_POI)) if (p.x > 200) memory.removePoi(FOOD_BIOME_POI, p)
    const to = await seekFoodLand(bot, { survey, memory, home: new Vec3(0, 120, 0), misses: () => 0, forgetLand: () => {}, travel: async (t) => { bot.entity.position = t.clone() } })
    assert.ok(to != null)
    assert.ok(plains ? to.x > 280 : to.x < -90, `${String(plains)}: ${to.toString()}`)
  }
})
