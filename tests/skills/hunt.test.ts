import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { nearestOfType } from '../../src/skills/hunt'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('nearestOfType skips the babies (they drop nothing)', () => {
  const calf = entity({ name: 'cow', position: new Vec3(2, 64, 0), meta: { baby: true } })
  const cow = entity({ name: 'cow', position: new Vec3(6, 64, 0), meta: { baby: false } })
  const pig = entity({ name: 'pig', position: new Vec3(1, 64, 0) })
  const bot = fakeBot({ position: new Vec3(0, 64, 0), entities: [calf, cow, pig] })
  assert.strictEqual(nearestOfType(bot, ['cow'], 64), cow)
  assert.strictEqual(nearestOfType(bot, ['cow', 'pig'], 64), pig)
  assert.strictEqual(nearestOfType(bot, ['cow'], 4), null)
})
