// The exploring for cane along the shores: the river, beach and swamp chunks the biome survey noted, and the land by a
// lake's or the sea's water (or the seed's reads), the nearest not looked at first, the canes in sight noted at each.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { BiomeSurvey } from '../../src/executor/foodLand'
import { CANE_LOOKED_POI, CANE_SEED_SURVEYED_POI, SHORE_POI, exploreCaneShores, nextCaneShore, readShoresFromSeed } from '../../src/executor/caneShores'
import { fakeBot } from '../reflexes/fakeBot'

function surveyOf (memory: WorldMemory, chunks: Array<[number, number, string]>): BiomeSurvey {
  const survey = new BiomeSurvey(fakeBot() as any, memory)
  for (const [x, z, biome] of chunks) survey.note({ x, z, y: 62, biome })
  return survey
}

test('nextCaneShore: the nearest river, beach or swamp chunk within range of home, none by a spot looked at', () => {
  const memory = new WorldMemory()
  const survey = surveyOf(memory, [[200, 0, 'plains'], [100, 8, 'river'], [-120, 0, 'beach'], [40, 40, 'forest'], [0, 600, 'swamp']])
  const home = { x: 0, z: 0 }
  assert.equal(nextCaneShore(memory, home, home)?.what, 'river')
  // from the west, the beach
  assert.equal(nextCaneShore(memory, home, { x: -100, z: 0 })?.what, 'beach')
  // the river looked at: the beach; both: none (the swamp past CANE_SHORE_RANGE)
  memory.addPoi(CANE_LOOKED_POI, { x: 110, y: 64, z: 0 })
  assert.equal(nextCaneShore(memory, home, home)?.what, 'beach')
  memory.addPoi(CANE_LOOKED_POI, { x: -120, y: 64, z: 0 })
  assert.equal(nextCaneShore(memory, home, home), null)
})

test('readShoresFromSeed: ring by ring until one has a shore, each read noted; the home marked read', async () => {
  const memory = new WorldMemory()
  const survey = surveyOf(memory, [])
  const reads: Array<[number, number]> = []
  // a river beyond 100 blocks east
  const biomes: any = { surface: async (x: number, z: number) => { reads.push([x, z]); return { x, z, y: 64, biome: x > 100 ? 'river' : 'plains' } }, dispose: async () => {} }
  const n = await readShoresFromSeed(biomes, survey, memory, { x: 0, z: 0 })
  // the 64 ring's 8 and the 128 ring's 12: the river's on the second
  assert.equal(n, 20)
  assert.equal(reads.length, 20)
  assert.ok([...survey.chunks.values()].some(s => s.biome === 'river'))
  assert.equal(memory.getPois(CANE_SEED_SURVEYED_POI).length, 1)
  assert.equal(nextCaneShore(memory, { x: 0, z: 0 }, { x: 0, z: 0 })?.what, 'river')
})

/** a bot whose trips put it where they went, with a cane column at `cane` (x, z) on the grass at y 63 */
function walker (cane: Vec3 | null): { bot: any, trips: Vec3[] } {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: p => cane != null && p.x === cane.x && p.z === cane.z && p.y >= 63 && p.y <= 64 ? 'sugar_cane' : p.y > 62 ? 'air' : 'grass_block' })
  bot.game.dimension = 'overworld'
  // the loaded chunks: 96 blocks round the bot
  bot.findBlocks = (opts: any) => cane != null && cane.distanceTo(bot.entity.position) <= (opts.maxDistance ?? 16) ? [cane.offset(0, 1, 0), cane] : []
  const trips: Vec3[] = []
  return { bot, trips }
}

test('exploreCaneShores: to the nearest shore, then the next; the canes seen there noted and walked to', async () => {
  const memory = new WorldMemory()
  const survey = surveyOf(memory, [[150, 0, 'river'], [0, -300, 'swamp']])
  const { bot, trips } = walker(new Vec3(-10, 63, -380))
  const near = (): boolean => bot.entity.position.distanceTo(new Vec3(-10, 64, -380)) <= 8
  const found = await exploreCaneShores(bot, {
    survey,
    memory,
    home: new Vec3(0, 64, 0),
    found: near,
    travel: async (to: Vec3) => { trips.push(to); bot.entity.position = to.offset(0.5, 1, 0.5) }
  })
  assert.equal(found, true)
  // the river (nearest), the swamp, then the cane seen from it (80 off)
  assert.deepEqual(trips.map(t => `${t.x},${t.z}`), ['150,0', '0,-300', '-10,-380'])
  assert.equal(memory.findBlocks('sugar_cane').length, 1)
  assert.ok(memory.getPois(CANE_LOOKED_POI).length >= 3)
})

