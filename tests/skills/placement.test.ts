import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { bedRoomToDig, botCells, findBedPlacement, findBedPlacementNear, findPlacement, type BlockView } from '../../src/skills/placement'
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

test('REPLACEABLE_BLOCKS is vanilla #replaceable: bubble columns, and 26.3\'s red shrub', async () => {
  const { REPLACEABLE_BLOCKS } = await import('../../src/skills/util')
  for (const name of ['air', 'water', 'short_grass', 'bubble_column', 'red_shrub', 'leaf_litter']) assert.ok(REPLACEABLE_BLOCKS.has(name), name)
  assert.ok(!REPLACEABLE_BLOCKS.has('stone'))
})

test('placeBlock into lava only when asked (intoFluid): a pedestal in a lava lake', async () => {
  const { placeBlock } = await import('../../src/skills/placeBlock')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 48, 2.5), items: [item('cobblestone', 4)], world: (p: any) => p.y < 47 ? 'stone' : (p.y === 47 && p.z === 0 ? 'lava' : 'air') })
  await assert.rejects(placeBlock(bot, { pos: new Vec3(0, 47, 0), item: 'cobblestone' }), /lava is at/)
  // asked to: it gets past the check to the inventory and the place (the fake has no hands for it)
  await assert.rejects(placeBlock(bot, { pos: new Vec3(0, 47, 0), item: 'cobblestone', against: new Vec3(0, 46, 0), intoFluid: true }), (err: any) => !/lava is at/.test(err.message))
})

test('findBedPlacementNear: foot, head and a cell behind the foot to face along it from, all on ground, off the cells to avoid', () => {
  // a corridor 1 wide along x at z 0 (walls at z -1 and 1), open from x -2 to 8: the bed lies along it
  const extra: Record<string, string> = {}
  for (let x = -6; x <= 12; x++) for (const z of [-1, 1]) for (const y of [-60, -59]) extra[`${x},${y},${z}`] = 'stone'
  for (const y of [-60, -59]) { extra[`-3,${y},0`] = 'stone'; extra[`9,${y},0`] = 'stone' }
  const world = flat(extra)
  const near = new Vec3(0, -60, 0)
  const spot = findBedPlacementNear(world, near, 5)
  assert.ok(spot != null)
  assert.strictEqual(spot.facing.z, 0)
  for (const p of [spot.foot, spot.head, spot.stand]) assert.strictEqual(p.z, 0)
  assert.deepStrictEqual(spot.head.minus(spot.foot), spot.facing)
  assert.deepStrictEqual(spot.foot.minus(spot.stand), spot.facing)
  // the cells by the start kept off (a portal there): the bed further along
  const away = findBedPlacementNear(world, near, 5, p => p.x < 3)
  assert.ok(away != null && [away.foot, away.head, away.stand].every(p => p.x >= 3))
  // a single free cell (findPlacement's pick) is no room for one
  const closed: Record<string, string> = {}
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (const y of [-60, -59]) if (x !== 0 || z !== 0) closed[`${x},${y},${z}`] = 'stone'
  assert.strictEqual(findBedPlacementNear(flat(closed), near, 5), null)
})

test('bedRoomToDig: in a 1-wide tunnel, the two cells straight out from the bot dug for a bed; never next to lava or through bedrock', () => {
  // stone all round from -64 to -55, a tunnel cell at the bot's feet and head (0, -60, 0), (0, -59, 0)
  const solid = (extra: Record<string, string> = {}) => (pos: Vec3): BlockView => {
    const k = `${pos.x},${pos.y},${pos.z}`
    const name = extra[k] ?? ((pos.x === 0 && pos.z === 0 && (pos.y === -60 || pos.y === -59)) ? 'air' : 'stone')
    return { name, boundingBox: ['air', 'lava', 'water'].includes(name) ? 'empty' : 'block' }
  }
  const feet = new Vec3(0.5, -60, 0.5)
  assert.strictEqual(findBedPlacementNear(solid(), feet, 5), null)
  const room = bedRoomToDig(solid(), feet)
  assert.ok(room != null)
  assert.strictEqual(room.dig.length, 2)
  assert.deepStrictEqual(room.stand, new Vec3(0, -60, 0))
  assert.deepStrictEqual(room.foot, room.stand.plus(room.facing))
  assert.deepStrictEqual(room.head, room.foot.plus(room.facing))
  // lava behind every way but +x, bedrock that way: no room
  const lava: Record<string, string> = { '0,-60,-3': 'lava', '0,-60,3': 'lava', '-3,-60,0': 'lava', '2,-60,0': 'bedrock' }
  assert.strictEqual(bedRoomToDig(solid(lava), feet), null)
  // the cells to avoid (a portal's): not that way
  const away = bedRoomToDig(solid(), feet, p => p.x > 0)
  assert.ok(away != null && away.facing.x <= 0)
})
