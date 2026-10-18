import { test } from 'node:test'
import assert from 'node:assert'
import { ReflexEngine } from '../../src/reflexes/engine'
import { reflexConfig, DEFAULT_REFLEX_CONFIG } from '../../src/reflexes/config'
import type { Reflex, TaskSink } from '../../src/reflexes/types'
import { fakeBot } from './fakeBot'

const flush = async (): Promise<void> => await new Promise(resolve => setImmediate(resolve))

/** a reflex that fires while `on()` and runs until aborted or released */
function fakeReflex (name: string, priority: number, on: () => boolean, log: string[]): Reflex & { release: () => void } {
  let release = (): void => {}
  return {
    name,
    priority,
    release: () => release(),
    check: () => on()
      ? {
          name,
          priority,
          run: async (signal) => await new Promise<void>((resolve, reject) => {
            log.push(`start ${name}`)
            release = () => { log.push(`done ${name}`); resolve() }
            signal.addEventListener('abort', () => { log.push(`abort ${name}`); reject(new Error('aborted')) })
          })
        }
      : null
  }
}

test('reflexConfig lays the given fields over the defaults, section by section', () => {
  const c = reflexConfig({ eat: { food: 10 }, retryCooldownTicks: 5 })
  assert.strictEqual(c.eat.food, 10)
  assert.strictEqual(c.eat.health, DEFAULT_REFLEX_CONFIG.eat.health)
  assert.strictEqual(c.retryCooldownTicks, 5)
  assert.deepStrictEqual(c.creeper, DEFAULT_REFLEX_CONFIG.creeper)
})

test('the engine runs the most urgent task, and a more urgent one preempts it', async () => {
  const bot = fakeBot()
  const log: string[] = []
  let lowOn = true
  let highOn = false
  const low = fakeReflex('low', 10, () => lowOn, log)
  const high = fakeReflex('high', 50, () => highOn, log)
  const engine = new ReflexEngine(bot, { reflexes: [low, high] })
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(log, ['start low'])
  assert.strictEqual(engine.current?.name, 'low')
  // the same reflex doesn't fire again while its task runs
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(log, ['start low'])
  highOn = true
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(log, ['start low', 'abort low', 'start high'])
  // a less urgent one waits
  lowOn = true
  bot.emit('physicsTick')
  await flush()
  assert.strictEqual(engine.current?.name, 'high')
  highOn = false
  high.release()
  await flush()
  assert.strictEqual(engine.current, null)
  // low failed (aborted): it waits out the retry cooldown
  bot.emit('physicsTick')
  await flush()
  assert.strictEqual(engine.current, null)
  for (let i = 0; i < DEFAULT_REFLEX_CONFIG.retryCooldownTicks; i++) bot.emit('physicsTick')
  await flush()
  assert.strictEqual(engine.current?.name, 'low')
  engine.stop()
})

test('with a task sink (core\'s TaskRunner) the tasks go to it, above the foreground priority', async () => {
  const bot = fakeBot()
  const queued: Array<{ name: string, priority?: number, onPreempt?: string }> = []
  const sink: TaskSink = {
    current: { name: 'collect logs', priority: 0 },
    enqueue: (opts, fn) => {
      queued.push(opts)
      return { result: fn({ signal: new AbortController().signal }), cancel: () => {} }
    }
  }
  const log: string[] = []
  const r = fakeReflex('eat', 50, () => true, log)
  const engine = new ReflexEngine(bot, { reflexes: [r], sink })
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(queued, [{ name: 'reflex:eat', priority: 50, onPreempt: 'fail' }])
  assert.deepStrictEqual(log, ['start eat'])
  engine.stop()
})

test('the engine follows each creeper\'s swell (+1 a tick swelling, -1 not, 0 - 30)', () => {
  const creeper: any = { id: 7, name: 'creeper', position: { distanceTo: () => 3 }, metadata: [] }
  const bot = fakeBot()
  bot.entities[7] = creeper
  const engine = new ReflexEngine(bot, { reflexes: [] })
  creeper.metadata[16] = 1
  for (let i = 0; i < 40; i++) bot.emit('physicsTick')
  assert.strictEqual(engine.context().swell.get(7), 30)
  creeper.metadata[16] = -1
  for (let i = 0; i < 12; i++) bot.emit('physicsTick')
  assert.strictEqual(engine.context().swell.get(7), 18)
  delete bot.entities[7]
  bot.emit('physicsTick')
  assert.strictEqual(engine.context().swell.has(7), false)
  engine.stop()
})
