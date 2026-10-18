import { test } from 'node:test'
import assert from 'node:assert'
import { potionOf, POTION_IDS } from '../../src/skills/potion'
import { item } from '../reflexes/fakeBot'

test('potionOf: the potion_contents id, the fire resistance ones known', () => {
  const potion = item('potion')
  potion.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: 12, customEffects: [] } }]])
  assert.strictEqual(potionOf(potion), 12)
  assert.ok(POTION_IDS.fire_resistance.includes(12))
  // the potion registry's protocol ids (the data generator's registries report, 1.21.11 and 26.3)
  assert.deepStrictEqual(POTION_IDS.healing, [24, 25])
  assert.deepStrictEqual(POTION_IDS.regeneration, [31, 32, 33])
  assert.deepStrictEqual(POTION_IDS.strength, [34, 35, 36])
  assert.deepStrictEqual(POTION_IDS.slow_falling, [40, 41])
  assert.strictEqual(potionOf(item('ender_eye')), null)
})
