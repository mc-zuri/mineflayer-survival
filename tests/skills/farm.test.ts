import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { cropOf, FARM_MIN_PLOTS, FARM_REACH, farmHoleSite, findFarmSite, grownPlots, knownFarms, plotCells, plotGround, rememberFarm, farmCells, SEED_OF } from '../../src/skills/farm'
import { waterHoleSite } from '../../src/skills/caneFarm'
import { FARM_PLOTS } from '../../src/core/crops'
import { obtainAll } from '../../src/planner/obtain'
import { checkPlan } from '../../src/planner/steps'
import { FOOD_GOAL, FOOD_POINTS } from '../../src/planner/progression'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

/** a grass plain at y 63 with a pond (water sources) at the given cells, crops at `crops` */
function world (water: Vec3[], crops: Array<{ at: Vec3, name: string, age: number }> = [], extra: Record<string, string> = {}): (p: Vec3) => any {
  return (p: Vec3) => {
    const k = `${p.x},${p.y},${p.z}`
    if (extra[k] != null) return { name: extra[k] }
    const crop = crops.find(c => c.at.equals(p))
    if (crop != null) return { name: crop.name, getProperties: () => ({ age: crop.age }) }
    if (water.some(w => w.equals(p))) return { name: 'water', getProperties: () => ({ level: 0 }) }
    if (p.y < 63) return { name: 'dirt' }
    if (p.y === 63) return { name: 'grass_block' }
    if (p.y === 64 && (p.x + p.z) % 3 === 0) return { name: 'short_grass' }
    return { name: 'air' }
  }
}

test('a farm site: the water, and the plot ground in a block of 5 by 5 round it, open above, the nearest first, FARM_PLOTS (12) at most', () => {
  const water = [new Vec3(10, 63, 10)]
  assert.equal(findFarmSite(world(water), new Vec3(0, 64, 0), 24)?.cells.length, FARM_PLOTS)
  const site = findFarmSite(world(water), new Vec3(0, 64, 0), 24, 8)
  assert.ok(site != null)
  assert.ok(site.water.equals(water[0]))
  assert.equal(site.cells.length, 8)
  for (const c of site.cells) {
    assert.equal(c.y, 63)
    // the 3 by 3 ring first, all in reach of the water for FarmBlock.isNearWater
    assert.ok(Math.max(Math.abs(c.x - 10), Math.abs(c.z - 10)) <= 1)
    assert.ok(!c.equals(water[0]))
  }
  // the whole block: 24 plots by one water
  const all = findFarmSite(world(water), new Vec3(0, 64, 0), 24, 30) as { cells: Vec3[] }
  assert.equal(all.cells.length, 24)
  assert.ok(all.cells.every(c => Math.max(Math.abs(c.x - 10), Math.abs(c.z - 10)) <= FARM_REACH))
  // a stone floor round the water: nothing to till
  const stone: Record<string, string> = {}
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) stone[`${10 + dx},63,${10 + dz}`] = 'stone'
  delete stone['10,63,10']
  assert.equal(findFarmSite(world(water, [], stone), new Vec3(10, 64, 10), 6), null)
  // no water: none
  assert.equal(findFarmSite(world([]), new Vec3(0, 64, 0), 8), null)
})

test('plot ground: grass, dirt and its path, coarse and rooted dirt (tilled twice), bare farmland; podzol is none (HoeItem.TILLABLES)', () => {
  for (const g of ['grass_block', 'dirt', 'dirt_path', 'coarse_dirt', 'rooted_dirt', 'farmland']) assert.equal(plotGround(g), true, g)
  for (const g of ['podzol', 'mycelium', 'stone', 'sand', undefined]) assert.equal(plotGround(g), false, String(g))
  // a pond in a pine taiga's podzol, coarse dirt on its east: the coarse dirt's plots alone, fewer than least none
  const water = [new Vec3(10, 63, 10)]
  const ground: Record<string, string> = {}
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) ground[`${10 + dx},63,${10 + dz}`] = dx > 0 ? 'coarse_dirt' : 'podzol'
  delete ground['10,63,10']
  const site = findFarmSite(world(water, [], ground), new Vec3(10, 64, 10), 4, 24) as { cells: Vec3[] }
  assert.equal(site.cells.length, 10)
  assert.ok(site.cells.every(c => c.x > 10))
  assert.equal(findFarmSite(world(water, [], ground), new Vec3(10, 64, 10), 4, 24, 12), null)
})

