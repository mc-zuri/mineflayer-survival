// The food milestone's handler: hungry with little food carried, a meal first, before the farm's start and the herd's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { foodHandler } from '../../src/milestones'
import { MEAL_POINTS, MILESTONES } from '../../src/planner/progression'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('26.3')

function fakeBot (food: number): any {
  const bot: any = new EventEmitter()
  bot.registry = registry
  bot.food = food
  bot.inventory = { slots: new Array(46).fill(null), inventoryStart: 9, inventoryEnd: 45, items: () => [] }
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.entities = {}
  bot.blockAt = () => null
  return bot
}

for (const food of [4, 16]) {
  test(`the food milestone at food ${food}: ${food <= 12 ? 'a meal first, then' : 'no meal,'} the milestone's goals (hunt2-a: a hoe and grass seeds for 3900 ticks at food 4)`, async () => {
    const bot = fakeBot(food)
    const asked: Array<{ count: number, unit?: string, opts?: any }> = []
    const executor: any = {
      memory: new WorldMemory(),
      obtain: async (reqs: any[], _s: AbortSignal, opts?: any) => { asked.push({ count: reqs[reqs.length - 1].count, unit: reqs[reqs.length - 1].unit, opts }) },
      plan: () => ({ ok: false, steps: [], cost: Infinity, unresolved: [] }),
      task: async (_n: string, fn: (s: AbortSignal) => Promise<unknown>, s: AbortSignal) => await fn(s),
      farmCost: () => undefined
    }
    const milestone = MILESTONES.find(m => m.id === 'food')
    assert.ok(milestone != null)
    await foodHandler({ bot, milestone, state: { inventory: { count: () => 0 } } as any, executor, signal: new AbortController().signal, log: () => {} } as any)
    if (food <= 12) {
      assert.equal(asked[0].count, MEAL_POINTS)
      assert.ok(asked[0].opts?.unseenFactor > 1)
    }
    assert.equal(asked[asked.length - 1].count, 40)
    assert.equal(asked.length, food <= 12 ? 2 : 1)
  })
}
