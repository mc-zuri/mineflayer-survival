import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { Inventory } from '../../src/core/inventory'
import { obtainAll } from '../../src/planner/obtain'
import { carriesWeapon, comeUp, dayPhase, nightAction, nightGeared, nightGoals, IRON_FOR_MILESTONE, TORCH_BUDGET } from '../../src/planner/schedule'

const registry: any = minecraftData('1.21.11')
const inv = (items: Record<string, number>): Inventory => new Inventory(registry, items)

test('the day\'s phases: day, dusk from 11500 (time to dig down), night from 12542 (a bed works) to 23460', () => {
  assert.equal(dayPhase(0), 'day')
  assert.equal(dayPhase(6000), 'day')
  assert.equal(dayPhase(11500), 'dusk')
  assert.equal(dayPhase(12541), 'dusk')
  assert.equal(dayPhase(12542), 'night')
  assert.equal(dayPhase(18000), 'night')
  assert.equal(dayPhase(23459), 'night')
  assert.equal(dayPhase(23460), 'day')
  assert.equal(dayPhase(24000 + 13000), 'night')
})

test('dusk means down the mine with a pickaxe; a bed skips the night; no pickaxe, the shelter', () => {
  const base = { overworld: true, bed: false, pickaxe: 'stone_pickaxe', goals: true }
  assert.equal(nightAction({ ...base, phase: 'day' }), 'work')
  assert.equal(nightAction({ ...base, phase: 'dusk' }), 'mine')
  assert.equal(nightAction({ ...base, phase: 'night' }), 'mine')
  // a bed: the work goes on until the bed works, then sleep
  assert.equal(nightAction({ ...base, bed: true, phase: 'dusk' }), 'work')
  assert.equal(nightAction({ ...base, bed: true, phase: 'night' }), 'sleep')
  // nothing to dig with, or nothing to mine: the shelter at night (the reflex's), the work till then
  assert.equal(nightAction({ ...base, pickaxe: null, phase: 'dusk' }), 'work')
  assert.equal(nightAction({ ...base, pickaxe: null, phase: 'night' }), 'shelter')
  assert.equal(nightAction({ ...base, goals: false, phase: 'night' }), 'shelter')
  // the nether and the End have no night
  assert.equal(nightAction({ ...base, overworld: false, phase: 'night' }), 'work')
})

test('a bot without the weapon and armor its progress had isn\'t sent down the mine at night: the shelter, the work at dusk (nightGeared)', () => {
  const base = { overworld: true, bed: false, pickaxe: 'stone_pickaxe', goals: true }
  assert.equal(nightAction({ ...base, phase: 'night', geared: false }), 'shelter')
  assert.equal(nightAction({ ...base, phase: 'dusk', geared: false }), 'work')
  assert.equal(nightAction({ ...base, phase: 'night', geared: true }), 'mine')
  // a bed sleeps the night all the same
  assert.equal(nightAction({ ...base, bed: true, phase: 'night', geared: false }), 'sleep')
  // a weapon from the stone milestone on, some armor from the iron one on (a bare bot back from a death)
  const bare = { weapon: false, armor: 0 }
  assert.equal(nightGeared(['wood'], bare), true)
  assert.equal(nightGeared(['wood', 'stone', 'food', 'base'], bare), false)
  assert.equal(nightGeared(['wood', 'stone', 'food', 'base'], { weapon: true, armor: 0 }), true)
  const iron = ['wood', 'stone', 'food', 'base', 'iron'] as const
  assert.equal(nightGeared(iron, { weapon: true, armor: 0 }), false)
  assert.equal(nightGeared(iron, { weapon: false, armor: 6 }), false)
  assert.equal(nightGeared(iron, { weapon: true, armor: 1 }), true)
  // a pickaxe's hit is no weapon
  assert.equal(carriesWeapon(['iron_pickaxe', 'dirt']), false)
  assert.equal(carriesWeapon(['stone_sword']), true)
  assert.equal(carriesWeapon(['iron_axe']), true)
})

