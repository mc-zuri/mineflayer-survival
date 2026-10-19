// The End Cities' placement, their purpur clusters, the ship's item frame and where to stand to hit it, without a server.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { END_CITIES } from '../../src/worldgen/placement'
import { endCityCandidates, frameItemName, purpurClusters } from '../../src/end/endCity'
import { frameStand } from '../../src/end/skills/endCity'

test('the End Cities\' structure set is vanilla\'s: a random spread of 20, a separation of 11, triangular, salt 10387313', () => {
  assert.deepStrictEqual(END_CITIES.placement, { spacing: 20, separation: 11, salt: 10387313, spreadType: 'triangular' })
})

// /locate structure minecraft:end_city on a 26.3 server with seed "elytra" (-1299962959) from the arrival of a
// gateway and five other places: the chunks of the cities that generated (the locate's block is the chunk's corner)
const LOCATED: Array<[number, number, number, number]> = [
  // from x, z; the city's chunk x, z
  [670, 912, 26, 61], [1500, 0, 84, 4], [0, -1500, 4, -118], [-1200, 1200, -55, 46], [-2000, -300, -158, -36], [3000, 3000, 168, 166]
]

test('every city a server located is among the candidates the seed gives round where it was looked for from', () => {
  for (const [x, z, cx, cz] of LOCATED) {
    const candidates = endCityCandidates(-1299962959, { x, z }, { radius: 1 })
    assert.ok(candidates.some(c => c.chunkX === cx && c.chunkZ === cz), `no candidate at chunk ${cx}, ${cz} round ${x}, ${z}`)
  }
  // nearest first, each a chunk's block 7, 7 out on the outer islands
  const c = endCityCandidates(-1299962959, { x: 670, z: 912 })
  assert.ok(c.every((k, i) => i === 0 || c[i - 1].distance <= k.distance))
  assert.ok(c.every(k => k.x === k.chunkX * 16 + 7 && Math.hypot(k.x, k.z) >= 1000))
  // none round 0, 0: the main island's void
  assert.deepStrictEqual(endCityCandidates(-1299962959, { x: 0, z: 0 }, { radius: 1 }), [])
})

test('purpur gathers into cities: the big clusters, a stray few left out', () => {
  const pts: Array<{ x: number, y: number, z: number }> = []
  for (let i = 0; i < 40; i++) pts.push({ x: 1190 + (i % 8), y: 60 + i, z: -20 + Math.floor(i / 8) })
  for (let i = 0; i < 20; i++) pts.push({ x: 1263 + (i % 5), y: 127 + (i % 3), z: 4 + Math.floor(i / 5) })
  pts.push({ x: 900, y: 70, z: 900 })
  const clusters = purpurClusters(pts)
  assert.strictEqual(clusters.length, 2)
  assert.strictEqual(clusters[0].count, 40)
  assert.strictEqual(clusters[0].minY, 60)
  assert.ok(Math.abs(clusters[1].center.x - 1265) <= 1)
  // two groups joined by a bridge of purpur are one
  const bridged = purpurClusters([...pts, ...Array.from({ length: 6 }, (_, i) => ({ x: 1200 + i * 10, y: 100, z: 0 }))])
  assert.strictEqual(bridged.length, 1)
})

test('the frame\'s item from its metadata: mineflayer\'s slot data by id, an empty frame none', () => {
  const names: Record<number, string> = { 974: 'elytra', 1: 'stone' }
  assert.strictEqual(frameItemName({ itemCount: 1, itemId: 974, addedComponentCount: 0 }, id => names[id]), 'elytra')
  assert.strictEqual(frameItemName({ itemCount: 0 }, id => names[id]), null)
  assert.strictEqual(frameItemName(null, id => names[id]), null)
  assert.strictEqual(frameItemName({ name: 'elytra', count: 1 }, id => names[id]), 'elytra')
})

test('the stand to hit a frame from: two out along its facing, the feet a block under it', () => {
  // the ship's frame at (1274.97, 132.5, 4.5) facing west (4): on the hull's wall at x 1275, the room to the west
  assert.deepStrictEqual(frameStand(new Vec3(1274.96875, 132.5, 4.5), 4), new Vec3(1272, 131, 4))
  assert.deepStrictEqual(frameStand(new Vec3(10.5, 70.5, 3.03), 3), new Vec3(10, 69, 5))
})
