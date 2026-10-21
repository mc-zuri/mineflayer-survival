import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { DEFAULT_SCAFFOLDING_BLOCKS, scaffoldCount, scaffoldItem } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin, Recorder, TaskError, nether, end, worldgen } from '../src'
import { SCAFFOLD_ITEMS } from '../src/executor/steps'

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
  assert.deepStrictEqual(bot.survival.options, { loadPathfinder: true, reflexes: true, diagnostics: {}, stock: {}, spawnProtection: 'auto', recorder: false })
  assert.strictEqual(bot.survival.recorder, null, 'no recording by default')
  assert.ok(bot.survival.stock != null, 'the stock policy is on by default')
  assert.ok(bot.survival.reflexes != null)
  assert.deepStrictEqual(bot.survival.diagnostics.lastReports(), [])
})

test('createPlugin with the recorder: its options (in memory here), or a recorder made before, hooked on the tasks', async () => {
  const bot = fakeBot()
  createPlugin({ recorder: { stateEvery: 0 } })(bot)
  const rec = bot.survival.recorder
  assert.ok(rec instanceof Recorder)
  await bot.survival.tasks.run('chop', async () => 1)
  assert.strictEqual(rec.counts.task, 2)
  await rec.stop()
  const early = fakeBot()
  const before = new Recorder(early, { stateEvery: 0 })
  createPlugin({ recorder: before })(early)
  assert.strictEqual(early.survival.recorder, before)
  await early.survival.tasks.run('chop', async () => 1)
  assert.strictEqual(before.counts.task, 2)
  await before.stop()
})

test('createPlugin with stock options, or the stock policy off', () => {
  const bot = fakeBot()
  createPlugin({ stock: { overrides: { iron: { low: 8, high: 16 } }, keep: { raw_iron: 4 } } })(bot)
  assert.deepStrictEqual(bot.survival.stock.marks.find((m: any) => m.id === 'iron')?.high, 16)
  assert.strictEqual(bot.survival.stock.keepCount('raw_iron'), 4)
  const off = fakeBot()
  createPlugin({ stock: false })(off)
  assert.strictEqual(off.survival.stock, null)
  const disabled = fakeBot()
  createPlugin({ stock: { enabled: false } })(disabled)
  assert.strictEqual(disabled.survival.stock, null)
})

test('createPlugin gives the pathfinder SCAFFOLD_ITEMS to build with: its budget and its places go by the survival list', () => {
  const bot = fakeBot()
  const before = { canDig: false, scaffoldReserve: 4, scaffoldingBlocks: [...DEFAULT_SCAFFOLDING_BLOCKS] }
  bot.pathfinder = { defaultMoveSettings: before, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  // stone bricks (a stronghold's) are the survival list's, not the pathfinder's own
  bot.inventory.items = () => [{ name: 'stone_bricks', count: 20 }, { name: 'cobblestone', count: 3 }, { name: 'netherrack', count: 5 }]
  assert.strictEqual(scaffoldCount(bot, before.scaffoldingBlocks), 8)
  createPlugin()(bot)
  const settings = bot.pathfinder.defaultMoveSettings
  assert.deepStrictEqual(settings.scaffoldingBlocks, SCAFFOLD_ITEMS)
  assert.strictEqual(settings.canDig, false, 'the other settings are kept')
  // no drop into water from any height (a 42-block ForwardDropDown fell short of its water, full-26.3-fresh-s)
  assert.strictEqual(settings.infiniteLiquidDropdownDistance, false)
  assert.strictEqual(scaffoldCount(bot, settings.scaffoldingBlocks), 28)
  // cheapest first: the netherrack before the cobblestone
  assert.strictEqual(scaffoldItem(bot, settings.scaffoldingBlocks)?.name, 'netherrack')
  // the End's pillars and the shelter's towers build of the same list
  assert.strictEqual(end.skills.SCAFFOLD_ITEMS, SCAFFOLD_ITEMS)
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

test('a death whose slots the server emptied before its health of 0 came is remembered with what the bot had: at the combat kill, else the last look', async () => {
  const { Vec3 } = await import('vec3')
  const setup = (): any => {
    const bot = fakeBot()
    bot._client = new EventEmitter()
    bot.game = { dimension: 'minecraft:overworld' }
    bot.entity = { id: 7, position: new Vec3(1.5, 64, -2.5) }
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    let items: any[] = [{ name: 'diamond_sword' }, { name: 'cobblestone' }]
    bot.inventory.items = () => items
    bot.inventory.slots = []
    bot.empty = () => { items = [] }
    createPlugin()(bot)
    return bot
  }
  // the combat kill's look (ServerPlayer.die), the slots emptied after, then the death
  const killed = setup()
  killed._client.emit('death_combat_event', { playerId: 7 })
  killed.empty()
  killed.emit('death')
  assert.strictEqual(killed.survival.memory.death.worth, true)
  assert.strictEqual(killed.survival.memory.death.dear, true)
  // no combat kill seen: the last look, every 20 ticks
  const looked = setup()
  for (let i = 0; i < 20; i++) looked.emit('physicsTick')
  looked.empty()
  looked.emit('death')
  assert.strictEqual(looked.survival.memory.death.worth, true)
  // with nothing before either: nothing worth the trip
  const bare = setup()
  bare.empty()
  bare.emit('death')
  assert.strictEqual(bare.survival.memory.death.worth, false)
})
