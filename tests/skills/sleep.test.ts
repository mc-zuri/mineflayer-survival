import { test } from 'node:test'
import assert from 'node:assert'
import { bedOccupied, canSleepNow, stateProperty } from '../../src/skills/sleep'
import { isBed } from '../../src/core/items'
import { defaultKeep } from '../../src/executor/keep'

test('isBed: every colour of bed, not the straw bed of 26.3 (no spawn, gone once slept in)', () => {
  assert.ok(isBed('white_bed'))
  assert.ok(isBed('light_blue_bed'))
  assert.ok(!isBed('straw_bed'))
  assert.ok(!isBed('bedrock'))
  assert.strictEqual(defaultKeep('red_bed'), 1)
  assert.notStrictEqual(defaultKeep('straw_bed'), 1)
})

test('canSleepNow: at night (12541 to 23458) or in a thunderstorm', () => {
  assert.strictEqual(canSleepNow(1000, false), false)
  assert.strictEqual(canSleepNow(12540, false), false)
  assert.strictEqual(canSleepNow(12541, false), true)
  assert.strictEqual(canSleepNow(18000, false), true)
  assert.strictEqual(canSleepNow(23459, false), false)
  assert.strictEqual(canSleepNow(6000, true), true)
})

test('bedOccupied: BedBlock.OCCUPIED from the state id (1.21.11 white_bed: facing, occupied, part)', () => {
  const registry = require('minecraft-data')('1.21.11')
  const bot = { registry } as any
  const bed = registry.blocksByName.white_bed
  // facing north, occupied true, part head: the first state
  assert.strictEqual(bedOccupied(bot, { stateId: bed.minStateId }), true)
  assert.strictEqual(stateProperty(bot, bed.minStateId, 'part'), 'head')
  assert.strictEqual(bedOccupied(bot, { stateId: bed.minStateId + 2 }), false)
  assert.strictEqual(stateProperty(bot, bed.minStateId + 2 + 1, 'part'), 'foot')
  assert.strictEqual(stateProperty(bot, bed.minStateId + 3 * 4, 'facing'), 'east')
  // the default state (BedBlock: occupied false, part foot)
  assert.strictEqual(bedOccupied(bot, { stateId: bed.defaultState }), false)
})
