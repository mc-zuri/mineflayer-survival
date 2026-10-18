import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { collectBlock, columnHarvestTarget, COLUMN_PLANTS, lavaBeside } from '../../src/skills/collectBlock'
import { fakeBot, item } from '../reflexes/fakeBot'

// blocks by "x,y,z"; air elsewhere
function world (blocks: Record<string, string>): (pos: Vec3) => { name: string } {
  return pos => ({ name: blocks[`${pos.x},${pos.y},${pos.z}`] ?? 'air' })
}

test('columnHarvestTarget: the second block of a sugar cane column, from any block of it; none for a column of one', () => {
  const lookup = world({ '0,0,0': 'sand', '0,1,0': 'sugar_cane', '0,2,0': 'sugar_cane', '0,3,0': 'sugar_cane', '2,1,0': 'sugar_cane' })
  for (const y of [1, 2, 3]) assert.deepStrictEqual(columnHarvestTarget(lookup, new Vec3(0, y, 0)), new Vec3(0, 2, 0), `from y ${y}`)
  // a lone cane is left to grow
  assert.strictEqual(columnHarvestTarget(lookup, new Vec3(2, 1, 0)), null)
  assert.strictEqual(columnHarvestTarget(lookup, new Vec3(5, 1, 0)), null)
  // a bamboo column, two high
  const bamboo = world({ '0,1,0': 'bamboo', '0,2,0': 'bamboo' })
  assert.deepStrictEqual(columnHarvestTarget(bamboo, new Vec3(0, 2, 0)), new Vec3(0, 2, 0))
  assert.ok(COLUMN_PLANTS.has('sugar_cane') && COLUMN_PLANTS.has('cactus') && !COLUMN_PLANTS.has('oak_log'))
})

test('collectBlock leaves the excluded blocks alone (the base\'s walls): none left to break is NOT_FOUND', async () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  const walls = [new Vec3(2, 63, 0), new Vec3(3, 63, 0)]
  bot.findBlocks = () => walls
  let dug = 0
  bot.dig = async () => { dug++ }
  await assert.rejects(collectBlock(bot, { names: ['stone'], count: 1, exclude: pos => pos.x >= 2 }), (err: any) => err.code === 'NOT_FOUND' && /no more stone/.test(err.message))
  assert.strictEqual(dug, 0)
})

test('collectBlock picks up what the broken blocks drop, not the sticks of leaves decaying up a tree', async () => {
  const registry = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const blocks = new Map<string, string>([['2,63,0', 'stone']])
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wooden_pickaxe')], world: (pos: Vec3) => blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? (pos.y < 64 ? 'dirt' : 'air') })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => [...blocks.keys()].filter(k => blocks.get(k) === 'stone').map(k => new Vec3(...k.split(',').map(Number) as [number, number, number]))
  bot._client = { on: () => {}, off: () => {} }
  bot.inventory.inventoryStart = 9
  bot.inventory.inventoryEnd = 45
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: () => null }
  bot.equip = async () => {}
  const drop = (id: number, name: string, pos: Vec3): any => ({ id, name: 'item', position: pos, getDroppedItem: () => new Item(registry.itemsByName[name].id, 1) })
  bot.dig = async (block: any) => {
    blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
    // the cobblestone falls out of the broken block; a stick from the leaves above lies 5 blocks up
    bot.entities[50] = drop(50, 'cobblestone', new Vec3(2.5, 63.2, 0.5))
    bot.entities[51] = drop(51, 'stick', new Vec3(2.5, 68.5, 0.5))
  }
  const goals: any[] = []
  bot.pathfinder = {
    isPathing: false,
    goto: async (goal: any) => {
      goals.push(goal)
      // walking onto the cobblestone picks it up
      if (goal.item?.y < 64) { delete bot.entities[50]; bot.inventory.slots[10] = new Item(registry.itemsByName.cobblestone.id, 1); bot.inventory.slots[10].slot = 10 }
    },
    cancel: async () => {}
  }
  bot.waitForTicks = async () => {}
  // the ticks the skill's waits count
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const res = await collectBlock(bot, { names: ['stone'], count: 1 })
    assert.strictEqual(res.mined, 1)
    assert.deepStrictEqual(res.items, { cobblestone: 1 })
    assert.ok(goals.every(g => g.item == null || g.item.y < 64), `went for the stick: ${goals.map(g => g.item?.toString()).join(' ')}`)
  } finally {
    clearInterval(ticker)
  }
})

