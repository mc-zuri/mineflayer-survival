import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { chestLids, isRedstoneConductor, storeItems } from '../../src/skills/chest'
import { fakeBot, item } from '../reflexes/fakeBot'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

test('chestLids: a single chest\'s cell over it; a double chest\'s over both halves (ChestBlock.getConnectedDirection)', () => {
  const at = new Vec3(0, 64, 0)
  const chest = (props: Record<string, string>): any => ({ name: 'chest', position: at, getProperties: () => props })
  assert.deepStrictEqual(chestLids(chest({ facing: 'north', type: 'single' })).map(String), ['(0, 65, 0)'])
  // facing north, the left half's other half is clockwise (east), the right half's counter-clockwise (west)
  assert.deepStrictEqual(chestLids(chest({ facing: 'north', type: 'left' })).map(String), ['(0, 65, 0)', '(1, 65, 0)'])
  assert.deepStrictEqual(chestLids(chest({ facing: 'north', type: 'right' })).map(String), ['(0, 65, 0)', '(-1, 65, 0)'])
  assert.deepStrictEqual(chestLids(chest({ facing: 'east', type: 'left' })).map(String), ['(0, 65, 0)', '(0, 65, 1)'])
})

test('isRedstoneConductor: a full block conducts, glass and leaves and a slab or torch don\'t', () => {
  const full = [[0, 0, 0, 1, 1, 1]]
  assert.strictEqual(isRedstoneConductor({ name: 'stone', boundingBox: 'block', shapes: full }), true)
  assert.strictEqual(isRedstoneConductor({ name: 'cobblestone', boundingBox: 'block', shapes: full }), true)
  assert.strictEqual(isRedstoneConductor({ name: 'glass', boundingBox: 'block', shapes: full }), false)
  assert.strictEqual(isRedstoneConductor({ name: 'oak_leaves', boundingBox: 'block', shapes: full }), false)
  assert.strictEqual(isRedstoneConductor({ name: 'stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] }), false)
  assert.strictEqual(isRedstoneConductor({ name: 'torch', boundingBox: 'empty', shapes: [] }), false)
  assert.strictEqual(isRedstoneConductor({ name: 'air', boundingBox: 'empty' }), false)
})

test('storeItems breaks the block over a chest before opening it: a chest under a full block doesn\'t open (ChestBlock.isChestBlockedAt)', async () => {
  // (26.3 seed 2: the base's one chest under its wall's stone, every store 'windowOpen did not fire within 20000ms')
  const chestPos = new Vec3(2, 64, 0)
  const blocks = new Map<string, string>([['2,64,0', 'chest'], ['2,65,0', 'stone']])
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('cobblestone', 64), item('iron_pickaxe')], world: (pos: Vec3) => blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? (pos.y < 64 ? 'stone' : 'air') })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => {
    const b = blockAt(pos)
    b.type = registry.blocksByName[b.name].id
    b.harvestTools = registry.blocksByName[b.name].harvestTools
    b.shapes = b.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []
    if (b.name === 'chest') b.getProperties = () => ({ facing: 'west', type: 'single', waterlogged: false })
    return b
  }
  bot._client = new EventEmitter()
  bot.pathingUtil = { refresh: () => {}, bestHarvestingTool: () => null }
  bot.pathfinder = { world: {} }
  bot.equip = async () => {}
  const dug: string[] = []
  bot.dig = async (block: any) => { dug.push(block.position.toString()); blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, 'air') }
  const chestItems: any[] = []
  bot.openContainer = async (block: any) => {
    // the server sends no window for a chest that's blocked
    if (blocks.get(`${block.position.x},${block.position.y + 1},${block.position.z}`) !== 'air') throw new Error('Event windowOpen did not fire within timeout of 20000ms')
    return {
      slots: new Array(63).fill(null),
      inventoryStart: 27,
      inventoryEnd: 63,
      items: () => bot.inventory.items(),
      containerItems: () => chestItems,
      deposit: async (type: number, _meta: unknown, count: number) => {
        const slot = bot.inventory.items().find((i: any) => i.type === type)
        slot.count -= count
        if (slot.count <= 0) bot.inventory.slots[slot.slot] = null
        chestItems.push(item(registry.items[type].name, count))
      },
      close: () => {}
    }
  }
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const res = await storeItems(bot, { chest: chestPos, filter: ['cobblestone'] })
    assert.deepStrictEqual(res.moved, { cobblestone: 64 })
  } finally {
    clearInterval(ticker)
  }
  assert.deepStrictEqual(dug, ['(2, 65, 0)'])
})