/** an old growth pine taiga's floor at y 63: podzol, a patch of grass from x 8 to 16, the base's cobblestone at home */
function taiga (holes: Vec3[] = []): (p: Vec3) => any {
  return (p: Vec3) => {
    if (holes.some(h => h.equals(p))) return { name: 'water', getProperties: () => ({ level: 0 }) }
    if (p.y < 63) return { name: 'dirt' }
    if (p.y === 63) return { name: Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 ? 'cobblestone' : p.x >= 8 && p.x <= 16 && Math.abs(p.z) <= 6 ? 'grass_block' : 'podzol' }
    return { name: p.y === 64 && (p.x * 7 + p.z) % 5 === 0 ? 'fern' : 'air' }
  }
}

test('farmHoleSite: the hole dug where the most plot ground is about it, in the grass, not in the podzol by home nor in the base (f5-1.21.11: the cane farm\'s hole in the podzol, no farm all game)', () => {
  const home = new Vec3(0, 64, 0)
  const hole = farmHoleSite(taiga(), home, 16) as Vec3
  assert.ok(hole != null)
  assert.equal(hole.y, 63)
  // in the grass, with the whole block of it about it
  assert.ok(hole.x >= 10 && hole.x <= 14 && Math.abs(hole.z) <= 4, hole.toString())
  assert.equal(plotCells(taiga(), hole).length, 24)
  // the cane farm's hole would be in the podzol by home: no plot by it
  const cane = waterHoleSite(taiga(), home) as Vec3
  assert.equal(plotCells(taiga([cane]), cane).length, 0)
  // with the hole's water in, the farm's site is there
  const site = findFarmSite(taiga([hole]), home, 24, FARM_PLOTS, FARM_MIN_PLOTS) as { water: Vec3 }
  assert.ok(site.water.equals(hole))
  // all podzol, or stone: no hole at all
  assert.equal(farmHoleSite((p: Vec3) => ({ name: p.y < 63 ? 'dirt' : p.y === 63 ? 'podzol' : 'air' }), home, 16), null)
  assert.equal(farmHoleSite((p: Vec3) => ({ name: p.y <= 63 ? 'stone' : 'air' }), home, 16), null)
  // a cell with air on a side (the edge of a step down) holds no water
  const step = (p: Vec3): any => ({ name: p.y < 63 ? 'dirt' : p.y === 63 && p.x < 20 ? 'grass_block' : 'air' })
  const edge = farmHoleSite(step, new Vec3(20, 64, 0), 4) as Vec3
  assert.ok(edge != null)
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notEqual(step(edge.offset(x, 0, z)).name, 'air', edge.toString())
})

test('startFarm by a home in the podzol: the water hole dug in the grass (farmHoleSite) and the farm sown by its water', async () => {
  const { startFarm } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const farmModule = require('../../src/skills/farm')
  const holes: Vec3[] = []
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('water_bucket', 1), item('wooden_hoe', 1), item('wheat_seeds', 12)] })
  bot.blockAt = (p: Vec3) => ({ ...taiga(holes)(p.floored()), position: p.floored() })
  bot.game.dimension = 'overworld'
  bot.time = { age: 5000 }
  const memory = new WorldMemory()
  memory.setBase(new Vec3(0, 64, 0), 'overworld')
  const tasks: string[] = []
  const sown: any[] = []
  const executor: any = {
    memory,
    plan: () => ({ ok: true, cost: 100, steps: [] }),
    obtain: async () => {},
    task: async (name: string, fn: any, s: AbortSignal) => {
      tasks.push(name)
      // (the hole dug: its water in the world)
      if (name === 'a water hole for the farm') { holes.push(farmHoleSite(taiga(), new Vec3(0, 64, 0), 16) as Vec3); return holes[0] }
      if (name === 'sow a farm') {
        const real = farmModule.plantFarm
        farmModule.plantFarm = async (_b: any, args: any) => { sown.push(args); return { water: args.water, cells: plotCells(taiga(holes), args.water, args.plots), crop: 'wheat' } }
        try { return await fn(s) } finally { farmModule.plantFarm = real }
      }
    }
  }
  const lines: string[] = []
  assert.equal(await startFarm(bot, executor, new AbortController().signal, l => lines.push(l)), true, lines.join(' | '))
  assert.deepEqual(tasks, ['a water hole for the farm', 'sow a farm'])
  assert.ok(sown[0].water.equals(holes[0]))
  const farm = knownFarms(memory)[0]
  assert.ok(farm.water.equals(holes[0]))
  assert.equal(farm.cells.length, FARM_PLOTS)
  assert.ok(farmCells(farm).every(c => taiga()(c).name === 'grass_block'))
})

