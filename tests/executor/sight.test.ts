import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Sightings, GIVE_UP_FACTOR, GIVE_UP_TICKS, MISS_STREAK_TICKS, SCARCE_FACTOR, SCARCE_TICKS } from '../../src/executor/sight'
import { obtainAll } from '../../src/planner/obtain'
import { FOOD_GOAL, FOOD_POINTS } from '../../src/planner/progression'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

/** a bot standing at the origin among `mobs`, with `blocks` (name and age) in its loaded chunks */
function fakeBot (mobs: Array<{ name: string, at: Vec3 }>, blocks: Array<{ name: string, at: Vec3, age?: number }> = []): any {
  const bot: any = { registry, game: { dimension: 'overworld' }, entity: { id: 0, position: new Vec3(0, 64, 0) } }
  bot.entities = { 0: bot.entity }
  mobs.forEach((m, i) => { bot.entities[i + 1] = { id: i + 1, name: m.name, position: m.at, metadata: [] } })
  const blockAt = (p: Vec3): any => {
    const b = blocks.find(b => b.at.equals(p.floored()))
    return b == null ? null : { name: b.name, position: b.at, getProperties: () => (b.age == null ? {} : { age: b.age }) }
  }
  bot.blockAt = blockAt
  bot.findBlocks = ({ matching }: { matching: number[] }) => blocks
    .filter(b => matching.includes(registry.blocksByName[b.name].id))
    .map(b => b.at)
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  return bot
}

test('sightings: an animal in sight is a walk away, one not found lately is dear, a bush counts once ripe', () => {
  let now = 1000
  const bot = fakeBot([{ name: 'pig', at: new Vec3(10, 64, 0) }], [
    { name: 'sweet_berry_bush', at: new Vec3(4, 64, 0), age: 1 },
    { name: 'sweet_berry_bush', at: new Vec3(0, 64, 8), age: 3 }
  ])
  const s = new Sightings(bot, () => now)
  const mob = (name: string): any => ({ name, kind: 'mob', dimension: 'overworld', find: 400 })
  assert.equal(s.cost(mob('pig')), 50)
  assert.equal(s.cost(mob('cow')), undefined)
  s.missing(['cow', 'pig'])
  assert.equal(s.cost(mob('cow')), 400 * SCARCE_FACTOR)
  // the pig is in sight all the same
  assert.equal(s.cost(mob('pig')), 50)
  now += SCARCE_TICKS
  assert.equal(s.cost(mob('cow')), undefined)
  // the unripe bush at 4 blocks is passed over for the ripe one at 8
  const bush = s.cost({ name: 'sweet_berry_bush', kind: 'block', dimension: 'overworld', find: 4000 })
  assert.ok(bush != null && bush > 35 && bush < 50, String(bush))
  // the stone and ores go by the memory, not the chunks
  assert.equal(s.cost({ name: 'stone', kind: 'block', dimension: 'overworld', find: 40 }), undefined)
  // another dimension's sources aren't the bot's to see
  assert.equal(s.cost({ name: 'blaze', kind: 'mob', dimension: 'the_nether', find: 8000 }), undefined)
})

