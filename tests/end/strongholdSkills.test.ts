import { test } from 'node:test'
import assert from 'node:assert'
import { STRONGHOLD_BLOCKS, craftEyes, overWater } from '../../src/end/strongholdSkills'
import { isSkillError } from '../../src/skills/errors'
import { fakeBot, item } from '../reflexes/fakeBot'

test('craftEyes: nothing to do with the eyes in hand, MISSING_ITEMS without pearls or powder', async () => {
  assert.deepStrictEqual(await craftEyes(fakeBot({ items: [item('ender_eye', 12)] }), { count: 12 }), { crafted: 0, eyes: 12 })
  await assert.rejects(craftEyes(fakeBot({ items: [item('blaze_rod', 6)] }), { count: 12 }), (err: unknown) => isSkillError(err, 'MISSING_ITEMS'))
  await assert.rejects(craftEyes(fakeBot({ items: [item('ender_pearl', 6)] }), { count: 12 }), (err: unknown) => isSkillError(err, 'MISSING_ITEMS'))
})

test('the stronghold blocks are StrongholdPieces\' stone bricks, the iron bars and the portal frame', () => {
  for (const name of ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'iron_bars', 'end_portal_frame']) assert.ok(STRONGHOLD_BLOCKS.includes(name), name)
})

test('overWater: an eye dropped into a frozen sea is left; one over open water, the ground or on the ice is picked up', () => {
  const { Vec3 } = require('vec3')
  // water from 55 to 62, ice on the surface where x >= 10
  const sea = (frozen: boolean) => (p: any) => ({ name: p.y > 63 ? 'air' : p.y === 63 ? (frozen && p.x >= 10 ? 'ice' : 'air') : p.y >= 55 ? (frozen && p.x >= 10 && p.y === 62 ? 'ice' : 'water') : 'stone' })
  assert.strictEqual(overWater(sea(false), new Vec3(3.4, 70.2, 8.9)), false)
  assert.strictEqual(overWater(sea(true), new Vec3(9.4, 70.2, 8.9)), true)
  assert.strictEqual(overWater(sea(true), new Vec3(9.4, 58.5, 8.9)), true)
  assert.strictEqual(overWater(sea(true), new Vec3(12.4, 70.2, 8.9)), false)
  assert.strictEqual(overWater((p: any) => ({ name: p.y > 62 ? 'air' : 'grass_block' }), new Vec3(3.4, 70.2, 8.9)), false)
  assert.strictEqual(overWater(() => null, new Vec3(0, 64, 0)), false)
})
