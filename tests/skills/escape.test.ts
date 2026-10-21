import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { breathTicksLeft, ceilingToDig, dryStandBeside, headInWater, inHazard, isSafeStand, nearestSpot, pathToAir, type CellLookup } from '../../src/skills/escape'
import { fakeBot } from '../reflexes/fakeBot'
import { VERSIONS } from '../versions'

// a lava pool: x 0 - 3, y 63 - 64 lava, stone around and below
const lavaPool = (p: Vec3): string => (p.x >= 0 && p.x <= 3 && p.z >= -1 && p.z <= 1 && p.y >= 63 && p.y <= 64) ? 'lava' : p.y < 64 ? 'stone' : 'air'

test('inHazard and isSafeStand', () => {
  assert.strictEqual(inHazard(fakeBot({ position: new Vec3(1.5, 63, 0.5), world: lavaPool })), true)
  assert.strictEqual(inHazard(fakeBot({ position: new Vec3(8.5, 64, 0.5), world: lavaPool })), false)
  const bot = fakeBot({ world: lavaPool })
  assert.strictEqual(isSafeStand(bot, new Vec3(5, 64, 0)), true)
  assert.strictEqual(isSafeStand(bot, new Vec3(2, 64, 0)), false) // lava at the feet
  assert.strictEqual(isSafeStand(bot, new Vec3(5, 70, 0)), false) // nothing under
})

test('nearestSpot finds the way out of the lava pool', () => {
  const bot = fakeBot({ position: new Vec3(1.5, 63, 0.5), world: lavaPool })
  const out = nearestSpot(bot, 6, p => isSafeStand(bot, p))
  assert.ok(out != null)
  assert.ok(isSafeStand(bot, out))
  // the pool's edge is two blocks from x 1: x -1 or z +-2
  assert.ok(out.distanceTo(new Vec3(1, 63, 0)) <= 3, out.toString())
})

test('headInWater', () => {
  const sea = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 70 ? 'water' : 'air'
  assert.strictEqual(headInWater(fakeBot({ position: new Vec3(0.5, 65, 0.5), world: sea })), true)
  assert.strictEqual(headInWater(fakeBot({ position: new Vec3(0.5, 69, 0.5), world: sea })), false)
})

test('ceilingToDig: under a frozen sea the ice over the head is dug for air; open water, a roof of bedrock or obsidian is not', () => {
  const world = (column: Record<number, string>) => (p: Vec3) => {
    const name = column[p.y] ?? 'air'
    return { name, boundingBox: name === 'water' || name === 'air' ? 'empty' : 'block' }
  }
  const eyes = new Vec3(5, 60, 5)
  assert.deepStrictEqual(ceilingToDig(world({ 60: 'water', 61: 'water', 62: 'ice' }), eyes), new Vec3(5, 62, 5))
  assert.deepStrictEqual(ceilingToDig(world({ 60: 'water', 61: 'packed_ice' }), eyes), new Vec3(5, 61, 5))
  assert.strictEqual(ceilingToDig(world({ 60: 'water', 61: 'water' }), eyes), null)
  assert.strictEqual(ceilingToDig(world({ 60: 'water', 61: 'bedrock' }), eyes), null)
  assert.strictEqual(ceilingToDig(world({ 60: 'water', 61: 'obsidian' }), eyes), null)
  assert.strictEqual(ceilingToDig(world({ 60: 'water', 61: 'water', 62: 'water', 63: 'water', 64: 'stone' }), eyes), null)
})

test('escapeHazard in a lava sea with no ground within 6 swims for the ground 12 blocks off', async () => {
  const { escapeHazard } = await import('../../src/skills/escape')
  // a lava sea at y 31 and under for x < 12, netherrack ground at y 31 from x 12 on
  const sea = (p: Vec3): string => p.x >= 12 ? (p.y <= 31 ? 'stone' : 'air') : (p.y <= 31 ? (p.y > 20 ? 'lava' : 'stone') : 'air')
  const bot = fakeBot({ position: new Vec3(0.5, 31, 0.5), world: sea })
  const looks: number[] = []
  ;(bot as any).look = async (yaw: number) => { looks.push(yaw) }
  ;(bot as any).clearControlStates = () => {}
  if ((bot as any).setControlState == null) (bot as any).setControlState = () => {}
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(escapeHazard(bot, { maxTicks: 3 }), /still in lava/)
  } finally {
    clearInterval(ticking)
  }
  // toward +x: mineflayer's yaw for +x is -pi/2
  assert.ok(looks.length > 0)
  assert.ok(Math.abs(looks[0] + Math.PI / 2) < 0.3, String(looks[0]))
})

