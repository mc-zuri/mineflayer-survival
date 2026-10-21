// A trident drowned's zone kept off by the work's paths (skills/tridentZone).
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { TRIDENT_ZONE_COST, TRIDENT_ZONE_RANGE, TRIDENT_ZONE_TICKS, inTridentZone, keepOffTridentZones, noteTridentDrowned, tridentZoneStepCost } from '../../src/skills/tridentZone'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

test('a trident drowned in the water: the cells it sees within TRIDENT_ZONE_RANGE cost TRIDENT_ZONE_COST a step, none behind a wall or out of range, and the zone kept TRIDENT_ZONE_TICKS after it was last seen (f6-26.3, t232374: the work walked the bot back into its reach)', () => {
  // the sea east of x 3 (water y 58 to 63), a stone wall at x -6 on the shore
  const world = (p: Vec3): string => p.x >= 3 ? (p.y <= 63 && p.y >= 58 ? 'water' : p.y < 58 ? 'stone' : 'air') : (p.y < 64 ? 'stone' : (p.x === -6 && p.y <= 70) ? 'stone' : 'air')
  const drowned = entity({ name: 'drowned', position: new Vec3(8.5, 62, 0.5) })
  drowned.heldItem = item('trident')
  const bot = fakeBot({ entities: [drowned], world })
  noteTridentDrowned(bot, 0)
  const cost = tridentZoneStepCost(bot)
  assert.strictEqual(cost({ position: new Vec3(0, 64, 0) }), TRIDENT_ZONE_COST)
  assert.strictEqual(inTridentZone(bot, new Vec3(-4, 64, 0)), true)
  // behind the wall, or past the range: none
  assert.strictEqual(inTridentZone(bot, new Vec3(-8, 64, 0)), false)
  assert.strictEqual(inTridentZone(bot, new Vec3(0, 64, TRIDENT_ZONE_RANGE + 4)), false)
  // a drowned with no trident, or one on dry land: no zone
  const plain = fakeBot({ entities: [entity({ name: 'drowned', position: new Vec3(8.5, 62, 0.5) })], world })
  noteTridentDrowned(plain, 0)
  assert.strictEqual(inTridentZone(plain, new Vec3(0, 64, 0)), false)
  // out of sight (sunk, gone from the entities): kept TRIDENT_ZONE_TICKS, then forgotten
  delete bot.entities[drowned.id]
  noteTridentDrowned(bot, TRIDENT_ZONE_TICKS - 10)
  assert.strictEqual(inTridentZone(bot, new Vec3(0, 64, 0)), true)
  noteTridentDrowned(bot, TRIDENT_ZONE_TICKS + 10)
  assert.strictEqual(inTridentZone(bot, new Vec3(0, 64, 0)), false)
})

test('keepOffTridentZones puts the zone\'s step cost in the pathfinder\'s step rules, once', () => {
  const bot = fakeBot()
  let settings: any = { exclusionAreasStep: [] }
  bot.pathfinder = { get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  keepOffTridentZones(bot)
  keepOffTridentZones(bot)
  assert.strictEqual(settings.exclusionAreasStep.filter((f: any) => f.survivalTridents === true).length, 1)
})
