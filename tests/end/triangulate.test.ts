import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EYE_UPDATE_INTERVAL, eyeSpawnPosition, inferThrowDirection, simulateEye, type Vec } from '../../src/end/eye'
import { secondThrowPoint, triangulate, type EyeRay } from '../../src/end/triangulate'
import { guessFromOneThrow, nearestStronghold, strongholdRings, strongholdsForSeed } from '../../src/end/stronghold'

/** throws an eye from `feet` at the locate pos and reads the ray back from what the client would see */
function throwAt (feet: Vec, stronghold: Vec, jitter = 0): EyeRay {
  const spawn = eyeSpawnPosition(feet)
  const q = (v: number): number => Math.round(v * 4096) / 4096
  const positions = simulateEye(spawn, stronghold)
    .filter((_, i) => (i + 1) % EYE_UPDATE_INTERVAL === 0)
    .map(s => ({ x: q(s.position.x) + jitter * Math.sin(s.life * 7.1), y: q(s.position.y), z: q(s.position.z) + jitter * Math.cos(s.life * 3.3) }))
  const dir = inferThrowDirection({ spawn, positions })
  assert.ok(dir != null)
  return { origin: dir.origin, direction: dir.direction }
}

const STRONGHOLD = { x: 1696, y: 0, z: -912 }

test('two throws from synthetic eye flights recover the stronghold within a couple of blocks', () => {
  const a = throwAt({ x: 10.5, y: 70, z: 20.5 }, STRONGHOLD)
  const second = secondThrowPoint(a, 60)
  const b = throwAt({ x: second.x, y: 70, z: second.z }, STRONGHOLD)
  const est = triangulate([a, b])
  assert.ok(est != null)
  const miss = Math.hypot(est.x - STRONGHOLD.x, est.z - STRONGHOLD.z)
  assert.ok(miss < 2, `missed by ${miss}`)
  assert.ok(est.crossingAngle > 1.5)
  assert.ok(est.error > miss, `error ${est.error} should cover the miss ${miss}`)
})

test('noisy reads still land within a few blocks, and more throws tighten the error', () => {
  const throws = [
    throwAt({ x: 0.5, y: 70, z: 0.5 }, STRONGHOLD, 0.03),
    throwAt({ x: 300.5, y: 70, z: 400.5 }, STRONGHOLD, 0.03),
    throwAt({ x: 900.5, y: 70, z: -300.5 }, STRONGHOLD, 0.03)
  ]
  const two = triangulate(throws.slice(0, 2))
  const three = triangulate(throws)
  assert.ok(two != null && three != null)
  assert.ok(Math.hypot(three.x - STRONGHOLD.x, three.z - STRONGHOLD.z) < 5)
  assert.ok(three.error < two.error)
})

test('parallel rays and rays crossing behind the throws give no estimate', () => {
  assert.equal(triangulate([{ origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 } }, { origin: { x: 0, z: 10 }, direction: { x: 1, z: 0 } }]), null)
  assert.equal(triangulate([{ origin: { x: 0, z: 0 }, direction: { x: 1, z: 1 } }, { origin: { x: 10, z: 0 }, direction: { x: -1, z: 1 } }].map(r => ({ ...r, direction: { x: -r.direction.x, z: -r.direction.z } }))), null)
})

test('the ring layout: 3 strongholds at 1296-2816 blocks, then 6, 10, ... to 128', () => {
  const rings = strongholdRings()
  assert.deepEqual(rings.map(r => r.count), [3, 6, 10, 15, 21, 28, 36, 9])
  assert.equal(rings.reduce((s, r) => s + r.count, 0), 128)
  assert.equal(rings[0].minDistance, 1296)
  assert.equal(rings[0].maxDistance, 2816)
})

test('one throw and the ring prior: the guess is on the ray inside the first ring', () => {
  const g = guessFromOneThrow({ origin: { x: 0, z: 0 }, direction: { x: 1, z: 1 } })
  assert.ok(g != null)
  assert.equal(g.ring, 0)
  const r = Math.hypot(g.x, g.z)
  assert.ok(r > 1296 && r < 2816)
  assert.ok(Math.abs(g.x - g.z) < 1e-6)
})

test('with the seed, the nearest stronghold is the one the eye flies to', () => {
  const all = strongholdsForSeed(12345)
  assert.equal(all.length, 128)
  // seed 12345's first ring (vanilla: chunks -105,124 / -39,-107 / 114,21)
  assert.deepEqual(all.filter(s => s.ring === 0).map(s => [s.x, s.z]).sort(), [[-105, 124], [-39, -107], [114, 21]].sort())
  const near = nearestStronghold(12345, { x: 1500, y: 70, z: 300 })
  assert.deepEqual([near.x, near.z], [114, 21])
  assert.deepEqual(near.block, { x: 114 * 16, y: 0, z: 21 * 16 })
})
