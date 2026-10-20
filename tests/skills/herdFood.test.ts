// The herd step and its upkeep without a server (the executor's tasks stood in for): the pen built near home and the
// cows led in, the herd remembered; the pairs bred, only the surplus slaughtered and cooked, the breeders and the
// calves never; the farm's wheat kept from the baking for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { planPen, rememberPen } from '../../src/skills/pen'
import { herdFromMemory, rememberHerd } from '../../src/skills/herd'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

const CENTER = new Vec3(10, 64, 10)
const signal = (): AbortSignal => new AbortController().signal

/** a bot by a pen of 7 at CENTER (its ring of fences and its gate in the world), with the herd's animals given */
function byThePen (animals: Array<{ x: number, z: number, baby?: boolean, name?: string }>, items: any[] = []): { bot: any, memory: WorldMemory, pen: any } {
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 7, 'west')
  const fence = new Set(pen.fences.map(p => p.toString()))
  const memory = new WorldMemory()
  rememberPen(memory, pen)
  const bot = fakeBot({
    position: new Vec3(6.5, 64, 10.5),
    items,
    entities: animals.map(a => entity({ name: a.name ?? 'cow', position: new Vec3(a.x + 0.5, 64, a.z + 0.5), meta: a.baby === true ? { baby: true } : {} })),
    world: p => p.y < 64 ? 'grass_block' : fence.has(p.toString()) ? 'oak_fence' : p.equals(pen.gate) ? 'oak_fence_gate' : 'air'
  })
  bot.game.dimension = 'overworld'
  bot.time = { age: 100000, timeOfDay: 1000 }
  return { bot, memory, pen }
}

function fakeExecutor (bot: any, memory: WorldMemory, onTask: (name: string, fn: any) => any = () => undefined): { executor: any, tasks: string[], obtained: any[] } {
  const tasks: string[] = []
  const obtained: any[] = []
  const executor: any = {
    memory,
    tasks: { tick: 0 },
    plan: () => ({ ok: true, cost: 100, steps: [] }),
    obtain: async (reqs: any[]) => { obtained.push(...reqs) },
    runStep: async () => ({ gained: 0 }),
    farmCost: () => undefined,
    task: async (name: string, fn: any) => { tasks.push(name); return await onTask(name, fn) }
  }
  return { executor, tasks, obtained }
}

test('startHerd: two cows near home and wheat held: a pen built near home, the cows led in, the herd remembered at the pen', async () => {
  const { startHerd } = await import('../../src/milestones')
  const memory = new WorldMemory()
  const bot = fakeBot({
    position: new Vec3(0.5, 64, 0.5),
    items: [item('wheat', 4)],
    entities: [entity({ name: 'cow', position: new Vec3(20.5, 64, 3.5) }), entity({ name: 'cow', position: new Vec3(-12.5, 64, 8.5) }), entity({ name: 'sheep', position: new Vec3(3.5, 64, 3.5) })]
  })
  bot.game.dimension = 'overworld'
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 9, 'west')
  const { executor, tasks } = fakeExecutor(bot, memory, (name) => {
    if (name === 'the herd pen') {
      rememberPen(memory, pen)
      for (const e of Object.values(bot.entities) as any[]) if (e.name === 'cow') e.position = CENTER.offset(0.5, 0, 0.5)
      return { pen, inside: 2, built: true }
    }
  })
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true)
  assert.deepEqual(tasks, ['the herd pen'])
  assert.deepEqual(herdFromMemory(memory), { pos: CENTER, mob: 'cow', adults: 2, calves: 0, bred: null })
  // a herd kept: no second one
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), false)
  assert.deepEqual(tasks, ['the herd pen'])
})

