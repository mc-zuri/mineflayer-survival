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

test('makeRoom: a part stack thrown THROW_LOOP_REPEATS times within THROW_LOOP_TICKS, picked up again each time, goes into a chest instead; with none, INVENTORY_FULL with a report, and no room is made on the way a while', async () => {
  // (26.3 run full-f: '19 dirt, 5 sand, 2 gravel' thrown into a pit the staircase's next step reached, every step for
  // 30 steps)
  const { THROW_LOOP_REPEATS, THROW_LOOP_TICKS } = await import('../../src/executor/keep')
  const valuables = ['diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'coal', 'obsidian', 'ender_pearl', 'blaze_rod', 'book',
    'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'crafting_table', 'furnace', 'chest', 'anvil',
    'bow', 'shield', 'shears', 'compass', 'clock', 'flint_and_steel', 'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'iron_shovel',
    'golden_apple', 'ender_eye', 'iron_ore', 'gold_ore']
  const make = (): { bot: any, ex: Executor, stashed: Array<Set<string>>, reports: string[] } => {
    // 34 valuables and 2 junk stacks: the bag full
    const bot = fakeBot({ ...Object.fromEntries(valuables.map(n => [n, 1])), rotten_flesh: 7, string: 5 })
    bot.tossed = []
    // what's thrown comes back (a pit in the next step's reach)
    bot.toss = async (type: number, _meta: unknown, n: number) => { bot.tossed.push(`${n} ${registry.items[type].name}`) }
    bot.blockAt = () => null
    bot._client = new EventEmitter()
    bot.entity.yaw = 0
    bot.entities = {}
    bot.look = async () => {}
    const reports: string[] = []
    bot.survival.diagnostics = { skillFailed: (name: string, err: Error) => { reports.push(`${name}: ${err.message}`); return null } }
    const ex = new Executor(bot, { runners: {} })
    const stashed: Array<Set<string>> = []
    ;(ex as any).stashNearby = async (_needed: unknown, _signal: unknown, _run: unknown, also: Set<string>) => { stashed.push(new Set(also)); return {} }
    return { bot, ex, stashed, reports }
  }
  const ticking = (bot: any): ReturnType<typeof setInterval> => setInterval(() => bot.emit('physicsTick'), 1)
  // a chest takes them: stored, not thrown a third time
  const a = make()
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
    assert.deepEqual(a.reports, [])
  } finally {
    clearInterval(t)
  }
  // none takes them: INVENTORY_FULL, a report, and no room made on the way (no throw, no stash) for THROW_LOOP_TICKS
  const b = make()
  t = ticking(b.bot)
  try {
    for (let i = 1; i < THROW_LOOP_REPEATS; i++) await b.ex.makeRoom()
    await assert.rejects(b.ex.makeRoom(), (err: any) => TaskError.is(err, 'INVENTORY_FULL') && /making room loops: 7 rotten_flesh, 5 string thrown 3 times/.test(err.message))
    assert.equal(b.reports.length, 1, b.reports.join(' | '))
    assert.match(b.reports[0], /^make room: making room loops/)
    const tosses = b.bot.tossed.length
    const stashes = b.stashed.length
    await b.ex.task('a staircase', async (s) => await b.ex.makeRoomDuringStep(s))
    assert.equal(b.bot.tossed.length, tosses)
    assert.equal(b.stashed.length, stashes)
    assert.ok(THROW_LOOP_TICKS > 1000)
  } finally {
    clearInterval(t)
  }
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
