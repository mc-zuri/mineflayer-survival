import { test } from 'node:test'
import assert from 'node:assert'
import { canSleepNow } from '../../src/skills/sleep'

test('canSleepNow: at night (12541 to 23458) or in a thunderstorm', () => {
  assert.strictEqual(canSleepNow(1000, false), false)
  assert.strictEqual(canSleepNow(12540, false), false)
  assert.strictEqual(canSleepNow(12541, false), true)
  assert.strictEqual(canSleepNow(18000, false), true)
  assert.strictEqual(canSleepNow(23459, false), false)
  assert.strictEqual(canSleepNow(6000, true), true)
})
