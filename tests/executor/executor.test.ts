import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'
import { WorldMemory } from '../../src/core/memory'
import { Executor, describeStep, neededItems, ownedInventory, requestsMet } from '../../src/executor/executor'
import type { StepRunner } from '../../src/executor/steps'
import { heldFor } from '../../src/planner/obtain'
import { FOOD_GOAL, FOOD_POINTS } from '../../src/planner/progression'

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

test('a mine step that fails forgets the remembered blocks of its kinds (the next plan prices them as yet to find)', async () => {
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
  // far off too (a vein remembered 200 blocks off priced cheaper than one yet to find); of other kinds: kept
  assert.equal(memory.findBlocks('oak_log').length, 0)
  assert.equal(memory.findBlocks('stone').length, 1)
})

test('a hunt that explored and found no animal makes the next plan go for another food (a snowy taiga)', async () => {
  const bot = fakeBot({ crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, oak_planks: 16 })
  const log: string[] = []
  const runners: Record<string, StepRunner<any>> = {
    ...honestRunners(bot, log),
    kill: async (step) => { log.push(describeStep(step)); throw new TaskError('NOT_FOUND', `no ${step.mob} found exploring`) },
    smelt: async (step) => {
      log.push(describeStep(step))
      for (const i of [...step.inputs, ...step.fuel]) bot.take(i.name, i.count)
      bot.give(step.item, step.count)
      return { gained: step.count }
    }
  }
  const ex = new Executor(bot, { runners, log: () => {} })
  await ex.obtain([{ item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' }])
  assert.ok(log[0].startsWith('kill'), log.join('; '))
  assert.equal(log.filter(l => l.startsWith('kill')).length, 1, log.join('; '))
  assert.ok(ex.sightings.isScarce('cow') && ex.sightings.isScarce('rabbit'))
  assert.ok(heldFor(ownedInventory(bot), FOOD_GOAL, { unit: 'nutrition' }) >= FOOD_POINTS)
})

test('a plan that fails its check the same way twice is made again counting on no drop beyond its steps\' counts, and a third time fails', async () => {
  // the food plans of 26.3 seed 2, which counted a cow's second beef their kill step didn't: 30 plans each failed
  // "smelt 4 cooked_beef needs 4 beef, has 3" before a step ran
  const make = (): { bot: any, ex: Executor, lines: string[], log: string[], planned: boolean[] } => {
    const bot = fakeBot({ furnace: 1, coal: 8, stone_sword: 1 })
    const log: string[] = []
    const lines: string[] = []
    const planned: boolean[] = []
    const runners: Record<string, StepRunner<any>> = {
      ...honestRunners(bot, log),
      kill: async (step) => { log.push(describeStep(step)); bot.give(step.item, step.count); return { gained: step.count } },
      smelt: async (step) => {
        log.push(describeStep(step))
        for (const i of [...step.inputs, ...step.fuel]) bot.take(i.name, i.count)
        bot.give(step.item, step.count)
        return { gained: step.count }
      }
    }
    const ex = new Executor(bot, { runners, log: line => lines.push(line) })
    const plan = ex.plan.bind(ex)
    // the planner of before: the kill steps leave out the beef expected beyond their counts
    ex.plan = (requests, inventory, extra = {}) => {
      planned.push(extra.exactYields === true)
      const out = plan(requests, inventory, extra)
      return { ...out, steps: out.steps.map(s => s.kind === 'kill' ? { ...s, extra: s.extra?.filter(e => e.name !== s.item) } : s) }
    }
    return { bot, ex, lines, log, planned }
  }
  const requests = [{ item: 'cooked_beef', count: 1 }, { item: 'cooked_beef', count: 5 }]

  const { bot, ex, lines, log, planned } = make()
  await ex.obtain(requests)
  assert.equal(count(bot, 'cooked_beef'), 5)
  assert.deepEqual(planned.slice(0, 3), [false, false, true], lines.join('\n'))
  assert.equal(lines.filter(l => l === 'replan: smelt 5 cooked_beef needs 5 beef, has 4').length, 2, lines.join('\n'))
  assert.ok(lines.some(l => l.includes('the same check failed twice')), lines.join('\n'))
  assert.ok(log[0].startsWith('kill'), log.join('; '))

  // a plan that fails the same way even so stops at the third plan, not the 30th
  const stuck = make()
  stuck.ex.plan = (requests, inventory, extra = {}) => {
    stuck.planned.push(extra.exactYields === true)
    return { ok: true, steps: [{ kind: 'smelt', item: 'cooked_beef', count: 4, input: 'beef', inputs: [{ name: 'beef', count: 4 }], fuel: [{ name: 'coal', count: 1 }], station: 'furnace', cost: 800 }], cost: 800, inventory: ownedInventory(stuck.bot), unresolved: [] }
  }
  await assert.rejects(stuck.ex.obtain(requests), /the plans fail their check the same way: smelt 4 cooked_beef needs 4 beef, has 0/)
  assert.deepEqual(stuck.planned, [false, false, true])
})

test('a forced room throws the junk away, the least worth first, never a valuable: with nothing else to throw and no chest near, INVENTORY_FULL', async () => {
  // (26.3 enchant run u: a forced room threw an enchanting table and a diamond away)
  const valuables = [
    'enchanting_table', 'anvil', 'diamond', 'crafting_table', 'furnace', 'white_bed', 'iron_ingot', 'gold_ingot', 'raw_iron',
    'raw_gold', 'lapis_lazuli', 'redstone', 'emerald', 'obsidian', 'ender_eye', 'ender_pearl', 'blaze_rod', 'book', 'bookshelf',
    'iron_block', 'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'iron_shovel', 'diamond_helmet', 'iron_boots', 'bow',
    'crossbow', 'shield', 'flint_and_steel', 'shears', 'coal', 'golden_apple', 'totem_of_undying', 'iron_ore'
  ]
  const fill = (extra: Record<string, number>): any => {
    const bot = fakeBot({ ...Object.fromEntries(valuables.map(n => [n, 1])), ...extra })
    bot.tossed = []
    bot.toss = async (type: number, _meta: unknown, n: number) => {
      const name = registry.items[type].name
      bot.tossed.push(name)
      bot.take(name, n)
    }
    bot.blockAt = () => null
    bot._client = new EventEmitter()
    bot.entity.yaw = 0
    bot.entities = {}
    bot.look = async () => {}
    return bot
  }
  // the bag full of what's never thrown: nothing goes, and the room fails
  const full = fill({ cobblestone: 64 })
  const ex = new Executor(full, { runners: {} })
  await assert.rejects(ex.makeRoom({}, undefined, true), (err: any) => TaskError.is(err, 'INVENTORY_FULL'))
  assert.deepEqual(full.tossed, [])
  // with junk in it: the junk goes, the dirt first, then the rotten flesh; the valuables stay
  const junk = fill({ rotten_flesh: 5 })
  junk.take('iron_ore', 1)
  junk.give('dirt', 30)
  const ex2 = new Executor(junk, { runners: {} })
  const ticking = setInterval(() => junk.emit('physicsTick'), 2)
  try {
    await ex2.makeRoom({}, undefined, true)
  } finally {
    clearInterval(ticking)
  }
  assert.deepEqual(junk.tossed, ['dirt', 'rotten_flesh'])
  for (const name of valuables.filter(n => n !== 'iron_ore')) assert.equal(count(junk, name), 1, name)
})