test('startHerd: no two of a kind near home, or no wheat: nothing built, tried again only after a while', async () => {
  const { startHerd, HERD_RETRY_TICKS } = await import('../../src/milestones')
  const memory = new WorldMemory()
  const cows = [entity({ name: 'cow', position: new Vec3(5.5, 64, 3.5) }), entity({ name: 'cow', position: new Vec3(-5.5, 64, 3.5) })]
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: cows })
  bot.game.dimension = 'overworld'
  const { executor, tasks } = fakeExecutor(bot, memory)
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), false)
  assert.ok(lines.some(l => /none to start yet \(2 cows, 0 sheeps, 0 pigs near home, 0 wheat\)/.test(l)), lines.join(' | '))
  // the wheat comes, but the retry's wait isn't over
  bot.inventory.slots[30] = item('wheat', 3)
  assert.equal(await startHerd(bot, executor, signal(), () => {}), false)
  executor.tasks.tick = HERD_RETRY_TICKS
  executor.task = async (name: string) => { tasks.push(name); throw new Error('NOT_FOUND: no ground for a pen') }
  assert.equal(await startHerd(bot, executor, signal(), () => {}), false)
  assert.ok(tasks.includes('the herd pen'))
  assert.equal(herdFromMemory(memory), null)
})

test('tendHerd: bred as the cooldown allows, only the surplus slaughtered for the food wanted and cooked, the two breeders and the calf kept, the gate shut', async () => {
  const { tendHerd } = await import('../../src/milestones')
  const { bot, memory } = byThePen([{ x: 9, z: 9 }, { x: 10, z: 9 }, { x: 11, z: 9 }, { x: 9, z: 11 }, { x: 10, z: 11, baby: true }], [item('wheat', 10)])
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 4, calves: 1, bred: null })
  const calf = (Object.values(bot.entities) as any[]).find(e => e.metadata.some((m: unknown) => m === true))
  const killed: number[] = []
  const { executor, tasks, obtained } = fakeExecutor(bot, memory, (name, fn) => {
    if (name === 'breed the cows') return { fed: 4, pairs: 2 }
    if (name === 'slaughter a cow') {
      // the hunt's kill: the animal gone, its beef picked up
      return fn(signal()).catch(() => ({ killed: false }))
    }
  })
  // the cooking after the bot is out of the pen (a furnace among the calves found no room, 26.3)
  const cookedAfter: string[] = []
  const obtain = executor.obtain
  executor.obtain = async (reqs: any[]) => { cookedAfter.push(tasks[tasks.length - 1]); await obtain(reqs) }
  const huntModule = require('../../src/skills/hunt')
  const real = huntModule.hunt
  huntModule.hunt = async (b: any, prey: any) => { killed.push(prey.id); delete b.entities[prey.id]; b.inventory.slots[31 + killed.length] = item('beef', 2); return { killed: true } }
  let points: number
  try {
    points = await tendHerd(bot, executor, signal(), () => {}, { want: 32 })
  } finally {
    huntModule.hunt = real
  }
  assert.equal(killed.length, 2)
  assert.ok(!killed.includes(calf.id))
  assert.equal((Object.values(bot.entities) as any[]).filter(e => e.name === 'cow').length, 3)
  assert.ok(tasks.indexOf('breed the cows') < tasks.indexOf('slaughter a cow'), tasks.join(', '))
  // the chores from inside the pen, its gate shut behind (fed from the gate's cell, the herd walked out, 26.3)
  assert.ok(tasks.includes('into the pen') && tasks.indexOf('into the pen') < tasks.indexOf('breed the cows'), tasks.join(', '))
  assert.equal(tasks[tasks.length - 1], 'shut the herd in')
  assert.deepEqual(cookedAfter, ['shut the herd in'])
  assert.ok(tasks.indexOf('the herd drops') > tasks.lastIndexOf('slaughter a cow'), tasks.join(', '))
  // the beef cooked (the base's furnace, through the planner)
  assert.deepEqual(obtained, [{ item: 'cooked_beef', count: 4 }])
  assert.equal(points, 0)
  // the breeding remembered: the next upkeep within the cooldown breeds none
  assert.equal(herdFromMemory(memory)?.bred, 100000)
  assert.equal(herdFromMemory(memory)?.adults, 2)
  tasks.length = 0
  await tendHerd(bot, executor, signal(), () => {}, { want: 200 })
  assert.ok(!tasks.includes('breed the cows') && !tasks.includes('slaughter a cow'), tasks.join(', '))
})

