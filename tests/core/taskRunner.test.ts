import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'

function setup (opts = {}): { runner: TaskRunner, tick: (n?: number) => Promise<void>, flush: () => Promise<void> } {
  const bot = new EventEmitter()
  const runner = new TaskRunner(bot as any, opts)
  const flush = async (): Promise<void> => await new Promise(resolve => setImmediate(resolve))
  const tick = async (n = 1): Promise<void> => {
    for (let i = 0; i < n; i++) {
      bot.emit('physicsTick')
      await flush()
    }
  }
  return { runner, tick, flush }
}

test('tasks queued together run one at a time, highest priority first, FIFO within a priority', async () => {
  const { runner, flush } = setup()
  const order: string[] = []
  const job = (name: string) => async () => { order.push(name) }
  const all = [
    runner.run({ name: 'a', priority: 0 }, job('a')),
    runner.run({ name: 'b', priority: 5 }, job('b')),
    runner.run({ name: 'c', priority: 0 }, job('c')),
    runner.run({ name: 'd', priority: 5 }, job('d'))
  ]
  await flush()
  await Promise.all(all)
  assert.deepEqual(order, ['b', 'd', 'a', 'c'])
})

test('a higher-priority reflex preempts the foreground task, which then resumes with its state', async () => {
  const { runner, tick, flush } = setup()
  const log: string[] = []
  const mine = runner.run<number, { mined: number }>({ name: 'mine', state: { mined: 0 } }, async (ctx) => {
    log.push(`mine attempt ${ctx.attempt} from ${ctx.state.mined}`)
    while (ctx.state.mined < 5) {
      await ctx.waitTicks(1)
      ctx.state.mined++
    }
    return ctx.state.mined
  })
  await flush()
  await tick(3)
  assert.equal(runner.current?.name, 'mine')
  const eat = runner.run({ name: 'eat', priority: 10 }, async (ctx) => {
    log.push('eat')
    await ctx.waitTicks(2)
    return 'fed'
  })
  await flush()
  assert.equal(runner.current?.name, 'eat')
  assert.deepEqual(runner.pending, ['mine'])
  await tick(2)
  assert.equal(await eat, 'fed')
  await tick(5)
  assert.equal(await mine, 5)
  assert.deepEqual(log, ['mine attempt 1 from 0', 'eat', 'mine attempt 2 from 3'])
})

test('a lower or equal priority task waits for the foreground lock', async () => {
  const { runner, tick, flush } = setup()
  const first = runner.run({ name: 'first', priority: 3 }, async (ctx) => { await ctx.waitTicks(2); return 1 })
  await flush()
  const second = runner.run({ name: 'second', priority: 3 }, async () => 2)
  await flush()
  assert.equal(runner.current?.name, 'first')
  await tick(2)
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
})

test("onPreempt 'fail' rejects with PREEMPTED instead of resuming", async () => {
  const { runner, tick, flush } = setup()
  const task = runner.run({ name: 'walk', onPreempt: 'fail' }, async (ctx) => { await ctx.waitTicks(100) })
  const rejected = assert.rejects(task, (err: unknown) => TaskError.is(err, 'PREEMPTED'))
  await flush()
  void runner.run({ name: 'flee', priority: 1 }, async () => {})
  await tick()
  await rejected
})

test('cancel aborts the running task and drops a queued one, both with ABORTED', async () => {
  const { runner, flush } = setup()
  let sawAbort = false
  const running = runner.enqueue('running', async (ctx) => {
    ctx.signal.addEventListener('abort', () => { sawAbort = true })
    await ctx.waitTicks(100)
  })
  const queued = runner.enqueue('queued', async () => 'never')
  await flush()
  queued.cancel()
  running.cancel()
  await assert.rejects(queued.result, (err: unknown) => TaskError.is(err, 'ABORTED'))
  await assert.rejects(running.result, (err: unknown) => TaskError.is(err, 'ABORTED'))
  assert.equal(sawAbort, true)
  assert.equal(runner.busy, false)
})