test('powder snow is a hazard: the cells the bot is in are dug, the head first', async () => {
  const { powderSnowToDig } = await import('../../src/skills/escape')
  const snow = (p: Vec3): string => p.y >= 64 && p.y <= 66 && p.x === 0 && p.z === 0 ? 'powder_snow' : p.y < 64 ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64.2, 0.5), world: snow })
  assert.strictEqual(inHazard(bot), true)
  assert.deepStrictEqual(powderSnowToDig(bot), new Vec3(0, 65, 0))
  const free = fakeBot({ position: new Vec3(3.5, 64, 0.5), world: snow })
  assert.strictEqual(inHazard(free), false)
  assert.strictEqual(powderSnowToDig(free), null)
  // the box's side in the snow beside the bot, its middle out of it: that cell dug too
  const side = fakeBot({ position: new Vec3(1.1, 64, 0.5), world: snow })
  assert.strictEqual(inHazard(side), true)
  assert.deepStrictEqual(powderSnowToDig(side)?.x, 0)
})

test('fireToPutOut: the fire at the feet or head, none elsewhere', async () => {
  const { fireToPutOut } = await import('../../src/skills/escape')
  const fire = (p: Vec3): string => p.x === 0 && p.z === 0 && p.y === 64 ? 'fire' : p.y < 64 ? 'netherrack' : 'air'
  assert.deepStrictEqual(fireToPutOut(fakeBot({ position: new Vec3(0.5, 64, 0.5), world: fire })), new Vec3(0, 64, 0))
  assert.strictEqual(fireToPutOut(fakeBot({ position: new Vec3(3.5, 64, 0.5), world: fire })), null)
})

test('inHazard: a fire in a cell the bot\'s box reaches into, its middle out of it, is one (Entity.checkInsideBlocks); fireToPutOut finds it', async () => {
  const { boxCells, fireToPutOut } = await import('../../src/skills/escape')
  const fireEast = (p: Vec3): string => p.x === 1 && p.y === 64 && p.z === 0 ? 'fire' : p.y < 64 ? 'netherrack' : 'air'
  // the box from x 0.45 to 1.05: in the fire's cell
  const by = fakeBot({ position: new Vec3(0.75, 64, 0.5), world: fireEast })
  assert.strictEqual(inHazard(by), true)
  assert.deepStrictEqual(fireToPutOut(by)?.toArray(), [1, 64, 0])
  // from x 0.2 to 0.8: out of it
  const off = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: fireEast })
  assert.strictEqual(inHazard(off), false)
  assert.strictEqual(fireToPutOut(off), null)
  // the cells: the middle's feet and head, then every cell the box is in (two wide here, two high)
  assert.strictEqual(boxCells(by).length, 4)
  assert.deepStrictEqual(boxCells(off).map(c => c.toArray()), [[0, 64, 0], [0, 65, 0]])
})

test('headInWater: seagrass or kelp at the eyes is under water too', () => {
  const river = (p: Vec3): string => p.y < 60 ? 'stone' : p.y === 61 ? 'seagrass' : p.y < 64 ? 'water' : 'air'
  // the eyes at 61.62: in the seagrass's cell
  assert.strictEqual(headInWater(fakeBot({ position: new Vec3(0.5, 60, 0.5), world: river })), true)
  const kelp = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 64 ? 'kelp_plant' : 'air'
  assert.strictEqual(headInWater(fakeBot({ position: new Vec3(0.5, 60, 0.5), world: kelp })), true)
})

