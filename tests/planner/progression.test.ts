import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import type { RegistryLike } from '../../src/core/registry'
import { Inventory } from '../../src/core/inventory'
import { WorldMemory } from '../../src/core/memory'
import { checkPlan } from '../../src/planner/steps'
import { SPARE_LOGS, FOOD_GOAL, FOOD_POINTS, MILESTONES, RAW_TO_COOKED, foodGoals, milestone, nextMilestone, planMilestone, toolsAtLeast, eyesAvailable, type ProgressState } from '../../src/planner/progression'
import { heldFor, unitValue } from '../../src/planner/obtain'
import { isGrown } from '../../src/core/crops'

const registry: RegistryLike = minecraftData('1.21.11')

function state (items: Record<string, number> = {}, extra: Partial<ProgressState> = {}): ProgressState {
  return { inventory: new Inventory(registry, items), memory: new WorldMemory(), ...extra }
}

test('the milestones come in the order of the plan', () => {
  assert.deepEqual(MILESTONES.map(m => m.id), ['wood', 'stone', 'food', 'base', 'iron', 'diamonds', 'enchanting', 'nether', 'eyes', 'end'])
})

test('a fresh spawn starts at wood, and its plan makes a table and a wooden pickaxe', () => {
  const s = state()
  assert.equal(nextMilestone(s)?.id, 'wood')
  const plan = planMilestone(registry, milestone('wood'), s)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.steps.map(st => `${st.kind} ${st.item}`), ['mine oak_log', 'craft oak_planks', 'craft crafting_table', 'craft stick', 'craft wooden_pickaxe'])
  assert.equal(milestone('wood').done({ ...s, inventory: plan.inventory }), true)
  // and logs to spare for the night down the mine
  assert.equal(plan.inventory.count('oak_log'), SPARE_LOGS)
})

test('stone: stone tools from mined cobblestone and the sticks held, and a furnace', () => {
  const s = state({ crafting_table: 1, wooden_pickaxe: 1, stick: 6 })
  assert.equal(nextMilestone(s)?.id, 'stone')
  const plan = planMilestone(registry, milestone('stone'), s)
  assert.equal(plan.ok, true)
  assert.equal(checkPlan(registry, plan.steps, s.inventory).ok, true)
  assert.deepEqual(plan.steps.map(st => `${st.kind} ${st.item} ${st.count}`), [
    'mine cobblestone 16', 'craft stone_pickaxe 1', 'craft stone_sword 1', 'craft stone_axe 1', 'craft furnace 1'
  ])
  assert.equal(milestone('stone').done({ ...s, inventory: plan.inventory }), true)
  // a furnace at the base counts
  assert.equal(planMilestone(registry, milestone('stone'), { ...s, stations: ['furnace'] }).steps.some(st => st.item === 'furnace'), false)
})

test('food: hunt and cook until there are 40 food points', () => {
  const s = state({ crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, oak_log: 4 })
  assert.equal(nextMilestone(s)?.id, 'food')
  const plan = planMilestone(registry, milestone('food'), s)
  assert.equal(plan.ok, true)
  assert.ok(plan.steps.some(st => st.kind === 'kill'))
  assert.ok(plan.steps.some(st => st.kind === 'smelt'))
  assert.equal(plan.steps.find(st => st.kind === 'kill' && st.weapon != null)?.kind, 'kill')
  assert.equal(milestone('food').done({ ...s, inventory: plan.inventory }), true)
})

