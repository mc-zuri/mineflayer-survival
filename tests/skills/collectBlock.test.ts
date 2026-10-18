import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { columnHarvestTarget, COLUMN_PLANTS } from '../../src/skills/collectBlock'

// blocks by "x,y,z"; air elsewhere
function world (blocks: Record<string, string>): (pos: Vec3) => { name: string } {
  return pos => ({ name: blocks[`${pos.x},${pos.y},${pos.z}`] ?? 'air' })
}

test('columnHarvestTarget: the second block of a sugar cane column, from any block of it; none for a column of one', () => {
  const lookup = world({ '0,0,0': 'sand', '0,1,0': 'sugar_cane', '0,2,0': 'sugar_cane', '0,3,0': 'sugar_cane', '2,1,0': 'sugar_cane' })
  for (const y of [1, 2, 3]) assert.deepStrictEqual(columnHarvestTarget(lookup, new Vec3(0, y, 0)), new Vec3(0, 2, 0), `from y ${y}`)
  // a lone cane is left to grow
  assert.strictEqual(columnHarvestTarget(lookup, new Vec3(2, 1, 0)), null)
  assert.strictEqual(columnHarvestTarget(lookup, new Vec3(5, 1, 0)), null)
  // a bamboo column, two high
  const bamboo = world({ '0,1,0': 'bamboo', '0,2,0': 'bamboo' })
  assert.deepStrictEqual(columnHarvestTarget(bamboo, new Vec3(0, 2, 0)), new Vec3(0, 2, 0))
  assert.ok(COLUMN_PLANTS.has('sugar_cane') && COLUMN_PLANTS.has('cactus') && !COLUMN_PLANTS.has('oak_log'))
})
