import { test } from 'node:test'
import assert from 'node:assert'
import { ReflexEngine } from '../../src/reflexes/engine'
import { reflexConfig, DEFAULT_REFLEX_CONFIG } from '../../src/reflexes/config'
import type { Reflex, TaskSink } from '../../src/reflexes/types'
import { entity, fakeBot, item } from './fakeBot'
import { armorReflex, drowningReflex, eatReflex, hostilesReflex } from '../../src/reflexes/rules'
import { Vec3 } from 'vec3'

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

test('a hostile at health 0 (its death animation) is not in the context: the hostiles reflex goes on to the next one', () => {
  const dead = entity({ name: 'zombie', position: new Vec3(2.5, 64, 0.5), meta: { health: 0 } })
  const next = entity({ name: 'zombie', position: new Vec3(4.5, 64, 0.5), meta: { health: 20 } })
  const bot = fakeBot({ items: [item('iron_sword')], entities: [dead, next] })
  const engine = new ReflexEngine(bot, { reflexes: [] })
  const ctx = engine.context()
  assert.deepStrictEqual(ctx.hostiles.map(e => e.id), [next.id])
  assert.strictEqual(hostilesReflex.check(ctx)?.detail, 'fight zombie')
  engine.stop()
})

test('inhibit keeps the named reflexes from firing until every hold is released; the others still fire', async () => {
  const bot = fakeBot()
  const log: string[] = []
  const eat = fakeReflex('eat', 50, () => true, log)
  const apple = fakeReflex('emergency eat', 75, () => false, log)
  const engine = new ReflexEngine(bot, { reflexes: [eat, apple] })
  const first = engine.inhibit(['eat'])
  const second = engine.inhibit(['eat'])
  assert.deepStrictEqual(engine.inhibitedNames, ['eat'])
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(log, [])
  first()
  // released twice counts once
  first()
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(log, [])
  second()
  assert.deepStrictEqual(engine.inhibitedNames, [])
  bot.emit('physicsTick')
  await flush()
  assert.deepStrictEqual(log, ['start eat'])
  engine.stop()
})

test('leaveAlone keeps the named mobs out of the reflexes\' sight until every hold is released: the hostiles reflex leaves a blaze to the blaze fight', () => {
  const blaze = entity({ name: 'blaze', position: new Vec3(3.5, 64, 0.5), meta: { health: 20 } })
  const zombie = entity({ name: 'zombie', position: new Vec3(6.5, 64, 0.5), meta: { health: 20 } })
  const bot = fakeBot({ items: [item('diamond_sword')], entities: [blaze, zombie] })
  bot.world = { raycast: () => null }
  const engine = new ReflexEngine(bot, { reflexes: [] })
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight blaze')
  const first = engine.leaveAlone(['blaze'])
  const second = engine.leaveAlone(['blaze'])
  assert.deepStrictEqual(engine.leftAloneNames, ['blaze'])
  assert.deepStrictEqual(engine.context().hostiles.map(e => e.id), [zombie.id])
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight zombie')
  first()
  first()
  assert.deepStrictEqual(engine.context().hostiles.map(e => e.id), [zombie.id])
  second()
  assert.deepStrictEqual(engine.leftAloneNames, [])
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight blaze')
  engine.stop()
})

test('the drowning reflex holds those under it with the head under water: no meal there, and at low air nothing but a lethal fight, while it waits to go again too', () => {
  // the bot's head in the water from y 60 to 69 (the drowning reflex itself out of the way: as in its retry cooldown)
  const water = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 70 ? 'water' : 'air'
  const waiting: Reflex = { ...drowningReflex, check: () => null }
  const reflexes = [waiting, eatReflex, hostilesReflex, armorReflex]
  const evaluate = (input: Parameters<typeof fakeBot>[0], setup?: (engine: ReflexEngine) => void): string | null => {
    const bot = fakeBot(input)
    bot.world = { raycast: () => null }
    const engine = new ReflexEngine(bot, { reflexes, enabled: false })
    setup?.(engine)
    const task = engine.evaluate()
    engine.stop()
    return task?.name ?? null
  }
  const food = [item('cooked_porkchop', 4)]
  // starving (food 6) under water, the air fine or low: no meal; the head out of the water: the meal
  assert.strictEqual(evaluate({ food: 6, items: food, oxygen: 15, position: new Vec3(0.5, 61, 0.5), world: water }), null)
  assert.strictEqual(evaluate({ food: 6, items: food, oxygen: 3, position: new Vec3(0.5, 61, 0.5), world: water }), null)
  assert.strictEqual(evaluate({ food: 6, items: food, oxygen: 3, position: new Vec3(0.5, 70, 0.5), world: water }), 'eat')
  // the armor reflex under water with air: on; at low air: held
  const armor = (engine: ReflexEngine): void => { (engine as any).armorChanged = true }
  assert.strictEqual(evaluate({ items: [item('iron_chestplate')], oxygen: 15, position: new Vec3(0.5, 61, 0.5), world: water }, armor), 'armor')
  assert.strictEqual(evaluate({ items: [item('iron_chestplate')], oxygen: 3, position: new Vec3(0.5, 61, 0.5), world: water }, armor), null)
  // a drowned close under water: fought with air; at low air only once it's lethal (hurt by it, at flee health)
  const drowned = entity({ name: 'drowned', position: new Vec3(2.5, 61, 0.5), meta: { health: 20 } })
  const fightAt = (oxygen: number, health: number, hurt: boolean): string | null => evaluate(
    { items: [item('iron_sword')], oxygen, health, entities: [drowned], position: new Vec3(0.5, 61, 0.5), world: water },
    engine => { if (hurt) { (engine as any).attackers.set(drowned.id, 0); (engine as any).lastHurtTick = 0 } })
  assert.strictEqual(fightAt(15, 20, false), 'hostiles')
  assert.strictEqual(fightAt(3, 20, true), null)
  assert.strictEqual(fightAt(3, 5, false), null)
  assert.strictEqual(fightAt(3, 5, true), 'hostiles')
  // inhibited, the drowning reflex holds nothing
  assert.strictEqual(evaluate({ food: 6, items: food, oxygen: 3, position: new Vec3(0.5, 61, 0.5), world: water }, engine => { engine.inhibit(['drowning']) }), 'eat')
})

test('a drowning task that failed goes again at once (retryCooldownTicks 0), not after the engine\'s cooldown', async () => {
  const bot = fakeBot()
  let runs = 0
  const failing: Reflex = {
    name: 'drowning',
    priority: 85,
    retryCooldownTicks: 0,
    check: () => ({ name: 'drowning', priority: 85, run: async () => { runs++; throw new Error('no air reached') } })
  }
  const engine = new ReflexEngine(bot, { reflexes: [failing] })
  bot.emit('physicsTick')
  await flush()
  assert.strictEqual(runs, 1)
  bot.emit('physicsTick')
  await flush()
  assert.strictEqual(runs, 2)
  engine.stop()
  assert.strictEqual(drowningReflex.retryCooldownTicks, 0)
})
