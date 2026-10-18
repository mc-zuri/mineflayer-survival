import { test } from 'node:test'
import assert from 'node:assert'
import { planCraft } from '../../src/skills/craft'
import { countsDelta } from '../../src/skills/util'

const registry = require('minecraft-data')('1.21.11')
const items = (list: Array<[string, number]>): Array<{ id: number, count: number }> => list.map(([name, count]) => ({ id: registry.itemsByName[name].id, count }))

test('planCraft: a wooden pickaxe from logs goes through planks and sticks, at a table', async () => {
  const plan = await planCraft(registry, items([['oak_log', 5]]), 'wooden_pickaxe', 1)
  assert.strictEqual(plan.status, 'complete')
  assert.strictEqual(plan.requiresCraftingTable, true)
  const made = plan.recipesToDo.map(step => registry.items[step.recipe.result.id].name)
  assert.deepStrictEqual([...new Set(made)].sort(), ['oak_planks', 'stick', 'wooden_pickaxe'])
})

test('planCraft: a crafting table needs no table, a furnace needs eight cobblestone', async () => {
  const table = await planCraft(registry, items([['birch_log', 1]]), 'crafting_table', 1)
  assert.strictEqual(table.status, 'complete')
  assert.strictEqual(table.requiresCraftingTable, false)
  const short = await planCraft(registry, items([['cobblestone', 7]]), 'furnace', 1)
  assert.notStrictEqual(short.status, 'complete')
  const furnace = await planCraft(registry, items([['cobblestone', 8]]), 'furnace', 1)
  assert.strictEqual(furnace.status, 'complete')
})

test('countsDelta keeps the names that changed', () => {
  assert.deepStrictEqual(countsDelta({ oak_log: 5, stick: 2 }, { oak_log: 3, stick: 2, oak_planks: 8 }), { oak_log: -2, oak_planks: 8 })
})
