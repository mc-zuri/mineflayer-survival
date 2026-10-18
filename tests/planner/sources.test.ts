import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BARTER, BARTER_TOTAL_WEIGHT } from '../../src/planner/sources'

// vanilla 1.21.11 piglin_bartering.json: entries and weights not listed in BARTER
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
