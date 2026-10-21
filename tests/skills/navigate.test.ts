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
function pathBot (mode: 'searching' | 'stuck' | 'hung'): any {
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
      if (mode !== 'searching') setImmediate(() => bot.emit('pathGenerated', { path: [] }))
      await new Promise<void>(resolve => { cancelled = resolve })
      bot.pathfinder.isPathing = false
    },
    // a hung goto doesn't return when cancelled
    cancel: async () => { if (mode === 'hung') return; cancelled?.(); cancelled = null }
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

test('navigate: a goto that does not return once called off is left behind after CANCEL_TICKS (the trip ends STUCK, not never)', async () => {
  const { CANCEL_TICKS } = await import('../../src/skills/navigate')
  const bot = pathBot('hung')
  let ticks = 0
  bot.on('physicsTick', () => { ticks++ })
  try {
    await assert.rejects(navigate(bot, { goal: new goals.GoalBlock(50, 64, 0), stuckTicks: 10, unstick: 0 }), (err: unknown) => isSkillError(err, 'STUCK'))
    assert.ok(ticks >= CANCEL_TICKS && ticks < CANCEL_TICKS + 100, `${ticks} ticks`)
    // (only the test's own tick counter is left)
    assert.equal(bot.listenerCount('physicsTick'), 1)
  } finally { bot.stop() }
})

test('navigate: a goto left behind with a dig still held lets the dig go (the pathfinder\'s end waited on it, and every goto after); none held, none stopped', async () => {
  for (const held of [true, false]) {
    const bot = pathBot('hung')
    let stops = 0
    bot.targetDigBlock = held ? { position: new Vec3(1, 65, 0) } : null
    bot.stopDigging = () => { stops++; bot.targetDigBlock = null }
    try {
      await assert.rejects(navigate(bot, { goal: new goals.GoalBlock(50, 64, 0), stuckTicks: 10, unstick: 0 }), (err: unknown) => isSkillError(err, 'STUCK'))
      assert.strictEqual(stops, held ? 1 : 0)
      assert.strictEqual(bot.targetDigBlock, null)
    } finally { bot.stop() }
  }
})

test('navigate gives a trip up after maxTicks however it moves (bobbing in the sea, searching again and again)', async () => {
  const bot = pathBot('stuck')
  // the bot keeps moving back and forth, more than the stuck check's half block
  let t = 0
  bot.on('physicsTick', () => { bot.entity.position = new Vec3(0.5 + ((t++ % 2) * 0.8), 64, 0.5) })
  try {
    await assert.rejects(navigate(bot, { goal: new goals.GoalBlock(50, 64, 0), stuckTicks: 10, unstick: 0, maxTicks: 60 }), (err: unknown) => isSkillError(err, 'STUCK') && /no arrival in 60 ticks/.test((err as Error).message))
  } finally { bot.stop() }
})

test('navigate counts the stuck ticks again from the end of a dig: a long dig (an ore by hand) isn\'t stuck the tick it ends', async () => {
  const { EventEmitter } = await import('node:events')
  const { navigate } = await import('../../src/skills/navigate')
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
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
  const tick = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
  }
  const rejected = assert.rejects(navigate(bot, { goal: new GoalReachBlock(new Vec3(30, 64, 0), 1), stuckTicks: 20, unstick: 0 }), (err: any) => err.reason === 'STUCK')
  let settled = false
  void rejected.then(() => { settled = true })
  for (let i = 0; i < 300 && release == null; i++) await tick(1)
  // a dig of 60 ticks (under 5 times 20), then the block broke and the bot sets off: the next ticks aren't stuck
  await tick(60)
  bot.targetDigBlock = null
  await tick(10)
  assert.strictEqual(settled, false, 'stuck as the dig ended')
  // still standing 20 ticks after it: that is stuck
  await tick(30)
  await rejected
})

test('navigate: a goto short of its goal (the pathfinder\'s GoalNotReachedError) is told as before, NO_PATH \'the path ended ... short of the goal\' with a no_path report, not \'the pathfinder failed\'; another failure of goto as it was', async () => {
  const run = async (error: Error): Promise<{ err: any, kinds: string[] }> => {
    const bot: any = pathBot('stuck')
    const kinds: string[] = []
    bot.survival = { diagnostics: { report: (r: any) => { kinds.push(r.kind); return { diagnosis: 'd' } }, fileOf: () => null } }
    bot.pathfinder.goto = async () => {
      setImmediate(() => bot.emit('pathGenerated', { path: [] }))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      throw error
    }
    try {
      const err = await navigate(bot, { goal: new goals.GoalBlock(50, 64, 0), stuckTicks: 1000 }).then(() => null, e => e)
      return { err, kinds }
    } finally { bot.stop() }
  }
  const short = Object.assign(new Error('Goto: ended at (0.7, 64, 0.5), short of the goal (the search ended: noPath)'), { name: 'GoalNotReachedError', code: 'GOAL_NOT_REACHED' })
  const a = await run(short)
  assert.ok(isSkillError(a.err, 'NO_PATH'), String(a.err))
  assert.match(a.err.message, /the path ended at .* short of the goal/)
  assert.doesNotMatch(a.err.message, /the pathfinder failed/)
  assert.deepStrictEqual(a.kinds, ['no_path'])
  const b = await run(new Error('Goto: 5 moves in a row failed'))
  assert.match(b.err.message, /the pathfinder failed: Goto: 5 moves in a row failed/)
  assert.deepStrictEqual(b.kinds, ['goto_failed'])
})
