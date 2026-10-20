import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { castCandidates, isSource, surfacePoints } from '../../src/skills/bucket'

test('castCandidates: beside the lava, above it, then above the blocks beside it', () => {
  const cells = castCandidates(new Vec3(5, -61, 5)).map(pos => pos.toArray().join(','))
  assert.deepStrictEqual(cells.slice(0, 5), ['5,-61,4', '5,-61,6', '4,-61,5', '6,-61,5', '5,-60,5'])
  assert.strictEqual(cells.length, 9)
})

test('isSource: a fluid of level 0', () => {
  const fluid = (name: string, level: number): any => ({ name, getProperties: () => ({ level: String(level) }) })
  assert.strictEqual(isSource(fluid('lava', 0), 'lava'), true)
  assert.strictEqual(isSource(fluid('lava', 2), 'lava'), false)
  assert.strictEqual(isSource(fluid('water', 0), 'lava'), false)
  assert.strictEqual(isSource({ name: 'water', metadata: 0 }, 'water'), true)
  assert.strictEqual(isSource(null, 'water'), false)
})

test('surfacePoints: the surface, the sides and the bottom of a source\'s shape, inside its block', () => {
  const pts = surfacePoints(new Vec3(3, 70, -2))
  assert.strictEqual(pts.length, 12)
  for (const p of pts) assert.ok(p.x > 3 && p.x < 4 && p.y > 70 && p.y < 70 + 8 / 9 && p.z > -2 && p.z < -1, p.toString())
  assert.ok(pts.some(p => p.y < 70.05), 'no point on the bottom')
})

test('renewableWater: a source with two sources beside it fills again once taken; a lone one (a farm\'s water hole) or a pool\'s edge with one does not', async () => {
  const { renewableWater } = await import('../../src/skills/bucket')
  const pool = new Set(['0,62,0', '1,62,0', '-1,62,0', '0,62,1', '5,62,5', '6,62,5'])
  const lookup = (p: Vec3): any => pool.has(`${p.x},${p.y},${p.z}`) ? { name: 'water', getProperties: () => ({ level: 0 }) } : { name: 'stone' }
  assert.strictEqual(renewableWater(lookup, new Vec3(0, 62, 0)), true)
  assert.strictEqual(renewableWater(lookup, new Vec3(1, 62, 0)), false)
  assert.strictEqual(renewableWater(lookup, new Vec3(5, 62, 5)), false)
  assert.strictEqual(renewableWater(lookup, new Vec3(9, 62, 9)), false)
})

test('keepWaterBucket: only with an empty bucket and no water bucket, at a renewable source only (full-26.3-fresh-r: a 35-block fall with an empty bucket)', async () => {
  const { keepWaterBucket, waterBucketEmpty } = await import('../../src/skills/bucket')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const full = fakeBot({ items: [item('water_bucket', 1), item('bucket', 1)] })
  assert.strictEqual(waterBucketEmpty(full), false)
  assert.strictEqual(await keepWaterBucket(full), false)
  const empty = fakeBot({ items: [item('bucket', 1)] })
  assert.strictEqual(waterBucketEmpty(empty), true)
  // the only water a lone source: none taken
  const lone = new Vec3(3, 63, 3)
  empty.findBlocks = () => [lone]
  empty.blockAt = (p: Vec3) => p.equals(lone) ? { name: 'water', position: p, getProperties: () => ({ level: 0 }) } : { name: 'stone', position: p }
  assert.strictEqual(await keepWaterBucket(empty), false)
})

test('keepWaterSource: a renewable source at the top of the water, not one under the water (full-26.3-fresh-z); viewSpots: no stand with the head in the water', async () => {
  const { keepWaterSource, viewSpots } = await import('../../src/skills/bucket')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // a pool x -2 to 2, z -2 to 2, y 60 to 62 of water sources, stone round and under it, air over y 62
  const name = (p: Vec3): string => (Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 && p.y >= 60 && p.y <= 62) ? 'water' : p.y <= 62 ? 'stone' : 'air'
  const lookup = (p: Vec3): any => ({ name: name(p), boundingBox: name(p) === 'stone' ? 'block' : 'empty', getProperties: () => ({ level: 0 }) })
  assert.deepStrictEqual(keepWaterSource(lookup, [new Vec3(0, 60, 0), new Vec3(0, 61, 0), new Vec3(0, 62, 0)]), new Vec3(0, 62, 0))
  assert.strictEqual(keepWaterSource(lookup, [new Vec3(0, 60, 0), new Vec3(1, 61, 0)]), null)
  const bot = fakeBot({ position: new Vec3(4.5, 63, 0.5), world: name })
  const spots = viewSpots(bot, new Vec3(0, 62, 0), 1.62, () => true)
  assert.ok(spots.length > 0)
  for (const spot of spots) assert.notStrictEqual(name(spot.offset(0, 1, 0)), 'water', spot.toString())
  assert.ok(!spots.some(s => s.y === 60), 'the floor of the pool')
})
