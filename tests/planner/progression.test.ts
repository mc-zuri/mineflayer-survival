import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import type { RegistryLike } from '../../src/core/registry'
import { Inventory } from '../../src/core/inventory'
import { WorldMemory } from '../../src/core/memory'
import { checkPlan } from '../../src/planner/steps'
import { MILESTONES, milestone, nextMilestone, planMilestone, toolsAtLeast, eyesAvailable, type ProgressState } from '../../src/planner/progression'

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
