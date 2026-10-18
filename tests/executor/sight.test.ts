import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Sightings, SCARCE_FACTOR, SCARCE_TICKS } from '../../src/executor/sight'
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