test('inHazard: on a magma block (the hot floor), unless sneaking or off the ground', async () => {
  const { onHotFloor } = await import('../../src/skills/escape')
  const magma = (p: Vec3): string => p.y === 63 && p.x === 0 && p.z === 0 ? 'magma_block' : p.y < 64 ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: magma })
  bot.entity.onGround = true
  assert.strictEqual(onHotFloor(bot), true)
  assert.strictEqual(inHazard(bot), true)
  bot.setControlState('sneak', true)
  assert.strictEqual(inHazard(bot), false)
  bot.setControlState('sneak', false)
  bot.entity.onGround = false
  assert.strictEqual(inHazard(bot), false)
  const beside = fakeBot({ position: new Vec3(1.5, 64, 0.5), world: magma })
  beside.entity.onGround = true
  assert.strictEqual(inHazard(beside), false)
  // its way off: the stand next to it, not the magma
  const { isSafeStand } = await import('../../src/skills/escape')
  assert.strictEqual(isSafeStand(bot, new Vec3(0, 64, 0)), false)
  assert.strictEqual(isSafeStand(bot, new Vec3(1, 64, 0)), true)
})

test('fleeFrom keeps running from a threat FLEE_MEMORY ticks after it went out of sight, till it is fleeDistance off (full-26.3-fresh-d: the flee ended a step on, 230 times)', async () => {
  const { fleeFrom, FLEE_MEMORY } = await import('../../src/skills/escape')
  const { entity } = await import('../reflexes/fakeBot')
  const skeleton = entity({ name: 'skeleton', position: new Vec3(8.5, 64, 0.5) })
  const bot = fakeBot({ entities: [skeleton] })
  let t = 0
  // the bot walks 0.3 a tick west while its steer holds forward, the skeleton in sight only the first tick
  bot.waitForTicks = async () => { t++; if (bot.controls.forward === true) bot.entity.position = bot.entity.position.offset(-0.3, 0, 0) }
  const res = await fleeFrom(bot, () => t === 0 ? [skeleton as any] : [], { distance: 16 })
  // 16 off takes about 25 ticks at 0.3 a tick: on past the tick it went out of sight, not a step
  assert.ok(res.ticks > 10 && res.ticks <= FLEE_MEMORY + 1, `${res.ticks} ticks`)
  assert.ok(bot.entity.position.distanceTo(skeleton.position) >= 15.5, bot.entity.position.toString())
})

test('evadeCreeper cornered with no shield (a tunnel): hits the creeper as the sword charges, no stand-still (nether-26.3-q3)', async () => {
  const { evadeCreeper } = await import('../../src/skills/escape')
  const { entity, item } = await import('../reflexes/fakeBot')
  const tunnel = (p: Vec3): string => (p.z === 0 && (p.y === 64 || p.y === 65) && p.x > -2 && p.x < 3) ? 'air' : 'stone'
  const creeper = entity({ name: 'creeper', position: new Vec3(2.2, 64, 0.5), meta: { swell_dir: 1 } })
  const bot = fakeBot({ items: [item('iron_sword')], entities: [creeper], world: tunnel })
  bot.heldItem = bot.inventory.slots[9]
  bot.equip = async () => {}
  let hits = 0
  bot.attack = () => { hits++ }
  bot.waitForTicks = async () => { bot.emit('physicsTick') }
  await evadeCreeper(bot, creeper as any, { maxTicks: 40 }).catch(() => {})
  assert.ok(hits >= 2, `${hits} hits`)
})

test('evadeCreeper: a run that gets nowhere (the body caught where its line said open) takes a route, then counts as cornered: the sword (ls3b-1.21.11, t327032: jumping in place 29 ticks by a trunk till the blast)', async () => {
  const { evadeCreeper } = await import('../../src/skills/escape')
  const { entity, item } = await import('../reflexes/fakeBot')
  // open ground; the bot's body held where it is each tick (the trunk's corner the line's middle passed)
  const creeper = entity({ name: 'creeper', position: new Vec3(2.6, 64, 0.5), meta: { swell_dir: 1 } })
  const bot = fakeBot({ items: [item('iron_sword')], entities: [creeper] })
  bot.heldItem = bot.inventory.slots[9]
  bot.equip = async () => {}
  let hits = 0
  let firstHit = -1
  let t = 0
  bot.attack = () => { hits++; if (firstHit < 0) firstHit = t }
  bot.waitForTicks = async () => { t++; bot.emit('physicsTick') }
  // (the sword long charged, as in a game)
  const { attackStrengthOf } = await import('../../src/skills/weapons')
  for (let i = 0; i < 20; i++) { attackStrengthOf(bot); bot.emit('physicsTick') }
  await evadeCreeper(bot, creeper as any, { maxTicks: 40 }).catch(() => {})
  // 8 ticks of the line, 8 of a route, then the sword: within the fuse's 30
  assert.ok(firstHit >= 0 && firstHit <= 20, `first hit at ${firstHit}`)
  assert.ok(hits >= 1, `${hits} hits`)
  // a bot that runs is let run
  const creeper2 = entity({ name: 'creeper', position: new Vec3(2.6, 64, 0.5), meta: { swell_dir: 1 } })
  const runner = fakeBot({ items: [item('iron_sword')], entities: [creeper2] })
  let ran = 0
  runner.attack = () => { ran = -1000 }
  runner.equip = async () => {}
  runner.waitForTicks = async () => { if (runner.controls.forward === true) { runner.entity.position = runner.entity.position.offset(-0.28, 0, 0); ran++ } }
  const res = await evadeCreeper(runner, creeper2 as any, { maxTicks: 60 }).catch(err => err)
  assert.ok(ran > 15, `ran ${ran}`)
  assert.ok(runner.entity.position.x < -4, String(res))
})

