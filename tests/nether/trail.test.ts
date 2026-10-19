import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { TRAIL_KEPT, TRAIL_STEP, extendTrail, pruneTrail, trailPoints, trailRoute } from '../../src/nether/trail'

/** a trail laid along the points, a step at a time */
function lay (memory: WorldMemory, points: Array<[number, number, number]>): void {
  for (const [x, y, z] of points) extendTrail(memory, { x, y, z })
}

test('extendTrail: a point every TRAIL_STEP blocks walked, numbered in order; the oldest dropped past TRAIL_KEPT', () => {
  const memory = new WorldMemory()
  for (let x = 0; x <= 100; x++) extendTrail(memory, { x, y: 70, z: 0 })
  const points = trailPoints(memory)
  assert.deepEqual(points.map(p => p.x), [0, 12, 24, 36, 48, 60, 72, 84, 96])
  assert.deepEqual(points.map(p => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (let x = 101; x <= TRAIL_STEP * (TRAIL_KEPT + 20); x += TRAIL_STEP) extendTrail(memory, { x, y: 70, z: 0 })
  assert.equal(trailPoints(memory).length, TRAIL_KEPT)
  assert.ok(trailPoints(memory)[0].x > 0)
})

test('trailRoute: the way walked from near the start to near the end, either way, its loop cut short; none off the trail or far round', () => {
  const memory = new WorldMemory()
  // west 120 blocks along z 0, a loop out to z 40 and back on the way, then on south to z -60 (the way round a lava sea)
  const walk: Array<[number, number, number]> = []
  for (let x = 0; x >= -60; x -= 12) walk.push([x, 70, 0])
  walk.push([-60, 70, 12], [-60, 70, 24], [-60, 70, 36], [-62, 70, 24], [-62, 70, 12], [-64, 70, 0])
  for (let x = -72; x >= -120; x -= 12) walk.push([x, 70, 0])
  for (let z = -12; z >= -60; z -= 12) walk.push([-120, 70, z])
  lay(memory, walk)
  const route = trailRoute(memory, { x: 2, y: 70, z: 3 }, { x: -118, y: 70, z: -62 })
  assert.ok(route.length > 0)
  // along it to the end, not into the loop to z 36
  assert.ok(route.every(p => p.z <= 12), route.map(p => p.toString()).join(' '))
  assert.deepEqual(route[route.length - 1].toArray(), [-120, 70, -60])
  // each point near the one before it (TRAIL_SKIP, or the next point walked)
  let at = new Vec3(0, 70, 0)
  for (const p of route) { assert.ok(p.distanceTo(at) <= 24, `${at} > ${p}`); at = p }
  // and back
  const back = trailRoute(memory, { x: -120, y: 70, z: -60 }, { x: 0, y: 70, z: 0 })
  assert.deepEqual(back[back.length - 1].toArray(), [0, 70, 0])
  assert.ok(back.some(p => p.x === -120 && p.z === -12))
  // a target off the trail: none
  assert.deepEqual(trailRoute(memory, { x: 0, y: 70, z: 0 }, { x: 200, y: 70, z: 200 }), [])
  // a way along the trail far longer than the straight one: none (a U out east 120 blocks and back, its ends 24 apart)
  const u = new WorldMemory()
  const legs: Array<[number, number, number]> = []
  for (let x = 0; x <= 120; x += 12) legs.push([x, 70, 0])
  for (let x = 120; x >= 0; x -= 12) legs.push([x, 70, 24])
  lay(u, legs)
  assert.deepEqual(trailRoute(u, { x: 0, y: 70, z: 0 }, { x: 0, y: 70, z: 24 }), [])
  assert.ok(trailRoute(u, { x: 0, y: 70, z: 0 }, { x: 120, y: 70, z: 0 }).length > 0)
})

test('pruneTrail: a death drops the points near it', () => {
  const memory = new WorldMemory()
  for (let x = 0; x <= 120; x += 12) extendTrail(memory, { x, y: 70, z: 0 })
  pruneTrail(memory, { x: 60, y: 70, z: 0 })
  assert.deepEqual(trailPoints(memory).map(p => p.x), [0, 12, 24, 36, 48, 72, 84, 96, 108, 120])
})
