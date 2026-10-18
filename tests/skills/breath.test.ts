import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { UNDERWATER_STEP_COST, keepHeadAboveWater, underwaterStepCost } from '../../src/skills/breath'

test('underwaterStepCost: a flooded tunnel (water at the head, rock over it) and a lake\'s bottom are kept out of; swimming at the surface and wading stay', () => {
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
  assert.equal(pf.defaultMoveSettings.exclusionAreasStep.length, 1)
})

test('underwaterStepCost is dear but no wall: a bot already in a flooded cave still has a way out', async () => {
  const { UNDERWATER_STEP_COST } = await import('../../src/skills/breath')
  assert.ok(UNDERWATER_STEP_COST > 20 && UNDERWATER_STEP_COST < 1e6)
})