test('food counts its points from any food: the raw meat held is cooked first, berries, melons or crops when near', () => {
  const kit = { crafting_table: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1 }
  const points = (inv: Inventory): number => heldFor(inv, FOOD_GOAL, { unit: 'nutrition' })
  assert.equal(unitValue({ unit: 'nutrition' }, 'cooked_beef', registry), 8)
  assert.equal(unitValue({ unit: 'nutrition' }, 'chicken', registry), 0) // raw chicken poisons
  assert.equal(unitValue({}, 'cooked_beef', registry), 1)
  assert.equal(RAW_TO_COOKED.rabbit, 'cooked_rabbit')
  assert.equal(RAW_TO_COOKED.potato, 'baked_potato')
  // the 9 rabbits of a snowy taiga (seed 4) are 45 points once cooked: no hunt for cows
  const rabbits = state({ ...kit, rabbit: 9 })
  const cooked = planMilestone(registry, milestone('food'), rabbits)
  assert.equal(cooked.ok, true)
  assert.equal(cooked.steps.some(st => st.kind === 'kill'), false)
  assert.equal(cooked.inventory.count('cooked_rabbit'), 9)
  assert.ok(points(cooked.inventory) >= FOOD_POINTS)
  assert.equal(milestone('food').done({ ...rabbits, inventory: cooked.inventory }), true)
  // a few points held count: 4 cooked beef (32) need one more beef's worth
  const some = planMilestone(registry, milestone('food'), state({ ...kit, cooked_beef: 4 }))
  assert.equal(some.ok, true)
  assert.ok(points(some.inventory) >= FOOD_POINTS)
  assert.ok(some.inventory.count('cooked_beef') <= 6)
  // nothing near: the hunt for cows and their meat cooked
  const fresh = planMilestone(registry, milestone('food'), state(kit))
  assert.ok(fresh.steps.some(st => st.kind === 'kill'))
  assert.ok(points(fresh.inventory) >= FOOD_POINTS)
  // a patch of ripe berry bushes beside the bot (the taiga): 20 berries off the bushes, eaten as they are
  const memory = new WorldMemory()
  for (let i = 0; i < 12; i++) memory.rememberBlock('sweet_berry_bush', { x: i, y: 64, z: 2 })
  const berries = planMilestone(registry, milestone('food'), state(kit, { memory }), { position: { x: 0, y: 64, z: 0 } })
  assert.deepEqual(berries.steps.map(st => `${st.kind} ${st.item}`), ['mine sweet_berries'])
  assert.equal(berries.inventory.count('sweet_berries'), 20)
  // melons of the jungle: 3 to 7 slices a melon, 2 points each
  const jungle = new WorldMemory()
  jungle.rememberBlock('melon', { x: 4, y: 64, z: 0 })
  const melons = planMilestone(registry, milestone('food'), state(kit, { memory: jungle }), { position: { x: 0, y: 64, z: 0 } })
  assert.ok(melons.steps.some(st => st.kind === 'mine' && st.item === 'melon_slice'))
  // a village's carrots
  const village = new WorldMemory()
  village.rememberBlock('carrots', { x: 3, y: 64, z: 0 })
  const carrots = planMilestone(registry, milestone('food'), state(kit, { memory: village }), { position: { x: 0, y: 64, z: 0 } })
  assert.ok(carrots.steps.some(st => st.kind === 'mine' && st.item === 'carrot'))
  // the goals: the raw held cooked first, then the points
  const goals = foodGoals(new Inventory(registry, { beef: 3, cooked_beef: 1, potato: 2 }))
  assert.deepEqual(goals.slice(0, 2), [{ item: 'cooked_beef', count: 4, optional: true }, { item: 'baked_potato', count: 2, optional: true }])
  assert.deepEqual(goals[2], { item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' })
})

test('a berry bush or a crop counts as grown at the age its loot table drops the food at', () => {
  const block = (name: string, age?: number): any => ({ name, getProperties: () => (age == null ? {} : { age }) })
  assert.equal(isGrown(block('sweet_berry_bush', 1)), false)
  assert.equal(isGrown(block('sweet_berry_bush', 2)), true)
  assert.equal(isGrown(block('sweet_berry_bush', 3)), true)
  assert.equal(isGrown(block('wheat', 6)), false)
  assert.equal(isGrown(block('carrots', 7)), true)
  assert.equal(isGrown(block('beetroots', 3)), true)
  assert.equal(isGrown(block('melon')), true)
  assert.equal(isGrown(null), false)
})

test('done predicates read inventory, worn equipment, memory and advancements', () => {
  const gear = { crafting_table: 1, iron_pickaxe: 1, iron_sword: 1, stone_axe: 1, furnace: 1, cooked_beef: 10, shield: 1, water_bucket: 1 }
  const s = state(gear)
  assert.equal(nextMilestone(s)?.id, 'base')
  s.memory.setBase({ x: 0, y: 40, z: 0 })
  assert.equal(nextMilestone(s)?.id, 'iron')
  const worn = { ...s, equipment: ['iron_helmet', 'diamond_chestplate', 'iron_leggings', 'iron_boots'] }
  assert.equal(milestone('iron').done(worn), true)
  // worn armor isn't planned again
  const plan = planMilestone(registry, milestone('iron'), worn)
  assert.deepEqual(plan.steps, [])
  assert.equal(nextMilestone(worn)?.id, 'diamonds')

  assert.equal(milestone('enchanting').done(state()), false)
  const table = state({}, { enchanted: ['diamond_pickaxe'] })
  table.memory.addPoi('enchanting_table', { x: 1, y: 40, z: 1 })
  assert.equal(milestone('enchanting').done(table), true)
  assert.deepEqual(milestone('enchanting').goals(table), [{ item: 'lapis_lazuli', count: 9 }])

  assert.equal(milestone('end').done(state({}, { advancements: ['end/kill_dragon'] })), true)
  assert.deepEqual(toolsAtLeast('pickaxe', 'stone'), ['stone_pickaxe', 'copper_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])
})

test('nether: the rods and pearls still missing for the eyes, and the portal only if none is known', () => {
  const s = state({ blaze_rod: 3, blaze_powder: 2, ender_pearl: 5 })
  assert.equal(eyesAvailable(s), 5)
  assert.deepEqual(milestone('nether').goals(s), [
    { item: 'obsidian', count: 10 },
    { item: 'flint_and_steel', count: 1 },
    { item: 'blaze_rod', count: 6 },
    { item: 'ender_pearl', count: 14 }
  ])
  s.memory.addPoi('nether_portal', { x: 0, y: 70, z: 0 })
  const goals = milestone('nether').goals(s)
  assert.deepEqual(goals.map(g => g.item), ['blaze_rod', 'ender_pearl'])
  const plan = planMilestone(registry, milestone('nether'), s)
  assert.equal(plan.ok, true)
  assert.equal(plan.steps.filter(st => st.kind === 'kill' && st.mob === 'blaze').length, 1)
  assert.equal(milestone('nether').done({ ...s, inventory: plan.inventory }), true)
  assert.equal(milestone('eyes').done({ ...s, inventory: plan.inventory }), false)
})

test('iron: the armor is iron, not diamond, even with a diamond ore seen nearby (one vein is no armor set)', () => {
  const memory = new WorldMemory()
  memory.rememberBlock('deepslate_diamond_ore', { x: 10, y: 50, z: 0 })
  const s = state({ iron_pickaxe: 1, stone_sword: 1, stone_axe: 1, crafting_table: 1, cooked_beef: 8, raw_iron: 11, cobblestone: 20 }, { memory })
  const plan = planMilestone(registry, milestone('iron'), s, { position: { x: 0, y: 60, z: 0 } })
  assert.equal(plan.ok, true)
  assert.ok(!plan.steps.some(st => st.item === 'diamond'), plan.steps.map(st => `${st.kind} ${st.count} ${st.item}`).join(', '))
  assert.ok(plan.steps.some(st => st.item === 'iron_chestplate'))
})

test('diamonds: the pickaxe and sword, and only the armor the diamonds held beyond them pay for', () => {
  const kit = { iron_pickaxe: 1, iron_sword: 1, crafting_table: 1, furnace: 1 }
  const items = (s: ProgressState): string[] => milestone('diamonds').goals(s).map(g => (g.item as string[])[0])
  assert.deepEqual(items(state(kit)), ['diamond_pickaxe', 'diamond_sword'])
  const plan = planMilestone(registry, milestone('diamonds'), state(kit))
  assert.equal(plan.steps.filter(st => st.kind === 'mine' && st.item === 'diamond').reduce((n, st) => n + st.count, 0), 5)
  // 5 for the tools and 4 over: the boots
  assert.deepEqual(items(state({ ...kit, diamond: 9 })), ['diamond_pickaxe', 'diamond_sword', 'diamond_boots'])
  // the tools made, 9 held: the boots and the helmet
  assert.deepEqual(items(state({ ...kit, diamond_pickaxe: 1, diamond_sword: 1, diamond: 9 })), ['diamond_pickaxe', 'diamond_sword', 'diamond_boots', 'diamond_helmet'])
})
