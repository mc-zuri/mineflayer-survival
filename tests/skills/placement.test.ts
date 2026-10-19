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

test('findBedPlacementNear and bedRoomToDig: no bed over a chest (the trip kit chest put down first: the bed opened it)', () => {
  // the corridor as above, a chest in its floor at x 1: the bed lies clear of it
  const extra: Record<string, string> = {}
  for (let x = -6; x <= 12; x++) for (const z of [-1, 1]) for (const y of [-60, -59]) extra[`${x},${y},${z}`] = 'stone'
  for (const y of [-60, -59]) { extra[`-3,${y},0`] = 'stone'; extra[`9,${y},0`] = 'stone' }
  extra['1,-61,0'] = 'chest'
  const world = (pos: Vec3): BlockView => {
    const b = flat(extra)(pos)
    return b.name === 'chest' ? { name: 'chest', boundingBox: 'block' } : b
  }
  const spot = findBedPlacementNear(world, new Vec3(1, -60, 0), 5)
  assert.ok(spot != null)
  for (const p of [spot.foot, spot.head]) assert.notStrictEqual(p.x, 1)
  // in a tunnel: not dug out over a chest either
  const tunnel = (pos: Vec3): BlockView => {
    if (pos.x === 1 && pos.y === -61 && pos.z === 0) return { name: 'chest', boundingBox: 'block' }
    const name = (pos.x === 0 && pos.z === 0 && (pos.y === -60 || pos.y === -59)) ? 'air' : 'stone'
    return { name, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  const room = bedRoomToDig(tunnel, new Vec3(0.5, -60, 0.5))
  assert.ok(room != null && room.facing.x !== 1)
})

test('bedRoomToDig: in a 1-wide tunnel, the two cells straight out from the bot and the head room over them dug for a bed; never next to lava or through bedrock', () => {
  // stone all round from -64 to -55, a tunnel cell at the bot's feet and head (0, -60, 0), (0, -59, 0)
  const solid = (extra: Record<string, string> = {}) => (pos: Vec3): BlockView => {
    const k = `${pos.x},${pos.y},${pos.z}`
    const name = extra[k] ?? ((pos.x === 0 && pos.z === 0 && (pos.y === -60 || pos.y === -59)) ? 'air' : 'stone')
    return { name, boundingBox: ['air', 'lava', 'water', 'wall_torch'].includes(name) ? 'empty' : 'block' }
  }
  const feet = new Vec3(0.5, -60, 0.5)
  assert.strictEqual(findBedPlacementNear(solid(), feet, 5), null)
  const room = bedRoomToDig(solid(), feet)
  assert.ok(room != null)
  // the bed's two cells and the head room over them (ServerPlayer.bedBlocked: a block over the bed is OBSTRUCTED)
  assert.strictEqual(room.dig.length, 4)
  assert.deepStrictEqual(room.stand, new Vec3(0, -60, 0))
  assert.deepStrictEqual(room.foot, room.stand.plus(room.facing))
  assert.deepStrictEqual(room.head, room.foot.plus(room.facing))
  assert.deepStrictEqual(room.dig.map(String).sort(), [room.foot, room.head, room.foot.offset(0, 1, 0), room.head.offset(0, 1, 0)].map(String).sort())
  // the head room open already (a torch on the wall is no block over the bed): the bed's cells alone
  const open: Record<string, string> = {}
  for (const facing of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const d of [1, 2]) open[`${facing[0] * d},-59,${facing[1] * d}`] = d === 1 ? 'wall_torch' : 'air'
  assert.strictEqual(bedRoomToDig(solid(open), feet)?.dig.length, 2)
  // gravel over the head room every way but -z (it would fall in over the bed): that way
  const gravel: Record<string, string> = { '1,-58,0': 'gravel', '2,-58,0': 'gravel', '-1,-58,0': 'gravel', '-2,-58,0': 'gravel', '0,-58,1': 'sand', '0,-58,2': 'sand' }
  assert.deepStrictEqual(bedRoomToDig(solid(gravel), feet)?.facing, new Vec3(0, 0, -1))
  // lava behind every way but +x, bedrock that way: no room
  const lava: Record<string, string> = { '0,-60,-3': 'lava', '0,-60,3': 'lava', '-3,-60,0': 'lava', '2,-60,0': 'bedrock' }
  assert.strictEqual(bedRoomToDig(solid(lava), feet), null)
  // the cells to avoid (a portal's): not that way
  const away = bedRoomToDig(solid(), feet, p => p.x > 0)
  assert.ok(away != null && away.facing.x <= 0)
})

test('cellToStepOff: a bot standing half in the gate\'s cell steps to the middle of the cell beside it (26.3: the gate refused 3 times)', async () => {
  const { boxInCell, cellToStepOff } = await import('../../src/skills/placement')
  const ground = flat({ '-48,-60,0': 'leaf_litter' })
  const lookup = (p: Vec3): BlockView => p.toString() === '(-48, -60, 0)' ? { name: 'leaf_litter', boundingBox: 'empty' } : ground(p)
  const gate = new Vec3(-48, -60, 0)
  // the bot as it stood: its feet's cell the gate's (x -47.25 floors to -48), its box 0.05 into the cell east of it
  const bot = new Vec3(-47.25, -60, 0.67)
  assert.ok(boxInCell(bot, gate))
  const to = cellToStepOff(lookup, bot, gate)
  assert.ok(to != null)
  assert.notStrictEqual(to.x, gate.x, 'out of the gate\'s column')
  assert.ok(!boxInCell(to.offset(0.5, 0, 0.5), gate), `the middle of ${to.toString()} is clear of the gate's cell`)
  assert.deepStrictEqual(to.toArray(), [-47, -60, 0], 'the nearest cell beside it')
  // a box clear of the cell: no step
  assert.strictEqual(cellToStepOff(lookup, new Vec3(-46.5, -60, 0.5), gate), null)
  // in the middle of the cell: beside it, not into a wall
  const walled = (p: Vec3): BlockView => (p.y === -60 && p.x === -48 && p.z === 1) ? { name: 'stone', boundingBox: 'block' } : lookup(p)
  const out = cellToStepOff(walled, new Vec3(-47.5, -60, 0.5), gate)
  assert.ok(out != null && !(out.x === -48 && out.z === 1))
  assert.strictEqual(Math.abs(out.x - gate.x) + Math.abs(out.z - gate.z), 1, 'a cardinal neighbour first')
})

test('placeBlock against a chest: sneaking, and a menu its use opened anyway is shut (its clicks took the eyes, 1.21.11)', async () => {
  const { placeBlock } = await import('../../src/skills/placeBlock')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot: any = fakeBot({ position: new Vec3(0.5, 64, 2.5), items: [item('white_bed', 1)], world: (p: any) => p.x === 0 && p.y === 63 && p.z === 0 ? 'chest' : p.y < 64 ? 'stone' : 'air' })
  const realAt = bot.blockAt.bind(bot)
  bot.blockAt = (p: any) => { const b = realAt(p); return b.name === 'chest' ? { ...b, boundingBox: 'block' } : b }
  bot.equip = async () => {}
  bot._client = new (require('events').EventEmitter)()
  let sneaking: boolean | null = null
  const closed: any[] = []
  bot.currentWindow = null
  bot.closeWindow = (w: any) => { closed.push(w); bot.currentWindow = null }
  bot._placeBlockWithOptions = async () => {
    sneaking = bot.controls.sneak === true
    bot.currentWindow = { id: 1, type: 'minecraft:generic_9x3' }
    throw new Error('No block has been placed : the block is still air')
  }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(placeBlock(bot, { pos: new Vec3(0, 64, 0), item: 'white_bed', against: new Vec3(0, 63, 0), facing: new Vec3(0, 0, -1) }), /still air/)
  } finally {
    clearInterval(ticking)
  }
  assert.strictEqual(sneaking, true)
  assert.strictEqual(bot.controls.sneak, false)
  assert.strictEqual(closed.length, 1)
  assert.strictEqual(bot.currentWindow, null)
})

test('placeBlock puts no chest under a solid block (it would never open)', async () => {
  const { placeBlock } = await import('../../src/skills/placeBlock')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('chest', 1)], world: (p: any) => p.y < 64 ? 'stone' : (p.x === 2 && p.y === 65 && p.z === 0 ? 'stone' : 'air') })
  await assert.rejects(placeBlock(bot, { pos: new Vec3(2, 64, 0), item: 'chest' }), /won't open/)
})
