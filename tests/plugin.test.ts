import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { createPlugin, TaskError, nether, end, worldgen } from '../src'

function fakeBot (): any {
  const bot: any = new EventEmitter()
  bot.pathfinder = {}
  bot.loadPlugin = () => { throw new Error('pathfinder already loaded') }
  bot.entity = { position: { x: 1.5, y: 64, z: -2.5 } }
  bot.game = { dimension: 'minecraft:the_nether' }
  bot.inventory = new EventEmitter()
  return bot
}

test('createPlugin sets bot.survival with the default options', () => {
  const bot = fakeBot()
  createPlugin()(bot)
  assert.deepStrictEqual(bot.survival.options, { loadPathfinder: true, reflexes: true })
  assert.ok(bot.survival.reflexes != null)
})

test('createPlugin without reflexes', () => {
  const bot = fakeBot()
  createPlugin({ reflexes: false })(bot)
  assert.strictEqual(bot.survival.reflexes, null)
})

test('on death the tasks fail with DIED and the death spot is remembered', async () => {
  const bot = fakeBot()
  createPlugin()(bot)
  const task = bot.survival.tasks.run('mine', async (ctx: any) => { await ctx.waitTicks(100) })
  const rejected = assert.rejects(task, (err: unknown) => TaskError.is(err, 'DIED'))
  await new Promise(resolve => setImmediate(resolve))
  bot.emit('physicsTick')
  bot.emit('death')
  await rejected
  assert.deepStrictEqual(bot.survival.memory.death, { x: 1, y: 64, z: -3, dimension: 'the_nether', seen: 1 })
})

test('the nether, end and worldgen helpers are exported by namespace', () => {
  assert.equal(typeof nether.planLavaCast, 'function')
  assert.equal(typeof end.triangulate, 'function')
  assert.equal(typeof worldgen.getPotentialStructureChunk, 'function')
})

test('a death in the overworld under a roof is remembered as underground (the runner leaves its spot)', async () => {
  const { Vec3 } = await import('vec3')
  for (const roofed of [true, false]) {
    const bot = fakeBot()
    bot.game = { dimension: 'minecraft:overworld' }
    bot.entity = { position: new Vec3(1.5, 20, -2.5) }
    // rock from y 40 up to 63 over the spot, or open sky
    bot.blockAt = (p: any) => roofed && p.y >= 40 && p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
    createPlugin()(bot)
    bot.emit('death')
    assert.strictEqual(bot.survival.memory.death.underground, roofed)
  }
})
