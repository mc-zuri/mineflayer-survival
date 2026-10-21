// The herd step and its upkeep without a server (the executor's tasks stood in for): the pen built near home and the
// cows led in, the herd remembered; the pairs bred, only the surplus slaughtered and cooked, the breeders and the
// calves never; the farm's wheat kept from the baking for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { planPen, rememberPen } from '../../src/skills/pen'
import { herdFromMemory, rememberHerd } from '../../src/skills/herd'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

const CENTER = new Vec3(10, 64, 10)
const signal = (): AbortSignal => new AbortController().signal

/** a bot by a pen of 7 at CENTER (its ring of fences and its gate in the world), with the herd's animals given */
function byThePen (animals: Array<{ x: number, z: number, baby?: boolean, name?: string }>, items: any[] = []): { bot: any, memory: WorldMemory, pen: any } {
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 7, 'west')
  const fence = new Set(pen.fences.map(p => p.toString()))
  const memory = new WorldMemory()
  rememberPen(memory, pen)
  const bot = fakeBot({
    position: new Vec3(6.5, 64, 10.5),
    items,
    entities: animals.map(a => entity({ name: a.name ?? 'cow', position: new Vec3(a.x + 0.5, 64, a.z + 0.5), meta: a.baby === true ? { baby: true } : {} })),
    world: p => p.y < 64 ? 'grass_block' : fence.has(p.toString()) ? 'oak_fence' : p.equals(pen.gate) ? 'oak_fence_gate' : 'air'
  })
  bot.game.dimension = 'overworld'
  bot.time = { age: 100000, timeOfDay: 1000 }
  return { bot, memory, pen }
}

function fakeExecutor (bot: any, memory: WorldMemory, onTask: (name: string, fn: any) => any = () => undefined): { executor: any, tasks: string[], obtained: any[] } {
  const tasks: string[] = []
  const obtained: any[] = []
  const executor: any = {
    memory,
    tasks: { tick: 0 },
    plan: () => ({ ok: true, cost: 100, steps: [] }),
    obtain: async (reqs: any[]) => { obtained.push(...reqs) },
    runStep: async () => ({ gained: 0 }),
    farmCost: () => undefined,
    task: async (name: string, fn: any) => { tasks.push(name); return await onTask(name, fn) }
  }
  return { executor, tasks, obtained }
}

test('startHerd: two cows near home and wheat held: a pen built near home, the cows led in, the herd remembered at the pen', async () => {
  const { startHerd } = await import('../../src/milestones')
  const memory = new WorldMemory()
  const bot = fakeBot({
    position: new Vec3(0.5, 64, 0.5),
    items: [item('wheat', 4)],
    entities: [entity({ name: 'cow', position: new Vec3(20.5, 64, 3.5) }), entity({ name: 'cow', position: new Vec3(-12.5, 64, 8.5) }), entity({ name: 'sheep', position: new Vec3(3.5, 64, 3.5) })]
  })
  bot.game.dimension = 'overworld'
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 9, 'west')
  const { executor, tasks } = fakeExecutor(bot, memory, (name) => {
    if (name === 'the herd pen') {
      rememberPen(memory, pen)
      for (const e of Object.values(bot.entities) as any[]) if (e.name === 'cow') e.position = CENTER.offset(0.5, 0, 0.5)
      return { pen, inside: 2, built: true }
    }
  })
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true)
  assert.deepEqual(tasks, ['the herd pen'])
  assert.deepEqual(herdFromMemory(memory), { pos: CENTER, mob: 'cow', adults: 2, calves: 0, bred: null })
  // a herd kept: no second one
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), false)
  assert.deepEqual(tasks, ['the herd pen'])
})

