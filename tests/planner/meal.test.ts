// A hungry bot's meal: when it is due, what counts (the raw meat safe raw, rotten flesh when starving), and the plan
// for it going for what's in sight over a cow somewhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { obtainAll } from '../../src/planner/obtain'
import { Sightings } from '../../src/executor/sight'

/* eslint-disable @typescript-eslint/no-var-requires */
const registryOf = (v: string): any => require('minecraft-data')(v)

const kit = { crafting_table: 1, stone_pickaxe: 1, iron_sword: 1, furnace: 1, coal: 16 }

test('mealGoals: a meal of 12 points when hungry and short of food, raw safe meat counted; rotten flesh at half only when starving', async () => {
  const { mealGoals, MEAL_POINTS } = await import('../../src/planner/progression')
  const { Inventory } = await import('../../src/core/inventory')
  const { heldFor } = await import('../../src/planner/obtain')
  const registry = registryOf('1.21.11')
  const inv = (items: Record<string, number>): any => new Inventory(registry, items)
  assert.equal(mealGoals(13, inv({})), null)
  const meal = mealGoals(12, inv({}))
  assert.ok(meal != null && meal[0].count === MEAL_POINTS)
  // 4 raw rabbits (3 each): fed
  assert.equal(mealGoals(10, inv({ rabbit: 4 })), null)
  assert.ok(mealGoals(10, inv({ rotten_flesh: 8 })) != null)
  const starving = mealGoals(4, inv({ rotten_flesh: 2 }))
  assert.ok(starving != null && starving[0].harmful === true)
  assert.equal(heldFor(inv({ rotten_flesh: 2 }), ['rotten_flesh'], starving[0]), 4)
  assert.equal(mealGoals(4, inv({ rotten_flesh: 6 })), null)
})

test('a hungry meal (unseenFactor) goes for the rabbits in sight or the water to fish over a cow somewhere', () => {
  const registry = registryOf('1.21.11')
  const bot: any = { registry, game: { dimension: 'overworld' }, entity: { id: 0, position: new Vec3(0, 64, 0) } }
  bot.entities = { 0: bot.entity, 1: { id: 1, name: 'rabbit', position: new Vec3(8, 64, 0), metadata: [] } }
  const s = new Sightings(bot, () => 0)
  const meal = [{ item: ['cooked_beef', 'beef', 'cooked_rabbit', 'rabbit', 'cooked_cod', 'cod'], count: 12, unit: 'nutrition' as const }]
  const mobs = (o: any): string[] => obtainAll(registry, meal, { inventory: kit, findCost: t => s.cost(t), ...o }).steps.filter(st => st.kind === 'kill').map(st => (st as any).mob)
  assert.deepEqual(mobs({}), ['cow'])
  assert.deepEqual(mobs({ unseenFactor: 8 }), ['rabbit'])
})