test('roomFor: a store takes no more than the chest\'s empty slots and its stacks of the item lack (28 stacks into 27 slots moved 1792 out, 1728 in)', () => {
  const { roomFor } = require('../../src/skills/chest')
  const iron = registry.itemsByName.raw_iron.id
  const slots: any[] = new Array(63).fill(null)
  slots[0] = { type: iron, count: 60 }
  slots[1] = { type: registry.itemsByName.cobblestone.id, count: 64 }
  for (let i = 2; i < 27; i++) slots[i] = { type: iron, count: 64 }
  const window = { slots, inventoryStart: 27, inventoryEnd: 63 }
  assert.strictEqual(roomFor(window, iron, 64, true), 4)
  slots[5] = null
  assert.strictEqual(roomFor(window, iron, 64, true), 68)
  // the inventory's side: 36 empty slots
  assert.strictEqual(roomFor(window, iron, 64, false), 36 * 64)
})

test('storeItems leaves the bag its protected items (keep.ts protectedCounts): the best pickaxe and the water bucket stay, the spare pickaxe goes; a shield in the off hand frees the bag\'s', async () => {
  // (26.3 whole game: the bot's diamond pickaxe was no pickaxe for the obsidian, 160 blocks from the base)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('diamond_pickaxe'), item('iron_pickaxe'), item('water_bucket'), item('shield'), item('cobblestone', 64)], offhand: item('shield'), world: (pos: Vec3) => pos.equals(new Vec3(2, 64, 0)) ? 'chest' : pos.y < 64 ? 'stone' : 'air' })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => {
    const b = blockAt(pos)
    b.type = registry.blocksByName[b.name].id
    if (b.name === 'chest') b.getProperties = () => ({ facing: 'west', type: 'single', waterlogged: false })
    return b
  }
  bot._client = new EventEmitter()
  bot.pathfinder = { world: {} }
  const chestItems: any[] = []
  bot.openContainer = async () => ({
    slots: new Array(63).fill(null),
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => bot.inventory.items(),
    containerItems: () => chestItems,
    deposit: async (type: number, _meta: unknown, count: number) => {
      const slot = bot.inventory.items().find((i: any) => i.type === type)
      slot.count -= count
      if (slot.count <= 0) bot.inventory.slots[slot.slot] = null
      chestItems.push(item(registry.items[type].name, count))
    },
    close: () => {}
  })
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const res = await storeItems(bot, { chest: new Vec3(2, 64, 0) })
    assert.deepStrictEqual(res.moved, { iron_pickaxe: 1, shield: 1, cobblestone: 64 })
    assert.deepStrictEqual(bot.inventory.items().map((i: any) => i.name).sort(), ['diamond_pickaxe', 'water_bucket'])
  } finally {
    clearInterval(ticker)
  }
})

/** a bot by a chest at (2, 64, 0) (the other half of a double chest at (2, 64, 1) when `double`), its window over `inChest` */
function chestBot (bag: any[], inChest: Record<string, number>, opts: { double?: boolean, block?: string } = {}): any {
  const { WorldMemory } = require('../../src/core/memory')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: bag, world: (pos: Vec3) => pos.equals(new Vec3(2, 64, 0)) || (opts.double === true && pos.equals(new Vec3(2, 64, 1))) ? (opts.block ?? 'chest') : pos.y < 64 ? 'stone' : 'air' })
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => {
    const b = blockAt(pos)
    b.type = registry.blocksByName[b.name].id
    // facing west, the left half's other half is clockwise: north (z - 1); the right half's south (z + 1)
    if (b.name === 'chest') b.getProperties = () => ({ facing: 'west', type: opts.double === true ? (pos.z === 0 ? 'right' : 'left') : 'single', waterlogged: false })
    return b
  }
  bot._client = new EventEmitter()
  bot.pathfinder = { world: {} }
  bot.survival = { memory: new WorldMemory() }
  bot.opened = 0
  bot.openContainer = async () => {
    bot.opened++
    return {
      slots: new Array(63).fill(null),
      inventoryStart: 27,
      inventoryEnd: 63,
      items: () => bot.inventory.items(),
      containerItems: () => Object.entries(inChest).filter(([, n]) => n > 0).map(([name, n]) => item(name, n)),
      deposit: async (type: number, _meta: unknown, count: number) => {
        const slot = bot.inventory.items().find((i: any) => i.type === type)
        slot.count -= count
        if (slot.count <= 0) bot.inventory.slots[slot.slot] = null
        const name = registry.items[type].name
        inChest[name] = (inChest[name] ?? 0) + count
      },
      withdraw: async (type: number, _meta: unknown, count: number) => {
        const name = registry.items[type].name
        inChest[name] -= count
        const free = bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && i < 45 && s == null)
        bot.inventory.slots[free] = { ...item(name, count), slot: free }
      },
      close: () => {}
    }
  }
  return bot
}

