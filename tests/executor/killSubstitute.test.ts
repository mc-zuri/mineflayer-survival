// A kill step whose animal isn't near while another meat animal is (a snowy mountain's rabbits for a cow's step): it
// plans again for the one near, its own meat and cooking named, and a substitute's meat got plans again with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Sightings, NOT_NEAR_TICKS, SCARCE_FACTOR } from '../../src/executor/sight'
import { meatOf } from '../../src/executor/steps'
import { obtainAll } from '../../src/planner/obtain'
import { WorldMemory } from '../../src/core/memory'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

const cowStep = { kind: 'kill', item: 'beef', count: 5, mob: 'cow', kills: 3, weapon: null, dimension: 'overworld', cost: 900 } as any

function snowyBot (): any {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('iron_sword', 1)], world: (p: Vec3) => p.y < 64 ? 'stone' : 'air' })
  const rabbit = entity({ name: 'rabbit', position: new Vec3(4.5, 64, 0.5) })
  bot.entities[rabbit.id] = rabbit
  return { bot, rabbit }
}

test('meatOf: the meat animals\' meats', () => {
  assert.equal(meatOf('rabbit'), 'rabbit')
  assert.equal(meatOf('cow'), 'beef')
  assert.equal(meatOf('zombie'), null)
})

test('a kill step for beef with no cow near and a rabbit near plans again for the rabbit, the cow noted not near (full-26.3-s31337-e: \'hunting a rabbit for beef 0 / 5\')', async () => {
  const { bot } = snowyBot()
  const huntModule = require('../../src/skills/hunt')
  const real = huntModule.hunt
  const hunted: string[] = []
  huntModule.hunt = async (_b: any, prey: any) => { hunted.push(prey.name); return { killed: true, drops: {} } }
  const away: string[] = []
  const lines: string[] = []
  try {
    const { runKill } = await import('../../src/executor/steps')
    const out = await runKill(cowStep, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: l => lines.push(l), notNear: names => away.push(...names), isNotNear: () => false })
    assert.equal(out.replan, true)
    assert.equal(out.gained, 0)
  } finally {
    huntModule.hunt = real
  }
  assert.deepEqual(hunted, [])
  assert.deepEqual(away, ['cow', 'pig', 'sheep', 'chicken'])
  assert.ok(lines.some(l => /no cow near, a rabbit is: planning for its rabbit/.test(l)), lines.join(' | '))
})

test('a kill step whose animal was noted not near hunts the rabbit near, and plans again once it has its meat', async () => {
  const { bot, rabbit } = snowyBot()
  const huntModule = require('../../src/skills/hunt')
  const real = huntModule.hunt
  const hunted: string[] = []
  huntModule.hunt = async (b: any, prey: any) => {
    hunted.push(prey.name)
    delete b.entities[prey.id]
    b.inventory.slots[20] = item('rabbit', 1)
    return { killed: true, drops: { rabbit: 1, rabbit_hide: 1 } }
  }
  try {
    const { runKill } = await import('../../src/executor/steps')
    const out = await runKill(cowStep, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {}, notNear: () => {}, isNotNear: name => name === 'cow' })
    assert.equal(out.replan, true)
  } finally {
    huntModule.hunt = real
  }
  assert.deepEqual(hunted, ['rabbit'])
  assert.equal(bot.entities[rabbit.id], undefined)
})

test('sightings: an animal not near a step is dear for a while, and cheap again once seen; no miss is counted', () => {
  let now = 1000
  const bot: any = { registry, game: { dimension: 'overworld' }, entity: { id: 0, position: new Vec3(0, 64, 0) } }
  bot.entities = { 0: bot.entity }
  const s = new Sightings(bot, () => now)
  const cow = { name: 'cow', kind: 'mob' as const, dimension: 'overworld' as const, find: 400 }
  assert.equal(s.cost(cow), undefined)
  s.notNear(['cow'])
  assert.equal(s.cost(cow), 400 * SCARCE_FACTOR)
  assert.equal(s.misses('cow'), 0)
  now += NOT_NEAR_TICKS
  assert.equal(s.cost(cow), undefined)
  s.notNear(['cow'])
  bot.entities[1] = { id: 1, name: 'cow', position: new Vec3(10, 64, 0), metadata: [] }
  assert.equal(s.cost(cow), 50)
  delete bot.entities[1]
  assert.equal(s.cost(cow), undefined)
})

test('the food plan with the cows not near and rabbits in sight: kill rabbits for rabbit, smelt cooked_rabbit', () => {
  const bot: any = { registry, game: { dimension: 'overworld' }, entity: { id: 0, position: new Vec3(0, 64, 0) } }
  bot.entities = { 0: bot.entity }
  for (let i = 1; i <= 3; i++) bot.entities[i] = { id: i, name: 'rabbit', position: new Vec3(6 * i, 64, 0), metadata: [] }
  const s = new Sightings(bot, () => 0)
  s.notNear(['cow', 'pig', 'sheep', 'chicken'])
  const kit = { crafting_table: 1, stone_pickaxe: 1, iron_sword: 1, furnace: 1, coal: 8 }
  const plan = obtainAll(registry, [{ item: ['cooked_beef', 'cooked_rabbit', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken'], count: 20, unit: 'nutrition' }], { inventory: kit, findCost: t => s.cost(t) })
  const steps = plan.steps.map(st => st.kind === 'kill' ? `kill ${st.mob} for ${st.item}` : `${st.kind} ${st.item}`)
  assert.ok(steps.includes('kill rabbit for rabbit') && steps.includes('smelt cooked_rabbit'), steps.join(', '))
})

test('a kill step that took the animals near and got some meat plans again before exploring for more; once noted not near, it explores', async () => {
  const { bot } = snowyBot()
  const huntModule = require('../../src/skills/hunt')
  const exploreModule = require('../../src/executor/explore')
  const real = { hunt: huntModule.hunt, exploreSurface: exploreModule.exploreSurface }
  huntModule.hunt = async (b: any, prey: any) => {
    delete b.entities[prey.id]
    b.inventory.slots[20] = item('rabbit', 1)
    return { killed: true, drops: { rabbit: 1 } }
  }
  let explored = 0
  exploreModule.exploreSurface = async () => { explored++; return false }
  const rabbitStep = { kind: 'kill', item: 'rabbit', count: 4, mob: 'rabbit', kills: 8, weapon: null, dimension: 'overworld', cost: 900 } as any
  const away: string[] = []
  const lines: string[] = []
  try {
    const { runKill } = await import('../../src/executor/steps')
    const out = await runKill(rabbitStep, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: l => lines.push(l), notNear: names => away.push(...names), isNotNear: n => away.includes(n) })
    assert.equal(out.replan, true)
    assert.equal(out.gained, 1)
    assert.equal(explored, 0)
    assert.ok(away.includes('rabbit'))
    // the next plan's step for more: explored for now
    await assert.rejects(runKill(rabbitStep, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: l => lines.push(l), notNear: names => away.push(...names), isNotNear: n => away.includes(n) }), (err: any) => err.code === 'NOT_FOUND')
    assert.equal(explored, 1)
  } finally {
    huntModule.hunt = real.hunt
    exploreModule.exploreSurface = real.exploreSurface
  }
  assert.ok(lines.some(l => /no more rabbit near: planning again with the 1 rabbit got/.test(l)), lines.join(' | '))
})
