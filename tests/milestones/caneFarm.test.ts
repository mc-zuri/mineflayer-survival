// The enchanting's cane farm by home: started from canes got where they grow (the shores), planted by the base, tended
// when the bot is by it, and the table's book waiting on it. A 1.21.11 game had no farm, and failed its enchanting five
// times on 'mine 3 sugar_cane' in 2100 ticks (f3-1.21.11).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { fakeBot, item } from '../reflexes/fakeBot'

async function stubbed<T> (stubs: Array<[string, string, any]>, fn: () => Promise<T>): Promise<T> {
  const saved = stubs.map(([mod, name]) => [require(mod), name, require(mod)[name]] as const)
  for (const [mod, name, fake] of stubs) require(mod)[name] = fake
  try {
    return await fn()
  } finally {
    for (const [m, name, real] of saved) m[name] = real
  }
}

/** a bot with `canes` held, an executor whose obtain gives it the canes asked for up to `found` */
function setup (canes: number, found = canes, at = new Vec3(0.5, 64, 0.5)): { bot: any, executor: any, tasks: string[], obtained: any[] } {
  const bot = fakeBot({ position: at, items: canes > 0 ? [item('sugar_cane', canes), item('water_bucket')] : [item('water_bucket')] })
  bot.game.dimension = 'overworld'
  const tasks: string[] = []
  const obtained: any[] = []
  const executor: any = {
    memory: new WorldMemory(),
    task: async (name: string, fn: (s: AbortSignal) => Promise<any>) => { tasks.push(name); return await fn(new AbortController().signal) },
    obtain: async (reqs: any[]) => {
      obtained.push(...reqs)
      const c = bot.inventory.items().find((i: any) => i.name === 'sugar_cane')
      if (c != null) c.count = Math.max(c.count, Math.min(found, reqs[0].count))
    }
  }
  return { bot, executor, tasks, obtained }
}

test('tableBookCanes: 3 less the paper held, none with a table or a book', async () => {
  const { tableBookCanes } = await import('../../src/milestones')
  const memory = new WorldMemory()
  assert.equal(tableBookCanes(fakeBot(), memory), 3)
  assert.equal(tableBookCanes(fakeBot({ items: [item('paper', 2)] }), memory), 1)
  assert.equal(tableBookCanes(fakeBot({ items: [item('book', 1)] }), memory), 0)
  assert.equal(tableBookCanes(fakeBot({ items: [item('enchanting_table', 1)] }), memory), 0)
  memory.addPoi('enchanting_table', { x: 0, y: 64, z: 0 })
  assert.equal(tableBookCanes(fakeBot(), memory), 0)
})

test('keepCaneFarm with no farm: CANE_FARM_CANES canes beyond the table\'s book\'s got, and those planted by the base\'s door; none with no base', async () => {
  const { keepCaneFarm, CANE_FARM_CANES } = await import('../../src/milestones')
  const planted: any[] = []
  const plant = async (_b: any, args: any): Promise<any> => { planted.push(args); return { water: [], planted: [] } }
  // a base: the canes asked for (11: the book's 3 and 8), planted by its door
  const { bot, executor, obtained } = setup(5, 20)
  executor.memory.setBase({ x: 0, y: 64, z: 0 }, 'overworld')
  executor.memory.addPoi('base_entrance', { x: 4, y: 64, z: 0 })
  await stubbed([
    ['../../src/skills/caneFarm', 'plantSugarCane', plant],
    ['../../src/end/strongholdSkills', 'overland', async () => {}]
  ], async () => await keepCaneFarm(bot, executor, new AbortController().signal, () => {}))
  assert.deepEqual(obtained, [{ item: 'sugar_cane', count: CANE_FARM_CANES + 3 }])
  assert.equal(planted.length, 1)
  assert.equal(planted[0].count, CANE_FARM_CANES)
  assert.ok(planted[0].center.equals(new Vec3(4, 64, 0)) || planted[0].center.equals(new Vec3(0, 64, 0)), planted[0].center.toString())
  // only 4 found: the book's 3 kept, 1 planted
  const few = setup(0, 4)
  few.bot.inventory.slots[30] = Object.assign(item('sugar_cane', 1), { slot: 30 })
  few.executor.memory.setBase({ x: 0, y: 64, z: 0 }, 'overworld')
  planted.length = 0
  await stubbed([
    ['../../src/skills/caneFarm', 'plantSugarCane', plant],
    ['../../src/end/strongholdSkills', 'overland', async () => {}]
  ], async () => await keepCaneFarm(few.bot, few.executor, new AbortController().signal, () => {}))
  assert.equal(planted[0]?.count, 1)
  // no base: nothing looked for, nothing planted
  const none = setup(20)
  planted.length = 0
  await stubbed([['../../src/skills/caneFarm', 'plantSugarCane', plant]], async () => await keepCaneFarm(none.bot, none.executor, new AbortController().signal, () => {}))
  assert.deepEqual(none.obtained, [])
  assert.equal(planted.length, 0)
})

test('keepCaneFarm with a farm: tended when within range and grown, the table\'s book\'s canes kept; let be far off', async () => {
  const { keepCaneFarm } = await import('../../src/milestones')
  const { rememberCaneFarm, CANE_FARM_SPOTS } = await import('../../src/skills/caneFarm')
  const spots = Array.from({ length: CANE_FARM_SPOTS }, (_, i) => new Vec3(3, 63, i))
  const tended: any[] = []
  const tend = async (_b: any, _farm: any, args: any): Promise<any> => { tended.push(args); return { canes: 2, replanted: 0 } }
  for (const far of [false, true]) {
    const { bot, executor, obtained } = setup(0, 0, far ? new Vec3(300, 64, 0) : new Vec3(0.5, 64, 0.5))
    // a column of 2 on the first spot: grown
    const world = (p: Vec3): string => p.x === 3 && p.z === 0 && (p.y === 64 || p.y === 65) ? 'sugar_cane' : p.x === 4 && p.y === 63 ? 'water' : p.y > 63 ? 'air' : 'grass_block'
    bot.blockAt = (p: Vec3) => ({ name: world(p.floored()), position: p.floored(), boundingBox: 'empty' })
    rememberCaneFarm(executor.memory, spots)
    tended.length = 0
    await stubbed([['../../src/skills/caneFarm', 'tendCaneFarm', tend]], async () => await keepCaneFarm(bot, executor, new AbortController().signal, () => {}))
    assert.deepEqual(tended, far ? [] : [{ keep: 3 }])
    assert.deepEqual(obtained, [])
  }
})

test('tableBookWait: the table\'s book short of canes with a farm planted, a not-ready wait for it; none without a farm, or with the canes', async () => {
  const { tableBookWait, CANE_WAIT_TICKS } = await import('../../src/milestones')
  const { rememberCaneFarm } = await import('../../src/skills/caneFarm')
  const memory = new WorldMemory()
  assert.equal(tableBookWait(fakeBot({ items: [item('sugar_cane', 1)] }), memory), null)
  rememberCaneFarm(memory, [new Vec3(3, 63, 0)])
  const err: any = tableBookWait(fakeBot({ items: [item('sugar_cane', 1)] }), memory)
  assert.equal(err?.notReady, true)
  assert.equal(err?.growing, true)
  assert.equal(err?.waitTicks, CANE_WAIT_TICKS)
  assert.match(err.message, /1 canes of 3/)
  assert.equal(tableBookWait(fakeBot({ items: [item('sugar_cane', 3)] }), memory), null)
})