test('timeouts count physics ticks while the task is in the foreground, and keep its partial result', async () => {
  const { runner, tick, flush } = setup()
  const task = runner.run<void, { logs: number }>({ name: 'chop', timeoutTicks: 4, state: { logs: 0 } }, async (ctx) => {
    try {
      for (;;) { await ctx.waitTicks(1); ctx.state.logs++ }
    } catch (err) {
      throw TaskError.from(err).withPartial({ logs: ctx.state.logs })
    }
  })
  const rejected = assert.rejects(task, (err: unknown) => TaskError.is(err, 'TIMEOUT') && (err.partial as any).logs === 3)
  await flush()
  await tick(3)
  assert.equal(runner.busy, true)
  await tick(1)
  await rejected
})

test('retries re-run a task that failed with one of retryOn', async () => {
  const { runner, flush } = setup()
  const task = runner.run({ name: 'path', retries: 2, retryOn: ['NO_PATH'] }, async (ctx) => {
    if (ctx.attempt < 3) throw new TaskError('NO_PATH')
    return ctx.attempt
  })
  await flush()
  assert.equal(await task, 3)
  const other = runner.run({ name: 'craft', retries: 2, retryOn: ['NO_PATH'] }, async () => { throw new TaskError('MISSING_ITEMS') })
  await assert.rejects(other, (err: unknown) => TaskError.is(err, 'MISSING_ITEMS'))
})

test('cancelAll rejects the running and the queued tasks with the given code', async () => {
  const { runner, flush } = setup()
  const a = runner.run('a', async (ctx) => { await ctx.waitTicks(10) })
  const b = runner.run('b', async () => {})
  await flush()
  runner.cancelAll('DIED')
  await assert.rejects(a, (err: unknown) => TaskError.is(err, 'DIED'))
  await assert.rejects(b, (err: unknown) => TaskError.is(err, 'DIED'))
})

test('a task that ignores its abort signal holds the lock only for the grace ticks', async () => {
  const { runner, tick, flush } = setup({ abortGraceTicks: 3 })
  const stuck = runner.run({ name: 'stuck' }, async () => await new Promise(() => {}))
  await flush()
  let reflexRan = false
  const reflex = runner.run({ name: 'reflex', priority: 1 }, async () => { reflexRan = true })
  await tick(2)
  assert.equal(reflexRan, false)
  await tick(1)
  await reflex
  assert.equal(reflexRan, true)
  // the stuck attempt is given up on and the task is queued again; cancel it so the test ends
  assert.deepEqual(runner.pending, [])
  assert.equal(runner.current?.name, 'stuck')
  runner.destroy()
  await assert.rejects(stuck, (err: unknown) => TaskError.is(err, 'ABORTED'))
})

test('stop aborts the running task with its reason, not to be resumed: the result rejects with it and the partial result once the task stops', async () => {
  const { runner, flush } = setup()
  const handle = runner.enqueue({ name: 'dig' }, async (ctx) => {
    await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject((ctx.signal.reason as TaskError).withPartial({ dug: 7 }))))
  })
  await flush()
  handle.stop(new TaskError('TOOL_WORN', 'the pickaxe is about to break'))
  await assert.rejects(handle.result, (err: unknown) => TaskError.is(err, 'TOOL_WORN') && (err as TaskError).partial != null && ((err as TaskError).partial as any).dug === 7)
  assert.equal(runner.current, null)
  assert.deepEqual(runner.pending, [])
  // a queued one is dropped
  const busy = runner.run('busy', async (ctx) => { await ctx.waitTicks(5) })
  const queued = runner.enqueue('queued', async () => 'ran')
  await flush()
  queued.stop(new TaskError('TOOL_WORN', 'worn'))
  await assert.rejects(queued.result, (err: unknown) => TaskError.is(err, 'TOOL_WORN'))
  runner.destroy()
  await assert.rejects(busy)
})