test('the night\'s goals: torches first (coal means torches), then the iron, then the diamonds', () => {
  // a wooden pickaxe: coal for the torches, and a stone pickaxe from the stone down there
  const wooden = nightGoals(inv({ wooden_pickaxe: 1, oak_planks: 8 }), ['wood'])
  assert.deepEqual(wooden.map(g => g.item), ['torch', ['stone_pickaxe', 'copper_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].filter(n => registry.itemsByName[n] != null), 'coal'])
  assert.equal(wooden[0].count, TORCH_BUDGET)
  // a stone pickaxe and torches: the iron the milestone needs, less what's held
  // (a shield first, from the first ore: the caves' skeletons)
  const stone = nightGoals(inv({ stone_pickaxe: 1, torch: 20, iron_ingot: 3, raw_iron: 2 }), ['wood', 'stone', 'food'])
  // (and coal for smelting it: a coal is 8 items)
  assert.deepEqual(stone, [{ item: 'shield', count: 1, optional: true }, { item: 'coal', count: 4, optional: true }, { item: 'raw_iron', count: 2 + IRON_FOR_MILESTONE - 5, optional: true }])
  assert.deepEqual(nightGoals(inv({ stone_pickaxe: 1, torch: 20, shield: 1, coal: 5 }), ['wood', 'stone', 'food']).map(g => g.item), ['raw_iron'])
  // the iron reached: the diamonds
  const iron = nightGoals(inv({ iron_pickaxe: 1, torch: 20 }), ['wood', 'stone', 'food', 'iron'])
  assert.deepEqual(iron.map(g => g.item), ['diamond'])
  // all the iron held: nothing more down there for it
  assert.deepEqual(nightGoals(inv({ stone_pickaxe: 1, torch: 20, iron_ingot: 40, shield: 1 }), ['wood', 'stone', 'food']), [])
})

test('the mine is left when the day is back, or when hungry with little left to eat', () => {
  assert.equal(comeUp('night', 30), false)
  assert.equal(comeUp('dusk', 30), false)
  assert.equal(comeUp('day', 30), true)
  // a full bar mines on without food; a hungry bot with food eats it down there
  assert.equal(comeUp('night', 4, 20), false)
  assert.equal(comeUp('night', 30, 5), false)
  assert.equal(comeUp('night', 4, 5), true)
})

test('a night\'s plan has only what a mine has: torches from coal ore and the sticks held, no logs or animals', () => {
  const held = { stone_pickaxe: 1, stick: 4, crafting_table: 1 }
  const plan = obtainAll(registry, [{ item: 'torch', count: 16 }], { inventory: held, undergroundOnly: true })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.steps.map(s => `${s.kind} ${s.item}`), ['mine coal', 'craft torch'])
  // no sticks or wood held: no torches tonight (the logs are the day's)
  assert.equal(obtainAll(registry, [{ item: 'torch', count: 16 }], { inventory: { stone_pickaxe: 1 }, undergroundOnly: true }).ok, false)
  assert.ok(obtainAll(registry, [{ item: 'torch', count: 16 }], { inventory: { stone_pickaxe: 1 } }).steps.some(s => s.kind === 'mine' && s.item.endsWith('_log')))
  // food: nothing to hunt down there
  assert.equal(obtainAll(registry, [{ item: 'cooked_beef', count: 4 }], { inventory: { stone_pickaxe: 1, furnace: 1, coal: 4 }, undergroundOnly: true }).ok, false)
})

test('the stock\'s top-ups: the surface\'s by day and dusk up there, the mine\'s at night or deep down by day', async () => {
  const { topUpPlaces } = await import('../../src/planner/schedule')
  assert.deepEqual(topUpPlaces('day', false), ['surface'])
  assert.deepEqual(topUpPlaces('dusk', false), ['surface'])
  assert.deepEqual(topUpPlaces('night', false), ['underground'])
  assert.deepEqual(topUpPlaces('day', true), ['underground'])
})