test('startHerd: no two of a kind near home, or no wheat: nothing built, tried again only after a while', async () => {
  const { startHerd, HERD_RETRY_TICKS } = await import('../../src/milestones')
  const memory = new WorldMemory()
  const cows = [entity({ name: 'cow', position: new Vec3(5.5, 64, 3.5) }), entity({ name: 'cow', position: new Vec3(-5.5, 64, 3.5) })]
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: cows })
  bot.game.dimension = 'overworld'
  const { executor, tasks } = fakeExecutor(bot, memory)
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), false)
  assert.ok(lines.some(l => /none to start yet \(2 cows, 0 sheeps, 0 pigs near home, 0 wheat\)/.test(l)), lines.join(' | '))
  // the wheat comes, but the retry's wait isn't over
  bot.inventory.slots[30] = item('wheat', 3)
  assert.equal(await startHerd(bot, executor, signal(), () => {}), false)
  executor.tasks.tick = HERD_RETRY_TICKS
  executor.task = async (name: string) => { tasks.push(name); throw new Error('NOT_FOUND: no ground for a pen') }
  assert.equal(await startHerd(bot, executor, signal(), () => {}), false)
  assert.ok(tasks.includes('the herd pen'))
  assert.equal(herdFromMemory(memory), null)
})

test('tendHerd: bred as the cooldown allows, only the surplus slaughtered for the food wanted and cooked, the three breeders and the calf kept, the gate shut', async () => {
  const { tendHerd } = await import('../../src/milestones')
  const { bot, memory } = byThePen([{ x: 9, z: 9 }, { x: 10, z: 9 }, { x: 11, z: 9 }, { x: 9, z: 11 }, { x: 11, z: 11 }, { x: 10, z: 11, baby: true }], [item('wheat', 10)])
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 5, calves: 1, bred: null })
  const calf = (Object.values(bot.entities) as any[]).find(e => e.metadata.some((m: unknown) => m === true))
  const killed: number[] = []
  const { executor, tasks, obtained } = fakeExecutor(bot, memory, (name, fn) => {
    if (name === 'breed the cows') return { fed: 4, pairs: 2 }
    if (name === 'slaughter a cow') {
      // the hunt's kill: the animal gone, its beef picked up
      return fn(signal()).catch(() => ({ killed: false }))
    }
  })
  // the cooking after the bot is out of the pen (a furnace among the calves found no room, 26.3)
  const cookedAfter: string[] = []
  const obtain = executor.obtain
  executor.obtain = async (reqs: any[]) => { cookedAfter.push(tasks[tasks.length - 1]); await obtain(reqs) }
  const huntModule = require('../../src/skills/hunt')
  const real = huntModule.hunt
  huntModule.hunt = async (b: any, prey: any) => { killed.push(prey.id); delete b.entities[prey.id]; b.inventory.slots[31 + killed.length] = item('beef', 2); return { killed: true } }
  let points: number
  try {
    points = await tendHerd(bot, executor, signal(), () => {}, { want: 32 })
  } finally {
    huntModule.hunt = real
  }
  assert.equal(killed.length, 2)
  assert.ok(!killed.includes(calf.id))
  assert.equal((Object.values(bot.entities) as any[]).filter(e => e.name === 'cow').length, 4)
  assert.ok(tasks.indexOf('breed the cows') < tasks.indexOf('slaughter a cow'), tasks.join(', '))
  // the chores from inside the pen, its gate shut behind (fed from the gate's cell, the herd walked out, 26.3)
  assert.ok(tasks.includes('into the pen') && tasks.indexOf('into the pen') < tasks.indexOf('breed the cows'), tasks.join(', '))
  assert.equal(tasks[tasks.length - 1], 'shut the herd in')
  assert.deepEqual(cookedAfter, ['shut the herd in'])
  assert.ok(tasks.indexOf('the herd drops') > tasks.lastIndexOf('slaughter a cow'), tasks.join(', '))
  // the beef cooked (the base's furnace, through the planner)
  assert.deepEqual(obtained, [{ item: 'cooked_beef', count: 4 }])
  assert.equal(points, 0)
  // the breeding remembered: the next upkeep within the cooldown breeds none
  assert.equal(herdFromMemory(memory)?.bred, 100000)
  assert.equal(herdFromMemory(memory)?.adults, 3)
  tasks.length = 0
  await tendHerd(bot, executor, signal(), () => {}, { want: 200 })
  assert.ok(!tasks.includes('breed the cows') && !tasks.includes('slaughter a cow'), tasks.join(', '))
})

