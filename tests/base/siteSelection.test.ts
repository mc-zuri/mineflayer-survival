import { test } from 'node:test'
import assert from 'node:assert'
import { BlockGetter, scoreSite, selectSite, siteCandidates } from '../../src/base'

// Grass at y 64 over three layers of dirt and stone below, a lake 14 deep at x >= 40, and a range of
// hills at z >= 60.
const world: BlockGetter = (x, y, z) => {
  const surface = z >= 60 ? 64 + ((x * 7 + z * 3) % 9) : 64
  if (x >= 40 && x < 60 && z < 40 && y > 50 && y <= 64) return 'water'
  if (y > surface) return null
  if (y === surface) return 'grass_block'
  if (y > surface - 4) return 'dirt'
  return 'stone'
}

test('site selection prefers deep stone away from water under level ground', () => {
  const deep = { x: 0, y: 40, z: 0 }
  const shallow = { x: 0, y: 57, z: 0 }
  const nearLake = { x: 30, y: 40, z: 0 }
  const hills = { x: 0, y: 40, z: 80 }
  const ranked = selectSite(world, [shallow, nearLake, hills, deep])
  assert.deepStrictEqual(ranked[0].origin, deep)
  const by = (o: { x: number, y: number, z: number }) => ranked.find(r => r.origin === o)!
  assert.strictEqual(by(deep).fluidDistance, Infinity)
  assert.strictEqual(by(deep).shellInPlace, 1)
  assert.ok(by(deep).stoneCover >= 8)
  assert.strictEqual(by(deep).surfaceRange, 0)
  assert.ok(by(shallow).stoneCover < 3 && by(shallow).reasons.some(r => r.includes('stone over the roof')))
  assert.ok(by(nearLake).fluidDistance < 8 && by(nearLake).reasons.some(r => r.includes('water or lava')))
  assert.ok(by(hills).surfaceRange > 4)
  for (const r of ranked.slice(1)) assert.ok(r.score < ranked[0].score)
})

test('a site cut through by the lake is the worst', () => {
  const inLake = scoreSite(world, { x: 45, y: 55, z: 5 })
  assert.strictEqual(inLake.fluidDistance, 0)
  assert.ok(inLake.score < scoreSite(world, { x: 0, y: 40, z: 0 }).score - 100)
})

test('siteCandidates spreads origins on a grid at each depth', () => {
  const c = siteCandidates({ x: 0.5, y: 64, z: 0.5 }, 16, 16, [20, 30])
  assert.strictEqual(c.length, 3 * 3 * 2)
  assert.ok(c.some(p => p.x === -16 && p.y === 44 && p.z === 16))
})
