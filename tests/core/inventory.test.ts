import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { Inventory } from '../../src/core/inventory'
import { itemTags } from '../../src/core/tags'
import { burnTicks } from '../../src/core/items'
import type { RegistryLike } from '../../src/core/registry'

const registry: RegistryLike = minecraftData('1.21.11')

test('tag groups hold every variant of the version', () => {
  const tags = itemTags(registry)
  const logs = tags.members('#logs')
  for (const n of ['oak_log', 'pale_oak_log', 'stripped_cherry_wood', 'mangrove_log', 'crimson_stem', 'warped_hyphae']) assert.ok(logs.includes(n), n)
  assert.ok(!logs.includes('bamboo_block'))
  assert.ok(!tags.members('#logs_that_burn').includes('crimson_stem'))
  assert.ok(tags.members('#logs_that_burn').includes('dark_oak_wood'))
  assert.deepEqual([...tags.members('#oak_logs')].sort(), ['oak_log', 'oak_wood', 'stripped_oak_log', 'stripped_oak_wood'])
  assert.equal(tags.members('#planks').length, 12)
  assert.deepEqual([...tags.members('#coals')], ['coal', 'charcoal'])
  assert.ok(tags.members('#pickaxes').includes('copper_pickaxe'))
  assert.deepEqual([...tags.members('#iron_ores')], ['iron_ore', 'deepslate_iron_ore'])
  assert.ok(tags.members('#fuel').includes('bamboo_planks'))
  assert.ok(!tags.members('#fuel').includes('warped_planks'))
  assert.ok(!tags.members('#food').includes('rotten_flesh'))
  assert.ok(tags.matches('#planks', 'birch_planks'))
  assert.ok(!tags.matches('#planks', 'birch_log'))
  assert.deepEqual(tags.resolve('stick'), ['stick'])
})

test('counts by item and by tag group', () => {
  const inv = new Inventory(registry, [
    { name: 'oak_log', count: 3 }, { name: 'birch_log', count: 2 }, { name: 'stripped_spruce_wood', count: 1 },
    { name: 'oak_planks', count: 4 }, { name: 'coal', count: 5 }, { name: 'charcoal', count: 2 }, { name: 'oak_log', count: 1 }
  ])
  assert.equal(inv.count('oak_log'), 4)
  assert.equal(inv.count('#logs'), 7)
  assert.equal(inv.count('#oak_logs'), 4)
  assert.equal(inv.count('#planks'), 4)
  assert.equal(inv.count('#coals'), 7)
  assert.equal(inv.countAny(['#coals', 'coal', '#planks']), 11)
  assert.ok(inv.has('#logs', 7))
  assert.ok(!inv.has('#logs', 8))
  assert.deepEqual(inv.matching('#logs').map(i => i.name), ['oak_log', 'birch_log', 'stripped_spruce_wood'])
  inv.remove('coal', 5)
  assert.equal(inv.count('coal'), 0)
  assert.throws(() => inv.remove('coal', 1))
  const copy = inv.clone()
  copy.add('coal', 3)
  assert.equal(inv.count('coal'), 0)
  assert.equal(copy.count('#coals'), 5)
})

test('free slots count full stacks against the 36 slots, or take the window count', () => {
  const inv = new Inventory(registry, { cobblestone: 130, diamond_pickaxe: 1, ender_pearl: 17 })
  // 130 cobblestone = 3 slots, a pickaxe = 1, 17 pearls (stack 16) = 2
  assert.equal(inv.usedSlots(), 6)
  assert.equal(inv.freeSlots(), 30)
  const fromBot = Inventory.fromBot({ registry, inventory: { items: () => [{ name: 'dirt', count: 1 }, { name: 'dirt', count: 1 }], emptySlotCount: () => 34 } })
  assert.equal(fromBot.count('dirt'), 2)
  assert.equal(fromBot.freeSlots(), 34)
  fromBot.add('dirt', 1)
  assert.equal(fromBot.freeSlots(), 35)
})

test('best tool by tier, for a kind or for a block', () => {
  const inv = new Inventory(registry, { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 1, copper_pickaxe: 1, iron_axe: 1, wooden_shovel: 1 })
  assert.equal(inv.bestTool('pickaxe'), 'copper_pickaxe')
  assert.equal(inv.bestTool('iron_ore'), 'copper_pickaxe')
  assert.equal(inv.bestTool('diamond_ore'), null)
  assert.equal(inv.bestTool('oak_log'), 'iron_axe')
  assert.equal(inv.bestTool('dirt'), 'wooden_shovel')
  assert.equal(inv.bestTool('sword'), null)
  inv.add('iron_pickaxe', 1)
  assert.equal(inv.bestTool('diamond_ore'), 'iron_pickaxe')
  assert.equal(inv.bestTool('obsidian'), null)
  inv.add('diamond_pickaxe', 1)
  assert.equal(inv.bestTool('obsidian'), 'diamond_pickaxe')
  assert.equal(new Inventory(registry, { golden_pickaxe: 1, wooden_pickaxe: 1 }).bestTool('stone'), 'wooden_pickaxe')
})

test('fuel and food totals follow vanilla burn times and nutrition', () => {
  assert.equal(burnTicks('coal'), 1600)
  assert.equal(burnTicks('oak_planks'), 300)
  assert.equal(burnTicks('stripped_birch_log'), 300)
  assert.equal(burnTicks('crimson_planks'), 0)
  assert.equal(burnTicks('oak_slab'), 150)
  assert.equal(burnTicks('stick'), 100)
  assert.equal(burnTicks('white_wool'), 100)
  assert.equal(burnTicks('cobblestone'), 0)
  const inv = new Inventory(registry, { coal: 2, oak_planks: 3, blaze_rod: 1, cooked_beef: 2, rotten_flesh: 5, bread: 1 })
  assert.equal(inv.fuelTicks(['blaze_rod']), 2 * 1600 + 3 * 300)
  assert.equal(inv.fuelTicks(), 2 * 1600 + 3 * 300 + 2400)
  assert.equal(inv.foodPoints(), 2 * 8 + 5)
})