test('sightCells: a cornered bot\'s feet and head cells toward the creeper, the open ones, then the other side; none with the creeper in them (its fuse runs only in sight: SwellGoal)', async () => {
  const { sightCells } = await import('../../src/skills/escape')
  const { entity } = await import('../reflexes/fakeBot')
  const placed = new Set<string>()
  // a nook at (0, 64, 0) open to the east (x 1) and the south (z 1), stone round it
  const nook = (p: Vec3): string => {
    if (placed.has(p.toString())) return 'cobblestone'
    if (p.y < 64 || p.y > 65) return p.y < 64 ? 'stone' : 'air'
    if (p.x === 0 && p.z === 0) return 'air'
    return (p.x === 1 && p.z === 0) || (p.x === 0 && p.z === 1) || p.x >= 2 || p.z >= 2 ? 'air' : 'stone'
  }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: nook })
  const creeper = entity({ name: 'creeper', position: new Vec3(3.5, 64, 1.5) })
  // east first (it's further off along x), the feet's then the head's
  assert.deepStrictEqual(sightCells(bot, creeper).map(String), ['(1, 64, 0)', '(1, 65, 0)'])
  placed.add('(1, 64, 0)')
  assert.deepStrictEqual(sightCells(bot, creeper).map(String), ['(1, 65, 0)'])
  placed.add('(1, 65, 0)')
  // the east shut: the south next
  assert.deepStrictEqual(sightCells(bot, creeper).map(String), ['(0, 64, 1)', '(0, 65, 1)'])
  // the creeper in the south's cells: none to put
  const at = entity({ name: 'creeper', position: new Vec3(0.5, 64, 1.5) })
  placed.clear()
  assert.deepStrictEqual(sightCells(bot, at).map(String), ['(1, 64, 0)', '(1, 65, 0)'])
  placed.add('(1, 64, 0)').add('(1, 65, 0)')
  assert.deepStrictEqual(sightCells(bot, at), [])
})

test('blastBarrierCells: one block on each open line from a creeper within 6 to the body, the first open cell with a block to put it against in reach; none past 6, none on a line a block cuts (after mine-ai-mcp blast-barrier)', async () => {
  const { blastBarrierCells, BLAST_BARRIER_RANGE } = await import('../../src/skills/escape')
  const { entity } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  const creeper = entity({ name: 'creeper', position: new Vec3(3.5, 64, 0.5) })
  // the feet's line: the cell beside the bot on the floor; the head's line has nothing to put a block against
  assert.deepStrictEqual(blastBarrierCells(bot, creeper).map(String), ['(1, 64, 0)'])
  // a block on the lines already (both pass the cell between at the feet's height, the blast low): none
  const walled = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (p: Vec3) => p.y < 64 || (p.x === 2 && p.y === 64 && p.z === 0) ? 'stone' : 'air' })
  assert.deepStrictEqual(blastBarrierCells(walled, creeper), [])
  // a creeper up a step (its blast at the head's height): the head's line's cell too, against the step
  const step = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (p: Vec3) => p.y < 64 || (p.x >= 2 && p.y === 64) ? 'stone' : 'air' })
  const up = entity({ name: 'creeper', position: new Vec3(3.5, 65, 0.5) })
  assert.ok(blastBarrierCells(step, up).length >= 1, String(blastBarrierCells(step, up)))
  // past its blast's reach: none
  assert.deepStrictEqual(blastBarrierCells(bot, entity({ name: 'creeper', position: new Vec3(BLAST_BARRIER_RANGE + 1.5, 64, 0.5) })), [])
})

