// The trip kit: what it takes from the bag, and the runner's way back to it after a death.
import { test } from 'node:test'
import assert from 'node:assert'
import { tripKitItems } from '../../src/skills/tripKit'

test('tripKitItems: the weapons but the best, half the arrows, food and blocks (64 at most), the armor carried', () => {
  const kit = tripKitItems([
    { name: 'diamond_sword', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'bow', count: 1 },
    { name: 'arrow', count: 64 }, { name: 'arrow', count: 64 }, { name: 'cooked_beef', count: 48 }, { name: 'bread', count: 4 },
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 10 }, { name: 'andesite', count: 30 },
    { name: 'iron_helmet', count: 1 }, { name: 'golden_apple', count: 2 }, { name: 'ender_eye', count: 12 }
  ])
  const by = Object.fromEntries(kit.map(k => [k.name, k.count]))
  assert.deepStrictEqual(by, { iron_sword: 1, arrow: 64, cooked_beef: 24, cobblestone: 64, iron_helmet: 1, golden_apple: 1 })
  // nothing spare: nothing taken
  assert.deepStrictEqual(tripKitItems([{ name: 'diamond_sword', count: 1 }, { name: 'arrow', count: 20 }]), [])
})

test('after a death the runner goes to a trip kit that still holds something, and takes it', async () => {
  const { Runner } = await import('../../src/runner')
  const { EventEmitter } = await import('node:events')
  const { TaskRunner } = await import('../../src/core/taskRunner')
  const { WorldMemory } = await import('../../src/core/memory')
  const { Vec3 } = await import('vec3')
  const bot: any = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.inventory = { slots: new Array(46).fill(null), items: () => [] }
  bot.entity = { position: new Vec3(2351, -22, 1016) }
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.time = { timeOfDay: 1000 }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot), handlers: {}, advancements: new Set() }
  const runner = new Runner(bot, { log: () => {} })
  assert.strictEqual(await runner.tripRekit(), null)
  bot.survival.memory.addPoi('trip_kit', { x: 2352, y: -22, z: 1016 }, 'overworld', 'spare kit')
  bot.survival.memory.rememberChest({ x: 2352, y: -22, z: 1016 }, {}, 'overworld')
  assert.strictEqual(await runner.tripRekit(), null, 'an empty one is no kit')
  bot.survival.memory.rememberChest({ x: 2352, y: -22, z: 1016 }, { iron_sword: 1, arrow: 64 }, 'overworld')
  const tasks: string[] = []
  runner.executor.task = (async (name: string) => { tasks.push(name); return { iron_sword: 1, arrow: 64 } }) as any
  assert.deepStrictEqual(await runner.tripRekit(), { iron_sword: 1, arrow: 64 })
  assert.deepStrictEqual(tasks, ['the trip kit'])
})

test('leaveTripKit fills the kit\'s emptied chest again, making no new chest or bed', async () => {
  const { leaveTripKit } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(2351.5, -22, 1016.5) })
  bot.game.dimension = 'overworld'
  const chest = new Vec3(2352, -22, 1016)
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => p.equals?.(chest) ? { name: 'chest', position: chest } : realAt(p)) as any
  const memory = new WorldMemory()
  memory.addPoi('trip_kit', chest, 'overworld', 'spare kit')
  memory.rememberChest(chest, { arrow: 0 }, 'overworld')
  const calls: string[] = []
  const executor: any = {
    memory,
    plan: () => { calls.push('plan'); return { ok: true, cost: 0 } },
    obtain: async () => { calls.push('obtain') },
    task: async (name: string) => { calls.push(name); return { chest, stored: { arrow: 32 }, bed: null } }
  }
  await leaveTripKit(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls, ['leave a trip kit'])
})

test('nearPortal: a cell 2 or fewer blocks from a portal\'s blocks is not for the kit', async () => {
  const { nearPortal } = await import('../../src/skills/tripKit')
  const { Vec3 } = await import('vec3')
  const world = (p: any) => ({ name: p.x === 0 && p.y >= 64 && p.y <= 66 && p.z === 0 ? 'nether_portal' : 'air' })
  assert.strictEqual(nearPortal(world, new Vec3(1, 64, 1)), true)
  assert.strictEqual(nearPortal(world, new Vec3(3, 64, 0)), false)
})

test('withTickBudget: the work is aborted once its ticks are gone', async () => {
  const { withTickBudget } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot()
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const r = await withTickBudget(bot, 50, new AbortController().signal, async () => 'quick')
    assert.strictEqual(r, 'quick')
    await assert.rejects(withTickBudget(bot, 5, new AbortController().signal, async (s) => await new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(s.reason)))), /budget of 5 ticks/)
  } finally {
    clearInterval(ticking)
  }
})
