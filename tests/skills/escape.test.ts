import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { headInWater, inHazard, isSafeStand, nearestSpot } from '../../src/skills/escape'
import { fakeBot } from '../reflexes/fakeBot'

// a lava pool: x 0 - 3, y 63 - 64 lava, stone around and below
const lavaPool = (p: Vec3): string => (p.x >= 0 && p.x <= 3 && p.z >= -1 && p.z <= 1 && p.y >= 63 && p.y <= 64) ? 'lava' : p.y < 64 ? 'stone' : 'air'

test('inHazard and isSafeStand', () => {
  assert.strictEqual(inHazard(fakeBot({ position: new Vec3(1.5, 63, 0.5), world: lavaPool })), true)
  assert.strictEqual(inHazard(fakeBot({ position: new Vec3(8.5, 64, 0.5), world: lavaPool })), false)
  const bot = fakeBot({ world: lavaPool })
  assert.strictEqual(isSafeStand(bot, new Vec3(5, 64, 0)), true)
  assert.strictEqual(isSafeStand(bot, new Vec3(2, 64, 0)), false) // lava at the feet
  assert.strictEqual(isSafeStand(bot, new Vec3(5, 70, 0)), false) // nothing under
})

test('nearestSpot finds the way out of the lava pool', () => {
  const bot = fakeBot({ position: new Vec3(1.5, 63, 0.5), world: lavaPool })
  const out = nearestSpot(bot, 6, p => isSafeStand(bot, p))
  assert.ok(out != null)
  assert.ok(isSafeStand(bot, out))
  // the pool's edge is two blocks from x 1: x -1 or z +-2
  assert.ok(out.distanceTo(new Vec3(1, 63, 0)) <= 3, out.toString())
})

test('headInWater', () => {
  const sea = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 70 ? 'water' : 'air'
  assert.strictEqual(headInWater(fakeBot({ position: new Vec3(0.5, 65, 0.5), world: sea })), true)
  assert.strictEqual(headInWater(fakeBot({ position: new Vec3(0.5, 69, 0.5), world: sea })), false)
})
