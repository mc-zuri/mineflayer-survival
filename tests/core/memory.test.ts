import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorldMemory, normalizeDimension } from '../../src/core/memory'

function sample (): WorldMemory {
  const mem = new WorldMemory()
  mem.now = 100
  mem.rememberBlock('iron_ore', { x: 10.5, y: 12, z: -3.2 })
  mem.rememberBlock('iron_ore', { x: 40, y: 15, z: 0 })
  mem.rememberBlock('diamond_ore', { x: 3, y: -58, z: 7 })
  mem.rememberBlock('nether_quartz_ore', { x: 3, y: 40, z: 7 }, 'minecraft:the_nether')
  mem.rememberChest({ x: 0, y: 64, z: 0 }, { cobblestone: 128, raw_iron: 5, torch: 0 })
  mem.rememberChest({ x: 1, y: 64, z: 0 }, { raw_iron: 9 })
  mem.setBase({ x: 0, y: 64, z: 0 })
  mem.addPoi('nether_portal', { x: 8, y: 70, z: 8 })
  mem.addPoi('fortress', { x: 200, y: 60, z: -40 }, 'the_nether', 'found by the bridge')
  mem.addPoi('stronghold_estimate', { x: 1200, y: 30, z: -600 })
  mem.now = 250
  mem.setDeath({ x: 5.7, y: 11, z: 5.1 })
  return mem
}

test('the memory round-trips through JSON', () => {
  const mem = sample()
  const json = JSON.stringify(mem)
  const back = WorldMemory.fromJSON(json)
  assert.deepEqual(back.toJSON(), mem.toJSON())
  assert.equal(back.now, 250)
  assert.deepEqual(back.death, { x: 5, y: 11, z: 5, dimension: 'overworld', seen: 250 })
  assert.deepEqual(back.base, { x: 0, y: 64, z: 0, dimension: 'overworld' })
  assert.equal(back.getPois('fortress')[0].note, 'found by the bridge')
})

test('blocks are found by type and dimension, nearest first, and forgotten when mined', () => {
  const mem = sample()
  const near = mem.findBlocks('iron_ore', { near: { x: 38, y: 15, z: 0 } })
  assert.deepEqual(near.map(b => b.x), [40, 10])
  assert.equal(mem.findBlocks(['iron_ore', 'diamond_ore'], { near: { x: 0, y: 0, z: 0 }, maxDistance: 30 }).length, 1)
  assert.equal(mem.findBlocks('nether_quartz_ore', { dimension: 'overworld' }).length, 0)
  assert.equal(mem.findBlocks('nether_quartz_ore', { dimension: 'the_nether' }).length, 1)
  mem.forgetBlock({ x: 10, y: 12, z: -4 })
  assert.deepEqual(mem.findBlocks('iron_ore').map(b => b.x), [40])
  // a block seen to be something else moves to its new type
  mem.rememberBlock('stone', { x: 40, y: 15, z: 0 })
  assert.equal(mem.findBlocks('iron_ore').length, 0)
  assert.equal(mem.findBlocks('stone').length, 1)
})

test('only maxPerBlock positions are kept per block type, oldest dropped first', () => {
  const mem = new WorldMemory({ maxPerBlock: 3 })
  for (let x = 0; x < 5; x++) mem.rememberBlock('oak_log', { x, y: 70, z: 0 })
  mem.rememberBlock('oak_log', { x: 2, y: 70, z: 0 }) // seen again: now the newest
  mem.rememberBlock('oak_log', { x: 5, y: 70, z: 0 })
  assert.deepEqual(mem.findBlocks('oak_log').map(b => b.x).sort(), [2, 4, 5])
})

test('chests are searched by item, fullest first, and dropping empty entries', () => {
  const mem = sample()
  assert.deepEqual(mem.findItem('raw_iron').map(r => r.count), [9, 5])
  assert.equal(mem.chestAt({ x: 0, y: 64, z: 0 })?.items.torch, undefined)
  mem.forgetChest({ x: 1, y: 64, z: 0 })
  assert.deepEqual(mem.findItem('raw_iron').map(r => r.count), [5])
})

test('points of interest replace the same kind at the same spot and normalise the dimension', () => {
  const mem = sample()
  mem.addPoi('nether_portal', { x: 8.9, y: 70, z: 8.1 }, 'minecraft:overworld')
  assert.equal(mem.getPois('nether_portal').length, 1)
  mem.removePoi('stronghold_estimate')
  assert.equal(mem.getPois('stronghold_estimate').length, 0)
  assert.equal(normalizeDimension('minecraft:the_end'), 'the_end')
  assert.equal(normalizeDimension(undefined), 'overworld')
})