test('tendHerd: the three breeders alone are never slaughtered, however hungry', async () => {
  const { tendHerd } = await import('../../src/milestones')
  const { bot, memory } = byThePen([{ x: 9, z: 9 }, { x: 11, z: 11 }, { x: 9, z: 11 }])
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 3, calves: 0, bred: null })
  const { executor, tasks } = fakeExecutor(bot, memory)
  assert.equal(await tendHerd(bot, executor, signal(), () => {}, { want: 500 }), 0)
  assert.ok(!tasks.includes('slaughter a cow'), tasks.join(', '))
  assert.equal((Object.values(bot.entities) as any[]).filter(e => e.name === 'cow').length, 3)
})

test('harvestGrownFarms keeps the herd\'s wheat from the baking', async () => {
  const { harvestGrownFarms, HERD_WHEAT_KEPT } = await import('../../src/milestones')
  const { bot, memory } = byThePen([], [item('wheat', 12)])
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 2, calves: 0, bred: null })
  const { executor, obtained } = fakeExecutor(bot, memory)
  await harvestGrownFarms(bot, executor, signal(), () => {})
  assert.deepEqual(obtained, [{ item: 'bread', count: Math.floor((12 - HERD_WHEAT_KEPT) / 3) }])
  // a herd of pigs eats none of it
  rememberHerd(memory, { pos: CENTER, mob: 'pig', adults: 2, calves: 0, bred: null })
  obtained.length = 0
  await harvestGrownFarms(bot, executor, signal(), () => {})
  assert.deepEqual(obtained, [{ item: 'bread', count: 4 }])
})

test('netherKit: short of the gate\'s food, the herd\'s surplus slaughtered and cooked before any other source is planned, its breeders kept', async () => {
  const { netherKit } = await import('../../src/milestones')
  const gear = [item('diamond_sword', 1), item('iron_chestplate', 1), item('iron_helmet', 1), item('iron_leggings', 1), item('golden_boots', 1), item('shield', 1), item('bow', 1), item('arrow', 64), item('flint_and_steel', 1)]
  const { bot, memory } = byThePen([{ x: 9, z: 9 }, { x: 10, z: 9 }, { x: 11, z: 9 }, { x: 9, z: 11 }, { x: 11, z: 11 }], gear)
  rememberHerd(memory, { pos: CENTER, mob: 'cow', adults: 5, calves: 0, bred: null })
  const give = (it: any): void => { bot.inventory.slots[bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && i < 45 && s == null)] = it }
  const calls: string[] = []
  const { executor } = fakeExecutor(bot, memory, async (name, fn) => {
    calls.push(name)
    if (name === 'slaughter a cow') return await fn(signal())
  })
  executor.obtain = async (reqs: any[]) => {
    calls.push(`obtain ${reqs.map(r => r.unit === 'nutrition' ? 'food' : r.item).join(',')}`)
    if (reqs.some(r => r.item === 'cooked_beef')) { for (const s of bot.inventory.slots) if (s?.name === 'beef') bot.inventory.slots[s.slot] = null; give(item('cooked_beef', 4)) }
    if (reqs.some(r => r.unit === 'nutrition')) give(item('bread', 24))
  }
  const huntModule = require('../../src/skills/hunt')
  const real = huntModule.hunt
  huntModule.hunt = async (b: any, prey: any) => { delete b.entities[prey.id]; give(item('beef', 2)); return { killed: true } }
  try {
    await netherKit(bot, executor, signal(), () => {})
  } finally {
    huntModule.hunt = real
  }
  const slaughtered = calls.filter(c => c === 'slaughter a cow').length
  assert.equal(slaughtered, 2, calls.join(', '))
  assert.ok(calls.indexOf('obtain cooked_beef') > calls.lastIndexOf('slaughter a cow'), calls.join(', '))
  assert.ok(calls.indexOf('obtain food') > calls.indexOf('obtain cooked_beef'), calls.join(', '))
  assert.equal((Object.values(bot.entities) as any[]).filter(e => e.name === 'cow').length, 3)
})

