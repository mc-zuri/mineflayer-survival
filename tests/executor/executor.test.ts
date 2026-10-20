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
    // (the hunt's exploring went by a patch of berry bushes, ripe, and noted it, and ended in sight of it: the taiga's)
    kill: async (step) => {
      log.push(describeStep(step))
      const bush = new Vec3(30, 64, 0)
      bot.survival.memory.rememberBlock('sweet_berry_bush', bush)
      bot.findBlocks = ({ matching }: { matching: number | number[] }) => [matching].flat().includes(registry.blocksByName.sweet_berry_bush.id) ? [bush] : []
      bot.blockAt = (p: Vec3) => p.equals(bush) ? { name: 'sweet_berry_bush', position: p, getProperties: () => ({ age: 3 }) } : null
      throw new TaskError('NOT_FOUND', `no ${step.mob} found exploring`)
    },
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
  // the plants the hunt went by none of are missed too: the berries it saw are not
  assert.ok(ex.sightings.isScarce('melon') && !ex.sightings.isScarce('sweet_berry_bush'))
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
  // (the dirt, all the bag has to build with, stays: SCAFFOLD_KEEP)
  assert.deepEqual(junk.tossed, ['rotten_flesh'])
  for (const name of valuables.filter(n => n !== 'iron_ore')) assert.equal(count(junk, name), 1, name)
})

test('makeRoom throws the route\'s cobblestone over a stack away once the stock has its high mark, not before; the drops of it are unwanted then', async () => {
  // (26.3 seed 2: 433 cobblestone in the bag down the diamonds' mine, the chests out of reach)
  const fill = (): any => {
    const bot = fakeBot()
    // 4 stacks of cobblestone and 32 other things: the bag full
    const stacks: Array<{ name: string, count: number }> = [1, 2, 3, 4].map(() => ({ name: 'cobblestone', count: 64 }))
    for (const name of ['raw_iron', 'iron_pickaxe', 'diamond_pickaxe', 'bread', 'torch', 'coal', 'oak_log', 'diamond_sword', 'shield', 'bucket',
      'water_bucket', 'iron_ingot', 'gold_ingot', 'lapis_lazuli', 'redstone', 'emerald', 'obsidian', 'ender_pearl', 'book', 'arrow',
      'bow', 'crafting_table', 'furnace', 'white_bed', 'iron_axe', 'iron_shovel', 'flint_and_steel', 'compass', 'clock', 'shears', 'leather', 'diamond']) stacks.push({ name, count: 1 })
    const slots = (): any[] => {
      const out: any[] = new Array(46).fill(null)
      stacks.forEach((st, i) => { if (st.count > 0) out[9 + i] = { name: st.name, count: st.count, type: registry.itemsByName[st.name].id, slot: 9 + i } })
      return out
    }
    bot.inventory = { get slots () { return slots() }, inventoryStart: 9, inventoryEnd: 45, items: () => slots().slice(9, 45).filter(x => x != null) }
    bot.tossed = []
    // a toss takes the stacks of the item one by one
    bot.toss = async (type: number, _meta: unknown, n: number) => {
      const name = registry.items[type].name
      bot.tossed.push(`${n} ${name}`)
      for (const st of stacks) { if (st.name !== name || n <= 0) continue; const k = Math.min(n, st.count); st.count -= k; n -= k }
    }
    bot.blockAt = () => null
    bot._client = new EventEmitter()
    bot.entity.yaw = 0
    bot.entities = {}
    bot.look = async () => {}
    return bot
  }
  const stocked = fill()
  const short = fill()
  const ex = new Executor(stocked, { runners: {}, stocked: name => name === 'cobblestone' })
  const ticking = setInterval(() => { stocked.emit('physicsTick'); short.emit('physicsTick') }, 2)
  try {
    assert.equal(ex.unwantedDrop('cobblestone'), true)
    assert.equal(ex.unwantedDrop('raw_iron'), false)
    await ex.makeRoom({}, undefined, false)
    // 4 slots wanted (2 free and 2 more): the 3 stacks over the one kept
    assert.deepEqual(stocked.tossed, ['64 cobblestone', '64 cobblestone', '64 cobblestone'])
    assert.equal(count(stocked, 'cobblestone'), 64)
    // short of the high mark: kept for the base (none here: none of it goes), and picked up
    const ex2 = new Executor(short, { runners: {}, stocked: () => false })
    assert.equal(ex2.unwantedDrop('cobblestone'), false)
    await ex2.makeRoom({}, undefined, false)
    assert.deepEqual(short.tossed, [])
    assert.equal(count(short, 'cobblestone'), 256)
  } finally {
    clearInterval(ticking)
  }
})