test('collectBlock gives up after 3 targets in a row it can\'t get to (it used to try every block it found)', async () => {
  const registry = require('minecraft-data')('1.21.11')
  const logs = [10, 11, 12, 13, 14, 15].map(x => new Vec3(x, 80, 0))
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (pos: Vec3) => logs.some(l => l.equals(pos)) ? 'oak_log' : pos.y < 64 ? 'stone' : 'air' })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.findBlocks = () => logs
  bot._client = { on: () => {}, off: () => {} }
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: () => null }
  let trips = 0
  // the pathfinder plans short of each log, up a cliff
  bot.pathfinder = { isPathing: false, goto: async () => { trips++ }, cancel: async () => {}, world: {} }
  await assert.rejects(collectBlock(bot, { names: ['oak_log'], count: 1 }), (err: any) => err.code === 'NO_PATH')
  assert.strictEqual(trips, 3)
})

test('collectBlock passes over an ore with lava beside or over it (broken, it opens the lava onto the bot)', async () => {
  const ores = [new Vec3(2, 40, 0), new Vec3(-3, 40, 0)]
  const lookup = (pos: Vec3): { name: string } => ores.some(o => o.equals(pos)) ? { name: 'iron_ore' } : pos.equals(new Vec3(2, 41, 0)) ? { name: 'lava' } : { name: 'stone' }
  assert.ok(lavaBeside(lookup, ores[0]))
  assert.ok(!lavaBeside(lookup, ores[1]))
  const bot = fakeBot({ position: new Vec3(0.5, 40, 0.5), world: (pos: Vec3) => lookup(pos).name })
  bot.findBlocks = () => ores
  // the one away from the lava is the one gone for
  const targets: string[] = []
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: (block: any) => { targets.push(block.position.toString()); throw new Error('the test stops here') } }
  await assert.rejects(collectBlock(bot, { names: ['iron_ore'], count: 1 }), /the test stops here/)
  assert.deepStrictEqual(targets, [ores[1].toString()])
  // with nothing but lava-touched ore: none found
  bot.findBlocks = () => [ores[0]]
  await assert.rejects(collectBlock(bot, { names: ['iron_ore'], count: 1 }), (err: any) => err.code === 'NOT_FOUND')
})

test('collectBlock with anyTool breaks a block by hand that the bag has no harvest tool for (a way out of a mine), and expects no drop', async () => {
  const registry = require('minecraft-data')('1.21.11')
  const blocks = new Map<string, string>([['1,64,0', 'stone']])
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (pos: Vec3) => blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? (pos.y < 64 ? 'stone' : 'air') })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => { const b = blockAt(pos); b.type = registry.blocksByName[b.name].id; b.harvestTools = registry.blocksByName[b.name].harvestTools; return b }
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: () => null }
  let dug = 0
  bot.dig = async (block: any) => { dug++; blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, 'air') }
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(collectBlock(bot, { positions: [new Vec3(1, 64, 0)] }), (err: any) => err.code === 'NO_TOOL')
    assert.strictEqual(dug, 0)
    const res = await collectBlock(bot, { positions: [new Vec3(1, 64, 0)], anyTool: true })
    assert.strictEqual(res.mined, 1)
    assert.strictEqual(dug, 1)
  } finally {
    clearInterval(ticker)
  }
})
