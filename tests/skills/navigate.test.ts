import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { GoalReachBlock, goalReached } from '../../src/skills/navigate'
import { SkillError } from '../../src/skills/errors'
import { TaskError } from '../../src/core/errors'

test('GoalReachBlock: within reach of the block, out of it', () => {
  const goal = new GoalReachBlock(new Vec3(0, -60, 0), 4)
  assert.strictEqual(goal.isEnd({ x: 0, y: -60, z: 0 }), false)
  assert.strictEqual(goal.isEnd({ x: 0, y: -61, z: 0 }), false)
  assert.strictEqual(goal.isEnd({ x: 1, y: -60, z: 0 }), true)
  assert.strictEqual(goal.isEnd({ x: 4, y: -60, z: 0 }), true)
  assert.strictEqual(goal.isEnd({ x: 6, y: -60, z: 0 }), false)
  assert.strictEqual(new GoalReachBlock(new Vec3(0, -60, 0), 4, 1.62, false).isEnd({ x: 0, y: -60, z: 0 }), true)
})

test('goalReached: the block of the bot, or one its feet overlap', () => {
  const goal = new GoalReachBlock(new Vec3(10, -60, 0), 1)
  const at = (x: number, z: number): any => ({ entity: { position: new Vec3(x, -60, z) } })
  // eyes over (8, -60, 0) are 1.5 off the block's box: short of the reach
  assert.strictEqual(goalReached(at(8.5, 0.5), goal), false)
  // over the edge into (9, -60, 0), its feet in both
  assert.strictEqual(goalReached(at(8.9, 0.5), goal), true)
  assert.strictEqual(goalReached(at(9.5, 0.5), goal), true)
})

test('SkillError is a TaskError: its code one of the core codes, its reason the skill reason', () => {
  const stuck = new SkillError('STUCK', 'no progress', { ticks: 200 })
  assert.ok(stuck instanceof TaskError)
  assert.ok(TaskError.is(stuck, 'NO_PATH'))
  assert.strictEqual(stuck.reason, 'STUCK')
  assert.deepStrictEqual(stuck.partial, { ticks: 200 })
  assert.strictEqual(new SkillError('NO_SPACE', 'full').code, 'INVENTORY_FULL')
  assert.strictEqual(new SkillError('VERIFY_FAILED', 'no').code, 'FAILED')
  assert.strictEqual(new SkillError('MISSING_ITEMS', 'no').code, 'MISSING_ITEMS')
})