test('fleeHeading keeps the run clear of the other mobs about (clearsCrowd): from a creeper west, not straight east into a zombie (after mine-ai-mcp creeper-retreat)', async () => {
  const { fleeHeading, clearsCrowd } = await import('../../src/skills/steer')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  const creeper = new Vec3(-2.5, 64, 0.5)
  const east = fleeHeading(bot, creeper)
  assert.ok(east != null && -Math.sin(east) > 0.95, String(east))
  const zombie = { position: new Vec3(2.5, 64, 0.5), width: 0.6 }
  assert.strictEqual(clearsCrowd(bot.entity.position, 1, 0, [zombie]), false)
  assert.strictEqual(clearsCrowd(bot.entity.position, -1, 0, [zombie]), true)
  const h = fleeHeading(bot, creeper, 16, undefined, [zombie])
  assert.ok(h != null && Math.abs(Math.cos(h)) > 0.3, `heading ${h}: ${-Math.sin(h ?? 0)}, ${-Math.cos(h ?? 0)}`)
})

/** a world of named cells from a function, water and air (and seagrass) empty, the rest solid */
function cells (name: (p: Vec3) => string): CellLookup {
  return p => {
    const n = name(p)
    return { name: n, boundingBox: n === 'water' || n === 'air' || n === 'seagrass' ? 'empty' : 'block' }
  }
}

test('pathToAir: straight up a 1-wide flooded hole to its tunnel\'s air, by the ledge beside it (full-26.3-fresh-z)', () => {
  // the pool x -2 to 0, y 0 to 2, z 0 to 3; the tunnel at y 3 and 4 from x 0 east; stone the rest
  const hole = cells(p => (p.x >= -2 && p.x <= 0 && p.y >= 0 && p.y <= 2 && p.z >= 0 && p.z <= 3) ? 'water'
    : (p.x >= 0 && p.x <= 4 && p.y >= 3 && p.y <= 4 && p.z === 0) ? 'air' : 'stone')
  assert.deepStrictEqual(pathToAir(hole, new Vec3(0, 0, 0)), [new Vec3(0, 1, 0), new Vec3(0, 2, 0)])
  // from the pool's far side: across to the hole's column, then up
  const far = pathToAir(hole, new Vec3(-2, 0, 2))
  assert.ok(far != null)
  assert.deepStrictEqual(far[far.length - 1], new Vec3(0, 2, 0))
  assert.strictEqual(far.length, 6)
  // the head room already breathing: no way to go
  assert.deepStrictEqual(pathToAir(hole, new Vec3(0, 2, 0)), [])
})

test('pathToAir: a flooded cave round its walls to the air, none past the radius or in a sealed cave', () => {
  // a cave of water x -2 to 12, y 0 to 2, z -2 to 2 under stone; open to the air over x 10 to 12
  const cave = (open: boolean): CellLookup => cells(p => (p.x >= -2 && p.x <= 12 && p.y >= 0 && p.y <= 2 && p.z >= -2 && p.z <= 2) ? 'water'
    : (open && p.x >= 10 && p.x <= 12 && p.y >= 3 && p.y <= 8 && p.z >= -2 && p.z <= 2) ? 'air' : 'stone')
  const way = pathToAir(cave(true), new Vec3(0, 0, 0), 12)
  assert.ok(way != null)
  const end = way[way.length - 1]
  assert.deepStrictEqual([end.x, end.y], [10, 2])
  assert.strictEqual(way.length, 12)
  // a wall in the way (x 5, but for a gap at z 2, y 0 - 1): round it through the gap, 2 high
  const walled = cells(p => p.x === 5 && !(p.z === 2 && p.y <= 1) && p.y >= 0 && p.y <= 2 && p.z >= -2 && p.z <= 2 ? 'stone' : (cave(true)(p)?.name ?? 'stone'))
  const round = pathToAir(walled, new Vec3(0, 0, 0), 12)
  assert.ok(round?.some(p => p.x === 5 && p.z === 2), 'through the gap')
  assert.strictEqual(pathToAir(cave(true), new Vec3(0, 0, 0), 8), null)
  assert.strictEqual(pathToAir(cave(false), new Vec3(0, 0, 0), 12), null)
  // a 1-high gap is no way for a body 2 high
  const low = cells(p => p.x === 5 && !(p.z === 2 && p.y === 0) && p.y >= 0 && p.y <= 2 && p.z >= -2 && p.z <= 2 ? 'stone' : (cave(true)(p)?.name ?? 'stone'))
  assert.strictEqual(pathToAir(low, new Vec3(0, 0, 0), 12), null)
})

