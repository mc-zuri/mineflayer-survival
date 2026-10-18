import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import type { Pos } from '../../src/core/memory'
import { checkPortalFrame, portalFrame, type BlockInfo } from '../../src/nether/portal'
import { choosePortalSite, frameBuildOrder, otherLavaSource, portalEntrance } from '../../src/nether/portalSkills'
import { portalLinkOf, portalNote } from '../../src/nether/portalTravel'

const k = (p: Pos): string => `${p.x},${p.y},${p.z}`

test('frameBuildOrder: every block has a solid neighbour placed before it (or the ground), 10 obsidian and 3 corners', () => {
  const frame = portalFrame({ x: 0, y: 64, z: 0 }, 'x')
  const order = frameBuildOrder(frame)
  assert.equal(order.filter(p => p.item === 'obsidian').length, 10)
  assert.equal(order.filter(p => p.item === 'filler').length, 3)
  const solid = new Set<string>()
  for (let x = -2; x <= 6; x++) solid.add(k({ x, y: 63, z: 0 }))
  for (const p of order) {
    const sides = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    assert.ok(sides.some(([dx, dy, dz]) => solid.has(k({ x: p.pos.x + dx, y: p.pos.y + dy, z: p.pos.z + dz }))), `nothing to place ${k(p.pos)} against`)
    solid.add(k(p.pos))
  }
  // what's placed is a frame PortalShape takes
  const world = new Map<string, BlockInfo>(order.map(p => [k(p.pos), { name: p.item === 'obsidian' ? 'obsidian' : 'cobblestone' }]))
  assert.equal(checkPortalFrame(p => world.get(k(p)) ?? { name: 'air' }, frame).valid, true)
})

test('choosePortalSite: flat clear ground near the bot, not over a hole or into a wall', () => {
  // stone below y 64, a wall at x 3, a hole at (-3, 63, 0)
  const get = (p: Pos): BlockInfo => {
    if (p.x === 3 && p.y >= 64 && p.y < 70) return { name: 'stone' }
    if (p.x === -3 && p.y === 63 && p.z === 0) return { name: 'air' }
    return { name: p.y < 64 ? 'stone' : 'air' }
  }
  const site = choosePortalSite(get, { x: 0.5, y: 64, z: 0.5 }, { radius: 6 })
  assert.ok(site != null)
  const frame = portalFrame(site.origin, site.axis)
  for (const p of [...frame.obsidian, ...frame.corners, ...frame.interior]) {
    assert.equal(get(p).name, 'air', `${k(p)} in the frame is taken`)
    if (p.y === site.origin.y) assert.equal(get({ ...p, y: p.y - 1 }).name, 'stone', `${k(p)} isn't on the ground`)
  }
  assert.equal(site.origin.y, 64)
  // the entrance is the inside's bottom middle
  const e = portalEntrance(frame)
  assert.equal(e.y, 65)
})

test('otherLavaSource: a source outside the frame; a palette block (no position) matches on the block alone', () => {
  const source = (position?: Vec3): any => ({ name: 'lava', getProperties: () => ({ level: 0 }), position })
  const match = otherLavaSource(new Set(['1,2,3']))
  assert.equal(match(source()), true)
  assert.equal(match(source(new Vec3(1, 2, 3))), false)
  assert.equal(match(source(new Vec3(4, 2, 3))), true)
  assert.equal(match({ name: 'lava', getProperties: () => ({ level: 2 }) }), false)
})

test('portal notes keep the link to the other side', () => {
  const note = portalNote('built', { dimension: 'the_nether', pos: new Vec3(12.7, 64, -3.2) })
  assert.equal(note, 'built;link=the_nether:12,64,-4')
  assert.deepEqual(portalLinkOf({ note }), { dimension: 'the_nether', pos: new Vec3(12, 64, -4) })
  assert.equal(portalLinkOf({ note: 'arrival' }), null)
})