test('noteAnimals: the wild adults in sight noted by chunk with their count, not the herd\'s nor a calf; a chunk in sight with none of its kind now forgotten, one out of sight kept', async () => {
  const { noteAnimals, rememberedAnimals, ANIMALS_POI, ANIMALS_TTL } = await import('../../src/skills/herd')
  const memory = new WorldMemory()
  const cows = [entity({ name: 'cow', position: new Vec3(33.5, 64, 2.5) }), entity({ name: 'cow', position: new Vec3(36.5, 64, 5.5) }), entity({ name: 'cow', position: new Vec3(35.5, 64, 4.5), meta: { baby: true } })]
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), entities: [...cows, entity({ name: 'zombie', position: new Vec3(5.5, 64, 5.5) })] })
  bot.game.dimension = 'overworld'
  memory.now = 1000
  assert.equal(noteAnimals(bot, memory), 1)
  const pois = memory.getPois(ANIMALS_POI)
  assert.equal(pois.length, 1)
  assert.deepEqual(JSON.parse(pois[0].note as string), { mob: 'cow', adults: 2 })
  // seen again: the one note, its count as now
  assert.equal(noteAnimals(bot, memory), 1)
  assert.equal(memory.getPois(ANIMALS_POI).length, 1)
  const groups = rememberedAnimals(memory, new Vec3(0, 64, 0), 64, 1000)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].mob, 'cow')
  assert.equal(groups[0].adults, 2)
  // too old, too far, or of a kind whose food isn't held: none
  assert.equal(rememberedAnimals(memory, new Vec3(0, 64, 0), 64, 1000 + ANIMALS_TTL + 1).length, 0)
  assert.equal(rememberedAnimals(memory, new Vec3(-100, 64, 0), 64, 1000).length, 0)
  assert.equal(rememberedAnimals(memory, new Vec3(0, 64, 0), 64, 1000, ['pig']).length, 0)
  // the cows gone (hunted) with their chunk in sight: forgotten
  for (const c of cows) delete bot.entities[c.id]
  noteAnimals(bot, memory)
  assert.equal(memory.getPois(ANIMALS_POI).length, 0)
  // a group out of sight is kept as it was
  memory.addPoi(ANIMALS_POI, new Vec3(200, 64, 0), 'overworld', JSON.stringify({ mob: 'sheep', adults: 3 }))
  noteAnimals(bot, memory)
  assert.equal(memory.getPois(ANIMALS_POI).length, 1)
})

test('rememberedAnimals: two groups of a kind across a chunk\'s edge counted together, one alone short of two not', async () => {
  const { rememberedAnimals, ANIMALS_POI } = await import('../../src/skills/herd')
  const memory = new WorldMemory()
  memory.addPoi(ANIMALS_POI, new Vec3(47, 64, 10), 'overworld', JSON.stringify({ mob: 'cow', adults: 1 }))
  memory.addPoi(ANIMALS_POI, new Vec3(49, 64, 12), 'overworld', JSON.stringify({ mob: 'cow', adults: 1 }))
  memory.addPoi(ANIMALS_POI, new Vec3(20, 64, 40), 'overworld', JSON.stringify({ mob: 'sheep', adults: 1 }))
  const groups = rememberedAnimals(memory, new Vec3(0, 64, 0), 160, 0)
  assert.deepEqual(groups.map(g => [g.mob, g.adults]), [['cow', 2], ['cow', 2]])
})

/** a bot at home with wheat and no animal near, a group of `n` cows noted `off` blocks east of home */
function homeWithCowsOff (off: number, n = 2): { bot: any, memory: WorldMemory, cows: any[] } {
  const memory = new WorldMemory()
  const { ANIMALS_POI } = require('../../src/skills/herd')
  memory.addPoi(ANIMALS_POI, new Vec3(off, 64, 0), 'overworld', JSON.stringify({ mob: 'cow', adults: n }))
  const cows = Array.from({ length: n }, (_, i) => entity({ name: 'cow', position: new Vec3(off + 0.5 + i, 64, 0.5) }))
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 6)] })
  bot.game.dimension = 'overworld'
  return { bot, memory, cows }
}