test('makeRoom in the nether keeps NETHER_SCAFFOLD_KEEP building blocks, the netherrack among them; the overworld its stack; the netherrack dug there picked up till the bag holds them', async () => {
  // (full-26.3-fresh-t, t211310: 'throwing away 37 netherrack, 8 cobblestone, 3 rotten_flesh' in the nether, the bag
  // left with 64 cobblestone, the 60-block bridge over the lava sea after it ended with 4 and the bot sat there)
  const { NETHER_SCAFFOLD_KEEP } = await import('../../src/executor/keep')
  const fill = (dimension: string, extra: Array<{ name: string, count: number }> = []): any => {
    const bot = fakeBot()
    bot.game.dimension = dimension
    const stacks: Array<{ name: string, count: number }> = [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 8 }, { name: 'netherrack', count: 37 }, { name: 'rotten_flesh', count: 3 }, ...extra]
    for (const name of ['raw_iron', 'iron_pickaxe', 'diamond_pickaxe', 'bread', 'torch', 'coal', 'oak_log', 'diamond_sword', 'shield', 'bucket',
      'water_bucket', 'iron_ingot', 'gold_ingot', 'lapis_lazuli', 'redstone', 'emerald', 'obsidian', 'ender_pearl', 'book', 'arrow',
      'bow', 'crafting_table', 'furnace', 'white_bed', 'iron_axe', 'iron_shovel', 'flint_and_steel', 'compass', 'clock', 'shears', 'leather', 'diamond'].slice(0, 32 - extra.length)) stacks.push({ name, count: 1 })
    const slots = (): any[] => {
      const out: any[] = new Array(46).fill(null)
      stacks.forEach((st, i) => { if (st.count > 0) out[9 + i] = { name: st.name, count: st.count, type: registry.itemsByName[st.name].id, slot: 9 + i } })
      return out
    }
    bot.inventory = { get slots () { return slots() }, inventoryStart: 9, inventoryEnd: 45, items: () => slots().slice(9, 45).filter(x => x != null) }
    bot.tossed = []
    bot.toss = async (type: number, _meta: unknown, n: number) => {
      const name = registry.items[type].name
      bot.tossed.push(`${n} ${name}`)
      for (const st of stacks) { if (st.name !== name || n <= 0) continue; const k = Math.min(n, st.count); st.count -= k; n -= k }
    }
    bot.blockAt = () => null
    bot._client = new EventEmitter()
    bot.entity.yaw = 0
    bot.entities = {}
    bot.look = async () => {}
    bot.pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
    return bot
  }
  assert.equal(NETHER_SCAFFOLD_KEEP, 128)
  const overworld = fill('overworld')
  const nether = fill('the_nether')
  const ticking = setInterval(() => { overworld.emit('physicsTick'); nether.emit('physicsTick') }, 2)
  try {
    // the overworld: as the run threw them, down to a stack of building blocks
    const exO = new Executor(overworld, { runners: {} })
    assert.equal(exO.scaffoldKeep().keep, 64)
    await exO.makeRoom({}, undefined, false)
    assert.deepEqual(overworld.tossed, ['37 netherrack', '8 cobblestone', '3 rotten_flesh'])
    // the nether: the 109 blocks are under its working set, none goes
    const exN = new Executor(nether, { runners: {} })
    assert.equal(exN.scaffoldKeep().keep, NETHER_SCAFFOLD_KEEP)
    await exN.makeRoom({}, undefined, false)
    assert.deepEqual(nether.tossed, ['3 rotten_flesh'])
    assert.equal(count(nether, 'netherrack') + count(nether, 'cobblestone'), 109)
    // the netherrack and cobblestone dug on the way are picked up while under it (the stock full of cobblestone)
    const stocked = new Executor(nether, { runners: {}, stocked: () => true })
    assert.equal(stocked.unwantedDrop('netherrack'), false)
    assert.equal(stocked.unwantedDrop('cobblestone'), false)
    // and not past it
    const full = fill('the_nether', [{ name: 'netherrack', count: 64 }])
    const stockedFull = new Executor(full, { runners: {}, stocked: () => true })
    assert.equal(stockedFull.unwantedDrop('netherrack'), true)
  } finally {
    clearInterval(ticking)
  }
})