test('storeItems and retrieveItems leave the memory the chest\'s true contents, what wasn\'t asked of it too, seen now (rememberContents)', async () => {
  const { retrieveItems } = require('../../src/skills/chest')
  // the memory says a diamond pickaxe; a run whose memory wasn't saved took it
  const inChest: Record<string, number> = { raw_iron: 20, bread: 5 }
  const bot = chestBot([item('cobblestone', 64), item('iron_pickaxe')], inChest)
  const memory = bot.survival.memory
  memory.rememberChest(new Vec3(2, 64, 0), { diamond_pickaxe: 1, raw_iron: 20 })
  memory.now = 500
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    // a take of what isn't there: none moved, the memory set right
    const res = await retrieveItems(bot, { chest: new Vec3(2, 64, 0), filter: 'diamond_pickaxe', count: 1 })
    assert.deepStrictEqual(res.moved, {})
    assert.deepStrictEqual(memory.chestAt(new Vec3(2, 64, 0))?.items, { raw_iron: 20, bread: 5 })
    assert.strictEqual(memory.chestAt(new Vec3(2, 64, 0))?.seen, 500)
    // a store: what's in it after, not what was remembered plus what went in
    await storeItems(bot, { chest: new Vec3(2, 64, 0), filter: ['cobblestone'] })
    assert.deepStrictEqual(memory.chestAt(new Vec3(2, 64, 0))?.items, { raw_iron: 20, bread: 5, cobblestone: 64 })
    // a take: what's left
    await retrieveItems(bot, { chest: new Vec3(2, 64, 0), filter: 'raw_iron', count: 15 })
    assert.deepStrictEqual(memory.chestAt(new Vec3(2, 64, 0))?.items, { raw_iron: 5, bread: 5, cobblestone: 64 })
    // memory: null leaves it be
    await retrieveItems(bot, { chest: new Vec3(2, 64, 0), filter: 'bread', memory: null })
    assert.strictEqual(memory.chestAt(new Vec3(2, 64, 0))?.items.bread, 5)
  } finally {
    clearInterval(ticker)
  }
})

test('a double chest\'s contents are the clicked half\'s, the other half\'s emptied (one window over both)', async () => {
  const { chestPartner } = require('../../src/skills/chest')
  const inChest: Record<string, number> = { diamond: 3 }
  const bot = chestBot([item('cobblestone', 64)], inChest, { double: true })
  const memory = bot.survival.memory
  assert.strictEqual(chestPartner(bot.blockAt(new Vec3(2, 64, 0))).toString(), new Vec3(2, 64, 1).toString())
  assert.strictEqual(chestPartner(bot.blockAt(new Vec3(2, 64, 1))).toString(), new Vec3(2, 64, 0).toString())
  // the diamonds stored through the other half before
  memory.rememberChest(new Vec3(2, 64, 1), { diamond: 3 })
  memory.rememberChest(new Vec3(2, 64, 0), {})
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await storeItems(bot, { chest: new Vec3(2, 64, 0), filter: ['cobblestone'] })
  } finally {
    clearInterval(ticker)
  }
  assert.deepStrictEqual(memory.chestAt(new Vec3(2, 64, 0))?.items, { diamond: 3, cobblestone: 64 })
  assert.deepStrictEqual(memory.chestAt(new Vec3(2, 64, 1))?.items, {})
  assert.deepStrictEqual(memory.findItem('diamond').map((f: any) => f.count), [3])
})

test('a remembered chest that is gone: forgotten, NOT_FOUND, and no window waited for', async () => {
  const { retrieveItems } = require('../../src/skills/chest')
  const bot = chestBot([], {}, { block: 'air' })
  const memory = bot.survival.memory
  memory.rememberChest(new Vec3(2, 64, 0), { diamond_pickaxe: 1 })
  await assert.rejects(retrieveItems(bot, { chest: new Vec3(2, 64, 0), filter: 'diamond_pickaxe' }), (err: any) => err.code === 'NOT_FOUND')
  assert.strictEqual(bot.opened, 0)
  assert.strictEqual(memory.chestAt(new Vec3(2, 64, 0)), undefined)
})
