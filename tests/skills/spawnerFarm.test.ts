import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { BOOTH_MOBS, knownFarmableSpawners, knownXpFarms, nearestXpFarm, planSpawnerFarm, rememberXpFarm, spawnerMob, type FarmBlock } from '../../src/skills/spawnerFarm'

/**
 * A dungeon (MonsterRoomFeature) in stone: the room `rx` x `rz` out from the spawner at (0, 20, 0), 4 high, cobblestone
 * walls, floor and ceiling; `extra` puts blocks by "x,y,z" (a chest, a hole to a cave)
 */
function dungeon (rx: number, rz: number, extra: Record<string, string> = {}): (p: Vec3) => FarmBlock {
  return (p: Vec3) => {
    const k = `${p.x},${p.y},${p.z}`
    const name = extra[k]
    if (name != null) return { name, boundingBox: name === 'air' || name === 'cave_air' ? 'empty' : 'block' }
    if (p.x === 0 && p.y === 20 && p.z === 0) return { name: 'spawner', boundingBox: 'block', blockEntity: { SpawnData: { entity: { id: 'minecraft:zombie' } } } }
    if (Math.abs(p.x) <= rx && Math.abs(p.z) <= rz && p.y >= 20 && p.y <= 23) return { name: 'cave_air', boundingBox: 'empty' }
    if (Math.abs(p.x) <= rx + 1 && Math.abs(p.z) <= rz + 1 && p.y >= 19 && p.y <= 24) return { name: 'cobblestone', boundingBox: 'block' }
    return { name: 'stone', boundingBox: 'block' }
  }
}

const cheb = (a: Vec3, b: Vec3): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))

test("a spawner's mob is read from its block entity", () => {
  assert.equal(spawnerMob({ name: 'spawner', blockEntity: { SpawnData: { entity: { id: 'minecraft:zombie' } } } }), 'zombie')
  assert.equal(spawnerMob({ name: 'spawner' }), null)
  assert.ok(BOOTH_MOBS.includes('zombie') && !BOOTH_MOBS.includes('skeleton') && !BOOTH_MOBS.includes('spider'))
})

test('a 7 x 7 room: the booth two into a wall, a zombie on the floor before its slit, the cave hole sealed', () => {
  // a chest against the west wall; a hole through the east wall to a cave, 2 high
  const extra: Record<string, string> = { '-3,20,-1': 'chest', '4,20,0': 'cave_air', '4,21,0': 'cave_air', '5,20,0': 'cave_air', '5,21,0': 'cave_air', '6,20,0': 'cave_air' }
  const lookup = dungeon(3, 3, extra)
  const plan = planSpawnerFarm(lookup, new Vec3(0, 20, 0))
  assert.ok(plan != null)
  // the kill cell on the floor against a wall, the barrier in the wall, the booth behind it, in a line
  assert.equal(plan.killCell.y, 20)
  assert.equal(cheb(plan.killCell, new Vec3(0, 20, 0)), 3)
  assert.equal(cheb(plan.barrier, new Vec3(0, 20, 0)), 4)
  assert.equal(cheb(plan.stand, new Vec3(0, 20, 0)), 5)
  assert.ok(plan.slit.equals(plan.barrier.offset(0, 1, 0)))
  assert.deepEqual(plan.stand.minus(plan.barrier), plan.barrier.minus(plan.killCell))
  // not through the hole, and the stone round the booth needs nothing
  assert.ok(!plan.barrier.equals(new Vec3(4, 20, 0)))
  assert.equal(plan.boothSeal.length, 0)
  const sealed = plan.seal.map(p => p.toString())
  assert.ok(sealed.includes(new Vec3(4, 20, 0).toString()) && sealed.includes(new Vec3(4, 21, 0).toString()), sealed.join(' '))
})

test('a 5 x 5 room: the booth in the wall and the stone behind it; a booth backing onto a cave seals its open sides', () => {
  const plan = planSpawnerFarm(dungeon(2, 2), new Vec3(0, 20, 0))
  assert.ok(plan != null)
  assert.equal(cheb(plan.killCell, new Vec3(0, 20, 0)), 2)
  assert.equal(cheb(plan.stand, new Vec3(0, 20, 0)), 4)
  assert.equal(plan.seal.length, 0)
  // a cave round the room behind the stone the booth is dug in: its far side open, wherever it is
  const caves: Record<string, string> = {}
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) if (Math.max(Math.abs(x), Math.abs(z)) === 5) for (const y of [20, 21]) caves[`${x},${y},${z}`] = 'cave_air'
  const caved = planSpawnerFarm(dungeon(2, 2, caves), new Vec3(0, 20, 0))
  assert.ok(caved != null)
  assert.equal(caved.boothSeal.length, 2)
  for (const p of caved.boothSeal) assert.equal(cheb(p, new Vec3(0, 20, 0)), 5)
})

