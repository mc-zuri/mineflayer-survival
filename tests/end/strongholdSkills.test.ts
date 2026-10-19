import { test } from 'node:test'
import assert from 'node:assert'
import { STRONGHOLD_BLOCKS, craftEyes, overWater, rememberRay, rememberedRays, toThrowingSpot, nextAlongRay, EYE_RAY } from '../../src/end/strongholdSkills'
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

test('the throws\' rays are remembered and come back from a save: the search goes on from them after a reflex cut it off', () => {
  const { WorldMemory } = require('../../src/core/memory')
  const memory = new WorldMemory()
  rememberRay(memory, { origin: { x: -27.5, z: 10.5 }, direction: { x: 0.12963, z: -0.99156 } })
  rememberRay(memory, { origin: { x: 464.05, z: -48.5 }, direction: { x: -0.87773, z: 0.47917 } })
  const back = WorldMemory.fromJSON(JSON.parse(JSON.stringify(memory.toJSON())))
  const rays = rememberedRays(back)
  assert.strictEqual(rays.length, 2)
  assert.deepStrictEqual(rays[0], { origin: { x: -27, z: 11 }, direction: { x: 0.12963, z: -0.99156 } })
  assert.deepStrictEqual(rays[1].direction, { x: -0.87773, z: 0.47917 })
  assert.strictEqual(back.getPois(EYE_RAY).length, 2)
})

test('toThrowingSpot: a bot on dry ground under the open sky throws where it stands; one in a cave goes up first', async () => {
  const { Vec3 } = require('vec3')
  const used: string[] = []
  const pathfinder = new Proxy({}, { get: (_t, k) => { used.push(String(k)); return () => { throw new Error('no pathfinder here') } } })
  const surface = fakeBot({ position: new Vec3(0.5, 70, 0.5), world: (p: any) => p.y < 70 ? 'stone' : 'air' })
  surface.game.dimension = 'overworld'
  surface.pathfinder = pathfinder
  await toThrowingSpot(surface)
  assert.deepStrictEqual(used, [])
  // underground: a roof of rock over a cave at y -20
  const cave = fakeBot({ position: new Vec3(0.5, -20, 0.5), world: (p: any) => p.y >= -20 && p.y <= -18 ? 'air' : 'stone' })
  cave.game.dimension = 'overworld'
  cave.pathfinder = pathfinder
  await toThrowingSpot(cave).catch(() => {})
  assert.ok(used.length > 0, 'no way up was looked for')
})

test('nextAlongRay: on along the eyes\' flight, the step doubling while they fly on and halving once one flies back; a good crossing ahead is gone to', () => {
  const east = (x: number) => ({ origin: { x, z: 0 }, direction: { x: 1, z: 0 } })
  const west = (x: number) => ({ origin: { x, z: 0 }, direction: { x: -1, z: 0 } })
  let a = nextAlongRay(null, east(0), null)
  assert.deepStrictEqual([a.step, a.target], [32, { x: 32, z: 0 }])
  a = nextAlongRay(a, east(32), null)
  assert.deepStrictEqual([a.step, a.target], [64, { x: 96, z: 0 }])
  a = nextAlongRay(a, east(96), null)
  assert.deepStrictEqual([a.step, a.target], [128, { x: 224, z: 0 }])
  // passed it: the eye flies back
  a = nextAlongRay(a, west(224), null)
  assert.deepStrictEqual([a.step, a.target], [64, { x: 160, z: 0 }])
  // a crossing well conditioned and ahead
  const crossing: any = { x: 190, z: 3, crossingAngle: 30 }
  assert.deepStrictEqual(nextAlongRay(a, east(160), crossing).target, { x: 190, z: 3 })
  // behind the throw: on along the ray instead
  assert.deepStrictEqual(nextAlongRay(null, east(200), crossing).target, { x: 232, z: 0 })
})
