// The runner's stock hooks: a milestone ends with the stock topped up where the bot is, the chests' stock counts, a
// top-up over its budget waits, the night's mine has the ores' top-ups, and the working set is the executor's keep rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { WorldMemory } from '../../src/core/memory'
import { Runner, STOCK_WAIT_TICKS } from '../../src/runner'
import { StockPolicy } from '../../src/planner/stock'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

function fakeBot (items: Record<string, number> = {}): any {
  const bot: any = new EventEmitter()
  bot.registry = registry
  const counts = new Map(Object.entries(items))
  const slots = (): any[] => {
    const out: any[] = new Array(46).fill(null)
    let i = 9
    for (const [name, count] of counts) {
      // whole stacks a slot, as the window holds them
      const stack = registry.itemsByName[name].stackSize
      for (let left = count; left > 0 && i < 45; left -= stack) out[i++] = { name, count: Math.min(stack, left), type: registry.itemsByName[name].id, slot: i - 1 }
    }
    return out
  }
  bot.inventory = { get slots () { return slots() }, inventoryStart: 9, inventoryEnd: 45, items: () => slots().slice(9, 45).filter(s => s != null) }
  bot.give = (name: string, n: number) => counts.set(name, (counts.get(name) ?? 0) + n)
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.food = 20
  bot.time = { timeOfDay: 1000, day: 0 }
  bot.isRaining = false
  bot.findBlock = () => null
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot), handlers: {}, advancements: new Set(), stock: new StockPolicy() }
  return bot
}

/** step runners that hand the bot what the step makes */
function giving (bot: any, log: string[]): any {
  const give = async (step: any): Promise<any> => { log.push(`${step.kind} ${step.count} ${step.item}`); bot.give(step.item, step.count); return { gained: step.count } }
  return { mine: give, craft: give, smelt: give, kill: give }
}

const at = (ids: string[]): any[] => ids.map(id => ({ id, title: '', tick: 0, wallMs: 0 }))

test('a milestone ends with its stock topped up when that is cheap: the stack of logs waits for the stone axe, and each event has the levels', async () => {
  const bot = fakeBot()
  const steps: string[] = []
  const lines: string[] = []
  const runner = new Runner(bot, {
    until: 'stone',
    log: l => lines.push(l),
    executor: { runners: giving(bot, steps), log: () => {} },
    handlers: {
      wood: async () => { bot.give('wooden_pickaxe', 1); bot.give('crafting_table', 1); bot.give('oak_log', 8) },
      stone: async () => {
        for (const n of ['stone_pickaxe', 'stone_sword', 'stone_axe', 'furnace']) bot.give(n, 1)
        bot.survival.tasks.tick += STOCK_WAIT_TICKS
      }
    }
  })
  const result = await runner.play()
  assert.equal(result.reason, 'until')
  // by hand a log is dearer than the wood's 60 ticks: none cut after the wood milestone, the stack after the stone's
  assert.ok(lines.some(l => /stock: wood 8\/32-64: not now/.test(l)), lines.join('\n'))
  assert.deepEqual(steps, ['mine 56 oak_log'], lines.join('\n'))
  assert.deepEqual(result.reached.map(r => r.stock?.wood), [{ carried: 8, stored: 0, low: 32, high: 64 }, { carried: 64, stored: 0, low: 32, high: 64 }])
  assert.ok(lines.some(l => /stock at stone: wood 64\/32-64/.test(l)), lines.join('\n'))
  // the working set is the executor's keep rule: a stack of logs carried
  assert.equal(runner.executor.options.keep('oak_log', registry), 64)
})

test('the base\'s chests count: logs stored there are stock, not cut again, and a top-up never loots them', async () => {
  const bot = fakeBot({ wooden_pickaxe: 1, stone_axe: 1, crafting_table: 1, oak_log: 8 })
  bot.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  bot.survival.memory.rememberChest({ x: 1, y: 40, z: 0 }, { oak_log: 60 })
  const steps: string[] = []
  const runner = new Runner(bot, { log: () => {}, executor: { runners: giving(bot, steps), log: () => {} } })
  assert.deepEqual(runner.stockStored(), { oak_log: 60 })
  assert.equal(runner.dueTopUps(['surface']).length, 0)
  // 20 stored: under the low mark, so to 64 with the 28 carried and stored: 36 more cut, none taken from the chest
  bot.survival.memory.rememberChest({ x: 1, y: 40, z: 0 }, { oak_log: 20 })
  let planned: any = null
  const plan = runner.executor.plan.bind(runner.executor)
  runner.executor.plan = (req: any, inv?: any, extra?: any) => { planned = extra; return plan(req, inv, extra) }
  await runner.topUp(['surface'], new AbortController().signal)
  assert.deepEqual(steps, ['mine 36 oak_log'])
  assert.deepEqual(planned.exclude, ['loot'])
})

