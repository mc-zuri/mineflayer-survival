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
