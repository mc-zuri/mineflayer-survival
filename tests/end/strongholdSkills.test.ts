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

test('overWater: an eye dropped over the sea (or into it) is left, one over the ground or on ice is picked up', () => {
  const { Vec3 } = require('vec3')
  const column = (top: string, topY: number) => (p: any) => ({ name: p.y > topY ? 'air' : p.y > topY - (top === 'water' ? 8 : 1) ? top : 'stone' })
  assert.strictEqual(overWater(column('water', 62), new Vec3(3.4, 70.2, 8.9)), true)
  assert.strictEqual(overWater(column('water', 62), new Vec3(3.4, 61.5, 8.9)), true)
  assert.strictEqual(overWater(column('grass_block', 62), new Vec3(3.4, 70.2, 8.9)), false)
  assert.strictEqual(overWater(column('ice', 62), new Vec3(3.4, 64, 8.9)), false)
  assert.strictEqual(overWater(() => null, new Vec3(0, 64, 0)), false)
})