test('dryStandBeside: the tunnel\'s floor beside the hole\'s top; none from the bottom of a lake or in open water', () => {
  const hole = cells(p => (p.x >= -2 && p.x <= 0 && p.y >= 0 && p.y <= 2 && p.z >= 0 && p.z <= 3) ? 'water'
    : (p.x >= 0 && p.x <= 4 && p.y >= 3 && p.y <= 4 && p.z === 0) ? 'air' : 'stone')
  // floating at the top (the feet in the top water cell): the tunnel's first cell, a block up
  assert.deepStrictEqual(dryStandBeside(hole, new Vec3(0.5, 2.3, 0.5)), new Vec3(1, 3, 0))
  // on the floor, 3 under it: out of a climb's reach
  assert.strictEqual(dryStandBeside(hole, new Vec3(0.5, 0, 0.5)), null)
  const sea = cells(p => p.y < 60 ? 'stone' : p.y < 70 ? 'water' : 'air')
  assert.strictEqual(dryStandBeside(sea, new Vec3(0.5, 69.3, 0.5)), null)
})

test('ceilingToDig goes up through seagrass as water; breathTicksLeft counts the air and the hits the health takes', () => {
  const column = cells(p => p.y <= 61 ? 'water' : p.y === 62 ? 'seagrass' : 'stone')
  assert.deepStrictEqual(ceilingToDig(column, new Vec3(0, 61, 0)), new Vec3(0, 63, 0))
  assert.strictEqual(breathTicksLeft({ oxygenLevel: 6, health: 20 } as any), 6 * 15 + 9 * 20)
  assert.strictEqual(breathTicksLeft({ oxygenLevel: 0, health: 2 } as any), 0)
})

/**
 * A fake bot on fire on a stone floor at y 64 (its feet's cell (0, 64, 0)), with `items`: its use of a water bucket
 * pours a source at the feet (the server clears the fire: the shared flags' bit 0 off), of an empty one takes it up
 */
function burningBot (version: string, items: string[], world?: (p: Vec3) => string): { bot: any, uses: string[] } {
  const { item } = require('../reflexes/fakeBot')
  const feet = new Vec3(0, 64, 0)
  let water = false
  const bot = fakeBot({ version, position: new Vec3(0.5, 64, 0.5), items: items.map(n => item(n, 1, undefined, version)) })
  bot.entity.metadata[0] = 1
  bot.survival = { tasks: { tick: 100 } }
  bot._client = new (require('node:events').EventEmitter)()
  const ground = world ?? ((p: Vec3) => p.y < 64 ? 'stone' : 'air')
  bot.blockAt = (p: Vec3) => {
    const c = p.floored()
    const name = water && c.equals(feet) ? 'water' : ground(c)
    return { name, position: c, boundingBox: name === 'stone' ? 'block' : 'empty', getProperties: () => ({ level: 0 }) }
  }
  // the world's ray (fluids passed through): the floor's top face under it
  bot.world = {
    raycast: (eye: Vec3, dir: Vec3, range: number) => {
      if (dir.y >= 0) return null
      const t = (64 - eye.y) / dir.y
      if (t > range) return null
      const at = eye.plus(dir.scaled(t))
      return { position: new Vec3(Math.floor(at.x), 63, Math.floor(at.z)), face: 1, intersect: at }
    }
  }
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.lookAt = async () => {}
  const uses: string[] = []
  const slotOf = (name: string): number => bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && s?.name === name)
  bot.activateItem = () => {
    const held = bot.heldItem?.name
    uses.push(held)
    if (held === 'water_bucket' && !water) {
      water = true
      bot.inventory.slots[slotOf('water_bucket')] = Object.assign(item('bucket', 1, undefined, version), { slot: slotOf('water_bucket') })
      bot.entity.metadata[0] = 0
    } else if (held === 'bucket' && water) {
      water = false
      bot.inventory.slots[slotOf('bucket')] = Object.assign(item('water_bucket', 1, undefined, version), { slot: slotOf('bucket') })
    }
    bot.heldItem = null
  }
  return { bot, uses }
}

