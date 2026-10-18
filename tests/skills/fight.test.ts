import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { blazeCharged } from '../../src/skills/fight'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('blazeCharged: Blaze.DATA_FLAGS_ID bit 1, set for the volley', () => {
  const bot = fakeBot()
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0), meta: { flags: 1 } })), true)
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0), meta: { flags: 0 } })), false)
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0) })), false)
})
