// A nutrition request cooks the raw food held first, then gets the rest from the cheapest one source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { obtainAll } from '../../src/planner/obtain'
import { FOOD_GOAL } from '../../src/planner/progression'
import { VERSIONS } from '../versions'

/* eslint-disable @typescript-eslint/no-var-requires */
const registryOf = (v: string): any => require('minecraft-data')(v)

for (const version of VERSIONS) {
  test(`${version}: 3 raw rabbits held for 20 food points: the rabbits cooked, the 5 points left from one source (snowFood: 10 berries planned for all 20)`, () => {
    const registry = registryOf(version)
    const kit = { crafting_table: 1, stone_pickaxe: 1, iron_sword: 1, furnace: 1, coal: 8, rabbit: 3 }
    const plan = obtainAll(registry, [{ item: FOOD_GOAL, count: 20, unit: 'nutrition' }], { inventory: kit })
    assert.ok(plan.ok)
    const smelt = plan.steps.find(s => s.kind === 'smelt' && s.item === 'cooked_rabbit')
    assert.ok(smelt != null && smelt.count === 3, plan.steps.map(s => `${s.kind} ${s.count} ${s.item}`).join(', '))
    // the cooked rabbit's 15 points counted: what else the plan gets makes up 5, not 20
    const rest = plan.steps.filter(s => s.kind !== 'smelt' || s.item !== 'cooked_rabbit')
    const points = rest.filter(s => FOOD_GOAL.includes(s.item)).reduce((n, s) => n + s.count * (registry.foodsByName[s.item]?.foodPoints ?? 0), 0)
    assert.ok(points >= 5 && points < 15, `${points} points more: ${rest.map(s => `${s.kind} ${s.count} ${s.item}`).join(', ')}`)
  })

  test(`${version}: more raw meat held than the points want: only what makes them up is cooked`, () => {
    const registry = registryOf(version)
    const plan = obtainAll(registry, [{ item: FOOD_GOAL, count: 16, unit: 'nutrition' }], { inventory: { furnace: 1, coal: 8, beef: 6 } })
    assert.deepEqual(plan.steps.map(s => `${s.kind} ${s.count} ${s.item}`), ['smelt 2 cooked_beef'])
  })
}

test('the held raw food cooked with the coal, the sticks left for the fishing rod (snowFood: the sticks burnt, the rod\'s wood explored for on a field with no tree)', () => {
  const registry = registryOf('26.3')
  const kit = { crafting_table: 1, stone_pickaxe: 1, iron_sword: 1, furnace: 1, coal: 16, stick: 6, string: 2, rabbit: 3 }
  const plan = obtainAll(registry, [{ item: FOOD_GOAL, count: 20, unit: 'nutrition' }], { inventory: kit, exclude: ['kill', 'mine', 'farm'] })
  const smelt = plan.steps.find(s => s.kind === 'smelt' && s.item === 'cooked_rabbit') as any
  assert.ok(smelt != null, plan.steps.map(s => `${s.kind} ${s.item}`).join(', '))
  assert.ok(smelt.fuel.every((f: any) => f.name === 'coal'), JSON.stringify(smelt.fuel))
  assert.ok(plan.steps.some(s => s.kind === 'fish'), plan.steps.map(s => `${s.kind} ${s.item}`).join(', '))
})
