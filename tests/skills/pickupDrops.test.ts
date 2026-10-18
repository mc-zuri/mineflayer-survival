import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { GoalTouch, restingY, touches } from '../../src/skills/pickupDrops'

test('touches: the player box inflated by 1 and 0.5 (Player.aiStep) meets the item box', () => {
  const bot = new Vec3(0.5, -60, 0.5)
  assert.strictEqual(touches(bot, new Vec3(1.5, -60, 0.5)), true)
  assert.strictEqual(touches(bot, new Vec3(1.9, -60, 1.9)), true)
  assert.strictEqual(touches(bot, new Vec3(2.0, -60, 0.5)), false)
  // up to 2.3 over the feet, 0.75 under them
  assert.strictEqual(touches(bot, new Vec3(0.5, -57.8, 0.5)), true)
  assert.strictEqual(touches(bot, new Vec3(0.5, -57.6, 0.5)), false)
  assert.strictEqual(touches(bot, new Vec3(0.5, -60.7, 0.5)), true)
  assert.strictEqual(touches(bot, new Vec3(0.5, -60.8, 0.5)), false)
})

test('GoalTouch: on the block of the item or next to it, not two blocks off', () => {
  const goal = new GoalTouch(new Vec3(5.5, -60, 5.5))
  assert.strictEqual(goal.isEnd({ x: 5, y: -60, z: 5 }), true)
  assert.strictEqual(goal.isEnd({ x: 4, y: -60, z: 6 }), true)
  assert.strictEqual(goal.isEnd({ x: 3, y: -60, z: 5 }), false)
  assert.strictEqual(goal.isEnd({ x: 5, y: -63, z: 5 }), false)
  assert.strictEqual(goal.distHeuristic({ x: 5, y: -60, z: 5 }), 0)
  assert.ok(goal.distHeuristic({ x: 9, y: -60, z: 5 }) > 2)
})

test('restingY: an item comes to rest on top of a dirt path or slab in its cell, on the floor of an empty one; the bot on the path touches it', () => {
  const path = { boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.9375, 1]] }
  assert.strictEqual(restingY(() => path, new Vec3(-31, 66, -1)), 66.9375)
  assert.strictEqual(restingY(() => ({ boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] }), new Vec3(0, 10, 0)), 10.5)
  assert.strictEqual(restingY(() => ({ boundingBox: 'empty', shapes: [] }), new Vec3(0, 10, 0)), 10)
  assert.strictEqual(restingY(() => null, new Vec3(0, 10, 0)), 10)
  // the bot standing on the path, the eye on it beside it
  assert.strictEqual(touches(new Vec3(-30.53, 66.9375, -0.33), new Vec3(-30.73, 66, -0.31)), false)
  assert.strictEqual(touches(new Vec3(-30.53, 66.9375, -0.33), new Vec3(-30.73, 66.9375, -0.31)), true)
})