for (const version of VERSIONS) {
  test(`douseBurning (${version}): the water bucket poured at the feet puts the fire out, and the water's taken back up (f9-26.3, t347525: burned to death out of the lava, a water bucket in the bag)`, async () => {
    const { burningToDouse, douseBurning, isOnFire } = await import('../../src/skills/escape')
    const { bot, uses } = burningBot(version, ['water_bucket', 'bucket'])
    assert.strictEqual(burningToDouse(bot), true)
    const ticking = setInterval(() => bot.emit('physicsTick'), 1)
    try {
      assert.strictEqual(await douseBurning(bot), true)
    } finally {
      clearInterval(ticking)
    }
    assert.strictEqual(isOnFire(bot), false)
    assert.deepStrictEqual(uses, ['water_bucket', 'bucket'])
    assert.strictEqual(bot.inventory.items().filter((i: any) => i.name === 'water_bucket').length, 1)
    assert.strictEqual(bot.blockAt(new Vec3(0, 64, 0)).name, 'air')
    assert.strictEqual(burningToDouse(bot), false)
  })

  test(`burningToDouse (${version}): only on fire, out of the lava and the water, with a water bucket, out of the nether, not fire resistant`, async () => {
    const { burningToDouse } = await import('../../src/skills/escape')
    assert.strictEqual(burningToDouse(burningBot(version, ['water_bucket']).bot), true)
    // not on fire
    const cold = burningBot(version, ['water_bucket']).bot
    cold.entity.metadata[0] = 0
    assert.strictEqual(burningToDouse(cold), false)
    // no water bucket: an empty one is none
    assert.strictEqual(burningToDouse(burningBot(version, ['bucket']).bot), false)
    // in lava (the escape's), in water (out by itself)
    const lava = burningBot(version, ['water_bucket']).bot
    lava.entity.isInLava = true
    assert.strictEqual(burningToDouse(lava), false)
    const wet = burningBot(version, ['water_bucket']).bot
    wet.entity.isInWater = true
    assert.strictEqual(burningToDouse(wet), false)
    // the nether: water boils away (DimensionType.ultraWarm)
    const nether = burningBot(version, ['water_bucket']).bot
    nether.game.dimension = 'the_nether'
    assert.strictEqual(burningToDouse(nether), false)
    // fire resistance: the fire hurts nothing
    const proof = burningBot(version, ['water_bucket']).bot
    proof.entity.effects = { [proof.registry.effectsByName.FireResistance.id]: { amplifier: 0, duration: 600 } }
    assert.strictEqual(burningToDouse(proof), false)
  })

  test(`escapeHazard (${version}): out of the lava still burning, the water bucket poured at the feet; with none, a run to water it gets no nearer to is given up after WATER_RUN_TICKS`, async () => {
    const { escapeHazard, isOnFire, WATER_RUN_TICKS } = await import('../../src/skills/escape')
    const ticking = setInterval(() => { for (const b of bots) b.emit('physicsTick') }, 1)
    const bots: any[] = []
    try {
      const { bot, uses } = burningBot(version, ['water_bucket'])
      bots.push(bot)
      await escapeHazard(bot, { maxTicks: 200 })
      assert.strictEqual(isOnFire(bot), false)
      assert.deepStrictEqual(uses, ['water_bucket', 'bucket'])
      // water 3 east over a wall the fake never gets past: the escape back well before its 200 ticks
      const wall = (p: Vec3): string => p.x === 3 && p.y === 64 ? 'water' : p.x === 2 && p.y >= 64 && p.y <= 66 ? 'stone' : p.y < 64 ? 'stone' : 'air'
      const dry = burningBot(version, [], wall).bot
      bots.push(dry)
      let ticks = 0
      dry.on('physicsTick', () => { ticks++ })
      const out = await escapeHazard(dry, { maxTicks: 200 })
      assert.ok(out.ticks <= WATER_RUN_TICKS + 2 && ticks < 150, `${out.ticks} ticks, ${ticks} waited`)
      assert.strictEqual(isOnFire(dry), true)
    } finally {
      clearInterval(ticking)
    }
  })
}

