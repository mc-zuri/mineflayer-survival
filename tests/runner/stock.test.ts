// The runner's stock hooks: a milestone ends with the stock topped up where the bot is, the chests' stock counts, a
// top-up over its budget waits, the night's mine has the ores' top-ups, and the working set is the executor's keep rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { WorldMemory } from '../../src/core/memory'
import { Runner, STOCK_RETRY_TICKS } from '../../src/runner'
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

test('a milestone ends with its stock topped up: the wood milestone cuts a stack of logs by day, and its event has the levels', async () => {
  const bot = fakeBot()
  const steps: string[] = []
  const lines: string[] = []
  const runner = new Runner(bot, {
    until: 'wood',
    log: l => lines.push(l),
    executor: { runners: giving(bot, steps), log: () => {} },
    handlers: { wood: async () => { bot.give('wooden_pickaxe', 1); bot.give('crafting_table', 1); bot.give('oak_log', 8) } }
  })
  const result = await runner.play()
  assert.equal(result.reason, 'until')
  assert.deepEqual(steps, ['mine 56 oak_log'], lines.join('\n'))
  assert.deepEqual(result.reached[0].stock?.wood, { carried: 64, stored: 0, low: 32, high: 64 })
  assert.ok(lines.some(l => /stock at wood: wood 64\/32-64/.test(l)), lines.join('\n'))
  // the working set is the executor's keep rule: a stack of logs carried
  assert.equal(runner.executor.options.keep('oak_log', registry), 64)
})

test('the base\'s chests count: logs stored there are stock, not cut again, and a top-up never loots them', async () => {
  const bot = fakeBot({ wooden_pickaxe: 1, crafting_table: 1, oak_log: 8 })
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
  assert.ok(lines.some(l => /stock: wood 0\/32-64: not now \(1000000 ticks for 64, over its 6400\)/.test(l)), lines.join('\n'))
  // waiting STOCK_RETRY_TICKS before the next try
  assert.equal(runner.dueTopUps(['surface']).length, 0)
  bot.survival.tasks.tick += STOCK_RETRY_TICKS
  assert.equal(runner.dueTopUps(['surface']).length, 1)
  // a cheap plan whose work runs on: cut off once its 6400 ticks are up
  runner.executor.plan = () => ({ ok: true, steps: [], cost: 100, inventory: null as any, unresolved: [] })
  runner.executor.obtain = async (_req: any, signal?: AbortSignal) => await new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
  const run = runner.topUp(['surface'], new AbortController().signal)
  for (let i = 0; i < 6400; i++) { bot.emit('physicsTick'); if (i % 500 === 0) await new Promise(resolve => setImmediate(resolve)) }
  await run
  assert.ok(lines.some(l => /stock: wood stopped after 6400 ticks: its 6400 ticks are up/.test(l)), lines.join('\n'))
})

test('at night the stock\'s mine top-ups are the night\'s work: with no milestone goal down there, the bot mines for them', async () => {
  const bot = fakeBot({ iron_pickaxe: 1, diamond_pickaxe: 1, stone_sword: 1, crafting_table: 1, furnace: 1, cooked_beef: 16, shield: 1, oak_log: 64, torch: 16 })
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
  const none = new Runner(fakeBot({ iron_pickaxe: 1, diamond_pickaxe: 1, cooked_beef: 16, torch: 16 }), { stock: false, log: () => {} })
  none.bot.time = { timeOfDay: 13000, day: 4 }
  none.reached.push(...at(['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting']))
  assert.equal(none.nightDue(), null)
})
