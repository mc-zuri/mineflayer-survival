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
