import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzePortalRoom, eyePlacements, expectedFrames, findPortalFrames, readPortalFrame, type BlockLike } from '../../src/end/portalRoom'
import type { Pos } from '../../src/core/memory'

/** a portal room around (cx, 30, cz) as StrongholdPieces.PortalRoom builds it, eyes where `eyes` says */
function room (cx: number, cz: number, eyes: (i: number) => boolean): Map<string, BlockLike> {
  const out = new Map<string, BlockLike>()
  expectedFrames({ x: cx, y: 30, z: cz }).forEach((f, i) => {
    // mineflayer's Block.getProperties gives bools as booleans
    out.set(`${f.pos.x},${f.pos.y},${f.pos.z}`, { name: 'end_portal_frame', getProperties: () => ({ facing: f.facing, eye: eyes(i) }) })
  })
  return out
}

test('frames face into the 3x3 as the stronghold places them', () => {
  const frames = expectedFrames({ x: 0, y: 30, z: 0 })
  assert.equal(frames.length, 12)
  const steps: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
  for (const f of frames) {
    const step = steps[f.facing]
    const inside = { x: f.pos.x + step[0], z: f.pos.z + step[1] }
    assert.ok(Math.abs(inside.x) <= 1 && Math.abs(inside.z) <= 1, `${f.facing} at ${f.pos.x},${f.pos.z}`)
  }
  // the north row (z = -2) faces south
  assert.ok(frames.filter(f => f.pos.z === -2).every(f => f.facing === 'south'))
})

test('the frame state is read from facing and eye, as booleans or strings', () => {
  assert.deepEqual(readPortalFrame({ name: 'end_portal_frame', properties: { facing: 'west', eye: 'true' } }, { x: 1.7, y: 2, z: 3 }), { pos: { x: 1, y: 2, z: 3 }, facing: 'west', eye: true })
  assert.equal(readPortalFrame({ name: 'end_portal_frame', properties: { facing: 'up', eye: false } }, { x: 0, y: 0, z: 0 }), null)
  assert.equal(readPortalFrame({ name: 'stone_bricks' }, { x: 0, y: 0, z: 0 }), null)
})

test('the room is found from a scan, with the frames still needing an eye', () => {
  const eyes = new Set([0, 4, 9])
  const world = room(-1200, 815, i => eyes.has(i))
  const getBlock = (p: Pos): BlockLike | null => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'stone_bricks' }
  const frames = findPortalFrames(getBlock, { x: -1203, y: 31, z: 818 }, 6)
  assert.equal(frames.length, 12)
  const r = analyzePortalRoom(frames)
  assert.ok(r != null)
  assert.deepEqual(r.center, { x: -1200, y: 30, z: 815 })
  assert.equal(r.interior.length, 9)
  assert.equal(r.missing.length, 9)
  assert.equal(r.eyesNeeded, 9)
  assert.equal(r.complete, false)
  assert.deepEqual(eyePlacements(r).map(e => e.face), Array(9).fill({ x: 0, y: 1, z: 0 }))
})

test('two sides seen are enough to place the inside; the unseen frames count as needing eyes', () => {
  const world = room(10, 20, () => true)
  const seen = findPortalFrames(p => world.get(`${p.x},${p.y},${p.z}`) ?? null, { x: 10, y: 30, z: 20 }, 3)
    .filter(f => f.facing === 'south' || f.facing === 'east')
  assert.equal(seen.length, 6)
  const r = analyzePortalRoom(seen)
  assert.ok(r != null)
  assert.deepEqual(r.center, { x: 10, y: 30, z: 20 })
  assert.equal(r.missing.length, 0)
  assert.equal(r.unseen.length, 6)
  assert.equal(r.eyesNeeded, 6)
  const all = analyzePortalRoom(findPortalFrames(p => world.get(`${p.x},${p.y},${p.z}`) ?? null, { x: 10, y: 30, z: 20 }, 3))
  assert.equal(all?.complete, true)
})
