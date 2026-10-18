import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'
import { WorldMemory } from '../../src/core/memory'
import { Executor, describeStep, neededItems, ownedInventory, requestsMet } from '../../src/executor/executor'
import type { StepRunner } from '../../src/executor/steps'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

/** a bot with an inventory the fake step runners fill, a task runner and a memory */
function fakeBot (items: Record<string, number> = {}): any {
  const bot: any = new EventEmitter()
  bot.registry = registry
  const counts = new Map(Object.entries(items))
  const slots = (): any[] => {
    const out: any[] = new Array(46).fill(null)
    let i = 9
    for (const [name, count] of counts) if (count > 0) out[i++] = { name, count, type: registry.itemsByName[name].id, slot: i - 1 }
    return out
  }
  bot.inventory = {
    get slots () { return slots() },
    inventoryStart: 9,
    inventoryEnd: 45,
    items: () => slots().slice(9, 45).filter(s => s != null)
  }
  bot.give = (name: string, n: number) => counts.set(name, (counts.get(name) ?? 0) + n)
  bot.take = (name: string, n: number) => counts.set(name, (counts.get(name) ?? 0) - n)
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot) }
  return bot
}

function count (bot: any, name: string): number {
  return bot.inventory.items().filter((i: any) => i.name === name).reduce((n: number, i: any) => n + i.count, 0)
}

/** runners that do what the step says, by giving the items and taking the ingredients */
function honestRunners (bot: any, log: string[]): Record<string, StepRunner<any>> {
  return {
    mine: async (step) => { log.push(describeStep(step)); bot.give(step.item, step.count); return { gained: step.count } },
    craft: async (step) => {
      log.push(describeStep(step))
      for (const i of step.ingredients) bot.take(i.name, i.count)
      bot.give(step.item, step.count)
      return { gained: step.count }
    }
  }
}

test('the executor runs a plan step by step through the runners until the requests are met', async () => {
  const bot = fakeBot()
  const log: string[] = []
  const ex = new Executor(bot, { runners: honestRunners(bot, log) })
  const out = await ex.obtain([{ item: 'crafting_table', count: 1 }])
  assert.equal(out.plans, 1)
  assert.deepEqual(log, ['mine 1 oak_log (1 oak_log)', 'craft 4 oak_planks', 'craft 1 crafting_table'])
  assert.equal(count(bot, 'crafting_table'), 1)
  // met already: nothing to do
  assert.deepEqual(await ex.obtain([{ item: 'crafting_table', count: 1 }]), { plans: 0, steps: 0 })
})

test('a step that comes out short is planned again from what the bot has', async () => {
  const bot = fakeBot()
  const log: string[] = []
  const runners = honestRunners(bot, log)
  let first = true
  runners.mine = async (step) => {
    log.push(describeStep(step))
    // the first trip brings one log of the two
    const n = first ? 1 : step.count
    first = false
    bot.give(step.item, n)
    return { gained: n }
  }
  const ex = new Executor(bot, { runners })
  const out = await ex.obtain([{ item: 'oak_planks', count: 8 }])
  assert.equal(out.plans, 2)
  assert.deepEqual(log, ['mine 2 oak_log (2 oak_log)', 'mine 1 oak_log (1 oak_log)', 'craft 8 oak_planks'])
  assert.equal(count(bot, 'oak_planks'), 8)
})

test('when the inventory changes under the plan (a reflex ate, a tool broke) the rest is planned again', async () => {
  const bot = fakeBot({ oak_planks: 4 })
  const log: string[] = []
  const runners = honestRunners(bot, log)
  const craft = runners.craft
  runners.craft = async (step) => {
    const res = await craft(step)
    // after the sticks, something takes the planks the pickaxe needed
    if (step.item === 'stick') bot.take('oak_planks', count(bot, 'oak_planks'))
    return res
  }
  const ex = new Executor(bot, { runners })
  await ex.obtain([{ item: 'wooden_pickaxe', count: 1 }, { item: 'crafting_table', count: 1 }])
  assert.equal(count(bot, 'wooden_pickaxe'), 1)
  assert.ok(log.filter(l => l.startsWith('mine')).length >= 1, log.join('; '))
})