test('startHerd with no animal near home: the two cows seen 50 off fetched, a pen built at home first and the cows led home into it, the herd remembered there (f5-1.21.11: \'herd: none to start yet\' all game)', async () => {
  const { startHerd } = await import('../../src/milestones')
  const { herdFromMemory: herdOf } = await import('../../src/skills/herd')
  const { bot, memory, cows } = homeWithCowsOff(50)
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 9, 'west')
  const { executor, tasks } = fakeExecutor(bot, memory, (name) => {
    if (name === 'the herd pen') { rememberPen(memory, pen); return { pen, inside: 0, built: true } }
    // (the cows in sight once the bot is by them)
    if (name === 'to the cows') { for (const c of cows) bot.entities[c.id] = c; bot.entity.position = new Vec3(48.5, 64, 0.5) }
    if (name === 'lead the cows home') { for (const c of cows) c.position = CENTER.offset(0.5, 0, 0.5); bot.entity.position = CENTER.offset(-6, 0, 0); return 2 }
  })
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true, lines.join(' | '))
  assert.deepEqual(tasks, ['the herd pen', 'to the cows', 'lead the cows home'])
  assert.ok(lines.some(l => /none near home: the 2 cows seen 50 blocks off .* led home into a pen/.test(l)), lines.join(' | '))
  assert.deepEqual(herdOf(memory), { pos: CENTER, mob: 'cow', adults: 2, calves: 0, bred: null })
})

test('startHerd with no animal near home: the sheep seen 225 off (as far as the nearest pair of f5-1.21.11) led home into a pen there, the legs of the lead enough for the way (leadLegs); a group not found there forgotten, no herd; one past HERD_FETCH_RANGE not gone to', async () => {
  const { startHerd, HERD_RETRY_TICKS, HERD_FETCH_RANGE } = await import('../../src/milestones')
  const { herdFromMemory: herdOf, ANIMALS_POI } = await import('../../src/skills/herd')
  const { leadLegs, LEAD_LEG } = await import('../../src/skills/pen')
  assert.equal(leadLegs(40), 16)
  assert.ok(leadLegs(225) * LEAD_LEG >= 225 + 5 * LEAD_LEG)
  const { bot, memory, cows } = homeWithCowsOff(225)
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 9, 'west')
  const asked: Vec3[] = []
  let radius = 0
  const { executor, tasks } = fakeExecutor(bot, memory, async (name, fn) => {
    if (name === 'the herd pen') { asked.push(bot.entity.position.clone()); rememberPen(memory, pen); return { pen, inside: 0, built: true } }
    if (name === 'to the cows') { for (const c of cows) bot.entities[c.id] = c; bot.entity.position = new Vec3(223.5, 64, 0.5) }
    if (name === 'lead the cows home') {
      const penModule = require('../../src/skills/pen')
      const real = penModule.leadIntoPen
      penModule.leadIntoPen = async (_b: any, _p: any, args: any) => { radius = args.radius; for (const c of cows) c.position = CENTER.offset(0.5, 0, 0.5); bot.entity.position = CENTER.offset(-6, 0, 0); return 2 }
      try { return await fn(signal()) } finally { penModule.leadIntoPen = real }
    }
  })
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true, lines.join(' | '))
  assert.deepEqual(tasks, ['the herd pen', 'to the cows', 'lead the cows home'])
  assert.ok(asked[0].x < 50)
  assert.ok(radius >= 225, String(radius))
  assert.ok(herdOf(memory)?.pos.equals(CENTER))
  // another game: the cows not there any more
  const gone = homeWithCowsOff(120)
  const g = fakeExecutor(gone.bot, gone.memory, async (name) => {
    if (name === 'to the cows') gone.bot.entity.position = new Vec3(118.5, 64, 0.5)
    if (name === 'the herd pen') { rememberPen(gone.memory, pen); return { pen, inside: 0, built: true } }
  })
  g.executor.tasks.tick = HERD_RETRY_TICKS * 10
  assert.equal(await startHerd(gone.bot, g.executor, signal(), () => {}), false)
  assert.equal(herdOf(gone.memory), null)
  assert.equal(gone.memory.getPois(ANIMALS_POI).length, 0)
  // past the fetch's range: nothing gone to
  const far = homeWithCowsOff(HERD_FETCH_RANGE + 20)
  const h = fakeExecutor(far.bot, far.memory)
  assert.equal(await startHerd(far.bot, h.executor, signal(), () => {}), false)
  assert.deepEqual(h.tasks, [])
})

