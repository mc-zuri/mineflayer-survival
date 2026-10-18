import { test } from 'node:test'
import assert from 'node:assert'
import { chooseBest, canHarvestWith, harvestToolFor, toolCategory, toolTier } from '../../src/skills/equipBest'

const mcData = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')('1.21.11')
const item = (name: string, count = 1): any => new Item(mcData.itemsByName[name].id, count)

test('toolCategory tells a pickaxe from an axe', () => {
  assert.strictEqual(toolCategory('wooden_pickaxe'), 'pickaxe')
  assert.strictEqual(toolCategory('stone_axe'), 'axe')
  assert.strictEqual(toolCategory('iron_sword'), 'sword')
  assert.strictEqual(toolCategory('shears'), 'shears')
  assert.strictEqual(toolCategory('stick'), null)
})

test('chooseBest takes the best tier: diamond over iron over copper over stone over gold over wood', () => {
  const items = ['golden_pickaxe', 'wooden_pickaxe', 'stone_pickaxe', 'iron_axe', 'copper_pickaxe'].map(name => item(name))
  assert.strictEqual(chooseBest(items, 'pickaxe')?.name, 'copper_pickaxe')
  assert.strictEqual(chooseBest([...items, item('iron_pickaxe')], 'pickaxe')?.name, 'iron_pickaxe')
  assert.strictEqual(chooseBest([item('golden_pickaxe'), item('wooden_pickaxe')], 'pickaxe')?.name, 'golden_pickaxe')
  assert.strictEqual(chooseBest(items, 'axe')?.name, 'iron_axe')
  assert.strictEqual(chooseBest(items, 'sword'), null)
  assert.ok(toolTier('netherite_sword') < toolTier('diamond_sword'))
})

test('chooseBest takes the one with more durability left of a tier', () => {
  const worn = item('stone_pickaxe')
  worn.durabilityUsed = 100
  const fresh = item('stone_pickaxe')
  assert.strictEqual(chooseBest([worn, fresh], 'pickaxe'), fresh)
})

test('canHarvestWith: stone needs a pickaxe to drop cobblestone, logs drop by hand', () => {
  const stone = mcData.blocksByName.stone
  const log = mcData.blocksByName.oak_log
  const iron = mcData.blocksByName.iron_ore
  assert.strictEqual(canHarvestWith(stone, null), false)
  assert.strictEqual(canHarvestWith(stone, item('wooden_pickaxe')), true)
  assert.strictEqual(canHarvestWith(stone, item('wooden_axe')), false)
  assert.strictEqual(canHarvestWith(log, null), true)
  assert.strictEqual(canHarvestWith(iron, item('wooden_pickaxe')), false)
  assert.strictEqual(canHarvestWith(iron, item('stone_pickaxe')), true)
  assert.strictEqual(harvestToolFor(log, []), undefined)
  assert.strictEqual(harvestToolFor(stone, [item('oak_log')]), null)
  assert.strictEqual(harvestToolFor(stone, [item('oak_log'), item('stone_pickaxe')])?.name, 'stone_pickaxe')
})