test('a top-up waits when its plan is dearer than its budget, and stops when its budget\'s ticks are up', async () => {
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1 })
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l), executor: { log: () => {} } })
  runner.executor.plan = () => ({ ok: true, steps: [], cost: 1e6, inventory: null as any, unresolved: [] })
  let obtained = 0
  runner.executor.obtain = async () => { obtained++; return { plans: 1, steps: 0 } }
  await runner.topUp(['surface'], new AbortController().signal)
  assert.equal(obtained, 0)
  assert.ok(lines.some(l => /stock: wood 0\/32-64: not now \(1000000 ticks for 64, over its 3840\)/.test(l)), lines.join('\n'))
  // waiting STOCK_WAIT_TICKS before the next look
  assert.equal(runner.dueTopUps(['surface']).length, 0)
  bot.survival.tasks.tick += STOCK_WAIT_TICKS
  assert.equal(runner.dueTopUps(['surface']).length, 1)
  // a cheap plan whose work runs on: cut off once its 3840 ticks are up
  runner.executor.plan = () => ({ ok: true, steps: [], cost: 100, inventory: null as any, unresolved: [] })
  runner.executor.obtain = async (_req: any, signal?: AbortSignal) => await new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
  const run = runner.topUp(['surface'], new AbortController().signal)
  for (let i = 0; i < 3840; i++) { bot.emit('physicsTick'); if (i % 500 === 0) await new Promise(resolve => setImmediate(resolve)) }
  await run
  assert.ok(lines.some(l => /stock: wood stopped after 3840 ticks: its 3840 ticks are up/.test(l)), lines.join('\n'))
})

test('at night the stock\'s mine top-ups are the night\'s work: with no milestone goal down there, the bot mines for them', async () => {
  const bot = fakeBot({ iron_pickaxe: 1, diamond_pickaxe: 1, stone_sword: 1, iron_chestplate: 1, crafting_table: 1, furnace: 1, cooked_beef: 16, shield: 1, oak_log: 64, torch: 16 })
  bot.time = { timeOfDay: 13000, day: 4 }
  const steps: string[] = []
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => lines.push(l), executor: { runners: giving(bot, steps), log: () => {} } })
  runner.reached.push(...at(['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting']))
  assert.notEqual(runner.nightDue(), null)
  await runner.nightSchedule()
  for (const item of ['cobblestone', 'coal', 'raw_iron', 'diamond']) assert.ok(steps.some(s => s.startsWith('mine') && s.endsWith(` ${item}`)), `no ${item}: ${steps.join(', ')}`)
  // only the mine's: no logs cut, no hunt
  assert.ok(!steps.some(s => /log|beef|arrow/.test(s)), steps.join(', '))
  // without a stock policy the night has nothing to mine for
  const none = new Runner(fakeBot({ iron_pickaxe: 1, diamond_pickaxe: 1, stone_sword: 1, iron_chestplate: 1, cooked_beef: 16, torch: 16 }), { stock: false, log: () => {} })
  none.bot.time = { timeOfDay: 13000, day: 4 }
  none.reached.push(...at(['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting']))
  assert.equal(none.nightDue(), null)
})

test('by day the top-ups are the surface\'s unless the bot is deep down: a pit under a hill is the surface\'s, y 20 the mine\'s', async () => {
  for (const [y, want] of [[63, 'oak_log'], [20, 'coal']] as const) {
    const bot = fakeBot({ stone_pickaxe: 1, stone_axe: 1, crafting_table: 1, furnace: 1, oak_log: 8 })
    bot.entity.position = new Vec3(0, y, 0)
    // a roof over the bot: not the open sky
    bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' })
    const steps: string[] = []
    const runner = new Runner(bot, { until: 'stone', log: () => {}, executor: { runners: giving(bot, steps), log: () => {} }, handlers: { stone: async () => bot.give('stone_sword', 1) } })
    runner.reached.push(...at(['wood']))
    await runner.play()
    assert.ok(steps.some(s => s.endsWith(want)), `y ${y}: ${steps.join(', ')}`)
    assert.ok(!steps.some(s => s.endsWith(want === 'coal' ? 'oak_log' : 'coal')), `y ${y}: ${steps.join(', ')}`)
  }
})

