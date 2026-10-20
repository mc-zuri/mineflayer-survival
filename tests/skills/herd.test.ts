// The herd kept for food without a server: the breeders and calves spared, only the surplus slaughtered, the chores
// for the food wanted, the herd remembered and what it supplies the planner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { BREEDERS_KEPT, breedersToSpare, chooseHerdMob, GROW_UP_TICKS, herdCap, herdChores, herdFromMemory, herdSpares, herdSupply, rememberHerd, slaughterPick } from '../../src/skills/herd'
import { BREED_COOLDOWN_TICKS } from '../../src/skills/husbandry'
import { rememberPen, planPen } from '../../src/skills/pen'
import { WorldMemory } from '../../src/core/memory'
import { entity, fakeBot } from '../reflexes/fakeBot'

const animal = (id: number, adult: boolean): { id: number, adult: boolean } => ({ id, adult })

test('breedersToSpare: the calves always; every adult while the herd has the two breeders or fewer, none beyond', () => {
  assert.equal(BREEDERS_KEPT, 2)
  assert.deepEqual([...breedersToSpare([animal(1, true), animal(2, true)])].sort(), [1, 2])
  assert.deepEqual([...breedersToSpare([animal(1, true)])], [1])
  assert.deepEqual([...breedersToSpare([animal(1, true), animal(2, true), animal(3, false)])].sort(), [1, 2, 3])
  // three adults: one may go (and once it has, the two left are spared)
  assert.deepEqual([...breedersToSpare([animal(1, true), animal(2, true), animal(3, true), animal(4, false)])], [4])
})

test('slaughterPick: the surplus adults only, never the last two, never a calf', () => {
  const herd = [animal(1, false), animal(2, true), animal(3, true), animal(4, false), animal(5, true), animal(6, true)]
  assert.deepEqual(slaughterPick(herd, 10), [2, 3])
  assert.deepEqual(slaughterPick(herd, 1), [2])
  assert.deepEqual(slaughterPick([animal(1, true), animal(2, true), animal(3, false)], 5), [])
  assert.deepEqual(slaughterPick([animal(1, false), animal(2, false), animal(3, false)], 5), [])
})

test('herdChores: the breeders kept whatever the food wanted; the surplus slaughtered for the food short or the pen\'s overflow; bred when the cooldown is over', () => {
  const base = { food: 20, cap: 12, sinceBred: null, perKill: 16 }
  // two adults: bred, none killed however hungry
  assert.deepEqual(herdChores({ ...base, adults: 2, calves: 0, want: 200 }), { breed: 1, slaughter: 0 })
  // five adults, 40 points wanted: 3 kills cover it, all 3 of the surplus
  assert.deepEqual(herdChores({ ...base, adults: 5, calves: 1, want: 40 }), { breed: 2, slaughter: 3 })
  // 16 points: one kill
  assert.equal(herdChores({ ...base, adults: 5, calves: 1, want: 16 }).slaughter, 1)
  // no food wanted, room in the pen: the surplus kept alive (the planner's cheap meat)
  assert.equal(herdChores({ ...base, adults: 5, calves: 1, want: 0 }).slaughter, 0)
  // the pen full: the overflow slaughtered, the calves not counted for it
  assert.equal(herdChores({ ...base, cap: 6, adults: 5, calves: 3, want: 0 }).slaughter, 2)
  // bred lately: no breeding till the cooldown is over; no wheat, none either
  assert.equal(herdChores({ ...base, adults: 4, calves: 0, want: 0, sinceBred: BREED_COOLDOWN_TICKS - 1 }).breed, 0)
  assert.equal(herdChores({ ...base, adults: 4, calves: 0, want: 0, sinceBred: BREED_COOLDOWN_TICKS }).breed, 2)
  assert.equal(herdChores({ ...base, adults: 4, calves: 0, want: 0, food: 1 }).breed, 0)
  // a full pen breeds no more
  assert.equal(herdChores({ ...base, cap: 4, adults: 2, calves: 2, want: 0 }).breed, 0)
})

test('herdCap: a quarter of the inside, 4 at least', () => {
  assert.equal(herdCap(9), 12)
  assert.equal(herdCap(7), 6)
  assert.equal(herdCap(5), 4)
})