test('makeRoom: a part stack thrown THROW_LOOP_REPEATS times within THROW_LOOP_TICKS, picked up again each time, goes into a chest near instead, the room got from the next junk meanwhile; with none, the bot walks THROW_AWAY_RANGE blocks off and throws it there; INVENTORY_FULL only for what that leaves held', async () => {
  // (26.3 run full-f: '19 dirt, 5 sand, 2 gravel' thrown into a pit the staircase's next step reached, every step for
  // 30 steps; run full-26.3-fresh-f: '23 diorite, 7 andesite, 3 dirt' refused a third throw with no chest near, and the
  // nether's gate failed 'inventory full (1 free slots)' with 5 stacks of cobblestone to spare)
  const { THROW_LOOP_REPEATS, THROW_LOOP_TICKS } = await import('../../src/executor/keep')
  const { THROW_AWAY_RANGE } = await import('../../src/executor/executor')
  const valuables = ['diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'coal', 'obsidian', 'ender_pearl', 'blaze_rod', 'book',
    'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'crafting_table', 'furnace', 'chest', 'anvil',
    'bow', 'shield', 'shears', 'compass', 'clock', 'flint_and_steel', 'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'iron_shovel',
    'golden_apple', 'ender_eye', 'iron_ore', 'gold_ore']
  const chestAt = new Vec3(3, 64, 0)
  const make = (opts: { chest?: boolean, bag?: Record<string, number>, surplus?: (name: string) => boolean } = {}): { bot: any, ex: Executor, stashed: Array<Set<string>>, reports: string[], walks: Vec3[] } => {
    // 34 valuables and 2 junk stacks: the bag full
    const bot = fakeBot(opts.bag ?? { ...Object.fromEntries(valuables.map(n => [n, 1])), rotten_flesh: 7, string: 5 })
    bot.tossed = []
    // what's thrown comes back (a pit in the next step's reach)
    bot.toss = async (type: number, _meta: unknown, n: number) => { bot.tossed.push(`${n} ${registry.items[type].name}`) }
    bot.blockAt = (p: Vec3) => opts.chest === true && p.equals(chestAt) ? { name: 'chest', boundingBox: 'block', position: p } : null
    bot._client = new EventEmitter()
    bot.entity.yaw = 0
    bot.entities = {}
    bot.look = async () => {}
    const reports: string[] = []
    bot.survival.diagnostics = { skillFailed: (name: string, err: Error) => { reports.push(`${name}: ${err.message}`); return null } }
    const ex = new Executor(bot, { runners: {}, surplus: opts.surplus })
    if (opts.chest === true) ex.memory.rememberChest(chestAt, {})
    const stashed: Array<Set<string>> = []
    ;(ex as any).stashNearby = async (_needed: unknown, _signal: unknown, _run: unknown, also: Set<string>) => { stashed.push(new Set(also)); return {} }
    const walks: Vec3[] = []
    ;(ex as any).walkOff = async (_s: AbortSignal, from: Vec3) => { walks.push(from.clone()); return true }
    return { bot, ex, stashed, reports, walks }
  }
  const ticking = (bot: any): ReturnType<typeof setInterval> => setInterval(() => bot.emit('physicsTick'), 1)
  // a chest near takes them: stored, not thrown a third time
  const a = make({ chest: true })
  let t = ticking(a.bot)
  try {
    for (let i = 1; i < THROW_LOOP_REPEATS; i++) await a.ex.makeRoom()
    assert.deepEqual(a.bot.tossed, ['7 rotten_flesh', '5 string', '7 rotten_flesh', '5 string'])
    assert.deepEqual(a.stashed.map(s => [...s]), [[], []])
    ;(a.ex as any).stashNearby = async (_n: unknown, _s: unknown, _r: unknown, also: Set<string>) => {
      a.stashed.push(new Set(also))
      for (const name of also) a.bot.take(name, count(a.bot, name))
      return {}
    }
    await a.ex.makeRoom()
    assert.equal(a.bot.tossed.length, 4, a.bot.tossed.join(', '))
    assert.deepEqual([...a.stashed[2]].sort(), ['rotten_flesh', 'string'])
    assert.equal(count(a.bot, 'rotten_flesh'), 0)
    assert.deepEqual(a.walks, [])
    assert.deepEqual(a.reports, [])
  } finally {
    clearInterval(t)
  }
  // the chest near takes the looping stacks; the room meanwhile from the surplus cobblestone, not nothing
  const spare = ['cobblestone', 'stone', 'deepslate', 'blackstone']
  const bag: Record<string, number> = { ...Object.fromEntries(valuables.slice(0, 30).map(n => [n, 1])), rotten_flesh: 7, string: 5, ...Object.fromEntries(spare.map(n => [n, 64])) }
  const c = make({ chest: true, bag, surplus: name => spare.includes(name) })
  t = ticking(c.bot)
  try {
    // (the stone whole stacks thrown each time: no sign of a loop)
    for (let i = 1; i < THROW_LOOP_REPEATS; i++) await c.ex.makeRoom()
    c.bot.tossed.length = 0
    ;(c.ex as any).stashNearby = async (_n: unknown, _s: unknown, _r: unknown, also: Set<string>) => {
      c.stashed.push(new Set(also))
      for (const name of also) c.bot.take(name, count(c.bot, name))
      return {}
    }
    await c.ex.makeRoom()
    assert.ok(!c.bot.tossed.includes('7 rotten_flesh') && c.bot.tossed.some((s: string) => /^64 /.test(s) && spare.includes(s.slice(3))), c.bot.tossed.join(', '))
    assert.ok(c.stashed.some(st => st.has('rotten_flesh')))
    assert.equal(count(c.bot, 'rotten_flesh'), 0)
  } finally {
    clearInterval(t)
  }
  // none near: the bot walks off THROW_AWAY_RANGE and throws them there, no INVENTORY_FULL, no report, and the room
  // made on the way goes on
  const b = make()
  t = ticking(b.bot)
  try {
    for (let i = 1; i < THROW_LOOP_REPEATS; i++) await b.ex.makeRoom()
    assert.equal(b.walks.length, 0)
    await b.ex.makeRoom()
    assert.equal(b.walks.length, 1)
    assert.deepEqual(b.bot.tossed.slice(4), ['7 rotten_flesh', '5 string'])
    assert.deepEqual(b.reports, [])
    await b.ex.task('a staircase', async (s) => await b.ex.makeRoomDuringStep(s))
    assert.equal(b.bot.tossed.length, 8)
    assert.ok(THROW_LOOP_TICKS > 1000 && THROW_AWAY_RANGE >= 8)
  } finally {
    clearInterval(t)
  }
  // no way off: thrown where it stands all the same
  const d = make()
  ;(d.ex as any).walkOff = async () => false
  t = ticking(d.bot)
  try {
    for (let i = 0; i < THROW_LOOP_REPEATS; i++) await d.ex.makeRoom()
    assert.equal(d.bot.tossed.length, 6)
    assert.deepEqual(d.reports, [])
  } finally {
    clearInterval(t)
  }
  // a chest near that takes none of them (full): thrown off after all; still held after that (the throws never leave
  // the bag here), INVENTORY_FULL with a report, and no room made on the way a while
  const e = make({ chest: true })
  t = ticking(e.bot)
  try {
    for (let i = 1; i < THROW_LOOP_REPEATS; i++) await e.ex.makeRoom()
    await assert.rejects(e.ex.makeRoom(), (err: any) => TaskError.is(err, 'INVENTORY_FULL') && /making room loops: 7 rotten_flesh, 5 string thrown 3 times/.test(err.message))
    assert.equal(e.walks.length, 1)
    assert.equal(e.reports.length, 1, e.reports.join(' | '))
    assert.match(e.reports[0], /^make room: making room loops/)
    const tosses = e.bot.tossed.length
    const stashes = e.stashed.length
    await e.ex.task('a staircase', async (s) => await e.ex.makeRoomDuringStep(s))
    assert.equal(e.bot.tossed.length, tosses)
    assert.equal(e.stashed.length, stashes)
  } finally {
    clearInterval(t)
  }
})

test('a step is tried with a slot free when no room is made before it (INVENTORY_FULL), not given up: the craft uses up what it\'s made from; with none free, the obtain fails', async () => {
  // (26.3 run full-26.3-fresh-f: the nether gate's 'craft 1 shield' with its planks and iron ingot held failed with the
  // room before it, 48 times in a tick, and the game stopped)
  const fill = (n: number): Record<string, number> => {
    const bag: Record<string, number> = { oak_planks: 4 }
    for (const name of Object.keys(registry.itemsByName).filter(n => !/planks|table|log|air/.test(n)).slice(0, n - 1)) bag[name] = 1
    return bag
  }
  const run = async (slots: number): Promise<{ bot: any, log: string[], out: Promise<unknown> }> => {
    const bot = fakeBot(fill(slots))
    const log: string[] = []
    const ex = new Executor(bot, { runners: honestRunners(bot, log), log: line => log.push(line) })
    ;(ex as any).makeRoom = async () => { throw new TaskError('INVENTORY_FULL', 'making room loops: 7 rotten_flesh thrown 3 times') }
    return { bot, log, out: ex.obtain([{ item: 'crafting_table', count: 1 }]) }
  }
  const one = await run(35)
  assert.equal(36 - one.bot.inventory.items().length, 1)
  await one.out
  assert.equal(count(one.bot, 'crafting_table'), 1)
  assert.ok(one.log.some(l => /^no room before craft 1 crafting_table, tried with 1 slots free/.test(l)), one.log.join(' | '))
  const none = await run(36)
  await assert.rejects(none.out, (err: any) => TaskError.is(err, 'INVENTORY_FULL'))
  assert.equal(count(none.bot, 'crafting_table'), 0)
})