test('tendHerd: a herd 100 off (fetched and penned where it was) is gone to only with a chore due by its remembered counts', async () => {
  const { tendHerd } = await import('../../src/milestones')
  const memory = new WorldMemory()
  const far = new Vec3(100, 64, 0)
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), far, 7, 'west')
  rememberPen(memory, pen)
  // two adults bred lately, nothing wanted: no chore, no trip
  rememberHerd(memory, { pos: far, mob: 'cow', adults: 2, calves: 1, bred: 99000 })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 4)] })
  bot.game.dimension = 'overworld'
  bot.time = { age: 100000, timeOfDay: 1000 }
  const { executor, tasks } = fakeExecutor(bot, memory)
  assert.equal(await tendHerd(bot, executor, signal(), () => {}), 0)
  assert.deepEqual(tasks, [])
  // the cooldown over, the wheat held: the trip there for the breeding
  rememberHerd(memory, { pos: far, mob: 'cow', adults: 2, calves: 1, bred: 90000 })
  await tendHerd(bot, executor, signal(), () => {})
  assert.equal(tasks[0], 'back to the herd')
})

test('startHerd holding no breeding food: the farm\'s grown wheat harvested first (unbaked), then the cows seen 50 off fetched; with no farm, the wheat planned when cheap; pigs tempted with the carrots held (f5-1.21.11: \'herd: none to start yet ... 0 wheat\')', async () => {
  const { startHerd } = await import('../../src/milestones')
  const { rememberFarm } = await import('../../src/skills/farm')
  const { bot, memory, cows } = homeWithCowsOff(50)
  for (const s of bot.inventory.slots) if (s?.name === 'wheat') bot.inventory.slots[s.slot] = null
  rememberFarm(memory, { water: new Vec3(3, 63, 3), cells: [new Vec3(4, 63, 3), new Vec3(5, 63, 3), new Vec3(2, 63, 3)], crop: 'wheat' }, 0)
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 9, 'west')
  const steps: any[] = []
  const { executor, tasks } = fakeExecutor(bot, memory, (name) => {
    if (name === 'the herd pen') { rememberPen(memory, pen); return { pen, inside: 0, built: true } }
    if (name === 'to the cows') { for (const c of cows) bot.entities[c.id] = c; bot.entity.position = new Vec3(48.5, 64, 0.5) }
    if (name === 'lead the cows home') { for (const c of cows) c.position = CENTER.offset(0.5, 0, 0.5); bot.entity.position = CENTER.offset(-6, 0, 0); return 2 }
  })
  // (the farm grown: its harvest gives 3 wheat)
  executor.farmCost = () => 0
  executor.runStep = async (step: any) => { steps.push(step); bot.inventory.slots[30] = item('wheat', 3); return { gained: 3 } }
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true, lines.join(' | '))
  assert.equal(steps[0]?.kind, 'farm')
  assert.deepEqual(tasks, ['the herd pen', 'to the cows', 'lead the cows home'])
  // no farm, no wheat: planned (a hay bale's), within HERD_WHEAT_TICKS
  const none = homeWithCowsOff(50)
  for (const s of none.bot.inventory.slots) if (s?.name === 'wheat') none.bot.inventory.slots[s.slot] = null
  const f = fakeExecutor(none.bot, none.memory)
  f.executor.obtain = async (reqs: any[]) => { f.obtained.push(...reqs); none.bot.inventory.slots[30] = item('wheat', 4) }
  await startHerd(none.bot, f.executor, signal(), () => {})
  assert.deepEqual(f.obtained[0], { item: 'wheat', count: 4 })
  // carrots held: pigs near led with them, no wheat got
  const { herdFoodFirst } = await import('../../src/milestones')
  const pigs = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('carrot', 5)] })
  const g = fakeExecutor(pigs, new WorldMemory())
  assert.equal(await herdFoodFirst(pigs, g.executor, signal(), () => {}), true)
  assert.deepEqual(g.obtained, [])
})