test('till turns coarse dirt into dirt with a first use of the hoe, then into farmland', async () => {
  const { till } = await import('../../src/skills/farm')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const cell = new Vec3(1, 63, 0)
  let ground = 'coarse_dirt'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wooden_hoe', 1)], world: p => p.y < 64 ? 'dirt' : 'air' })
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => p.equals?.(cell) ? { ...realAt(p), name: ground } : realAt(p)) as any
  ;(bot as any).equip = async () => {}
  ;(bot as any).heldItem = { name: 'wooden_hoe' }
  const uses: string[] = []
  ;(bot as any).activateBlock = async () => { uses.push(ground); ground = ground === 'coarse_dirt' ? 'dirt' : 'farmland' }
  if ((bot as any)._client == null) (bot as any)._client = { on: () => {}, off: () => {}, write: () => {} }
  ;(bot as any).supportFeature = () => false
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await till(bot, cell)
  } finally {
    clearInterval(ticking)
  }
  assert.deepEqual(uses, ['coarse_dirt', 'dirt'])
  assert.equal(ground, 'farmland')
})

test('grown plots and the seeds of each crop', () => {
  const cells = [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)]
  const lookup = world([], [{ at: new Vec3(0, 64, 0), name: 'wheat', age: 7 }, { at: new Vec3(1, 64, 0), name: 'wheat', age: 3 }])
  assert.deepEqual(grownPlots(lookup, cells, 'wheat'), [cells[0]])
  assert.equal(SEED_OF.wheat, 'wheat_seeds')
  assert.equal(cropOf('carrot'), 'carrots')
  assert.equal(cropOf('stick'), null)
})

test('a farm sown is remembered with its plots and the age it was sown at', () => {
  const memory = new WorldMemory()
  rememberFarm(memory, { water: new Vec3(5, 63, 5), cells: [new Vec3(6, 63, 5)], crop: 'wheat' }, 1234)
  const farms = knownFarms(memory)
  assert.equal(farms.length, 1)
  assert.equal(farms[0].crop, 'wheat')
  assert.equal(farms[0].sown, 1234)
  assert.ok(farms[0].water.equals(new Vec3(5, 63, 5)))
  assert.ok(farmCells(farms[0])[0].equals(new Vec3(6, 63, 5)))
  // the same farm sown again replaces the note
  rememberFarm(memory, { water: new Vec3(5, 63, 5), cells: [new Vec3(6, 63, 5)], crop: 'wheat' }, 5000)
  assert.equal(knownFarms(memory)[0].sown, 5000)
})