test('makeRoom: what isn\'t kept goes to the base within BASE_STORE_RANGE, farther into a depot chest put down by the bot', async () => {
  const { BASE_STORE_RANGE } = await import('../../src/executor/executor')
  const bag: Record<string, number> = {}
  // 35 slots of what is stored, not thrown (no junk): one free
  for (const name of ['raw_iron', 'raw_gold', 'leather', 'white_wool', 'gray_wool', 'brown_wool', 'oak_door', 'chest', 'iron_sword', 'beef', 'mutton',
    'chicken', 'porkchop', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'raw_copper', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz',
    'book', 'paper', 'sugar_cane', 'feather', 'gunpowder', 'slime_ball', 'bone_meal', 'ink_sac', 'oak_planks', 'birch_log', 'spruce_log',
    'clay_ball', 'brick']) bag[name] = 1
  const calls: string[] = []
  const at = (distance: number): any => {
    const bot = fakeBot(bag)
    bot.entities = {}
    bot.blockAt = () => null
    const ex = new Executor(bot, { runners: {} })
    ex.memory.setBase({ x: distance, y: 64, z: 0 })
    ex.memory.rememberChest({ x: distance + 1, y: 64, z: 0 }, {})
    ;(ex as any).storeAtBase = async () => { calls.push(`base ${distance}`); return {} }
    ;(ex as any).stashNearby = async () => { calls.push(`depot ${distance}`); return {} }
    return ex
  }
  await at(60).makeRoom()
  await at(BASE_STORE_RANGE + 50).makeRoom()
  assert.deepEqual(calls, ['base 60', 'depot 60', `depot ${BASE_STORE_RANGE + 50}`])
})

test('stashNearby puts a depot chest down when no chest is near, stores what isn\'t kept in it (not the junk) and remembers it (DEPOT_POI)', async () => {
  const { DEPOT_POI } = await import('../../src/executor/executor')
  const bot = fakeBot({ raw_iron: 30, leather: 3, andesite: 20, cobblestone: 64, iron_pickaxe: 1 })
  bot.entities = {}
  bot.entity.yaw = 0
  bot.entity.eyeHeight = 1.62
  const depot = new Vec3(1, 64, 0)
  let placed = false
  bot.blockAt = (pos: Vec3) => placed && pos.equals(depot) ? { name: 'chest', type: registry.blocksByName.chest.id, position: depot, boundingBox: 'block' } : { name: 'air', position: pos, boundingBox: 'empty' }
  bot._client = new EventEmitter()
  const inChest: Record<string, number> = {}
  bot.openContainer = async () => ({
    slots: new Array(63).fill(null),
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => bot.inventory.items(),
    containerItems: () => Object.entries(inChest).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })),
    deposit: async (type: number, _meta: unknown, n: number) => { const name = registry.items[type].name; bot.take(name, n); inChest[name] = (inChest[name] ?? 0) + n },
    close: () => {}
  })
  const ex = new Executor(bot, { runners: {} })
  ;(ex as any).putDownDepot = async () => { placed = true; return depot }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    const moved = await ex.stashNearby({}, undefined, async (_name: string, fn: any) => await fn(new AbortController().signal))
    assert.deepEqual(moved, { raw_iron: 30, leather: 3 })
  } finally {
    clearInterval(ticking)
  }
  assert.deepEqual(inChest, { raw_iron: 30, leather: 3 })
  assert.deepEqual(ex.memory.getPois(DEPOT_POI).map(p => [p.x, p.y, p.z]), [[1, 64, 0]])
  assert.deepEqual(ex.memory.chestAt(depot)?.items, { raw_iron: 30, leather: 3 })
  assert.equal(count(bot, 'andesite'), 20)
})

test('stashNearby with obtainChest gets a chest for the depot first when the bag\'s wood is short of one and the plan is within DEPOT_CHEST_TICKS (a log cut near); not in a task, nor over the budget, nor with the wood for one in the bag (putDownDepot crafts it)', async () => {
  // (26.3 run full-26.3-fresh-f: 7 planks held, 'can't craft 1 chest: short of 1 chest', and no depot)
  const { DEPOT_CHEST_TICKS } = await import('../../src/executor/executor')
  const make = (bag: Record<string, number> = { oak_planks: 4, crafting_table: 1 }): { bot: any, ex: Executor, chests: number[], log: string[] } => {
    const bot = fakeBot({ ...bag, raw_iron: 30, iron_pickaxe: 1 })
    bot.entities = {}
    bot.blockAt = () => null
    const log: string[] = []
    const ex = new Executor(bot, { runners: honestRunners(bot, log), log: line => log.push(line) })
    // a tree by the bot
    for (let y = 64; y < 68; y++) ex.memory.rememberBlock('oak_log', { x: 4, y, z: 0 })
    const chests: number[] = []
    ;(ex as any).putDownDepot = async () => { chests.push(count(bot, 'chest')); return null }
    return { bot, ex, chests, log }
  }
  const straight = async (_name: string, fn: any): Promise<any> => await fn(new AbortController().signal)
  const a = make()
  await a.ex.stashNearby({}, undefined, straight, new Set(), true)
  assert.deepEqual(a.chests, [1])
  assert.ok(a.log.some(l => /^mine \d+ oak_log/.test(l)) && a.log.includes('craft 1 chest'), a.log.join(' | '))
  // in a task (a step's room): no obtain, the depot's own craft from the bag
  const b = make()
  await b.ex.stashNearby({}, undefined, straight, new Set(), false)
  assert.deepEqual(b.chests, [0])
  // a dear plan: none
  const c = make()
  const plan = c.ex.plan.bind(c.ex)
  ;(c.ex as any).plan = (...args: any[]) => ({ ...plan(...args), cost: DEPOT_CHEST_TICKS + 1 })
  await c.ex.stashNearby({}, undefined, straight, new Set(), true)
  assert.deepEqual(c.chests, [0])
  assert.ok(c.log.some(l => /no chest for a depot: a plan of \d+ ticks, over 1200/.test(l)), c.log.join(' | '))
  // the wood for one in the bag: left to the depot's own craft
  const d = make({ oak_log: 2, crafting_table: 1 })
  await d.ex.stashNearby({}, undefined, straight, new Set(), true)
  assert.deepEqual(d.chests, [0], d.log.join(" | "))
  assert.deepEqual(d.log, [])
})