test('chooseHerdMob: cows first, else sheep, else pigs: two adults near and the food held', () => {
  assert.equal(chooseHerdMob({ cow: 2, sheep: 5 }, () => true), 'cow')
  assert.equal(chooseHerdMob({ cow: 1, sheep: 2 }, () => true), 'sheep')
  assert.equal(chooseHerdMob({ pig: 3 }, m => m === 'pig'), 'pig')
  assert.equal(chooseHerdMob({ cow: 4 }, m => m !== 'cow'), null)
  assert.equal(chooseHerdMob({}, () => true), null)
})

test('the herd remembered with its counts and last breeding; an egg herd\'s plain note read as its kind; moved to its pen', () => {
  const memory = new WorldMemory()
  memory.addPoi('herd', new Vec3(1, 64, 1), 'overworld', 'sheep')
  assert.deepEqual(herdFromMemory(memory), { pos: new Vec3(1, 64, 1), mob: 'sheep', adults: 0, calves: 0, bred: null })
  rememberHerd(memory, { pos: new Vec3(10, 64, 10), mob: 'sheep', adults: 3, calves: 1, bred: 5000 }, new Vec3(1, 64, 1))
  assert.equal(memory.getPois('herd').length, 1)
  assert.deepEqual(herdFromMemory(memory), { pos: new Vec3(10, 64, 10), mob: 'sheep', adults: 3, calves: 1, bred: 5000 })
})

function penned (): { memory: WorldMemory, bot: any, ids: { adults: number[], calves: number[] } } {
  const memory = new WorldMemory()
  const center = new Vec3(10, 64, 10)
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), center, 7, 'west')
  rememberPen(memory, pen)
  rememberHerd(memory, { pos: center, mob: 'cow', adults: 2, calves: 0, bred: 1000 })
  const adults = [entity({ name: 'cow', position: new Vec3(10.5, 64, 10.5) }), entity({ name: 'cow', position: new Vec3(11.5, 64, 9.5) }), entity({ name: 'cow', position: new Vec3(9.5, 64, 11.5) })]
  const calves = [entity({ name: 'cow', position: new Vec3(10.5, 64, 11.5), meta: { baby: true } })]
  // a wild cow outside the ring
  const wild = entity({ name: 'cow', position: new Vec3(30.5, 64, 10.5) })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [...adults, ...calves, wild] })
  bot.game.dimension = 'overworld'
  return { memory, bot, ids: { adults: adults.map(e => e.id), calves: calves.map(e => e.id) } }
}

test('herdSpares: the pen\'s calves always, its adults once only the two breeders are left; never a wild one', () => {
  const { memory, bot, ids } = penned()
  assert.deepEqual([...herdSpares(bot, memory)], ids.calves)
  delete bot.entities[ids.adults[0]]
  assert.deepEqual([...herdSpares(bot, memory)].sort(), [...ids.adults.slice(1), ...ids.calves].sort())
  // out of sight: nothing known to spare (the hunt finds none of them anyway)
  bot.entity.position = new Vec3(200, 64, 0)
  assert.equal(herdSpares(bot, memory).size, 0)
})

test('herdSupply: the surplus now, the calves as later surplus with their growing left, as seen or as remembered out of sight', () => {
  const { memory, bot, ids } = penned()
  assert.deepEqual(herdSupply(bot, memory, 'cow', 1000 + GROW_UP_TICKS - 500), { surplus: 1, growing: 1, growTicks: 500, distance: bot.entity.position.distanceTo(new Vec3(10, 64, 10)) })
  assert.equal(herdSupply(bot, memory, 'pig', 0), undefined)
  // two breeders and a calf: the calf alone, later
  delete bot.entities[ids.adults[0]]
  assert.deepEqual(herdSupply(bot, memory, 'cow', 1000), { surplus: 0, growing: 1, growTicks: GROW_UP_TICKS, distance: bot.entity.position.distanceTo(new Vec3(10, 64, 10)) })
  // the two breeders alone: nothing to take
  delete bot.entities[ids.calves[0]]
  assert.equal(herdSupply(bot, memory, 'cow', 1000), undefined)
  // out of sight, the counts remembered (2 adults: nothing)
  bot.entity.position = new Vec3(300, 64, 0)
  assert.equal(herdSupply(bot, memory, 'cow', 1000), undefined)
  rememberHerd(memory, { pos: new Vec3(10, 64, 10), mob: 'cow', adults: 4, calves: 0, bred: null })
  assert.equal(herdSupply(bot, memory, 'cow', 1000)?.surplus, 2)
})