test('the food plan goes to a grown farm when nothing is near; with none sown, a farm is the dearest food', () => {
  const kit = { crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, wooden_hoe: 1, wheat_seeds: 8 }
  const goal = [{ item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' as const }]
  // no animal or plant found anywhere lately, a farm grown by the water: its harvest's wheat into bread (a harvest
  // of 8 plots is 2 bread; more is another growing, 48000 ticks on)
  const scarce = (t: { find: number }): number => t.find * 50
  const grown = obtainAll(registry, [{ item: FOOD_GOAL, count: 10, unit: 'nutrition' }], { inventory: kit, findCost: scarce, farmCost: crop => crop === 'wheat' ? 100 : undefined })
  assert.equal(grown.ok, true)
  assert.ok(grown.steps.some(s => s.kind === 'farm' && s.item === 'wheat'), grown.steps.map(s => `${s.kind} ${s.item}`).join(', '))
  assert.ok(grown.steps.some(s => s.kind === 'craft' && s.item === 'bread'))
  assert.equal(checkPlan(registry, grown.steps, kit).ok, true)
  // none sown: sowing and growing one is dearer than a hunt
  const fresh = obtainAll(registry, goal, { inventory: kit })
  assert.ok(!fresh.steps.some(s => s.kind === 'farm'))
  // a farm sown from scratch needs the hoe and the plots' seeds
  const sow = obtainAll(registry, [{ item: 'wheat', count: 8 }], { inventory: { crafting_table: 1, oak_planks: 4, stick: 2 }, exclude: ['mine', 'loot'] })
  assert.equal(sow.ok, false)
  const sown = obtainAll(registry, [{ item: 'wheat', count: 8 }], { inventory: { wooden_hoe: 1, wheat_seeds: 8 }, exclude: ['mine', 'loot'] })
  assert.equal(sown.ok, true)
  assert.deepEqual(sown.steps.map(s => s.kind), ['farm'])
  assert.equal((sown.steps[0] as any).plots, 8)
})

test('till selects the hoe afresh and tries again when the first use leaves grass', async () => {
  const { till } = await import('../../src/skills/farm')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const cell = new Vec3(1, 63, 0)
  let tilled = false
  let uses = 0
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wooden_hoe', 1)], world: p => p.y < 64 ? 'grass_block' : 'air' })
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (tilled && p.equals?.(cell)) ? { ...realAt(p), name: 'farmland' } : realAt(p)) as any
  const slots: number[] = []
  ;(bot as any).setQuickBarSlot = (n: number) => { slots.push(n); (bot as any).quickBarSlot = n }
  ;(bot as any).quickBarSlot = 0
  ;(bot as any).equip = async () => {}
  ;(bot as any).heldItem = { name: 'wooden_hoe' }
  ;(bot as any).activateBlock = async () => { uses++; if (uses === 2) tilled = true }
  if ((bot as any)._client == null) (bot as any)._client = { on: () => {}, off: () => {}, write: () => {} }
  ;(bot as any).supportFeature = () => false
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await till(bot, cell)
  } finally {
    clearInterval(ticking)
  }
  assert.equal(uses, 2)
  assert.deepEqual(slots, [1])
})

test('till sneaks with a shield in the off hand, the shift sent a tick before the use, and lets go after', async () => {
  const { till } = await import('../../src/skills/farm')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const cell = new Vec3(1, 63, 0)
  let tilled = false
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wooden_hoe', 1)], offhand: item('shield', 1), world: p => p.y < 64 ? 'grass_block' : 'air' })
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => (tilled && p.equals?.(cell)) ? { ...realAt(p), name: 'farmland' } : realAt(p)) as any
  ;(bot as any).equip = async () => {}
  ;(bot as any).heldItem = { name: 'wooden_hoe' }
  let ticks = 0
  const sneaking: Array<{ sneak: boolean, ticks: number }> = []
  // (BlockTransformer.playerHasBlockingItemUseIntent: the 26.3 server tills only for a sneaking player)
  ;(bot as any).activateBlock = async () => { sneaking.push({ sneak: bot.getControlState('sneak'), ticks }); if (bot.getControlState('sneak')) tilled = true }
  const ticking = setInterval(() => { ticks++; bot.emit('physicsTick') }, 1)
  try {
    await till(bot, cell)
  } finally {
    clearInterval(ticking)
  }
  assert.equal(sneaking.length, 1)
  assert.equal(sneaking[0].sneak, true)
  assert.ok(sneaking[0].ticks >= 1, `the use ${sneaking[0].ticks} ticks after the shift`)
  assert.equal(bot.getControlState('sneak'), false)
})

