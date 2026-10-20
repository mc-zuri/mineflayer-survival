import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { UNDERWATER_STEP_COST, keepHeadAboveWater, underwaterStepCost } from '../../src/skills/breath'

test('underwaterStepCost: a flooded tunnel (water at the head, rock over it) and a lake\'s bottom cost more, short of a wall; swimming at the surface and wading stay', () => {
  // a lake from y 60 to 63 (air over it) at x < 0; a flooded tunnel at y 40..41 under rock at x >= 10
  const lookup = (p: Vec3): { name: string } => {
    if (p.x < 0 && p.y >= 60 && p.y <= 63) return { name: 'water' }
    if (p.x >= 10 && (p.y === 40 || p.y === 41)) return { name: 'water' }
    if (p.y >= 64) return { name: 'air' }
    return { name: 'stone' }
  }
  const cost = underwaterStepCost(lookup)
  assert.equal(cost({ position: new Vec3(-5, 60, 0) }), UNDERWATER_STEP_COST) // the lake's bottom
  assert.equal(cost({ position: new Vec3(-5, 62, 0) }), 0) // swimming at the surface: water at the head, air over it
  assert.equal(cost({ position: new Vec3(-5, 63, 0) }), 0) // wading: the head in air
  assert.equal(cost({ position: new Vec3(12, 40, 0) }), UNDERWATER_STEP_COST) // the flooded tunnel
  assert.equal(cost({ position: new Vec3(5, 64, 0) }), 0)
})

test('keepHeadAboveWater adds the cost to the pathfinder\'s step costs once', () => {
  const pf: any = { defaultMoveSettings: { exclusionAreasStep: [] }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  const bot: any = { pathfinder: pf, blockAt: () => null }
  keepHeadAboveWater(bot)
  keepHeadAboveWater(bot)
  assert.equal(pf.defaultMoveSettings.exclusionAreasStep.length, 2)
})

test('underwaterStepCost is dear but no wall: a bot already in a flooded cave still has a way out', async () => {
  const { UNDERWATER_STEP_COST } = await import('../../src/skills/breath')
  assert.ok(UNDERWATER_STEP_COST > 20 && UNDERWATER_STEP_COST < 1e6)
})

test('a spot the drowning reflex took the bot up from is kept off DROWNED_TICKS: the steps with the head in water near it cost DROWNED_STEP_COST, the dry ones nothing; a death forgets it', async () => {
  const { DROWNED_STEP_COST, DROWNED_TICKS, drownedNear, drownedStepCost, noteDrowning } = await import('../../src/skills/breath')
  const bot: any = new (require('node:events').EventEmitter)()
  bot.survival = { tasks: { tick: 1000 } }
  // a pond at y 55 to 58 by x 10 to 14
  const lookup = (p: Vec3): { name: string } => ({ name: p.x >= 10 && p.x <= 14 && p.y >= 55 && p.y <= 58 ? 'water' : p.y > 58 ? 'air' : 'stone' })
  const cost = drownedStepCost(bot, lookup)
  assert.equal(cost({ position: new Vec3(11, 56, 0) }), 0)
  noteDrowning(bot, new Vec3(11.5, 56.5, 0.5))
  assert.equal(drownedNear(bot, new Vec3(18, 56, 0)), true)
  assert.equal(drownedNear(bot, new Vec3(30, 56, 0)), false)
  assert.equal(cost({ position: new Vec3(13, 56, 0) }), DROWNED_STEP_COST)
  // dry ground by the pond, and swimming with the head over the water: no more
  assert.equal(cost({ position: new Vec3(16, 59, 0) }), 0)
  assert.equal(cost({ position: new Vec3(12, 58, 0) }), 0)
  bot.survival.tasks.tick += DROWNED_TICKS + 1
  assert.equal(cost({ position: new Vec3(13, 56, 0) }), 0)
  // (a death forgets them)
  const { clearDrownings } = await import('../../src/skills/breath')
  noteDrowning(bot, new Vec3(11.5, 56.5, 0.5))
  clearDrownings(bot)
  assert.equal(drownedNear(bot, new Vec3(11, 56, 0)), false)
})
