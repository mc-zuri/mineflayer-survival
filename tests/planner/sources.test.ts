import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { BARTER, BARTER_TOTAL_WEIGHT, BLOCK_SOURCES, MOB_SOURCES, SMELTING } from '../../src/planner/sources'
import { VERSIONS } from '../versions'

// vanilla 1.21.11 piglin_bartering.json (26.3's is the same): entries and weights not listed in BARTER
// (enchanted book 5, iron boots 8, potion 8, splash potion 8, potion 10, dried ghast 10)
const UNLISTED_WEIGHT = 5 + 8 + 8 + 8 + 10 + 10

test('the barter table matches the 1.21.11 piglin_bartering loot table', () => {
  assert.equal(BARTER.reduce((sum, o) => sum + o.weight, 0) + UNLISTED_WEIGHT, BARTER_TOTAL_WEIGHT)
  const pearl = BARTER.find(o => o.item === 'ender_pearl')
  assert.ok(pearl != null)
  assert.equal(pearl.perIngot, 10 / 469 * 3)
  // quartz drops 5-12 in 1.21.11
  assert.equal(BARTER.find(o => o.item === 'quartz')?.perIngot, 20 / 469 * 8.5)
})

for (const version of VERSIONS) {
  test(`every block, mob and item the source tables name is in ${version}'s registry (but 26.3's poplar on 1.21.11)`, () => {
    const registry = minecraftData(version)
    const later = version === '1.21.11' ? new Set(['poplar_log']) : new Set<string>()
    for (const b of BLOCK_SOURCES) {
      if (later.has(b.block)) continue
      assert.ok(registry.blocksByName[b.block] != null, b.block)
      for (const d of b.drops) assert.ok(registry.itemsByName[d.item] != null, `${b.block}: ${d.item}`)
    }
    for (const m of MOB_SOURCES) {
      assert.ok(registry.entitiesByName[m.mob] != null, m.mob)
      for (const d of m.drops) assert.ok(registry.itemsByName[d.item] != null, `${m.mob}: ${d.item}`)
    }
    for (const r of SMELTING) {
      assert.ok(registry.itemsByName[r.output] != null, r.output)
      for (const i of r.input) if (!i.startsWith('#')) assert.ok(registry.itemsByName[i] != null, i)
    }
    for (const o of BARTER) assert.ok(registry.itemsByName[o.item] != null, o.item)
  })
}