test('the food plan goes by the sightings: the pigs in sight over cows, berries once no animal was found', () => {
  const kit = { crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1 }
  const goal = [{ item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' as const }]
  const bushes: any[] = []
  const bot = fakeBot([{ name: 'pig', at: new Vec3(12, 64, 0) }], bushes)
  let now = 0
  const s = new Sightings(bot, () => now)
  const plan = (): string[] => obtainAll(registry, goal, { inventory: kit, findCost: t => s.cost(t) }).steps.map(st => st.kind === 'kill' ? `kill ${st.mob}` : `${st.kind} ${st.item}`)
  assert.ok(plan().includes('kill pig'), plan().join(', '))
  // the pigs ran off and the hunt found no meat animal, and found berry bushes on the way: the berries
  delete bot.entities[1]
  s.missing(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
  bushes.push({ name: 'sweet_berry_bush', at: new Vec3(30, 64, 0), age: 3 })
  assert.deepEqual(plan(), ['mine sweet_berries'])
  // half a day on, the bushes picked: the hunt again
  now += SCARCE_TICKS
  bushes.length = 0
  assert.ok(plan().some(st => st.startsWith('kill')), plan().join(', '))
})

test('sightings: a source missed twice in a row is given up on for a day (the last resort); a miss a day apart starts the count again', () => {
  let now = 0
  const bot = fakeBot([])
  const s = new Sightings(bot, () => now)
  const melon = { name: 'carrots', kind: 'block' as const, dimension: 'overworld' as const, find: 4000 }
  s.missing(['carrots'])
  assert.equal(s.cost(melon), 4000 * SCARCE_FACTOR)
  now += SCARCE_TICKS
  assert.equal(s.cost(melon), undefined)
  // explored for again, half a day after: none again
  s.missing(['carrots'])
  assert.equal(s.cost(melon), 4000 * GIVE_UP_FACTOR)
  assert.ok(s.givenUp('carrots') && s.isScarce('carrots'))
  now += SCARCE_TICKS
  assert.equal(s.cost(melon), 4000 * GIVE_UP_FACTOR)
  now += GIVE_UP_TICKS - SCARCE_TICKS
  assert.equal(s.cost(melon), undefined)
  // a miss three days and more after the last: one miss again
  now += MISS_STREAK_TICKS
  s.missing(['carrots'])
  assert.equal(s.cost(melon), 4000 * SCARCE_FACTOR)
  assert.equal(s.misses('carrots'), 1)
  // and a day and a half later another: two in a row, given up on
  now += GIVE_UP_TICKS * 1.5
  assert.equal(s.misses('carrots'), 1)
  s.missing(['carrots'])
  assert.equal(s.misses('carrots'), 2)
  assert.equal(s.cost(melon), 4000 * GIVE_UP_FACTOR)
})

test('sightings: a rare source (melons, berry bushes: of one biome) is given up on at its first miss', () => {
  let now = 0
  const s = new Sightings(fakeBot([]), () => now)
  const melon = { name: 'melon', kind: 'block' as const, dimension: 'overworld' as const, find: 16000 }
  s.missing(['melon', 'carrots'])
  assert.equal(s.cost(melon), 16000 * GIVE_UP_FACTOR)
  assert.equal(s.cost({ ...melon, name: 'carrots', find: 5000 }), 5000 * SCARCE_FACTOR)
  now += GIVE_UP_TICKS
  assert.equal(s.cost(melon), undefined)
})

test('the fish in the water are as dear as the water once none was found (WATER_MOBS); a fishing that found none makes them dear too', () => {
  let now = 0
  const bot = fakeBot([])
  const s = new Sightings(bot, () => now)
  const mob = (name: string): any => ({ name, kind: 'mob', dimension: 'overworld', find: 6000 })
  assert.equal(s.cost(mob('salmon')), undefined)
  s.missing(['water'])
  assert.equal(s.cost(mob('salmon')), 6000 * SCARCE_FACTOR)
  assert.equal(s.cost(mob('cod')), 6000 * SCARCE_FACTOR)
  // (not the land's animals)
  assert.equal(s.cost({ name: 'cow', kind: 'mob', dimension: 'overworld', find: 400 }), undefined)
  now += 100
  s.missing(['water'])
  assert.equal(s.cost(mob('salmon')), 6000 * GIVE_UP_FACTOR)
  now += GIVE_UP_TICKS
  assert.equal(s.cost(mob('salmon')), undefined)
})

test('a village\'s crops are NO_VILLAGE_FACTOR times dearer with no village noted near; with one, the source\'s estimate (full-26.3-s31337-h: \'mine 14 carrot\' explored for twice)', async () => {
  const { NO_VILLAGE_FACTOR } = await import('../../src/executor/sight')
  let village = false
  const s = new Sightings(fakeBot([]), () => 0, () => false, () => new Set(), () => village)
  const carrots = { name: 'carrots', kind: 'block' as const, dimension: 'overworld' as const, find: 5000 }
  assert.equal(s.cost(carrots), 5000 * NO_VILLAGE_FACTOR)
  assert.equal(s.cost({ ...carrots, name: 'hay_block' }), 5000 * NO_VILLAGE_FACTOR)
  // (not the land's own plants)
  assert.equal(s.cost({ ...carrots, name: 'sweet_berry_bush', find: 16000 }), undefined)
  village = true
  assert.equal(s.cost(carrots), undefined)
  // the food plan with the cows not near: the rabbits over a village's carrots somewhere
  village = false
  const bot = fakeBot([{ name: 'rabbit', at: new Vec3(20, 64, 0) }])
  const s2 = new Sightings(bot, () => 0, () => false, () => new Set(), () => village)
  s2.notNear(['cow', 'pig', 'sheep', 'chicken'])
  const kit = { crafting_table: 1, stone_pickaxe: 1, iron_sword: 1, furnace: 1, coal: 16 }
  const steps = obtainAll(registry, [{ item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' as const }], { inventory: kit, findCost: t => s2.cost(t), exclude: ['farm'] }).steps.map(st => `${st.kind} ${st.item}`)
  assert.ok(!steps.includes('mine carrot'), steps.join(', '))
})

test('kelp is NO_OCEAN_FACTOR times dearer with no ocean that grows it known near, as dear as the water once none was found, and given up at its first miss (rt-1: \'mine 10 kelp\' explored 166 blocks of a snowy spruce land)', async () => {
  const { NO_OCEAN_FACTOR, KELP_BLOCKS } = await import('../../src/executor/sight')
  let now = 0
  let ocean = false
  const kelpBlocks: any[] = []
  const s = new Sightings(fakeBot([], kelpBlocks), () => now, () => false, () => new Set(), () => true, () => ocean)
  for (const name of KELP_BLOCKS) {
    const kelp = { name, kind: 'block' as const, dimension: 'overworld' as const, find: 1000 }
    assert.equal(s.cost(kelp), 1000 * NO_OCEAN_FACTOR, name)
    ocean = true
    assert.equal(s.cost(kelp), undefined, name)
    ocean = false
  }
  // (not the land's own plants, nor a village's crops)
  assert.equal(s.cost({ name: 'sweet_berry_bush', kind: 'block', dimension: 'overworld', find: 16000 }), undefined)
  assert.equal(s.cost({ name: 'carrots', kind: 'block', dimension: 'overworld', find: 5000 }), undefined)
  // kelp in sight is a walk away, the sea or not
  kelpBlocks.push({ name: 'kelp_plant', at: new Vec3(20, 60, 0) })
  assert.equal(s.cost({ name: 'kelp_plant', kind: 'block', dimension: 'overworld', find: 1000 }), 105)
  kelpBlocks.length = 0
  // no water found to fish in: the kelp in the water as dear
  ocean = true
  s.missing(['water'])
  assert.equal(s.cost({ name: 'kelp', kind: 'block', dimension: 'overworld', find: 1000 }), 1000 * SCARCE_FACTOR)
  now += GIVE_UP_TICKS
  // explored for and none found: given up on for a day at once (the sea's only)
  s.missing(['kelp_plant'])
  assert.equal(s.cost({ name: 'kelp_plant', kind: 'block', dimension: 'overworld', find: 1000 }), 1000 * GIVE_UP_FACTOR)
})

test('the rt-1 food restock with no sea known: no kelp planned, the animals not near notwithstanding; with an ocean near, the kelp as before', () => {
  // (the bag at t157268: the porkchops and a mutton, a furnace, coal and spruce logs; the sheep, pigs, cows, chickens and rabbits not near)
  const inv = { cooked_porkchop: 2, mutton: 1, furnace: 1, crafting_table: 1, coal: 32, spruce_log: 53, stick: 15, diamond_sword: 1, iron_pickaxe: 1, diamond_pickaxe: 1, stone_sword: 1, cobblestone: 64 }
  const goal = [{ item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' as const }]
  const plan = (ocean: boolean): string[] => {
    const s = new Sightings(fakeBot([]), () => 0, () => false, () => new Set(), () => false, () => ocean)
    s.notNear(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
    return obtainAll(registry, goal, { inventory: inv, findCost: t => s.cost(t), exclude: ['farm'] }).steps.map(st => `${st.kind} ${st.item}`)
  }
  assert.ok(plan(true).includes('mine kelp'), plan(true).join(', '))
  assert.ok(!plan(false).includes('mine kelp'), plan(false).join(', '))
})

test('the wool\'s sources by what\'s about: a night monster by day is dear but by a spawner of it, an animal with none of its biomes about too (f3-26.3 and f3-run1: spiders hunted by day for a bed\'s wool and a rod\'s string)', async () => {
  const { DAY_MONSTER_FACTOR, NO_LAND_FACTOR } = await import('../../src/executor/sight')
  const bot = fakeBot([])
  bot.time = { timeOfDay: 6000 }
  const land: Record<string, any> = {}
  const s = new Sightings(bot, () => 0, () => false, () => new Set(), () => true, () => true, mob => land[mob] ?? {})
  const mob = (name: string, find: number): any => ({ name, kind: 'mob', dimension: 'overworld', find })
  // by day: a spider somewhere is dear, a cave's (the nether's blaze) not
  assert.equal(s.cost(mob('spider', 1200)), 1200 * DAY_MONSTER_FACTOR)
  assert.equal(s.cost(mob('zombie', 600)), 600 * DAY_MONSTER_FACTOR)
  assert.equal(s.cost(mob('cow', 400)), undefined)
  // by a spider spawner: not
  land.spider = { spawner: true }
  assert.equal(s.cost(mob('spider', 1200)), undefined)
  delete land.spider
  // at night: not; in sight: a walk
  bot.time.timeOfDay = 15000
  assert.equal(s.cost(mob('spider', 1200)), undefined)
  bot.time.timeOfDay = 6000
  bot.entities[1] = { id: 1, name: 'spider', position: new Vec3(8, 64, 0), metadata: [] }
  assert.equal(s.cost(mob('spider', 1200)), 40)
  delete bot.entities[1]
  // sheep: none of their biomes about (the land known) dear; not known, or about, as the source says
  land.sheep = { land: false }
  assert.equal(s.cost(mob('sheep', 400)), 400 * NO_LAND_FACTOR)
  land.sheep = { land: null }
  assert.equal(s.cost(mob('sheep', 400)), undefined)

  // the plan for a bed's 3 wool by day: the sheep, even with none of their land known
  const kit = { crafting_table: 1, oak_planks: 3, stone_sword: 1 }
  const plan = (): string[] => obtainAll(registry, [{ item: 'white_bed', count: 1 }], { inventory: kit, findCost: t => s.cost(t) }).steps.filter(st => st.kind === 'kill').map(st => (st as any).mob)
  land.sheep = { land: false }
  assert.deepEqual(plan(), ['sheep'])
  // at night with no sheep land about: the spiders' string
  bot.time.timeOfDay = 15000
  assert.deepEqual(plan(), ['spider'])
})