test('a fetch whose home has no ground for a pen pens the animals where they are found (f5-1.21.11: \'no ground for a pen of 9 near (0, 71, 24)\', the sheep 227 off not penned)', async () => {
  const { startHerd } = await import('../../src/milestones')
  const { herdFromMemory: herdOf } = await import('../../src/skills/herd')
  const { bot, memory, cows } = homeWithCowsOff(200)
  const there = new Vec3(206, 64, 0)
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), there, 7, 'west')
  const { executor, tasks } = fakeExecutor(bot, memory, async (name) => {
    if (name === 'the herd pen') {
      if (bot.entity.position.x < 100) throw new Error('NOT_FOUND: no ground for a pen near home')
      rememberPen(memory, pen)
      for (const c of cows) c.position = there.offset(0.5, 0, 0.5)
      return { pen, inside: 2, built: true }
    }
    if (name === 'to the cows') { for (const c of cows) bot.entities[c.id] = c; bot.entity.position = new Vec3(198.5, 64, 0.5) }
  })
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true, lines.join(' | '))
  assert.ok(lines.some(l => /no pen at home: the cows penned where they are/.test(l)), lines.join(' | '))
  assert.equal(tasks[tasks.length - 1], 'the herd pen')
  assert.ok(tasks.includes('to the cows') && !tasks.includes('lead the cows home'), tasks.join(', '))
  assert.ok(herdOf(memory)?.pos.equals(there))
})

test('herd search: due with none yet, then every 3 days, a failed one dear for 6; its spot the open land\'s food biomes first, within the fetch range and away from home and from spots searched', async () => {
  const { herdSearchDue, herdSearchTarget, HERD_SEARCH_POI, HERD_SEARCH_TICKS, HERD_SEARCH_FAIL_TICKS } = await import('../../src/milestones')
  const memory = new WorldMemory()
  assert.equal(herdSearchDue(memory, 0), true)
  const home = new Vec3(0, 64, 0)
  memory.addPoi('food_biome', new Vec3(20, 70, 0), 'overworld', 'old_growth_pine_taiga')
  memory.addPoi('food_biome', new Vec3(120, 70, 0), 'overworld', 'old_growth_pine_taiga')
  memory.addPoi('food_biome', new Vec3(0, 70, 200), 'overworld', 'plains')
  memory.addPoi('food_biome', new Vec3(0, 70, 300), 'overworld', 'meadow')
  // the plains first, though the taiga's nearer; not the taiga 20 off (home's), not the meadow past the range
  assert.deepEqual(herdSearchTarget(memory, home), { pos: new Vec3(0, 70, 200), biome: 'plains' })
  memory.now = 1000
  memory.addPoi(HERD_SEARCH_POI, new Vec3(0, 70, 200), 'overworld', JSON.stringify({ found: false }))
  assert.deepEqual(herdSearchTarget(memory, home), { pos: new Vec3(120, 70, 0), biome: 'old_growth_pine_taiga' })
  assert.equal(herdSearchDue(memory, 1000 + HERD_SEARCH_TICKS), false)
  assert.equal(herdSearchDue(memory, 1000 + HERD_SEARCH_FAIL_TICKS), true)
  memory.now = 2000
  memory.addPoi(HERD_SEARCH_POI, new Vec3(120, 70, 0), 'overworld', JSON.stringify({ found: true }))
  assert.equal(herdSearchDue(memory, 2000 + HERD_SEARCH_TICKS - 1), false)
  assert.equal(herdSearchDue(memory, 2000 + HERD_SEARCH_TICKS), true)
})

