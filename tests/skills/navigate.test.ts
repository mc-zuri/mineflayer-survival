import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { GoalReachBlock, goalReached, navigate } from '../../src/skills/navigate'
import { SkillError, isSkillError } from '../../src/skills/errors'
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

/** a bot whose pathfinder searches forever (no path) or "walks" without moving (stuck), ticked on setImmediate */
function pathBot (mode: 'searching' | 'stuck'): any {
  const bot: any = new EventEmitter()
  bot.setMaxListeners(50)
  bot.entity = { position: new Vec3(0.7, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 }
  bot.look = async () => {}
  bot.setControlState = () => {}
  bot.clearControlStates = () => {}
  let cancelled: (() => void) | null = null
  let gotos = 0
  bot.pathfinder = {
    isPathing: false,
    goto: async () => {
      gotos++
      bot.pathfinder.isPathing = true
      if (mode === 'stuck') setImmediate(() => bot.emit('pathGenerated', { path: [] }))
      await new Promise<void>(resolve => { cancelled = resolve })
      bot.pathfinder.isPathing = false
    },
    cancel: async () => { cancelled?.(); cancelled = null }
  }
  let ticking = true
  const tick = (): void => { if (!ticking) return; bot.emit('physicsTickBegin'); bot.emit('physicsTick'); setImmediate(tick) }
  setImmediate(tick)
  bot.stop = () => { ticking = false }
  bot.gotos = () => gotos
  return bot
}

test('navigate: a search that brings no path in planTicks ends with NO_PATH, not STUCK', async () => {
  const bot = pathBot('searching')
  try {
    await assert.rejects(navigate(bot, { goal: new goals.GoalBlock(50, 64, 0), planTicks: 30, stuckTicks: 10 }), (err: unknown) => isSkillError(err, 'NO_PATH') && /no path found in 30 ticks/.test((err as Error).message))
  } finally { bot.stop() }
})

test('navigate: stuck on a path, the bot steps to its block\'s middle and goes again, `unstick` times', async () => {
  const bot = pathBot('stuck')
  try {
    await assert.rejects(navigate(bot, { goal: new goals.GoalBlock(50, 64, 0), stuckTicks: 10, unstick: 2 }), (err: unknown) => isSkillError(err, 'STUCK'))
    assert.strictEqual(bot.gotos(), 3)
  } finally { bot.stop() }
})

test('navigate gives up stuck while a dig target stays set and the bot stays put (it used to wait for good)', async () => {
  const { EventEmitter } = await import('node:events')
  const { navigate } = await import('../../src/skills/navigate')
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  // a dig target left set by a dig the pathfinder dropped
  bot.targetDigBlock = { position: new Vec3(1, 64, 0) }
  let release: (() => void) | null = null
  bot.pathfinder = {
    isPathing: false,
    goto: async () => {
      bot.pathfinder.isPathing = true
      setImmediate(() => bot.emit('pathGenerated', { path: [] }))
      await new Promise<void>(resolve => { release = resolve })
      bot.pathfinder.isPathing = false
    },
    cancel: async () => { release?.() }
  }
  const goal = new GoalReachBlock(new Vec3(30, 64, 0), 1)
  const rejected = assert.rejects(navigate(bot, { goal, stuckTicks: 20, unstick: 0 }), (err: any) => err.reason === 'STUCK')
  // 20 ticks are not enough while it digs (the same block): 5 times that are
  let ticks = 0
  for (; ticks < 300 && release == null; ticks++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  let settled = false
  void rejected.then(() => { settled = true })
  for (let i = 0; i < 50; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  assert.strictEqual(settled, false, 'stuck after 50 ticks on one dig')
  for (let i = 0; i < 100; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  await rejected
})