test('stashNearby keeps what the milestones being worked on need (milestoneNeeds: the nether\'s obsidian, buckets and gold), stashes the rest', async () => {
  const bot = fakeBot({ raw_iron: 2, furnace: 1, obsidian: 6, raw_gold: 2, bucket: 2, lava_bucket: 1, oak_door: 1, iron_pickaxe: 1 })
  bot.entities = {}
  bot.entity.yaw = 0
  bot.entity.eyeHeight = 1.62
  const depot = new Vec3(1, 64, 0)
  let placed = false
  bot.blockAt = (pos: Vec3) => placed && pos.equals(depot) ? { name: 'chest', type: registry.blocksByName.chest.id, position: depot, boundingBox: 'block' } : { name: 'air', position: pos, boundingBox: 'empty' }
  bot._client = new EventEmitter()
  const inChest: Record<string, number> = {}
  bot.openContainer = async () => ({
    slots: new Array(63).fill(null),
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => bot.inventory.items(),
    containerItems: () => Object.entries(inChest).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })),
    deposit: async (type: number, _meta: unknown, n: number) => { const name = registry.items[type].name; bot.take(name, n); inChest[name] = (inChest[name] ?? 0) + n },
    close: () => {}
  })
  // a stock keep rule of nothing: what stays is what's protected
  const ex = new Executor(bot, { runners: {}, keep: () => 0, milestoneNeeds: () => ({ obsidian: 10, bucket: Infinity, lava_bucket: Infinity, raw_gold: Infinity }) })
  ;(ex as any).putDownDepot = async () => { placed = true; return depot }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await ex.stashNearby({}, undefined, async (_name: string, fn: any) => await fn(new AbortController().signal))
  } finally {
    clearInterval(ticking)
  }
  assert.deepEqual(inChest, { raw_iron: 2, furnace: 1, oak_door: 1 })
  for (const [name, n] of [['obsidian', 6], ['raw_gold', 2], ['bucket', 2], ['lava_bucket', 1], ['iron_pickaxe', 1]] as const) assert.equal(count(bot, name), n, name)
})

test('the loot step walks to a chest out of the loaded chunks before it opens it', async () => {
  const travelModule = require('../../src/skills/travel')
  const chestModule = require('../../src/skills/chest')
  const { runLoot } = await import('../../src/executor/steps')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { WorldMemory } = await import('../../src/core/memory')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(97.5, -54, 64.5) })
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (Math.abs(p.x - 97) > 64 ? null : realAt(p))) as any
  const calls: string[] = []
  const realTravel = travelModule.travel
  const realRetrieve = chestModule.retrieveItems
  travelModule.travel = async (_b: unknown, a: any) => { calls.push(`travel ${a.target.toString()}`) }
  chestModule.retrieveItems = async () => { calls.push('retrieve'); return { moved: {} } }
  try {
    await runLoot({ kind: 'loot', item: 'diamond_pickaxe', count: 1, from: { x: -56, y: 60, z: -16, dimension: 'overworld' } } as any, { bot, signal: new AbortController().signal, log: () => {}, state: {}, memory: new WorldMemory() } as any)
  } finally {
    travelModule.travel = realTravel
    chestModule.retrieveItems = realRetrieve
  }
  assert.deepEqual(calls, [`travel ${new Vec3(-56, 60, -16).toString()}`, 'retrieve'])
})

test('the loot step walks to a dug-in base by its entrance, not down onto its roof over the chest', async () => {
  const travelModule = require('../../src/skills/travel')
  const chestModule = require('../../src/skills/chest')
  const { runLoot } = await import('../../src/executor/steps')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { WorldMemory } = await import('../../src/core/memory')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(66.5, -40, -185.5) })
  const memory = new WorldMemory()
  memory.setBase({ x: -56, y: 60, z: -16 })
  memory.addPoi('base_entrance', { x: -51, y: 60, z: -20 }, 'overworld')
  memory.addPoi('base_bounds', { x: -57, y: 59, z: -19 }, 'overworld', '-49,63,-12')
  const calls: string[] = []
  const realTravel = travelModule.travel
  const realRetrieve = chestModule.retrieveItems
  const exploreModule = require('../../src/executor/explore')
  const realEnsure = exploreModule.ensurePickaxe
  travelModule.travel = async (_b: unknown, a: any) => { calls.push(`travel ${a.target.toString()} ${a.range}`) }
  chestModule.retrieveItems = async () => { calls.push('retrieve'); return { moved: {} } }
  // no pickaxe in the bag (it's the one in the chest): one made first, for the stone on the way in
  exploreModule.ensurePickaxe = async () => { calls.push('ensurePickaxe'); return 'stone_pickaxe' }
  try {
    await runLoot({ kind: 'loot', item: 'diamond_pickaxe', count: 1, from: { x: -56, y: 60, z: -16, dimension: 'overworld' } } as any, { bot, signal: new AbortController().signal, log: () => {}, state: {}, memory } as any)
  } finally {
    travelModule.travel = realTravel
    chestModule.retrieveItems = realRetrieve
    exploreModule.ensurePickaxe = realEnsure
  }
  assert.deepEqual(calls, ['ensurePickaxe', `travel ${new Vec3(-51, 60, -20).toString()} 1`, 'retrieve'])
})

test('baseWayIn: the entrance for a target in the base box from outside it, none from inside, for one outside, or elsewhere', async () => {
  const { baseWayIn } = await import('../../src/base/pois')
  const { WorldMemory } = await import('../../src/core/memory')
  const memory = new WorldMemory()
  memory.setBase({ x: -56, y: 60, z: -16 })
  memory.addPoi('base_entrance', { x: -51, y: 60, z: -20 }, 'overworld')
  assert.equal(baseWayIn(memory, { x: -56, y: 60, z: -16 }, { x: -54.5, y: 68, z: -13.5 }, 'overworld'), null, 'no box recorded')
  memory.addPoi('base_bounds', { x: -57, y: 59, z: -19 }, 'overworld', '-49,63,-12')
  assert.deepEqual(baseWayIn(memory, { x: -56, y: 60, z: -16 }, { x: -54.5, y: 68, z: -13.5 }, 'overworld'), { x: -51, y: 60, z: -20 })
  assert.equal(baseWayIn(memory, { x: -56, y: 60, z: -16 }, { x: -53.5, y: 60, z: -15.5 }, 'overworld'), null)
  assert.equal(baseWayIn(memory, { x: -40, y: 60, z: -16 }, { x: -54.5, y: 68, z: -13.5 }, 'overworld'), null)
  assert.equal(baseWayIn(memory, { x: -56, y: 60, z: -16 }, { x: -54.5, y: 68, z: -13.5 }, 'the_nether'), null)
})

