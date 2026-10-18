import { test } from 'node:test'
import assert from 'node:assert'
import { potionOf, POTION_IDS } from '../../src/skills/potion'
import { item } from '../reflexes/fakeBot'

test('potionOf: the potion_contents id, the fire resistance ones known', () => {
  const potion = item('potion')
  potion.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: 12, customEffects: [] } }]])
  assert.strictEqual(potionOf(potion), 12)
  assert.ok(POTION_IDS.fire_resistance.includes(12))
  assert.strictEqual(potionOf(item('ender_eye')), null)
})
