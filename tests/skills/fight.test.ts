import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { ArrowGuard, MOB_ARROW_SPEED, blazeCharged } from '../../src/skills/fight'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('blazeCharged: Blaze.DATA_FLAGS_ID bit 1, set for the volley', () => {
  const bot = fakeBot()
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0), meta: { flags: 1 } })), true)
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0), meta: { flags: 0 } })), false)
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0) })), false)
})

test('ArrowGuard: the shield stays up from the draw until the arrow has had time to arrive', () => {
  const guard = new ArrowGuard()
  assert.strictEqual(guard.update(false, 9, 0), false)
  for (let t = 1; t <= 20; t++) assert.strictEqual(guard.update(true, 9, t), true)
  // released at tick 21 from 9 blocks: in the air ceil(9 / 1.6) = 6 ticks, and 2 to spare
  const flight = Math.ceil(9 / MOB_ARROW_SPEED) + 2
  for (let t = 21; t <= 21 + flight; t++) assert.strictEqual(guard.update(false, 9, t), true, `tick ${t}`)
  assert.strictEqual(guard.update(false, 9, 22 + flight), false)
  // the next draw raises it again
  assert.strictEqual(guard.update(true, 8, 60), true)
})