/**
 * a bot whose bag holds a worn iron pickaxe (uses left as given) beside what fakeBot's counts give, the best pickaxe
 * held, the one with the most uses of the best tier (as the dig's tool choice: bestHarvestingTool)
 */
function wornPickBot (usesLeft: number, items: Record<string, number>): { bot: any, pick: any } {
  const bot = fakeBot(items)
  const pick = { name: 'iron_pickaxe', count: 1, type: registry.itemsByName.iron_pickaxe.id, slot: 36, maxDurability: 250, durabilityUsed: 250 - usesLeft }
  const items0 = bot.inventory.items
  bot.inventory.items = () => [...items0(), ...(pick.durabilityUsed < pick.maxDurability ? [pick] : [])]
  const tier = (i: any): number => ['wooden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(i.name.split('_')[0])
  const uses = (i: any): number => (i.maxDurability ?? 1e9) - (i.durabilityUsed ?? 0)
  Object.defineProperty(bot, 'heldItem', { get: () => bot.inventory.items().filter((i: any) => i.name.endsWith('_pickaxe')).sort((a: any, b: any) => tier(b) - tier(a) || uses(b) - uses(a))[0] ?? null })
  return { bot, pick }
}

/** a long dig as a milestone task: `blocks` blocks, each a use of the held pickaxe; it goes on from what it dug (its memory) */
function longDig (bot: any, blocks: number, progress: { dug: number, runs: number, tools: string[] }): (s: AbortSignal) => Promise<number> {
  return async (s) => {
    progress.runs++
    while (progress.dug < blocks) {
      if (s.aborted) throw (s.reason as TaskError).withPartial({ dug: progress.dug })
      const held = bot.heldItem
      if (held == null) throw new TaskError('NO_TOOL', 'no pickaxe')
      if (held.maxDurability != null) held.durabilityUsed++
      progress.tools.push(held.name)
      progress.dug++
      bot.emit('physicsTick')
      await new Promise(resolve => setImmediate(resolve))
    }
    return progress.dug
  }
}

test('a long task whose pickaxe is about to break stops (TOOL_WORN), a new one is made from what is carried, and the task goes on from where it was', async () => {
  const { bot, pick } = wornPickBot(30, { iron_ingot: 3, stick: 2, crafting_table: 1 })
  const log: string[] = []
  const lines: string[] = []
  const ex = new Executor(bot, { runners: honestRunners(bot, log), log: line => lines.push(line) })
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  const dug = await ex.task('down to the deep lava', longDig(bot, 40, progress))
  assert.equal(dug, 40)
  assert.equal(progress.runs, 2)
  // stopped with 24 uses left: 6 blocks dug with the old one, the rest with the new
  assert.equal(pick.durabilityUsed, 250 - 24)
  assert.deepEqual(log, ['craft 1 iron_pickaxe'])
  assert.equal(progress.tools.filter((_t, i) => i < 6).length, 6)
  // the worn one, and the new one
  assert.equal(count(bot, 'iron_pickaxe'), 2)
  assert.ok(lines.some(l => /down to the deep lava: stopped, the iron_pickaxe has 24 uses left.*"dug":6/.test(l)), lines.join('\n'))
})

test('a long task whose pickaxe is replaced and worn down again and again goes on: no count of replaced stops fails it', async () => {
  // each replacement a pickaxe 30 uses from breaking: worn to the mark again 6 blocks on (a 26.3 nether trip's fourth
  // stop failed the milestone, each stone pickaxe replaced and worn down again on the way to the fortress)
  const { bot, pick } = wornPickBot(30, {})
  const ex = new Executor(bot, { log: () => {} })
  let replaced = 0
  ex.replaceWornTool = async () => { replaced++; pick.durabilityUsed = 250 - 30; return true }
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  assert.equal(await ex.task('to the fortress', longDig(bot, 40, progress)), 40)
  assert.ok(replaced >= 4, `${replaced} replacements`)
  assert.equal(progress.runs, replaced + 1)
})

test('a task stopped MAX_WEAR_STOPS_TOTAL times goes on with the worn tool (muted) rather than failing', async () => {
  const { MAX_WEAR_STOPS_TOTAL } = await import('../../src/executor/executor')
  const { bot, pick } = wornPickBot(30, {})
  const lines: string[] = []
  const ex = new Executor(bot, { log: line => lines.push(line) })
  let replaced = 0
  ex.replaceWornTool = async () => { replaced++; pick.durabilityUsed = 250 - 30; return true }
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  // 6 blocks before each of the 11 replaced stops' marks, then the muted one's 24 uses: 90 blocks done with it
  assert.equal(await ex.task('a very long tunnel', longDig(bot, 90, progress)), 90)
  assert.equal(replaced, MAX_WEAR_STOPS_TOTAL - 1)
  assert.ok(lines.some(l => /a very long tunnel: goes on with the worn iron_pickaxe/.test(l)), lines.join('\n'))
})

test('a task stopped for a worn tool whose only replacement is a far chest\'s goes on with the worn one (no trip mid-task)', async () => {
  const { bot } = wornPickBot(30, {})
  // the base's spare 300 blocks off: a plan of a short walk, a trip of tens of thousands of ticks from the deep caves
  bot.survival.memory.rememberChest(new Vec3(300, 64, 0), { iron_pickaxe: 1 })
  const log: string[] = []
  const lines: string[] = []
  const ex = new Executor(bot, { runners: { loot: async (step: any) => { log.push(describeStep(step)); return { gained: 0 } } }, maxStepFailures: 1, log: line => lines.push(line) })
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  assert.equal(await ex.task('mine the obsidian', longDig(bot, 20, progress)), 20)
  assert.deepEqual(log, [])
  assert.ok(lines.some(l => /no new pickaxe for the iron_pickaxe/.test(l)), lines.join('\n'))
})

test('a task that tells the uses it still needs is not stopped while the worn tool has them (TaskInfo.uses)', async () => {
  const { bot } = wornPickBot(30, { iron_ingot: 3, stick: 2, crafting_table: 1 })
  const log: string[] = []
  const ex = new Executor(bot, { runners: honestRunners(bot, log), log: () => {} })
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  assert.equal(await ex.task('mine the obsidian', longDig(bot, 10, progress), undefined, { uses: () => 10 - progress.dug }), 10)
  assert.equal(progress.runs, 1)
  assert.deepEqual(log, [])
})

test('a worn tool no replacement can be got for is let be: the task goes on with it, and no task stops for it a while', async () => {
  // nothing to make a pickaxe of, and the mine steps find nothing
  const { bot } = wornPickBot(30, {})
  const lines: string[] = []
  const ex = new Executor(bot, { runners: { mine: async () => { throw new TaskError('NOT_FOUND', 'none found') } }, maxStepFailures: 1, log: line => lines.push(line) })
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  assert.equal(await ex.task('a tunnel', longDig(bot, 20, progress)), 20)
  assert.equal(progress.runs, 2)
  assert.ok(lines.some(l => /no new pickaxe for the iron_pickaxe/.test(l)), lines.join('\n'))
  // the next task with it: no stop
  const next = { dug: 0, runs: 0, tools: [] as string[] }
  assert.equal(await ex.task('another tunnel', longDig(bot, 3, next)), 3)
  assert.equal(next.runs, 1)
})

test('a lower tier spare held does when no tool of the worn one\'s tier can be got; a plan\'s step is never stopped by the watch', async () => {
  const { bot, pick } = wornPickBot(30, { stone_pickaxe: 1 })
  pick.name = 'diamond_pickaxe'
  pick.maxDurability = 1561
  pick.durabilityUsed = 1561 - 30
  const lines: string[] = []
  const ex = new Executor(bot, { runners: { mine: async () => { throw new TaskError('NOT_FOUND', 'none found') } }, maxStepFailures: 1, log: line => lines.push(line) })
  const progress = { dug: 0, runs: 0, tools: [] as string[] }
  assert.equal(await ex.task('a staircase', longDig(bot, 10, progress)), 10)
  assert.ok(lines.some(l => /the stone_pickaxe held goes on after it/.test(l)), lines.join('\n'))
  // a step task wears its tool unwatched (the mine step hands a worn tool back itself)
  const step = { dug: 0, runs: 0, tools: [] as string[] }
  const fresh = wornPickBot(30, {})
  const ex2 = new Executor(fresh.bot, { log: () => {} })
  assert.equal(await ex2.task('step:mine', longDig(fresh.bot, 10, step), undefined, { step: { kind: 'mine' } as any }), 10)
  assert.equal(step.runs, 1)
})

test('a loot that finds the item gone: the memory has the chest\'s true contents, and the next plan, made at once, goes another way (no retry of the loot)', async () => {
  const chestModule = require('../../src/skills/chest')
  const { runLoot } = await import('../../src/executor/steps')
  const bot = fakeBot({ iron_pickaxe: 1, stick: 2, crafting_table: 1 })
  bot.blockAt = (pos: Vec3) => ({ name: 'chest', position: pos, boundingBox: 'block' })
  const chest = new Vec3(4, 64, 0)
  // the memory of a run segment whose take of the pickaxe wasn't saved
  bot.survival.memory.rememberChest(chest, { diamond_pickaxe: 1, bread: 3 })
  const log: string[] = []
  const lines: string[] = []
  const runners = honestRunners(bot, log)
  let loots = 0
  runners.loot = async (step, ctx) => { log.push(describeStep(step)); return await runLoot(step as any, ctx) }
  const real = chestModule.retrieveItems
  // the window as transfer sees it: nothing of the pickaxe, the contents remembered (chest.ts rememberContents)
  chestModule.retrieveItems = async (_b: unknown, args: any) => { loots++; args.memory.rememberChest(args.chest, { bread: 3 }); return { chest: args.chest, moved: {} } }
  try {
    const ex = new Executor(bot, { runners, log: line => lines.push(line), maxStepFailures: 1 })
    await ex.obtain([{ item: 'diamond_pickaxe', count: 1 }])
  } finally {
    chestModule.retrieveItems = real
  }
  assert.equal(loots, 1)
  assert.equal(log[0], 'loot 1 diamond_pickaxe at 4 64 0')
  assert.equal(log.filter(l => l.startsWith('loot')).length, 1, log.join('; '))
  assert.equal(log[log.length - 1], 'craft 1 diamond_pickaxe')
  assert.ok(lines.some(l => /had 0 of the 1 diamond_pickaxe remembered: planning again/.test(l)), lines.join(' | '))
  assert.deepEqual(bot.survival.memory.chestAt(chest)?.items, { bread: 3 })
  assert.equal(count(bot, 'diamond_pickaxe'), 1)
})

test('a loot from a chest that is gone plans again at once (the chest forgotten)', async () => {
  const { runLoot } = await import('../../src/executor/steps')
  const bot = fakeBot()
  bot.blockAt = (pos: Vec3) => ({ name: 'air', position: pos, boundingBox: 'empty' })
  const chest = new Vec3(4, 64, 0)
  bot.survival.memory.rememberChest(chest, { diamond_pickaxe: 1 })
  const lines: string[] = []
  const out = await runLoot({ kind: 'loot', item: 'diamond_pickaxe', count: 1, from: { x: 4, y: 64, z: 0, dimension: 'overworld' } } as any, { bot, signal: new AbortController().signal, log: (l: string) => lines.push(l), state: {}, memory: bot.survival.memory } as any)
  assert.deepEqual(out, { gained: 0, replan: true })
  assert.equal(bot.survival.memory.chestAt(chest), undefined)
})

test('an exploring for berry bushes that found none, and saw no animal, makes the other plants and the animals dear too (snowFood: berries, then melons, each a 96-block walk)', async () => {
  const bot = fakeBot({ crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, oak_planks: 16 })
  bot.entities = { 0: bot.entity }
  bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p })
  let mined = 0
  const runners: Record<string, StepRunner<any>> = {
    ...honestRunners(bot, []),
    mine: async (step) => {
      mined++
      // a pig went by on the second exploring
      if (mined === 2) { bot.entities[5] = { id: 5, name: 'pig', position: new Vec3(20, 64, 0), metadata: [] }; for (let i = 0; i < 20; i++) bot.emit('physicsTick'); delete bot.entities[5] }
      throw new TaskError('NOT_FOUND', `no ${String(step.block)} found exploring`)
    }
  }
  const lines: string[] = []
  const ex = new Executor(bot, { runners, maxStepFailures: 1, log: l => lines.push(l) })
  await ex.obtain([{ item: 'sweet_berries', count: 4 }]).catch(() => {})
  assert.ok(ex.sightings.isScarce('sweet_berry_bush'), lines.join(' | '))
  assert.ok(ex.sightings.isScarce('melon') && ex.sightings.isScarce('kelp'), 'the plants it went by none of')
  assert.ok(ex.sightings.isScarce('cow') && ex.sightings.isScarce('pig'), 'the animals it saw none of')
  const ex2 = new Executor(bot, { runners, maxStepFailures: 1, log: l => lines.push(l) })
  await ex2.obtain([{ item: 'sweet_berries', count: 4 }]).catch(() => {})
  assert.ok(ex2.sightings.isScarce('cow'), lines.join(' | '))
  assert.ok(!ex2.sightings.isScarce('pig'), 'the pig seen on the way')
})

