// Obsidian from a lava pool: where the water is poured for a source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { pourSpot, pourTarget } from '../../src/nether/obsidian'

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

test('pourTarget: a source with ground beside it first; in a lake, one open to the air above, the water poured into it', () => {
  // a 5 x 5 lake at y 47 walled by stone, air above
  const lake = (p: Vec3) => {
    if (p.y === 47 && Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2) return { name: 'lava', boundingBox: 'empty', properties: { level: 0 } }
    if (p.y >= 48) return { name: 'cave_air', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  assert.equal(pourTarget(lake, [new Vec3(0, 47, 0)]), null)
  const t = pourTarget(lake, [new Vec3(0, 47, 0)], true)
  assert.deepEqual(t, { source: new Vec3(0, 47, 0), spot: new Vec3(0, 47, 0), side: false })
  // the shore: a source at the edge with a floor beside it at its level
  const shore = (p: Vec3) => (p.x === 3 && p.y === 47 && p.z === 0) ? { name: 'cave_air', boundingBox: 'empty' } : lake(p)
  assert.deepEqual(pourTarget(shore, [new Vec3(0, 47, 0), new Vec3(2, 47, 0)])?.spot, new Vec3(3, 47, 0))
  assert.equal(pourTarget((p: Vec3) => ({ name: 'stone', boundingBox: 'block' }), [new Vec3(0, 47, 0)]), null)
})

test('refillWater: nothing done with a water bucket held or no empty bucket; with an empty one and no water near, false', async () => {
  const { refillWater } = await import('../../src/nether/obsidian')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  let looked = 0
  const withWater = fakeBot({ items: [item('water_bucket', 1), item('bucket', 1)] })
  ;(withWater as any).findBlock = () => { looked++; return null }
  assert.equal(await refillWater(withWater), false)
  const noBucket = fakeBot({ items: [item('cobblestone', 8)] })
  ;(noBucket as any).findBlock = () => { looked++; return null }
  assert.equal(await refillWater(noBucket), false)
  assert.equal(looked, 0)
  const empty = fakeBot({ items: [item('bucket', 1)] })
  ;(empty as any).findBlock = () => { looked++; return null }
  assert.equal(await refillWater(empty), false)
  assert.equal(looked, 1)
})

test('pitSite: a floor cell walled and floored in stone, open two above, PIT_CLEARANCE off the lake; none on the lake', async () => {
  const { pitSite, PIT_CLEARANCE } = await import('../../src/nether/obsidian')
  // stone below y 64, a 4 x 4 lake 2 deep at x 4 to 7 (y 62, 63), air from 64
  const lakeAt = (p: Vec3): boolean => p.x >= 4 && p.x <= 7 && p.z >= 0 && p.z <= 3 && (p.y === 62 || p.y === 63)
  const get = (p: Vec3): { name: string, boundingBox: string } => lakeAt(p) ? { name: 'lava', boundingBox: 'empty' } : p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const lava: Vec3[] = []
  for (let x = 4; x <= 7; x++) for (let z = 0; z <= 3; z++) for (const y of [62, 63]) lava.push(new Vec3(x, y, z))
  const pit = pitSite(get as any, new Vec3(0, 64, 1), lava)
  assert.ok(pit != null)
  assert.equal(pit.y, 63)
  assert.ok(lava.every(l => Math.max(Math.abs(l.x - pit.x), Math.abs(l.z - pit.z)) > PIT_CLEARANCE), pit.toString())
  // the bot on the lake's far side with no floor near but the lake's lid: lava all round within reach, none
  const sea = (p: Vec3): { name: string, boundingBox: string } => p.y === 63 ? { name: 'lava', boundingBox: 'empty' } : p.y < 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  const seaLava: Vec3[] = []
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) seaLava.push(new Vec3(x, 63, z))
  assert.equal(pitSite(sea as any, new Vec3(0, 64, 0), seaLava), null)
})