test('a hole in the floor is sealed', () => {
  const lookup = dungeon(3, 3, { '1,19,1': 'cave_air', '1,18,1': 'cave_air' })
  const plan = planSpawnerFarm(lookup, new Vec3(0, 20, 0))
  assert.ok(plan != null)
  assert.ok(plan.seal.some(p => p.equals(new Vec3(1, 19, 1))))
})

test('the farm and the spawners are kept in the memory', () => {
  const memory = new WorldMemory()
  memory.addPoi('spawner', new Vec3(10, 20, 10), 'overworld', 'zombie')
  memory.addPoi('spawner', new Vec3(30, 20, 10), 'overworld', 'skeleton')
  assert.deepEqual(knownFarmableSpawners(memory).map(s => s.mob), ['zombie'])
  rememberXpFarm(memory, { spawner: new Vec3(10, 20, 10), mob: 'zombie', stand: new Vec3(15, 20, 10), barrier: new Vec3(14, 20, 10), dimension: 'overworld' })
  rememberXpFarm(memory, { spawner: new Vec3(10, 20, 10), mob: 'zombie', stand: new Vec3(10, 20, 15), barrier: new Vec3(10, 20, 14), dimension: 'overworld' })
  const farms = knownXpFarms(WorldMemory.fromJSON(memory.toJSON()))
  assert.equal(farms.length, 1)
  assert.ok(farms[0].stand.equals(new Vec3(10, 20, 15)) && farms[0].barrier.equals(new Vec3(10, 20, 14)))
  // the levels go to it from near enough, not from across the world or another dimension
  assert.ok(nearestXpFarm(memory, new Vec3(50, 60, 50)) != null)
  assert.equal(nearestXpFarm(memory, new Vec3(1000, 60, 50)), null)
  assert.equal(nearestXpFarm(memory, new Vec3(10, 20, 10), 'the_nether'), null)
})

test('the pathfinder is kept out of the farm\'s room (the booth left in) and off its barrier, once a farm', async () => {
  const { boothSides, keepOutOfFarm } = await import('../../src/skills/spawnerFarm')
  const settings: any = { exclusionAreasStep: [], exclusionAreasBreak: [] }
  const bot: any = { pathfinder: { defaultMoveSettings: settings, setMoveOptions: (s: any) => { bot.pathfinder.defaultMoveSettings = s } } }
  const farm = { spawner: new Vec3(0, 20, 0), stand: new Vec3(5, 20, 0), barrier: new Vec3(4, 20, 0) }
  keepOutOfFarm(bot, farm)
  keepOutOfFarm(bot, farm)
  const s = bot.pathfinder.defaultMoveSettings
  assert.equal(s.exclusionAreasStep.length, 1)
  const step = (p: Vec3): number => s.exclusionAreasStep[0]({ position: p })
  const brk = (p: Vec3): number => s.exclusionAreasBreak[0]({ position: p })
  assert.ok(step(new Vec3(2, 20, 1)) >= 1e9 && step(new Vec3(-3, 19, 3)) >= 1e9)
  assert.equal(step(new Vec3(5, 20, 0)), 0)
  assert.equal(step(new Vec3(4, 21, 7)), 0)
  assert.ok(brk(new Vec3(4, 20, 0)) >= 1e9 && brk(new Vec3(4, 22, 0)) >= 1e9)
  assert.equal(brk(new Vec3(4, 21, 0)), 0)
  // the booth's sides to fill: not the slit's way, the head's cell over it
  const sides = boothSides(farm).map(p => p.toString())
  assert.equal(sides.length, 7)
  assert.ok(!sides.includes(new Vec3(4, 20, 0).toString()) && sides.includes(new Vec3(6, 21, 0).toString()) && sides.includes(new Vec3(5, 22, 0).toString()))
})
