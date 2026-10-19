// Obsidian from a lava pool: where the water is poured for a source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { pourSpot } from '../../src/nether/obsidian'

test('pourSpot: the air beside a lava source with solid ground under it; none when the lava is walled in or over lava', () => {
  // a cave floor of stone at y 46, a lava pool at x 0..2, z 0, y 47; air elsewhere at 47
  const cave = (p: Vec3) => {
    if (p.y < 47) return { name: p.x >= 0 && p.x <= 2 && p.z === 0 && p.y === 46 ? 'stone' : 'stone', boundingBox: 'block' }
    if (p.y === 47 && p.z === 0 && p.x >= 0 && p.x <= 2) return { name: 'lava', boundingBox: 'empty', properties: { level: 0 } }
    return { name: p.y === 47 ? 'cave_air' : 'stone', boundingBox: p.y === 47 ? 'empty' : 'block' }
  }
  const spot = pourSpot(cave, new Vec3(0, 47, 0)) as Vec3
  assert.ok(spot != null)
  assert.equal(cave(spot).name, 'cave_air')
  assert.equal(spot.y, 47)
  // the middle source: lava on two sides, air on the others
  assert.ok(pourSpot(cave, new Vec3(1, 47, 0)) != null)
  const walled = (p: Vec3) => (p.x === 0 && p.y === 47 && p.z === 0) ? { name: 'lava', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }
  assert.equal(pourSpot(walled, new Vec3(0, 47, 0)), null)
})