test('exploreCaneShores: no shore surveyed, the seed\'s biomes read for one; none there, false', async () => {
  for (const river of [true, false]) {
    const memory = new WorldMemory()
    const survey = surveyOf(memory, [])
    const { bot, trips } = walker(null)
    let opened = 0
    const found = await exploreCaneShores(bot, {
      survey,
      memory,
      home: new Vec3(0, 64, 0),
      found: () => false,
      seed: '42',
      openSeed: async () => { opened++; return { surface: async (x: number, z: number) => ({ x, z, y: 64, biome: river && z < -100 ? 'river' : 'plains' }), dispose: async () => {} } },
      travel: async (to: Vec3) => { trips.push(to); bot.entity.position = to.offset(0.5, 1, 0.5) }
    })
    assert.equal(found, false)
    // the seed read once (the home marked), and the river's points gone to when there is one
    assert.equal(opened, 1)
    assert.ok(river ? trips.length > 0 && trips.every(t => t.z < -100) : trips.length === 0, trips.map(t => t.toString()).join(' '))
  }
})

test('the survey notes the shores in the memory: a shore biome\'s chunk, and the land chunk beside a water chunk (a lake in the plains); none inland', () => {
  const memory = new WorldMemory()
  const survey = new BiomeSurvey(fakeBot() as any, memory)
  const chunk = (cx: number, cz: number, biome: string, water: boolean): any => ({ x: cx * 16 + 8, z: cz * 16 + 8, y: water ? 62 : 64, biome, water })
  // plains all about, a lake in chunk (2, 0); a river chunk far off
  for (let cx = 0; cx < 4; cx++) for (let cz = -1; cz <= 1; cz++) survey.note(chunk(cx, cz, 'plains', cx === 2 && cz === 0))
  survey.note(chunk(20, 0, 'river', true))
  const shores = memory.getPois(SHORE_POI)
  assert.ok(shores.some(p => p.note === 'river' && p.x === 20 * 16 + 8))
  // the lake's shore: a land chunk beside it (the lake's own chunk not one), SHORE_SPACING apart
  const lake = shores.filter(p => p.note === 'water')
  assert.ok(lake.length >= 1)
  assert.ok(lake.every(p => Math.hypot(p.x - (2 * 16 + 8), p.z - 8) === 16), lake.map(p => `${p.x},${p.z}`).join(' '))
  // no water, no shore
  const dry = new WorldMemory()
  const s2 = new BiomeSurvey(fakeBot() as any, dry)
  for (let cx = 0; cx < 4; cx++) s2.note(chunk(cx, 0, 'plains', false))
  assert.equal(dry.getPois(SHORE_POI).length, 0)
})

test('readShoresFromSeed: a lake on the ring by a point of land, that land noted a shore, the reads stopped there (f3-1.21.11: the lakes of the plains)', async () => {
  const memory = new WorldMemory()
  const survey = surveyOf(memory, [])
  // plains all about, a lake west of home (x < -50, |z| < 30) on the first ring
  const biomes: any = { surface: async (x: number, z: number) => ({ x, z, y: 64, biome: 'plains', water: x < -50 && Math.abs(z) < 30 }), dispose: async () => {} }
  const n = await readShoresFromSeed(biomes, survey, memory, { x: 0, z: 0 })
  assert.equal(n, 8)
  const shores = memory.getPois(SHORE_POI)
  assert.ok(shores.length >= 1 && shores.every(p => p.note === 'water' && p.x < 0), shores.map(p => `${p.x},${p.z}`).join(' '))
  assert.equal(nextCaneShore(memory, { x: 0, z: 0 }, { x: 0, z: 0 })?.what, 'water')
})

test('exploreCaneShores: a trip cut off by a reflex (its abort) leaves the shore not looked at, the same one next time; noted after CANE_SHORE_CUTOFFS cut-offs, or once reached (f6-1.21.11, t178981 to t179158: a bear\'s fight cut the trips off, each shore noted before it, out to 449 blocks)', async () => {
  const { CANE_SHORE_CUTOFFS } = await import('../../src/executor/caneShores')
  const memory = new WorldMemory()
  const survey = surveyOf(memory, [[150, 0, 'river'], [0, -300, 'swamp']])
  const { bot } = walker(null)
  const home = new Vec3(0, 64, 0)
  const abort = (): Error => Object.assign(new Error('preempted'), { name: 'AbortError', code: 'ABORTED' })
  let trips = 0
  const cutOff = async (): Promise<void> => { trips++; throw abort() }
  for (let i = 1; i < CANE_SHORE_CUTOFFS; i++) {
    await assert.rejects(exploreCaneShores(bot, { survey, memory, home, found: () => false, travel: cutOff }))
    // still the river next
    assert.equal(nextCaneShore(memory, home, bot.entity.position)?.what, 'river', `after ${i} cut-offs`)
  }
  await assert.rejects(exploreCaneShores(bot, { survey, memory, home, found: () => false, travel: cutOff }))
  assert.equal(nextCaneShore(memory, home, bot.entity.position)?.what, 'swamp')
  assert.equal(trips, CANE_SHORE_CUTOFFS)
  // a trip that gets there: noted, the next shore after it
  const m2 = new WorldMemory()
  const s2 = surveyOf(m2, [[150, 0, 'river'], [0, -300, 'swamp']])
  const w2 = walker(null)
  const seen: string[] = []
  await exploreCaneShores(w2.bot, { survey: s2, memory: m2, home, found: () => false, travel: async (to: Vec3) => { seen.push(`${to.x},${to.z}`); w2.bot.entity.position = to.offset(0.5, 1, 0.5) } })
  assert.deepEqual(seen, ['150,0', '0,-300'])
})
