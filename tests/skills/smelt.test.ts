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

test('a smelt that runs out of fuel takes what is in the furnace back out before it fails', async () => {
  const { Vec3 } = await import('vec3')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { smelt } = await import('../../src/skills/smelt')
  const registry = require('minecraft-data')('1.21.11')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('raw_iron', 3), item('stick', 1)] })
  bot.findBlock = () => ({ name: 'furnace', type: registry.blocksByName.furnace.id, position: new Vec3(1, 64, 0) })
  bot._client = { on: () => {}, off: () => {} }
  const slots: Record<string, any> = { input: null, fuel: null, output: null }
  const taken: string[] = []
  const window: any = {
    totalProgress: 0, fuel: 0, totalFuel: 0, progress: 0,
    items: () => bot.inventory.items(),
    inputItem: () => slots.input, fuelItem: () => slots.fuel, outputItem: () => slots.output,
    putInput: async (type: number, _m: unknown, n: number) => { slots.input = { name: registry.items[type].name, count: n } },
    putFuel: async (type: number, _m: unknown, n: number) => { slots.fuel = { name: registry.items[type].name, count: n }; window.fuel = 1 },
    takeOutput: async () => { taken.push(`output ${String(slots.output?.name)}`); slots.output = null },
    takeInput: async () => { taken.push(`input ${String(slots.input?.name)} ${String(slots.input?.count)}`); slots.input = null },
    takeFuel: async () => { slots.fuel = null },
    close: () => {}
  }
  bot.openFurnace = async () => window
  // the stick burns out after one ingot: 2 raw iron left in, nothing more to burn
  let burnt = 0
  const tick = setInterval(() => {
    if (slots.fuel != null && burnt === 0) { burnt++; slots.fuel = null; slots.input = { ...slots.input, count: slots.input.count - 1 }; slots.output = { name: 'iron_ingot', count: 1, stackSize: 64 }; window.fuel = 0 }
    bot.emit('physicsTick')
  }, 1)
  let error: any
  try {
    await smelt(bot, { input: 'raw_iron', count: 3, stallTicks: 50 }).catch(err => { error = err })
  } finally {
    clearInterval(tick)
  }
  assert.ok(error != null && /fuel|get on/.test(error.message), String(error?.message))
  assert.ok(taken.includes('input raw_iron 2'), taken.join(', '))
  assert.equal(slots.input, null)
  assert.equal(slots.output, null)
})

test('a big smelt is shared out among the furnaces as evenly as can be', async () => {
  const { shareOut, PARALLEL_FURNACES, PARALLEL_MIN_ITEMS } = await import('../../src/skills/smelt')
  assert.deepStrictEqual(shareOut(33, 3), [11, 11, 11])
  assert.deepStrictEqual(shareOut(13, 3), [5, 4, 4])
  assert.deepStrictEqual(shareOut(2, 3), [1, 1])
  assert.deepStrictEqual(shareOut(5, 1), [5])
  // the furnaces a 33-iron smelt takes: a third of the time at them
  assert.ok(Math.max(...shareOut(33, PARALLEL_FURNACES)) * 3 <= 33)
  assert.ok(PARALLEL_MIN_ITEMS >= PARALLEL_FURNACES * 4)
})

test('smeltParallel picks up one furnace after (FURNACES_CARRIED), the rest left standing, and a smelt after uses the ones standing near before making more', async () => {
  // (26.3 seed 2: 4 furnaces in the bag down the diamonds' mine)
  const { Vec3 } = await import('vec3')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const smeltModule = await import('../../src/skills/smelt')
  const placeModule = require('../../src/skills/placeBlock')
  const collectModule = require('../../src/skills/collectBlock')
  const craftModule = require('../../src/skills/craft')
  const registry = require('minecraft-data')('1.21.11')
  const furnaces = new Map<string, { input: any, fuel: any, output: any }>()
  const key = (p: any): string => `${p.x},${p.y},${p.z}`
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('raw_iron', 12), item('coal', 4), item('furnace', 3)], world: (pos: Vec3) => furnaces.has(key(pos)) ? 'furnace' : pos.y < 64 ? 'stone' : 'air' })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; return b }
  bot.findBlocks = () => [...furnaces.keys()].map(k => new Vec3(...k.split(',').map(Number) as [number, number, number]))
  bot._client = { on: () => {}, off: () => {} }
  const take = (name: string, n: number): void => { const it = bot.inventory.items().find((i: any) => i.name === name); it.count -= n; if (it.count <= 0) bot.inventory.slots[it.slot] = null }
  const give = (name: string, n: number): void => {
    const it = bot.inventory.items().find((i: any) => i.name === name)
    if (it != null) { it.count += n; return }
    const slot = bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && i < 45 && s == null)
    bot.inventory.slots[slot] = item(name, n)
    bot.inventory.slots[slot].slot = slot
  }
  const real = { place: placeModule.placeBlock, collect: collectModule.collectBlock, craft: craftModule.craft }
  placeModule.placeBlock = async (_bot: any, args: any) => { take('furnace', 1); furnaces.set(key(args.pos), { input: null, fuel: null, output: null }) }
  collectModule.collectBlock = async (_bot: any, args: any) => { furnaces.delete(key(args.positions[0])); give('furnace', 1); return { mined: 1, positions: args.positions, items: {}, count: 1 } }
  let crafted = 0
  craftModule.craft = async () => { crafted++; give('furnace', 1) }
  bot.openFurnace = async (block: any) => {
    const f = furnaces.get(key(block.position)) as any
    return {
      items: () => bot.inventory.items(),
      inputItem: () => f.input, fuelItem: () => f.fuel, outputItem: () => f.output,
      putInput: async (type: number, _m: unknown, n: number) => { take(registry.items[type].name, n); f.output = { name: 'iron_ingot', count: n } },
      putFuel: async (type: number, _m: unknown, n: number) => { take(registry.items[type].name, n) },
      takeOutput: async () => { give(f.output.name, f.output.count); f.output = null },
      takeInput: async () => { f.input = null },
      takeFuel: async () => { f.fuel = null },
      close: () => {}
    }
  }
  const ticker = setInterval(() => bot.emit('physicsTick'), 0)
  try {
    assert.strictEqual(await smeltModule.smeltParallel(bot, { input: 'raw_iron', count: 12 }), 12)
    const count = (name: string): number => bot.inventory.items().filter((i: any) => i.name === name).reduce((n: number, i: any) => n + i.count, 0)
    assert.strictEqual(count('furnace'), smeltModule.FURNACES_CARRIED)
    assert.strictEqual(furnaces.size, 2)
    // the next big smelt here: the two standing and the bag's, none made
    give('raw_iron', 12)
    give('coal', 4)
    give('cobblestone', 64)
    assert.strictEqual(await smeltModule.smeltParallel(bot, { input: 'raw_iron', count: 12 }), 12)
    assert.strictEqual(crafted, 0)
    assert.strictEqual(count('furnace'), 1)
    assert.strictEqual(furnaces.size, 2)
  } finally {
    clearInterval(ticker)
    placeModule.placeBlock = real.place
    collectModule.collectBlock = real.collect
    craftModule.craft = real.craft
  }
})
