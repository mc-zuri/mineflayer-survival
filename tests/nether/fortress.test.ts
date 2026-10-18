import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateBlazeSpawner, explorationRoute, fortressCandidates, netherComplexes, recognizeFortress } from '../../src/nether/fortress'

// vanilla 1.21.11 (tests/worldgen/placement.test.ts has the full table): seed 12345, region
// (0, 0) → chunk (12, 20), roll 2 (bastion); region (-1, -2) → chunk (-13, -37), roll 0 (fortress)
test('the complexes for a known seed come from the region grid, with the fortress roll', () => {
  const all = netherComplexes(12345, { x: 100, z: 100 }, { radius: 2 })
  assert.equal(all.length, 25)
  const home = all.find(c => c.regionX === 0 && c.regionZ === 0)
  assert.deepEqual(home && [home.chunkX, home.chunkZ, home.roll, home.structure], [12, 20, 2, 'bastion_remnant'])
  const f = all.find(c => c.regionX === -1 && c.regionZ === -2)
  assert.deepEqual(f && [f.chunkX, f.chunkZ, f.roll, f.structure, f.x, f.z], [-13, -37, 0, 'fortress', -13 * 16 + 2, -37 * 16 + 2])
  // nearest first, and fortresses are the rolls under 2
  for (let i = 1; i < all.length; i++) assert.ok(all[i].distance >= all[i - 1].distance)
  const forts = fortressCandidates(12345, { x: 100, z: 100 }, { radius: 2 })
  assert.ok(forts.length > 0 && forts.every(c => c.roll < 2))
  // a bastion chunk in basalt deltas is a fortress
  const deltas = fortressCandidates(12345, { x: 100, z: 100 }, { radius: 2, isBasaltDeltas: (x, z) => x === 12 && z === 20 })
  assert.ok(deltas.some(c => c.chunkX === 12 && c.chunkZ === 20))
})

test('the unknown-seed walk is a straight line along an axis', () => {
  const route = explorationRoute({ x: -40, y: 70, z: 300 }, { length: 320 })
  assert.equal(route.length, 10)
  // farther out along z than x: it walks parallel to the z axis, away from 0
  assert.ok(route.every(p => p.x === -40 && p.y === 64))
  assert.deepEqual(route.slice(0, 2).map(p => p.z), [332, 364])
  const alongX = explorationRoute({ x: -500, y: 70, z: 20 }, { length: 64 })
  assert.deepEqual(alongX.map(p => [p.x, p.z]), [[-532, 20], [-564, 20]])
})

test('nether bricks and fences mark a fortress; blackstone does not', () => {
  const scan = [
    { name: 'netherrack', pos: { x: 0, y: 60, z: 0 } },
    { name: 'nether_brick_fence', pos: { x: 10, y: 66, z: 4 } },
    { name: 'nether_bricks', pos: { x: 12, y: 64, z: 4 } },
    { name: 'nether_bricks', pos: { x: 14, y: 64, z: 4 } }
  ]
  const f = recognizeFortress(scan)
  assert.ok(f != null)
  assert.equal(f.fences, 1)
  assert.deepEqual(f.center, { x: 12, y: 65, z: 4 })
  assert.equal(recognizeFortress([{ name: 'polished_blackstone_bricks', pos: { x: 0, y: 0, z: 0 } }, { name: 'nether_bricks', pos: { x: 1, y: 0, z: 0 } }]), null)
})

test('the blaze spawner: a seen spawner, else the cluster of blazes, else the fortress', () => {
  const fortress = recognizeFortress([{ name: 'nether_brick_fence', pos: { x: 0, y: 64, z: 0 } }, { name: 'nether_bricks', pos: { x: 60, y: 72, z: 30 } }])
  assert.deepEqual(estimateBlazeSpawner({ spawners: [{ x: 20, y: 70, z: 10 }, { x: 500, y: 40, z: 500 }], fortress }), { x: 20, y: 70, z: 10, source: 'spawner', confidence: 1 })
  const blazes = [{ x: 40, y: 71, z: 12 }, { x: 42, y: 72, z: 14 }, { x: 39, y: 70, z: 15 }, { x: -30, y: 60, z: 0 }]
  const est = estimateBlazeSpawner({ blazes, fortress })
  assert.ok(est != null)
  assert.equal(est.source, 'blazes')
  assert.ok(Math.hypot(est.x - 40, est.z - 13) < 2)
  assert.equal(estimateBlazeSpawner({ fortress })?.source, 'explore')
  assert.equal(estimateBlazeSpawner({}), null)
})