test('the base\'s crafting table or furnace a step found gone (its chunk loaded) is forgotten; one in an unloaded chunk, or not the base\'s, kept', () => {
  const bot = fakeBot({})
  const memory = new WorldMemory()
  memory.addPoi('base_crafting_table', { x: -54, y: 60, z: -16 }, 'overworld')
  memory.addPoi('base_furnace', { x: -53, y: 60, z: -16 }, 'overworld')
  bot.game = { dimension: 'overworld' }
  let loaded = false
  bot.blockAt = (p: Vec3) => loaded ? { name: 'air', type: 0, position: p } : null
  const ex = new Executor(bot, { runners: {}, log: () => {}, memory } as any)
  const gone = new TaskError('NOT_FOUND', 'no crafting table at (-54, 60, -16)')
  ex.forgetMissingStation(gone)
  assert.equal(memory.getPois('base_crafting_table').length, 1, 'unloaded: kept')
  loaded = true
  ex.forgetMissingStation(new TaskError('NOT_FOUND', 'no crafting table at (10, 60, 10)'))
  assert.equal(memory.getPois('base_crafting_table').length, 1, 'not the base\'s: kept')
  ex.forgetMissingStation(gone)
  assert.equal(memory.getPois('base_crafting_table').length, 0)
  ex.forgetMissingStation(new TaskError('NOT_FOUND', 'no furnace at (-53, 60, -16)'))
  assert.equal(memory.getPois('base_furnace').length, 0)
})

