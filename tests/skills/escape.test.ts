import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { ceilingToDig, headInWater, inHazard, isSafeStand, nearestSpot } from '../../src/skills/escape'
import { fakeBot } from '../reflexes/fakeBot'

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