test('a farm sown further by its water grows its one record; another water is a farm of its own', async () => {
  const { extendFarm, farmPlots } = await import('../../src/skills/farm')
  const memory = new WorldMemory()
  const water = new Vec3(10, 63, 10)
  extendFarm(memory, { water, cells: [new Vec3(9, 63, 10), new Vec3(11, 63, 10)], crop: 'wheat' }, 100)
  const rec = extendFarm(memory, { water, cells: [new Vec3(11, 63, 10), new Vec3(10, 63, 9)], crop: 'wheat' }, 500)
  assert.equal(rec.cells.length, 3)
  // sown when it was first
  assert.equal(rec.sown, 100)
  assert.equal(knownFarms(memory).length, 1)
  extendFarm(memory, { water: new Vec3(30, 63, 10), cells: [new Vec3(29, 63, 10)], crop: 'wheat' }, 600)
  assert.equal(knownFarms(memory).length, 2)
  assert.equal(farmPlots(memory), 4)
  assert.equal(farmPlots(memory, 'the_nether'), 0)
})

test('nearlyGrownPlots: the grown plots and the ones a stage short; a farm with half of them so is waited for, one with none harvested at once (full-26.3-fresh-d: 2400 ticks three times for nothing)', async () => {
  const { nearlyGrownPlots } = await import('../../src/skills/farm')
  const { runFarm } = await import('../../src/executor/steps')
  const cells = [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0), new Vec3(3, 63, 0)]
  const ages = [7, 6, 2, 0]
  const lookup = (p: Vec3): any => {
    const i = cells.findIndex(c => c.x === p.x && c.z === p.z)
    if (i >= 0 && p.y === 64) return { name: 'wheat', getProperties: () => ({ age: ages[i] }) }
    return { name: p.y === 63 ? 'farmland' : 'air' }
  }
  assert.deepEqual(nearlyGrownPlots(lookup, cells, 'wheat').map(c => c.x), [0, 1])
  // runFarm with nothing near grown: no wait (no tick comes in this test: a wait would hang it)
  const farmModule = require('../../src/skills/farm')
  const navModule = require('../../src/skills/navigate')
  const realHarvest = farmModule.harvestFarm
  const realNav = navModule.navigateNear
  const memory = new WorldMemory()
  rememberFarm(memory, { water: new Vec3(0, 63, 1), cells, crop: 'wheat' }, 0)
  ages.splice(0, 4, 2, 1, 0, 0)
  const bot: any = { blockAt: lookup, inventory: { items: () => [], slots: [] }, game: { dimension: 'overworld' }, time: { age: 0 }, on () {}, off () {}, removeListener () {} }
  let harvested = false
  farmModule.harvestFarm = async () => { harvested = true; return {} }
  navModule.navigateNear = async () => {}
  try {
    await runFarm({ kind: 'farm', item: 'wheat', count: 4, crop: 'wheat', seed: 'wheat_seeds', plots: 0, cycles: 1, cost: 0 } as any, { bot, memory, signal: new AbortController().signal, log: () => {}, home: null, state: {} } as any)
  } finally {
    farmModule.harvestFarm = realHarvest
    navModule.navigateNear = realNav
  }
  assert.equal(harvested, true)
})