test('evadeCreeper: a use in hand (a bow drawn by a shot it cut off) is stopped before the run, which goes at full speed; cornered at the fuse\'s CREEPER_BLOCK_SWELL, the shield up facing it (f9-1.21.11, t305885)', async () => {
  const { evadeCreeper, CREEPER_BLOCK_SWELL } = await import('../../src/skills/escape')
  const { entity, item } = await import('../reflexes/fakeBot')
  assert.ok(30 - CREEPER_BLOCK_SWELL >= 5 + 3, 'the raise, its trip and the shield\'s 5-tick delay before the blast')
  for (const version of ['1.21.11', '26.3']) {
    const creeper = entity({ name: 'creeper', position: new Vec3(2.6, 64, 0.5), meta: { swell_dir: 1 }, version })
    const bot = fakeBot({ items: [item('bow', 1, undefined, version), item('arrow', 8, undefined, version)], offhand: item('shield', 1, undefined, version), entities: [creeper], usingHeldItem: true, version })
    bot.heldItem = bot.inventory.slots[9]
    bot.equip = async () => {}
    const events: string[] = []
    bot.deactivateItem = () => { events.push('release'); bot.usingHeldItem = false }
    bot.activateItem = (off: boolean) => { events.push(off ? 'shield' : 'main'); bot.usingHeldItem = true }
    let ran = 0
    bot.waitForTicks = async () => {
      // the run's speed as the use leaves it: a fifth while in use (LocalPlayer.aiStep)
      if (bot.controls.forward === true) { bot.entity.position = bot.entity.position.offset(bot.usingHeldItem === true ? -0.056 : -0.28, 0, 0); ran++ }
    }
    await evadeCreeper(bot, creeper as any, { maxTicks: 60, swell: 0 }).catch(err => err)
    assert.strictEqual(events[0], 'release', `${version}: ${events.join(' ')}`)
    assert.ok(!events.includes('shield'), `${version}: ${events.join(' ')}`)
    assert.ok(bot.entity.position.x < -4, `${version}: ${bot.entity.position.toString()}`)
    // cornered (a nook open to the creeper alone), the fuse along: the shield up, the look on the creeper
    const nook = (p: Vec3): string => p.y < 64 ? 'stone' : (p.z === 0 && p.x >= 0 && p.x <= 4 && p.y <= 65) ? 'air' : p.y <= 66 ? 'stone' : 'air'
    const creeper2 = entity({ name: 'creeper', position: new Vec3(3.2, 64, 0.5), meta: { swell_dir: 1 }, version })
    const cornered = fakeBot({ items: [item('bow', 1, undefined, version)], offhand: item('shield', 1, undefined, version), entities: [creeper2], usingHeldItem: true, world: nook, version })
    cornered.heldItem = cornered.inventory.slots[9]
    cornered.equip = async () => {}
    const used: string[] = []
    cornered.deactivateItem = () => { used.push('release'); cornered.usingHeldItem = false }
    cornered.activateItem = (off: boolean) => { used.push(off ? 'shield' : 'main'); cornered.usingHeldItem = true }
    const looks: number[] = []
    cornered.look = async (yaw: number) => { looks.push(yaw) }
    cornered.waitForTicks = async () => {}
    await evadeCreeper(cornered, creeper2 as any, { maxTicks: 30, swell: CREEPER_BLOCK_SWELL }).catch(err => err)
    assert.deepStrictEqual(used.slice(0, 2), ['release', 'shield'], `${version}: ${used.join(' ')}`)
    // (facing +x, the creeper's way: yaw -pi/2 in mineflayer's)
    assert.ok(looks.length > 0 && Math.abs(Math.abs(looks[looks.length - 1]) - Math.PI / 2) < 0.3, `${version}: ${looks.join(' ')}`)
  }
})
