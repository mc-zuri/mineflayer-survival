// crossToIsland's choices without a server: the way toward 0, 0, whether the bot is off the island, and each step.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { islandStep, offTheIsland, towardCenter } from '../../src/end/skills/island'

// the arrival platform (obsidian at y 48, x 98..102, z -2..2), the void, and the island's end stone from x 75 in,
// its top at y 60 (a wall at x 75..80 from y 40 up to 60 standing in the bridge's way)
function world (p: Vec3): { name: string, boundingBox: string } {
  const solid = (name: string) => ({ name, boundingBox: 'block' })
  if (p.y === 48 && p.x >= 98 && p.x <= 102 && Math.abs(p.z) <= 2) return solid('obsidian')
  if (p.x <= 80 && p.y >= 40 && p.y <= 60) return solid('end_stone')
  return { name: 'air', boundingBox: 'empty' }
}

test('the way to the island: toward 0, 0 along the platform\'s axis; off the island on the platform, not on the island', () => {
  assert.deepStrictEqual(towardCenter({ x: 100.5, z: 0.5 }), new Vec3(-1, 0, 0))
  assert.deepStrictEqual(towardCenter({ x: 3, z: -90 }), new Vec3(0, 0, 1))
  assert.strictEqual(offTheIsland(world, new Vec3(100, 49, 0)), true)
  assert.strictEqual(offTheIsland(world, new Vec3(30, 61, 0)), false)
})

test('each step: walked on the platform, bridged over the void, dug through the island\'s side', () => {
  const dir = new Vec3(-1, 0, 0)
  assert.strictEqual(islandStep(world, new Vec3(100, 49, 0), dir), 'walk')
  assert.strictEqual(islandStep(world, new Vec3(98, 49, 0), dir), 'bridge')
  assert.strictEqual(islandStep(world, new Vec3(85, 49, 0), dir), 'bridge')
  assert.strictEqual(islandStep(world, new Vec3(81, 49, 0), dir), 'dig')
})
