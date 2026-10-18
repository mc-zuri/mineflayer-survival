import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { botCells, findBedPlacement, findPlacement, type BlockView } from '../../src/skills/placement'
import { placedBlockNames } from '../../src/skills/placeBlock'

// a superflat world: grass at y = -61 and below, air above; `extra` sets blocks by "x,y,z"
function flat (extra: Record<string, string> = {}): (pos: Vec3) => BlockView {
  return pos => {
    const name = extra[`${pos.x},${pos.y},${pos.z}`] ?? (pos.y <= -61 ? 'grass_block' : 'air')
    return { name, boundingBox: ['air', 'short_grass', 'water', 'lava'].includes(name) ? 'empty' : 'block' }
  }
}

test('botCells: the cells a player box overlaps, one column when centred, more when it straddles', () => {
  assert.deepStrictEqual(botCells(new Vec3(0.5, -60, 0.5)).map(String), ['(0, -60, 0)', '(0, -59, 0)'])
  assert.strictEqual(botCells(new Vec3(0.9, -60, 0.5)).length, 4)
})

test('findPlacement: a free cell beside the bot at its feet, with ground below', () => {
  const pos = findPlacement(flat(), new Vec3(0.5, -60, 0.5))
  assert.ok(pos != null)
  assert.strictEqual(pos.y, -60)
  assert.strictEqual(Math.max(Math.abs(pos.x), Math.abs(pos.z)), 1)
})

test('findPlacement skips taken cells, the bot\'s own column, and cells over interactive blocks', () => {
  const extra: Record<string, string> = {}
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (x !== 0 || z !== 0) extra[`${x},-60,${z}`] = 'stone'
  extra['1,-60,0'] = 'chest'
  // walled in at the feet: a step up, on top of the stone ring, not on the chest
  const pos = findPlacement(flat(extra), new Vec3(0.5, -60, 0.5))
  assert.ok(pos != null)
  assert.strictEqual(pos.y, -59)
  assert.notDeepStrictEqual([pos.x, pos.z], [1, 0])
  assert.notDeepStrictEqual([pos.x, pos.z], [0, 0])
  // nothing free within radius 0
  assert.strictEqual(findPlacement(flat(), new Vec3(0.5, -60, 0.5), { radius: 0 }), null)
})

test('findPlacement with freeAbove keeps the cell over it free (so a chest opens)', () => {
  const extra: Record<string, string> = {}
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) extra[`${x},-59,${z}`] = 'stone'
  extra['0,-59,0'] = 'air'
  extra['2,-59,2'] = 'air'
  const pos = findPlacement(flat(extra), new Vec3(0.5, -60, 0.5), { freeAbove: true })
  assert.deepStrictEqual(pos?.toArray(), [2, -60, 2])
})

test('findBedPlacement: foot and head in a line from the bot', () => {
  const placement = findBedPlacement(flat({ '0,-60,-1': 'stone' }), new Vec3(0.5, -60, 0.5))
  assert.ok(placement != null)
  assert.deepStrictEqual(placement.foot.toArray(), [0, -60, 1])
  assert.deepStrictEqual(placement.head.toArray(), [0, -60, 2])
  assert.deepStrictEqual(placement.facing.toArray(), [0, 0, 1])
})

test('placedBlockNames: torches and signs go on walls too', () => {
  assert.deepStrictEqual(placedBlockNames('crafting_table'), ['crafting_table'])
  assert.deepStrictEqual(placedBlockNames('torch'), ['torch', 'wall_torch'])
  assert.deepStrictEqual(placedBlockNames('oak_sign'), ['oak_sign', 'oak_wall_sign'])
})

test('yawFor: the yaw that faces a cardinal direction (mineflayer: 0 to -z, pi/2 to -x)', async () => {
  const { yawFor } = await import('../../src/skills/placeBlock')
  const { Vec3 } = await import('vec3')
  assert.strictEqual(yawFor(new Vec3(0, 0, -1)) + 0, 0)
  assert.strictEqual(yawFor(new Vec3(-1, 0, 0)), Math.PI / 2)
  assert.strictEqual(yawFor(new Vec3(1, 0, 0)), -Math.PI / 2)
  assert.strictEqual(Math.abs(yawFor(new Vec3(0, 0, 1))), Math.PI)
})

test('findPlacementNear: further off when every cell around the bot is taken (leaves up a tree)', async () => {
  const { findPlacementNear } = await import('../../src/skills/placement')
  const extra: Record<string, string> = {}
  for (let x = -2; x <= 2; x++) for (let y = -61; y <= -58; y++) for (let z = -2; z <= 2; z++) if (x !== 0 || z !== 0) extra[`${x},${y},${z}`] = 'oak_leaves'
  const world = flat(extra)
  assert.strictEqual(findPlacement(world, new Vec3(0.5, -60, 0.5)), null)
  const pos = findPlacementNear(world, new Vec3(0.5, -60, 0.5))
  assert.ok(pos != null)
  assert.strictEqual(Math.max(Math.abs(pos.x), Math.abs(pos.z)), 3)
})