test('a kill step passes over the pen\'s two breeders and its calf, nearer as they are, for a wild cow', async () => {
  const { memory, bot, ids } = penned()
  delete bot.entities[ids.adults[2]]
  const wild = Object.values(bot.entities).find((e: any) => e.name === 'cow' && e.position.x > 20) as any
  wild.position = new Vec3(16.5, 64, 10.5)
  bot.entity.position = new Vec3(12.5, 64, 10.5)
  const huntModule = require('../../src/skills/hunt')
  const { item } = await import('../reflexes/fakeBot')
  const real = huntModule.hunt
  const killed: number[] = []
  huntModule.hunt = async (b: any, prey: any) => {
    killed.push(prey.id)
    delete b.entities[prey.id]
    b.inventory.slots[20] = item('beef', 2)
    return { killed: true, drops: { beef: 2 } }
  }
  try {
    const { runKill } = await import('../../src/executor/steps')
    const out = await runKill({ kind: 'kill', item: 'beef', count: 2, mob: 'cow', kills: 1, weapon: null, dimension: 'overworld', cost: 100 } as any, { bot, memory, signal: new AbortController().signal, state: {}, log: () => {} })
    assert.equal(out.gained, 2)
  } finally {
    huntModule.hunt = real
  }
  assert.deepEqual(killed, [wild.id])
  assert.ok(ids.adults.slice(0, 2).every(id => bot.entities[id] != null) && bot.entities[ids.calves[0]] != null)
})

test('sightings: the pen\'s breeders are no cow in sight; its surplus is', async () => {
  const { Sightings } = await import('../../src/executor/sight')
  const { memory, bot, ids } = penned()
  const wild = Object.values(bot.entities).find((e: any) => e.name === 'cow' && e.position.x > 20) as any
  delete bot.entities[wild.id]
  const s = new Sightings(bot, () => 0, () => false, () => herdSpares(bot, memory))
  const cow = { name: 'cow', kind: 'mob' as const, dimension: 'overworld' as const, find: 400 }
  assert.ok((s.cost(cow) ?? Infinity) < 100)
  delete bot.entities[ids.adults[0]]
  assert.equal(s.cost(cow), undefined)
})

test('a kill step with no cow near goes to the herd it keeps out of sight for its surplus, not exploring', async () => {
  const { memory, bot } = penned()
  const herdCows = Object.values(bot.entities).filter((e: any) => e.name === 'cow' && e.position.x < 20) as any[]
  for (const e of Object.values(bot.entities) as any[]) if (e.name === 'cow') delete bot.entities[e.id]
  rememberHerd(memory, { pos: new Vec3(10, 64, 10), mob: 'cow', adults: 3, calves: 1, bred: null })
  bot.entity.position = new Vec3(300.5, 64, 0.5)
  const travelModule = require('../../src/skills/travel')
  const huntModule = require('../../src/skills/hunt')
  const { item } = await import('../reflexes/fakeBot')
  const real = { travel: travelModule.travel, hunt: huntModule.hunt }
  const trips: string[] = []
  const killed: number[] = []
  travelModule.travel = async (b: any, args: any) => {
    trips.push(args.target.toString())
    b.entity.position = new Vec3(12.5, 64, 10.5)
    for (const e of herdCows) b.entities[e.id] = e
    return {}
  }
  huntModule.hunt = async (b: any, prey: any) => {
    killed.push(prey.id)
    delete b.entities[prey.id]
    b.inventory.slots[20] = item('beef', 2)
    return { killed: true, drops: { beef: 2 } }
  }
  const lines: string[] = []
  try {
    const { runKill } = await import('../../src/executor/steps')
    await runKill({ kind: 'kill', item: 'beef', count: 2, mob: 'cow', kills: 1, weapon: null, dimension: 'overworld', cost: 100 } as any, { bot, memory, signal: new AbortController().signal, state: {}, log: l => lines.push(l) })
  } finally {
    Object.assign(travelModule, { travel: real.travel })
    huntModule.hunt = real.hunt
  }
  assert.deepEqual(trips, ['(10, 64, 10)'])
  assert.equal(killed.length, 1)
  assert.ok(herdCows.some(e => e.id === killed[0]), 'a penned cow')
  assert.ok(!lines.some(l => /exploring/.test(l)), lines.join(' | '))
  // its counts as seen there remembered
  assert.equal(herdFromMemory(memory)?.adults, 3)
})