test('tendHerd: the two breeders alone are never slaughtered, however hungry', async () => {
  const { tendHerd } = await import('../../src/milestones')
  const { bot, memory } = byThePen([{ x: 9, z: 9 }, { x: 11, z: 11 }])
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 2, calves: 0, bred: null })
  const { executor, tasks } = fakeExecutor(bot, memory)
  assert.equal(await tendHerd(bot, executor, signal(), () => {}, { want: 500 }), 0)
  assert.ok(!tasks.includes('slaughter a cow'), tasks.join(', '))
  assert.equal((Object.values(bot.entities) as any[]).filter(e => e.name === 'cow').length, 2)
})

test('harvestGrownFarms keeps the herd\'s wheat from the baking', async () => {
  const { harvestGrownFarms, HERD_WHEAT_KEPT } = await import('../../src/milestones')
  const { bot, memory } = byThePen([], [item('wheat', 12)])
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 2, calves: 0, bred: null })
  const { executor, obtained } = fakeExecutor(bot, memory)
  await harvestGrownFarms(bot, executor, signal(), () => {})
  assert.deepEqual(obtained, [{ item: 'bread', count: Math.floor((12 - HERD_WHEAT_KEPT) / 3) }])
  // a herd of pigs eats none of it
  rememberHerd(memory, { pos: CENTER, mob: 'pig', adults: 2, calves: 0, bred: null })
  obtained.length = 0
  await harvestGrownFarms(bot, executor, signal(), () => {})
  assert.deepEqual(obtained, [{ item: 'bread', count: 4 }])
})

test('netherKit: short of the gate\'s food, the herd\'s surplus slaughtered and cooked before any other source is planned, its breeders kept', async () => {
  const { netherKit } = await import('../../src/milestones')
  const gear = [item('diamond_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('golden_boots', 1), item('shield', 1), item('bow', 1), item('arrow', 64)]
  const { bot, memory } = byThePen([{ x: 9, z: 9 }, { x: 10, z: 9 }, { x: 11, z: 9 }, { x: 9, z: 11 }], gear)
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 4, calves: 0, bred: null })
  const give = (it: any): void => { bot.inventory.slots[bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && i < 45 && s == null)] = it }
  const calls: string[] = []
  const { executor } = fakeExecutor(bot, memory, async (name, fn) => {
    calls.push(name)
    if (name === 'slaughter a cow') return await fn(signal())
  })
  executor.obtain = async (reqs: any[]) => {
    calls.push(`obtain ${reqs.map(r => r.unit === 'nutrition' ? 'food' : r.item).join(',')}`)
    if (reqs.some(r => r.item === 'cooked_beef')) { for (const s of bot.inventory.slots) if (s?.name === 'beef') bot.inventory.slots[s.slot] = null; give(item('cooked_beef', 4)) }
    if (reqs.some(r => r.unit === 'nutrition')) give(item('bread', 24))
  }
  const huntModule = require('../../src/skills/hunt')
  const real = huntModule.hunt
  huntModule.hunt = async (b: any, prey: any) => { delete b.entities[prey.id]; give(item('beef', 2)); return { killed: true } }
  try {
    await netherKit(bot, executor, signal(), () => {})
  } finally {
    huntModule.hunt = real
  }
  const slaughtered = calls.filter(c => c === 'slaughter a cow').length
  assert.equal(slaughtered, 2, calls.join(', '))
  assert.ok(calls.indexOf('obtain cooked_beef') > calls.lastIndexOf('slaughter a cow'), calls.join(', '))
  assert.ok(calls.indexOf('obtain food') > calls.indexOf('obtain cooked_beef'), calls.join(', '))
  assert.equal((Object.values(bot.entities) as any[]).filter(e => e.name === 'cow').length, 2)
})