test('growFarms: a farm of 12 by its water sown further from the seeds of its harvest, up to FARM_TARGET_PLOTS (18), its record grown; none past it, none far off', async () => {
  const { growFarms, FARM_TARGET_PLOTS } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const farmModule = require('../../src/skills/farm')
  const water = new Vec3(10, 63, 10)
  const memory = new WorldMemory()
  const first = plotCells(world([water]), water, 12)
  rememberFarm(memory, { water, cells: first, crop: 'wheat' }, 1000)
  // the first 12 sown (wheat on them), the rest of the block bare grass
  const lookup = (p: Vec3): any => first.some(c => c.equals(p.offset(0, -1, 0))) ? { name: 'wheat', getProperties: () => ({ age: 0 }) } : first.some(c => c.equals(p)) ? { name: 'farmland' } : world([water])(p)
  const bot = fakeBot({ position: new Vec3(12.5, 64, 12.5), items: [item('wooden_hoe', 1), item('wheat_seeds', 9)] })
  bot.blockAt = (p: Vec3) => ({ ...lookup(p.floored()), position: p.floored() })
  bot.game.dimension = 'overworld'
  bot.time = { age: 60000 }
  const asked: any[] = []
  const executor: any = { memory, plan: () => ({ ok: true, cost: 100 }), obtain: async () => {}, task: async (_n: string, fn: any, s: AbortSignal) => await fn(s) }
  const real = farmModule.plantFarm
  farmModule.plantFarm = async (_b: any, args: any) => { asked.push(args); return { water: args.water, cells: plotCells(lookup, args.water, args.plots), crop: 'wheat' } }
  try {
    assert.equal(await growFarms(bot, executor, new AbortController().signal, () => {}), FARM_TARGET_PLOTS - 12)
    assert.equal(asked.length, 1)
    assert.ok(asked[0].water.equals(water))
    assert.equal(asked[0].plots, 6)
    const rec = knownFarms(memory)[0]
    assert.equal(rec.cells.length, FARM_TARGET_PLOTS)
    // sown when it was first (its growing goes on)
    assert.equal(rec.sown, 1000)
    // at its 18: no more
    assert.equal(await growFarms(bot, executor, new AbortController().signal, () => {}), 0)
    assert.equal(asked.length, 1)
    // a farm 40 off: not from here
    const far = new WorldMemory()
    rememberFarm(far, { water: new Vec3(50, 63, 10), cells: [new Vec3(51, 63, 10)], crop: 'wheat' }, 0)
    assert.equal(await growFarms(bot, { ...executor, memory: far }, new AbortController().signal, () => {}), 0)
  } finally {
    farmModule.plantFarm = real
  }
})

test('harvestGrownFarms: a farm harvested is sown further from the seeds it gave', async () => {
  const { harvestGrownFarms } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const farmModule = require('../../src/skills/farm')
  const water = new Vec3(10, 63, 10)
  const memory = new WorldMemory()
  rememberFarm(memory, { water, cells: plotCells(world([water]), water, 12), crop: 'wheat' }, 0)
  const bot = fakeBot({ position: new Vec3(12.5, 64, 12.5), items: [item('wooden_hoe', 1)] })
  bot.blockAt = (p: Vec3) => ({ ...world([water])(p.floored()), position: p.floored() })
  bot.game.dimension = 'overworld'
  bot.time = { age: 60000 }
  const steps: any[] = []
  const executor: any = {
    memory,
    farmCost: () => 0,
    plan: () => ({ ok: true, cost: 100 }),
    obtain: async () => {},
    // (the harvest: 12 wheat and 20 seeds, 12 of them sown again)
    runStep: async (step: any) => { steps.push(step); bot.inventory.slots[20] = item('wheat_seeds', 8); return { gained: 12 } },
    task: async (_n: string, fn: any, s: AbortSignal) => await fn(s)
  }
  const real = farmModule.plantFarm
  let grown = 0
  farmModule.plantFarm = async (_b: any, args: any) => { grown = args.plots; return { water: args.water, cells: plotCells(world([water]), args.water, 24).slice(12, 12 + args.plots), crop: 'wheat' } }
  try {
    await harvestGrownFarms(bot, executor, new AbortController().signal, () => {}, false)
  } finally {
    farmModule.plantFarm = real
  }
  assert.equal(steps.length, 1)
  assert.equal(grown, 6)
  assert.equal(knownFarms(memory)[0].cells.length, 18)
})

