import { test } from 'node:test'
import assert from 'node:assert'
import { burnTicks, chooseFuel, SMELT_TICKS } from '../../src/skills/smelt'

test('burnTicks: vanilla fuel values, the nether woods not burning', () => {
  assert.strictEqual(burnTicks('coal'), 1600)
  assert.strictEqual(burnTicks('charcoal'), 1600)
  assert.strictEqual(burnTicks('oak_planks'), 300)
  assert.strictEqual(burnTicks('spruce_log'), 300)
  assert.strictEqual(burnTicks('oak_slab'), 150)
  assert.strictEqual(burnTicks('stick'), 100)
  assert.strictEqual(burnTicks('lava_bucket'), 20000)
  assert.strictEqual(burnTicks('coal_block'), 16000)
  assert.strictEqual(burnTicks('crimson_planks'), 0)
  assert.strictEqual(burnTicks('warped_stem'), 0)
  assert.strictEqual(burnTicks('stone_slab'), 0)
  assert.strictEqual(burnTicks('cobblestone'), 0)
})

test('chooseFuel burns coal before wood, and only as much as the smelt needs', () => {
  const items = [{ name: 'oak_planks', count: 10 }, { name: 'coal', count: 5 }, { name: 'raw_iron', count: 3 }]
  assert.deepStrictEqual(chooseFuel(items, 3 * SMELT_TICKS), { name: 'coal', count: 1, ticks: 1600 })
  assert.deepStrictEqual(chooseFuel(items, 20 * SMELT_TICKS), { name: 'coal', count: 3, ticks: 4800 })
})

test('chooseFuel burns planks before logs and sticks, and all it has when they fall short', () => {
  const items = [{ name: 'stick', count: 8 }, { name: 'oak_log', count: 4 }, { name: 'birch_planks', count: 1 }]
  assert.deepStrictEqual(chooseFuel(items, 3 * SMELT_TICKS), { name: 'birch_planks', count: 1, ticks: 300 })
  assert.deepStrictEqual(chooseFuel(items.slice(0, 2), 3 * SMELT_TICKS), { name: 'oak_log', count: 2, ticks: 600 })
  assert.deepStrictEqual(chooseFuel([{ name: 'stick', count: 2 }], 3 * SMELT_TICKS), { name: 'stick', count: 2, ticks: 200 })
})

test('chooseFuel keeps lava buckets and tools, and honours the fuel asked for', () => {
  const items = [{ name: 'lava_bucket', count: 1 }, { name: 'wooden_pickaxe', count: 1 }]
  assert.strictEqual(chooseFuel(items, SMELT_TICKS), null)
  assert.deepStrictEqual(chooseFuel(items, SMELT_TICKS, 'lava_bucket'), { name: 'lava_bucket', count: 1, ticks: 20000 })
  assert.strictEqual(chooseFuel(items, SMELT_TICKS, 'coal'), null)
})

test('smelt fuels the furnace from what its window reaches: not the planks in the off hand', async () => {
  const { Vec3 } = await import('vec3')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { smelt } = await import('../../src/skills/smelt')
  const registry = require('minecraft-data')('1.21.11')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('raw_iron', 1), item('stick', 8)], offhand: item('oak_planks', 8) })
  bot.findBlock = () => ({ name: 'furnace', type: registry.blocksByName.furnace.id, position: new Vec3(1, 64, 0) })
  bot._client = { on: () => {}, off: () => {} }
  const fuelled: string[] = []
  const slots: Record<string, any> = { input: null, fuel: null, output: null }
  const window: any = {
    totalProgress: 0, fuel: 0, totalFuel: 0, progress: 0,
    items: () => bot.inventory.items(),
    inputItem: () => slots.input, fuelItem: () => slots.fuel, outputItem: () => slots.output,
    putInput: async (type: number, _m: unknown, n: number) => { slots.input = { name: registry.items[type].name, count: n } },
    putFuel: async (type: number, _m: unknown, n: number) => {
      const name = registry.items[type].name
      if (!bot.inventory.items().some((i: any) => i.name === name)) throw new Error(`Can't find ${name} in slots`)
      fuelled.push(name)
      slots.fuel = { name, count: n }
      window.fuel = 1
    },
    takeOutput: async () => { slots.output = null },
    takeFuel: async () => {},
    close: () => {}
  }
  bot.openFurnace = async () => window
  // the furnace cooks it in the next tick
  const tick = setInterval(() => { if (slots.input != null && slots.fuel != null) { slots.output = { name: 'iron_ingot', count: 1, stackSize: 64 }; slots.input = null; window.fuel = 0 } bot.emit('physicsTick') }, 1)
  try {
    await smelt(bot, { input: 'raw_iron', count: 1 }).catch(() => {})
  } finally {
    clearInterval(tick)
  }
  assert.deepStrictEqual(fuelled, ['stick'])
})
