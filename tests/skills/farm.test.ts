import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { cropOf, findFarmSite, grownPlots, knownFarms, rememberFarm, farmCells, SEED_OF } from '../../src/skills/farm'
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

test('a farm site: the water, and a row of tillable cells beside it, open above, at most 8', () => {
  const water = [new Vec3(10, 63, 10)]
  const site = findFarmSite(world(water), new Vec3(0, 64, 0), 24)
  assert.ok(site != null)
  assert.ok(site.water.equals(water[0]))
  assert.equal(site.cells.length, 8)
  for (const c of site.cells) {
    assert.equal(c.y, 63)
    // in reach of the water for FarmBlock.isNearWater
    assert.ok(Math.max(Math.abs(c.x - 10), Math.abs(c.z - 10)) <= 4)
    assert.ok(!c.equals(water[0]))
  }
  // a stone floor round the water: nothing to till
  const stone: Record<string, string> = {}
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) stone[`${10 + dx},63,${10 + dz}`] = 'stone'
  delete stone['10,63,10']
  assert.equal(findFarmSite(world(water, [], stone), new Vec3(10, 64, 10), 6), null)
  // no water: none
  assert.equal(findFarmSite(world([]), new Vec3(0, 64, 0), 8), null)
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
