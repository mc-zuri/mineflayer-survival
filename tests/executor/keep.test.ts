import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { defaultKeep, junkToToss, splitInventory } from '../../src/executor/keep'
import { VERSIONS } from '../versions'

for (const version of VERSIONS) {
  test(`the default keep rule keeps the safe foods of ${version}'s registry, not the fish buckets`, () => {
    const registry = minecraftData(version)
    assert.equal(defaultKeep('cooked_beef', registry), Infinity)
    assert.equal(defaultKeep('bread', registry), Infinity)
    assert.equal(defaultKeep('rotten_flesh', registry), null)
    assert.equal(defaultKeep('cod_bucket', registry), null)
  })
}

test('the default keep rule: tools, armor and food all, a stack of cobblestone and torches, the rest stored', () => {
  const registry = minecraftData('1.21.11')
  assert.equal(defaultKeep('iron_pickaxe'), Infinity)
  assert.equal(defaultKeep('iron_chestplate'), Infinity)
  assert.equal(defaultKeep('cooked_beef', registry), Infinity)
  assert.equal(defaultKeep('rotten_flesh', registry), null)
  assert.equal(defaultKeep('cobblestone'), 64)
  assert.equal(defaultKeep('white_bed'), 1)
  assert.equal(defaultKeep('raw_iron'), null)
  const { keep, store } = splitInventory([
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 40 }, { name: 'raw_iron', count: 12 },
    { name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 5 }, { name: 'diamond', count: 3 }
  ], { needed: { diamond: 2 }, registry })
  const rec = (l: Array<{ name: string, count: number }>): Record<string, number> => Object.fromEntries(l.map(i => [i.name, i.count]))
  assert.deepEqual(rec(keep), { cobblestone: 64, stone_pickaxe: 1, bread: 5, diamond: 2 })
  assert.deepEqual(rec(store), { cobblestone: 40, raw_iron: 12, diamond: 1 })
})

test('junkToToss frees whole slots of junk, never what is kept or needed', () => {
  const stacks = [
    { name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }, { name: 'gravel', count: 30 }, { name: 'cobblestone', count: 64 },
    { name: 'cobblestone', count: 64 }, { name: 'wheat_seeds', count: 3 }, { name: 'raw_iron', count: 9 }
  ]
  assert.deepEqual(junkToToss(stacks, 2), [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }])
  // gravel the plan needs (flint) stays
  assert.deepEqual(junkToToss(stacks, 4, { needed: { gravel: 10 } }), [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 12 }, { name: 'wheat_seeds', count: 3 }])
  // with `anything`, what storing would take goes too: the cobblestone over a stack, the raw iron
  const all = junkToToss(stacks, 6, { anything: true })
  assert.deepEqual(all.slice(4), [{ name: 'cobblestone', count: 64 }, { name: 'raw_iron', count: 9 }])
})

test('spare kit: a second pickaxe, sword and axe at the carried tier, and 20 food points, less what the chests hold', async () => {
  const { spareKitGoals, SPARE_FOOD_POINTS } = await import('../../src/executor/keep')
  const { Inventory } = await import('../../src/core/inventory')
  const { FOOD_GOAL } = await import('../../src/planner/progression')
  const registry = require('minecraft-data')('1.21.11')
  const carried = new Inventory(registry, { iron_pickaxe: 1, iron_sword: 1, stone_axe: 1, wooden_shovel: 1, cooked_beef: 5 })
  const goals = spareKitGoals(carried, {})
  assert.deepEqual(goals.map(g => g.item).slice(0, 3), [
    ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
    ['iron_sword', 'diamond_sword', 'netherite_sword'],
    ['stone_axe', 'copper_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']
  ].map(alts => alts.filter(a => registry.itemsByName[a] != null)))
  assert.deepEqual(goals.map(g => g.count), [2, 2, 2, 40 + SPARE_FOOD_POINTS])
  assert.deepEqual(goals[3].item, FOOD_GOAL)
  // the chests hold a diamond pickaxe and 12 points of bread: the rest
  const rest = spareKitGoals(carried, { diamond_pickaxe: 1, bread: 2, cobblestone: 64 })
  assert.equal(rest.length, 3)
  assert.equal(rest[2].count, 40 + SPARE_FOOD_POINTS - 10)
  // wooden tools are no loss
  assert.deepEqual(spareKitGoals(new Inventory(registry, { wooden_pickaxe: 1 }), { bread: 4 }), [])
})

test('junkToToss: after the junk, what surplus names may go beyond its kept count (the stock with no base), never below it', async () => {
  const registry = minecraftData('1.21.11')
  const { StockPolicy } = await import('../../src/planner/stock')
  const { stockKeepRule } = await import('../../src/executor/keep')
  const policy = new StockPolicy()
  const stacks = [{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'raw_iron', count: 20 }]
  const keep = stockKeepRule(policy)
  // without surplus only the junk goes
  assert.deepEqual(junkToToss(stacks, 3, { keep, registry }), [{ name: 'dirt', count: 64 }])
  const surplus = (name: string): boolean => policy.keepCount(name, registry) != null
  assert.deepEqual(junkToToss(stacks, 3, { keep, registry, surplus }), [{ name: 'dirt', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }])
})

test('junkToToss throws the leaves and leaf litter a shears\' dig picked up', () => {
  const stacks = [{ name: 'oak_leaves', count: 64 }, { name: 'leaf_litter', count: 25 }, { name: 'oak_log', count: 45 }, { name: 'leather', count: 38 }]
  const toss = junkToToss(stacks, 2)
  assert.deepEqual(toss.map(t => t.name).sort(), ['leaf_litter', 'oak_leaves'])
})
