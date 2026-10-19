// The nether milestone's fortress search without the seed: the axis walks taken in turn, one noted in memory per search.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { fortressRoute, fortressRoutes } from '../../src/milestones'

test('the fortress search walks findFortress\'s line first, then the other axis both ways, then back', () => {
  assert.deepEqual(fortressRoutes({ x: -40, z: 10 }), [
    { axis: 'x', direction: -1 }, { axis: 'z', direction: 1 }, { axis: 'z', direction: -1 }, { axis: 'x', direction: 1 }
  ])
  assert.deepEqual(fortressRoutes({ x: 3, z: -90 })[0], { axis: 'z', direction: -1 })
})

test('each search takes the next walk and notes it, so a search that found none isn\'t walked again', () => {
  const memory = new WorldMemory()
  const from = new Vec3(-40, 70, 10)
  const walks = [0, 1, 2, 3, 4].map(() => fortressRoute(memory, from))
  assert.deepEqual(walks.map(w => `${w.direction as number > 0 ? '+' : '-'}${String(w.axis)}`), ['-x', '+z', '-z', '+x', '-x'])
  assert.match(memory.getPois('fortress_search', { dimension: 'the_nether' })[0].note ?? '', /^searches=5;last=-x/)
})

test('eyesShort: out of eyes on the search or in the portal room is a trip back to the nether for more, not the end of the game', async () => {
  const { eyesShort } = await import('../../src/milestones')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  const memory = new WorldMemory()
  // the search still on: a frame's 12 and 2 for the throws
  assert.equal(eyesShort(inv({ ender_eye: 16 }), memory), 0)
  assert.equal(eyesShort(inv({ ender_eye: 9 }), memory), 5)
  assert.equal(eyesShort(inv({ ender_eye: 9, ender_pearl: 6, blaze_rod: 2 }), memory), 1)
  assert.equal(eyesShort(inv({}), memory), 14)
  // in the portal room: its empty frames
  memory.addPoi('end_portal', { x: 2351, y: -22, z: 1013 }, 'overworld', 'eyes=11')
  assert.equal(eyesShort(inv({ ender_eye: 9 }), memory), 2)
  assert.equal(eyesShort(inv({ ender_eye: 11 }), memory), 0)
})

test('the nether milestone with no lava near and no obsidian gets the frame\'s 10 obsidian first, then builds the portal', async () => {
  const { netherHandler } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${reqs.map(r => `${r.count} ${r.item}`).join(', ')}`) },
    task: async (name: string) => { calls.push(name); return { fortress: { center: { x: 0, y: 64, z: 0 } }, via: 'explore', ticks: 0 } }
  }
  const bot = fakeBot({ items: [item('water_bucket', 1), item('bucket', 2)] })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => []
  await netherHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: null as any, state: null as any })
  assert.deepStrictEqual(calls.slice(0, 5), ['down to the deep lava', 'obtain 10 obsidian', 'up to the surface', 'build a nether portal', 'into the nether'])
})

test('pearls in the nether: the endermen in sight hunted, else a leg on to find piglins or endermen, a few legs at most', async () => {
  const { pearlsInTheNether } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const tasks: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { tasks.push(name) } }
  const bot = fakeBot({ entities: [{ id: 7, name: 'enderman', position: new Vec3(10, 64, 0), metadata: [] }] })
  bot.game.dimension = 'the_nether'
  assert.equal(await pearlsInTheNether(bot, executor, 4, new AbortController().signal, () => {}), 0)
  assert.deepEqual(tasks, ['endermen for pearls', 'endermen for pearls', 'endermen for pearls', 'endermen for pearls'])
  tasks.length = 0
  const alone = fakeBot()
  alone.game.dimension = 'the_nether'
  await pearlsInTheNether(alone, executor, 4, new AbortController().signal, () => {})
  assert.deepEqual(tasks, ['a leg for pearls', 'a leg for pearls', 'a leg for pearls', 'a leg for pearls'])
})
