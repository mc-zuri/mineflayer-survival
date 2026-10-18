import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { noteVillage, villageAt } from '../../src/skills/village'
import { isHostile } from '../../src/reflexes/rules'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

test('a village is its bell, or villagers among dirt paths or farmland; a trader or a path alone is none', () => {
  const none = { bell: null, villagers: [], hints: {} }
  assert.equal(villageAt(none), null)
  assert.ok(villageAt({ ...none, bell: new Vec3(1, 70, 2) })?.equals(new Vec3(1, 70, 2)))
  assert.ok(villageAt({ ...none, villagers: [new Vec3(5, 64, 5)], hints: { dirt_path: 10 } }) != null)
  assert.ok(villageAt({ ...none, villagers: [new Vec3(5, 64, 5)], hints: { farmland: 6 } }) != null)
  assert.equal(villageAt({ ...none, villagers: [new Vec3(5, 64, 5)], hints: { dirt_path: 2 } }), null)
  assert.equal(villageAt({ ...none, hints: { dirt_path: 20, farmland: 20, composter: 1 } }), null)
})

test('a village seen is noted once, with its crops remembered; villagers and golems are never fought', () => {
  const bell = new Vec3(30, 70, 30)
  const bot: any = {
    registry,
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0) },
    entities: {},
    findBlock: ({ matching }: any) => matching === registry.blocksByName.bell.id ? { position: bell } : null,
    findBlocks: () => []
  }
  const memory = new WorldMemory()
  const remembered: string[][] = []
  assert.ok(noteVillage(bot, memory, names => remembered.push([...names]))?.equals(bell))
  assert.equal(memory.getPois('village').length, 1)
  assert.deepEqual(remembered[0], ['carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block'])
  // seen again: the same village
  noteVillage(bot, memory, () => {})
  assert.equal(memory.getPois('village').length, 1)
  for (const name of ['villager', 'iron_golem', 'wandering_trader']) assert.equal(isHostile(bot, { name } as any), false, name)
})