test('a top-up that gathers tells the stall watchdog (bot.survival.diagnostics.progress)', async () => {
  const bot = fakeBot({ stone_axe: 1, crafting_table: 1 })
  const progress: string[] = []
  const steps: string[] = []
  const runner = new Runner(bot, { log: () => {}, executor: { runners: giving(bot, steps), log: () => {} } })
  // the diagnostics' other hooks (arm, planMade, stepStarted...) left as no-ops
  bot.survival.diagnostics = new Proxy({}, { get: (_t, k) => k === 'progress' ? (what: string) => progress.push(what) : k === 'step' ? undefined : () => () => {} })
  await runner.topUp(['surface'], new AbortController().signal)
  assert.deepEqual(steps, ['mine 64 oak_log'])
  assert.ok(progress.includes('stock wood 64'), progress.join(', '))
})

test('with no base the stock over its working set may go when room is wanted; with the base\'s chests it is stored', () => {
  const bot = fakeBot()
  const runner = new Runner(bot, { log: () => {} })
  assert.equal(runner.executor.options.surplus('cobblestone'), true)
  assert.equal(runner.executor.options.surplus('raw_iron'), false)
  bot.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  bot.survival.memory.rememberChest({ x: 1, y: 40, z: 0 }, {})
  assert.equal(runner.executor.options.surplus('cobblestone'), false)
})

test('on a trip (the eyes\' search, the End) the stock tops up only what the trip spends: food, arrows, blocks; not gold', async () => {
  const gear = { diamond_pickaxe: 1, diamond_sword: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bucket: 1, crafting_table: 1, furnace: 1, stone_axe: 1, cooked_beef: 4 }
  const reached = ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting', 'nether'] as const
  const bot = fakeBot({ ...gear, ender_eye: 16 })
  bot.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  const runner = new Runner(bot, { log: () => {}, executor: { log: () => {} } })
  runner.reached.push(...at([...reached]))
  const trip = runner.dueTopUps(['surface', 'underground']).map(u => u.mark.id)
  assert.ok(trip.length > 0)
  assert.ok(trip.every(id => ['food', 'arrow', 'stone'].includes(id)), trip.join(', '))
  // at home before the nether, gold and the rest are due as before
  const home = fakeBot({ ...gear })
  home.survival.memory.setBase({ x: 0, y: 40, z: 0 })
  const r2 = new Runner(home, { log: () => {}, executor: { log: () => {} } })
  r2.reached.push(...at(['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting']))
  assert.ok(r2.dueTopUps(['surface', 'underground']).some(u => u.mark.id === 'gold'))
})

test('between trips the herd is tended for the food the stock is short of: from the food milestone on, by day, once a breeding cooldown', async () => {
  const { HERD_TEND_TICKS } = await import('../../src/runner')
  const milestones = require('../../src/milestones')
  const bot = fakeBot({ bread: 4 })
  const runner = new Runner(bot, { log: () => {} })
  const real = milestones.tendHerd
  const wants: number[] = []
  milestones.tendHerd = async (_b: any, _e: any, _s: any, _l: any, opts: any) => { wants.push(opts.want); return 0 }
  try {
    // not before the food milestone
    await runner.keepHerd()
    assert.deepEqual(wants, [])
    runner.reached.push(...at(['wood', 'stone', 'food']))
    await runner.keepHerd()
    // the food's high mark, 80, less the 20 points of bread carried
    assert.deepEqual(wants, [60])
    // not again within the cooldown, nor at night
    await runner.keepHerd()
    bot.survival.tasks.tick += HERD_TEND_TICKS
    bot.time.timeOfDay = 18000
    await runner.keepHerd()
    assert.deepEqual(wants, [60])
    bot.time.timeOfDay = 1000
    await runner.keepHerd()
    assert.deepEqual(wants, [60, 60])
  } finally {
    milestones.tendHerd = real
  }
})

test('a mine step\'s bulk is the stock\'s: the logs short of the working set carried, the stone\'s from the wood milestone on; none with no stock', () => {
  const bot = fakeBot({ stone_axe: 1, oak_log: 8, cobblestone: 10 })
  const runner = new Runner(bot, { executor: { log: () => {} } })
  const logs = runner.stock?.keepCount('oak_log', registry) as number
  assert.deepEqual(runner.executor.options.bulk('oak_log'), { count: logs - 8, ticksPerUnit: 60 })
  // the stone mark applies from the wood milestone
  assert.equal(runner.executor.options.bulk('cobblestone'), null)
  runner.reached.push(...at(['wood']))
  assert.equal(runner.executor.options.bulk('cobblestone')?.count, (runner.stock?.keepCount('cobblestone', registry) as number) - 10)
  assert.equal(new Runner(bot, { stock: false, executor: { log: () => {} } }).executor.options.bulk('oak_log'), null)
})