test('a step that keeps failing fails the requests with its error; a death goes straight up', async () => {
  const bot = fakeBot()
  let tries = 0
  const ex = new Executor(bot, { runners: { mine: async () => { tries++; throw new TaskError('NOT_FOUND', 'no trees') } }, maxStepFailures: 3 })
  await assert.rejects(ex.obtain([{ item: 'oak_log', count: 1 }]), /no trees/)
  assert.equal(tries, 3)
  const dead = new Executor(bot, { runners: { mine: async () => { throw new TaskError('DIED', 'the bot died') } } })
  await assert.rejects(dead.obtain([{ item: 'oak_log', count: 1 }]), (err: any) => err.code === 'DIED')
})

test('steps run as foreground tasks a reflex preempts and resumes', async () => {
  const bot = fakeBot()
  const tasks: any = bot.survival.tasks
  let attempts = 0
  const ex = new Executor(bot, {
    runners: {
      mine: async (step, ctx) => {
        attempts++
        if (attempts === 1) {
          // a reflex comes in while the step runs
          tasks.enqueue({ name: 'reflex:eat', priority: 50 }, async () => {})
          // (the preemption aborts the signal at once)
          await new Promise((_resolve, reject) => {
            if (ctx.signal.aborted) reject(ctx.signal.reason)
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))
          })
        }
        bot.give(step.item, step.count)
        return { gained: step.count }
      }
    }
  })
  await ex.obtain([{ item: 'oak_log', count: 2 }])
  assert.equal(attempts, 2)
  assert.equal(count(bot, 'oak_log'), 2)
})

test('requestsMet, neededItems and ownedInventory', () => {
  const bot = fakeBot({ oak_log: 3, stone_pickaxe: 1 })
  const inv = ownedInventory(bot)
  assert.equal(inv.count('oak_log'), 3)
  assert.equal(requestsMet(inv, [{ item: '#logs', count: 3 }, { item: ['wooden_pickaxe', 'stone_pickaxe'], count: 1 }]), true)
  assert.equal(requestsMet(inv, [{ item: 'furnace', count: 1 }]), false)
  assert.equal(requestsMet(inv, [{ item: 'furnace', count: 1, optional: true }]), true)
  assert.deepEqual(neededItems([{ item: ['iron_pickaxe'], count: 1 }, { item: '#planks', count: 4 }]), { iron_pickaxe: 1 })
})

test('the executor makes a new tool at the uses left a mine step hands back at (else the step would hand back for good)', async () => {
  const { MIN_TOOL_USES } = await import('../../src/executor/steps')
  const ex = new Executor(fakeBot())
  assert.equal(ex.options.minToolUses, MIN_TOOL_USES)
})

test('a mine step that fails forgets the remembered blocks of its kinds near the bot (the next plan prices them as yet to find)', async () => {
  const bot = fakeBot()
  const memory: WorldMemory = bot.survival.memory
  memory.rememberBlock('oak_log', { x: 10, y: 64, z: 0 })
  memory.rememberBlock('oak_log', { x: 2000, y: 64, z: 0 })
  memory.rememberBlock('stone', { x: 5, y: 60, z: 0 })
  let tries = 0
  const ex = new Executor(bot, { runners: { mine: async () => { tries++; throw new TaskError('NO_PATH', 'no safe way down') } }, maxStepFailures: 1, log: () => {} })
  await assert.rejects(ex.obtain([{ item: 'oak_log', count: 1 }]), /no safe way down/)
  assert.equal(tries, 1)
  assert.equal(memory.findBlocks('oak_log', { near: { x: 0, y: 64, z: 0 } as any, maxDistance: 128 }).length, 0)
  // far off, and of other kinds: kept
  assert.equal(memory.findBlocks('oak_log').length, 1)
  assert.equal(memory.findBlocks('stone').length, 1)
})
