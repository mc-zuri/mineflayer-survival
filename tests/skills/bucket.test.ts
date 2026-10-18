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