test('keepFarm between trips: no farm, its start tried by home, again only after FARM_RETRY_TICKS; a farm grown, harvested and its wheat baked (f5-1.21.11: no farm all game once the food milestone had none)', async () => {
  const { keepFarm, FARM_RETRY_TICKS } = await import('../../src/milestones')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const memory = new WorldMemory()
  memory.setBase(new Vec3(0, 64, 0), 'overworld')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('water_bucket', 1)] })
  bot.game.dimension = 'overworld'
  bot.time = { age: 0 }
  const steps: any[] = []
  const obtained: any[] = []
  const executor: any = {
    memory,
    tasks: { tick: 100 },
    farmCost: () => 0,
    plan: () => ({ ok: true, cost: 100 }),
    obtain: async (reqs: any[]) => { obtained.push(...reqs) },
    runStep: async (step: any) => { steps.push(step); bot.inventory.slots[20] = item('wheat', 9); return { gained: 9 } },
    task: async () => {}
  }
  const lines: string[] = []
  await keepFarm(bot, executor, new AbortController().signal, l => lines.push(l))
  // (a stone world: no ground for a hole) the start tried
  assert.ok(lines.some(l => /no farm yet/.test(l)), lines.join(' | '))
  const tried = lines.length
  executor.tasks.tick += FARM_RETRY_TICKS - 1
  await keepFarm(bot, executor, new AbortController().signal, l => lines.push(l))
  assert.equal(lines.length, tried)
  executor.tasks.tick += 1
  await keepFarm(bot, executor, new AbortController().signal, l => lines.push(l))
  assert.ok(lines.length > tried)
  // a farm sown and grown: harvested, its wheat (beyond the herd's 6) baked
  rememberFarm(memory, { water: new Vec3(10, 63, 10), cells: [new Vec3(11, 63, 10)], crop: 'wheat' }, 0)
  await keepFarm(bot, executor, new AbortController().signal, () => {})
  assert.equal(steps.length, 1)
  assert.equal(steps[0].kind, 'farm')
  assert.ok(obtained.some(r => r.item === 'bread' && r.count === 1), JSON.stringify(obtained))
})

test('growingLeft and the farm\'s cost: what is left of the growing read off its crops\' ages when its chunks are loaded, not the sowing\'s age (f5-1.21.11: a farm sown 65000 ticks before, not grown, gone to for a starving meal)', async () => {
  const { growingLeft } = await import('../../src/skills/farm')
  const { Executor } = await import('../../src/executor/executor')
  const { GROW_TICKS } = await import('../../src/core/crops')
  const cells = [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0), new Vec3(3, 63, 0)]
  const ages = [7, 3, 2, 1]
  const lookup = (p: Vec3): any => {
    const i = cells.findIndex(c => c.x === p.x && c.z === p.z)
    if (i >= 0 && p.y === 64) return ages[i] < 0 ? { name: 'air' } : { name: 'wheat', getProperties: () => ({ age: ages[i]! }) }
    return { name: p.y === 63 ? 'farmland' : 'air' }
  }
  // the plot at the middle by age, 3: 4 stages left
  assert.equal(growingLeft(lookup, cells, 'wheat'), Math.round(4 * GROW_TICKS / 7))
  // a chunk not loaded: not known
  assert.equal(growingLeft(() => null, cells, 'wheat'), null)
  // the farm's cost: sown long ago, but its crops young
  const memory = new WorldMemory()
  rememberFarm(memory, { water: new Vec3(0, 63, 1), cells, crop: 'wheat' }, 0)
  const self: any = { memory, bot: { entity: { position: new Vec3(0, 64, 1) }, game: { dimension: 'overworld' }, time: { age: 100000 }, blockAt: lookup } }
  const cost = Executor.prototype.farmCost.call(self, 'wheat') as number
  assert.ok(cost >= Math.round(4 * GROW_TICKS / 7), String(cost))
  // half grown: the walk
  ages.splice(0, 4, 7, 7, 2, 1)
  assert.ok((Executor.prototype.farmCost.call(self, 'wheat') as number) < 10)
  // out of the loaded chunks: by the sowing's age (grown by now)
  self.bot.blockAt = () => null
  assert.ok((Executor.prototype.farmCost.call(self, 'wheat') as number) < 10)
})

test('farmCensus: the crops by age, the bare plots, the ones trampled to dirt, the least light', async () => {
  const { farmCensus } = await import('../../src/skills/farm')
  const cells = [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0), new Vec3(3, 63, 0), new Vec3(4, 63, 0)]
  const lookup = (p: Vec3): any => {
    if (p.y === 63) return { name: p.x === 3 ? 'dirt' : 'farmland' }
    if (p.x === 2) return { name: 'air' }
    return { name: 'wheat', skyLight: p.x === 4 ? 6 : 15, light: 0, getProperties: () => ({ age: p.x === 0 ? 7 : 2 }) }
  }
  assert.equal(farmCensus(lookup, cells, 'wheat'), '1 at age 7, 2 at age 2, 1 bare, 1 no farmland, light 6 at the least')
})