test('startHerd with no group seen within 256 of home: by day a search of the plains noted 200 off, the group it sees fetched home; by night, or not due, none', async () => {
  const { startHerd, HERD_SEARCH_POI } = await import('../../src/milestones')
  const { herdFromMemory: herdOf, ANIMALS_POI } = await import('../../src/skills/herd')
  const memory = new WorldMemory()
  memory.addPoi('food_biome', new Vec3(0, 70, 200), 'overworld', 'plains')
  const cows = [entity({ name: 'cow', position: new Vec3(0.5, 64, 200.5) }), entity({ name: 'cow', position: new Vec3(2.5, 64, 200.5) })]
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 6)] })
  bot.game.dimension = 'overworld'
  bot.time = { age: 0, timeOfDay: 1000 }
  const pen = planPen(() => ({ name: 'air', boundingBox: 'empty' }), CENTER, 9, 'west')
  const { executor, tasks } = fakeExecutor(bot, memory, (name) => {
    // (the search's exploring: the cows seen by the plains, the sightings' note)
    if (name === 'look for a herd') { memory.addPoi(ANIMALS_POI, new Vec3(1, 64, 200), 'overworld', JSON.stringify({ mob: 'cow', adults: 2 })) }
    if (name === 'the herd pen') { rememberPen(memory, pen); return { pen, inside: 0, built: true } }
    if (name === 'to the cows') { for (const c of cows) bot.entities[c.id] = c; bot.entity.position = new Vec3(0.5, 64, 196.5) }
    if (name === 'lead the cows home') { for (const c of cows) c.position = CENTER.offset(0.5, 0, 0.5); bot.entity.position = CENTER.offset(-6, 0, 0); return 2 }
  })
  const lines: string[] = []
  assert.equal(await startHerd(bot, executor, signal(), l => lines.push(l)), true, lines.join(' | '))
  assert.deepEqual(tasks, ['look for a herd', 'the herd pen', 'to the cows', 'lead the cows home'])
  assert.ok(herdOf(memory) != null)
  assert.equal(memory.getPois(HERD_SEARCH_POI).length, 1)
  // another game by night: no search
  const night = new WorldMemory()
  night.addPoi('food_biome', new Vec3(0, 70, 200), 'overworld', 'plains')
  const nb = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 6)] })
  nb.game.dimension = 'overworld'
  nb.time = { age: 0, timeOfDay: 18000 }
  const n = fakeExecutor(nb, night)
  assert.equal(await startHerd(nb, n.executor, signal(), () => {}), false)
  assert.ok(!n.tasks.includes('look for a herd'))
})

test('herd search: a search cut short (the upkeep\'s budget) is noted as tried all the same, not the same spot again; with no open land\'s biome, another than home\'s own first', async () => {
  const { searchHerd, herdSearchTarget, HERD_SEARCH_POI } = await import('../../src/milestones')
  const memory = new WorldMemory()
  memory.addPoi('food_biome', new Vec3(0, 70, 8), 'overworld', 'old_growth_pine_taiga')
  memory.addPoi('food_biome', new Vec3(-8, 95, -60), 'overworld', 'old_growth_pine_taiga')
  memory.addPoi('food_biome', new Vec3(150, 70, 0), 'overworld', 'snowy_taiga')
  assert.deepEqual(herdSearchTarget(memory, new Vec3(0, 64, 0)), { pos: new Vec3(150, 70, 0), biome: 'snowy_taiga' })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 6)] })
  bot.game.dimension = 'overworld'
  bot.time = { age: 0, timeOfDay: 1000 }
  const ctrl = new AbortController()
  const { executor } = fakeExecutor(bot, memory, () => { ctrl.abort(new Error('out of the upkeep\'s ticks')); throw new Error('aborted') })
  await assert.rejects(searchHerd(bot, executor, new Vec3(0, 64, 0), ctrl.signal, () => {}))
  assert.equal(memory.getPois(HERD_SEARCH_POI).length, 1)
  assert.deepEqual(herdSearchTarget(memory, new Vec3(0, 64, 0)), { pos: new Vec3(-8, 95, -60), biome: 'old_growth_pine_taiga' })
})