test('storeAtBase stores nothing from another dimension than the base\'s (its chests\' coordinates are the overworld\'s)', async () => {
  const bot = fakeBot({ diorite: 64 })
  bot.game = { dimension: 'the_nether' }
  const memory = new WorldMemory()
  memory.setBase({ x: 0, y: 64, z: 0 }, 'overworld')
  memory.addPoi('base_bounds', { x: -5, y: 60, z: -5 }, 'overworld', '5,70,5')
  const ex = new Executor(bot, { runners: {}, log: () => {}, memory } as any)
  ;(ex as any).storeChests = () => { throw new Error('went for the chests') }
  assert.deepStrictEqual(await ex.storeAtBase(), {})
})

test('a hunt for salmon that found none with no water in sight makes the water and the cod dear too; with water in sight the water is not (full-26.3-s31337-h: \'kill 7 salmon\' explored a snowy mountain with no water)', async () => {
  for (const water of [false, true]) {
    const bot = fakeBot({ iron_sword: 1, furnace: 1, coal: 8 })
    bot.entities = { 0: bot.entity }
    const pond = new Vec3(6, 63, 0)
    bot.blockAt = (p: Vec3) => water && p.equals(pond)
      ? { name: 'water', position: p, getProperties: () => ({ level: 0 }) }
      : { name: p.y < 64 ? 'stone' : 'air', position: p, getProperties: () => ({}) }
    bot.findBlocks = ({ matching }: { matching: number[] }) => water && matching.includes(registry.blocksByName.water.id) ? [pond] : []
    const runners: Record<string, StepRunner<any>> = {
      ...honestRunners(bot, []),
      kill: async (step) => { throw new TaskError('NOT_FOUND', `no ${step.mob} found exploring`) }
    }
    const ex = new Executor(bot, { runners, maxStepFailures: 1, log: () => {} })
    await ex.obtain([{ item: 'salmon', count: 3 }], undefined, { exclude: ['fish'] }).catch(() => {})
    assert.ok(ex.sightings.isScarce('salmon') && ex.sightings.isScarce('cod'))
    assert.equal(ex.sightings.isScarce('water'), !water)
  }
})

test('the executor knows an ocean that grows kelp near by its biome survey (or the kelp remembered), within OCEAN_RANGE: kelp is priced as the sea\'s then', async () => {
  const { OCEAN_RANGE, NO_OCEAN_FACTOR } = await import('../../src/executor/sight')
  const bot = fakeBot({})
  bot.entities = { 0: bot.entity }
  const ex = new Executor(bot, {})
  const kelp = { name: 'kelp_plant', kind: 'block' as const, dimension: 'overworld' as const, find: 1000 }
  assert.equal(ex.oceanNear(), false)
  assert.equal(ex.sightings.cost(kelp), 1000 * NO_OCEAN_FACTOR)
  // a river, a frozen ocean (no kelp in them), and a cold ocean too far
  ex.biomes.note({ x: 40, z: 0, y: 62, biome: 'river' })
  ex.biomes.note({ x: 0, z: 60, y: 62, biome: 'frozen_ocean' })
  ex.biomes.note({ x: OCEAN_RANGE + 24, z: 0, y: 62, biome: 'cold_ocean' })
  assert.equal(ex.oceanNear(), false)
  ex.biomes.note({ x: -100, z: 0, y: 62, biome: 'cold_ocean' })
  assert.equal(ex.oceanNear(), true)
  assert.equal(ex.sightings.cost(kelp), undefined)
  // kelp remembered near, no ocean surveyed
  const ex2 = new Executor(fakeBot({}), {})
  assert.equal(ex2.oceanNear(), false)
  ex2.memory.rememberBlock('kelp_plant', new Vec3(30, 50, 30), 'overworld')
  assert.equal(ex2.oceanNear(), true)
})
