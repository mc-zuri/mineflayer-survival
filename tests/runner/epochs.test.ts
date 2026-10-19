import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { TaskError } from '../../src/core/errors'
import { WorldMemory } from '../../src/core/memory'
import { Inventory } from '../../src/core/inventory'
import { Runner, type MilestoneHandler } from '../../src/runner'
import { MILESTONES, type MilestoneId, type ProgressState } from '../../src/planner/progression'
import { EPOCHS, FARM_EPOCH_PLOTS, isEpoch, nextEpoch, unmendedKinds } from '../../src/epochs'
import { extendFarm, farmPlots } from '../../src/skills/farm'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

function fakeBot (): any {
  const bot: any = new EventEmitter()
  bot.registry = registry
  bot.inventory = { slots: new Array(46).fill(null), inventoryStart: 9, inventoryEnd: 45, items: () => [] }
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.time = { timeOfDay: 1000 }
  bot.isRaining = false
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot), handlers: {}, advancements: new Set() }
  return bot
}

const state = (memory: WorldMemory, items: Record<string, number> = {}, mended: string[] = [], equipment: string[] = []): ProgressState =>
  ({ inventory: new Inventory(registry, items), memory, equipment, mended })

test('the epochs: the farm, then the experience farm once a zombie spawner is known, then mending', () => {
  assert.deepEqual(EPOCHS.map(e => e.id), ['farm', 'xp_farm', 'mending'])
  assert.ok(isEpoch('mending') && !isEpoch('end'))
  const memory = new WorldMemory()
  const s = state(memory, { diamond_pickaxe: 1, diamond_sword: 1 }, [], ['diamond_chestplate'])
  assert.equal(nextEpoch(s, [])?.id, 'farm')
  // no spawner known: the experience farm waits, mending is next
  assert.equal(nextEpoch(s, ['farm'])?.id, 'mending')
  memory.addPoi('spawner', new Vec3(5, 20, 5), 'overworld', 'skeleton')
  assert.equal(nextEpoch(s, ['farm'])?.id, 'mending')
  memory.addPoi('spawner', new Vec3(9, 20, 5), 'overworld', 'zombie')
  assert.equal(nextEpoch(s, ['farm'])?.id, 'xp_farm')
  memory.addPoi('xp_farm', new Vec3(9, 20, 5), 'overworld', '{}')
  assert.equal(nextEpoch(s, ['farm'])?.id, 'mending')
  assert.equal(nextEpoch(s, ['farm', 'mending']), null)
})

test('the farm epoch is done with its plots sown; one water\'s farm grows in one record', () => {
  const memory = new WorldMemory()
  const farm = EPOCHS.find(e => e.id === 'farm')
  assert.ok(farm != null)
  const water = new Vec3(10, 63, 10)
  const cells = (n: number, z: number): Vec3[] => Array.from({ length: n }, (_, i) => new Vec3(8 + i, 63, z))
  extendFarm(memory, { water, cells: cells(5, 9), crop: 'wheat' }, 100)
  extendFarm(memory, { water, cells: [...cells(5, 9), ...cells(5, 11)], crop: 'wheat' }, 200)
  assert.equal(memory.getPois('farm').length, 1)
  assert.equal(farmPlots(memory), 10)
  assert.equal(farm.done(state(memory)), false)
  extendFarm(memory, { water: new Vec3(30, 63, 10), cells: Array.from({ length: FARM_EPOCH_PLOTS - 10 }, (_, i) => new Vec3(28 + (i % 5), 63, 9 + 2 * Math.floor(i / 5))), crop: 'wheat' }, 300)
  assert.equal(farmPlots(memory), FARM_EPOCH_PLOTS)
  assert.equal(farm.done(state(memory)), true)
})

test('mending: the pickaxe, the sword and the chestplate owned, worn or carried, each mended', () => {
  const memory = new WorldMemory()
  assert.deepEqual(unmendedKinds(state(memory, { diamond_pickaxe: 1, iron_sword: 1 }, [], ['diamond_chestplate'])), ['pickaxe', 'sword', 'chestplate'])
  assert.deepEqual(unmendedKinds(state(memory, { diamond_pickaxe: 1, iron_sword: 1 }, ['diamond_pickaxe'], ['diamond_chestplate'])), ['sword', 'chestplate'])
  // no chestplate at all: nothing to mend there
  assert.deepEqual(unmendedKinds(state(memory, { diamond_pickaxe: 1, iron_sword: 1 }, ['diamond_pickaxe', 'iron_sword'])), [])
  const mending = EPOCHS.find(e => e.id === 'mending')
  assert.equal(mending?.done(state(memory, { diamond_pickaxe: 1 }, ['diamond_pickaxe'])), true)
  // the gear lost (a death): not done, nothing to mend is no mending
  assert.equal(mending?.done(state(memory, {})), false)
})

test('play goes on to the epochs after the dragon only when asked, and an epoch that keeps failing is left out', async () => {
  const all = MILESTONES.map(m => m.id) as MilestoneId[]
  // the game finished (every milestone skipped as done): play ends there without epochs
  const worked: string[] = []
  const handlers: Partial<Record<MilestoneId, MilestoneHandler>> = {
    farm: async () => { worked.push('farm'); throw new TaskError('NOT_FOUND', 'no water') },
    mending: async ({ bot }) => { worked.push('mending'); (bot as any).mended = true }
  }
  const plain = await new Runner(fakeBot(), { skip: all, handlers, log: () => {} }).play()
  assert.equal(plain.reason, 'finished')
  assert.deepEqual(worked, [])
  // with them: the farm fails five times and is left out, the experience farm waits for a spawner, mending is done
  const bot = fakeBot()
  bot.inventory.slots[36] = { name: 'diamond_pickaxe', count: 1, type: registry.itemsByName.diamond_pickaxe.id, slot: 36 }
  bot.inventory.items = () => [bot.inventory.slots[36]].map((i: any) => bot.mended === true ? { ...i, enchants: [{ name: 'mending', lvl: 1 }] } : i)
  const result = await new Runner(bot, { skip: all, handlers, epochs: true, log: () => {} }).play()
  assert.equal(result.reason, 'finished')
  assert.deepEqual(worked, ['farm', 'farm', 'farm', 'farm', 'farm', 'mending'])
  assert.deepEqual(result.reached.map(r => r.id), ['mending'])
})
