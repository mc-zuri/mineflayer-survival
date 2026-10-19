import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { findFishingSpot, isOpenWater, openWaterTypeForBlock, planCast, rodScore, simulateCast, toVanillaYaw, fromVanillaYaw, type FishBlock } from '../../src/skills/fish'

/**
 * Grass at y 63 with a pond: water sources from x0..x1, z0..z1, its surface at y 63 and `depth` deep, air over it.
 * `extra` puts blocks by "x,y,z".
 */
function pond (x0: number, x1: number, z0: number, z1: number, depth = 3, extra: Record<string, string> = {}): (p: Vec3) => FishBlock {
  return (p: Vec3) => {
    const k = `${p.x},${p.y},${p.z}`
    if (extra[k] != null) return { name: extra[k], boundingBox: extra[k] === 'air' ? 'empty' : 'block' }
    const inPond = p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1
    if (inPond && p.y <= 63 && p.y > 63 - depth) return { name: 'water', boundingBox: 'empty', getProperties: () => ({ level: 0 }) }
    if (p.y <= 63) return { name: p.y === 63 ? 'grass_block' : 'dirt', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
}

test('open water: the 5 x 5 water from under the bobber to its block, air the two over it', () => {
  const lookup = pond(0, 10, 0, 10)
  assert.equal(isOpenWater(lookup, new Vec3(5, 63, 5)), true)
  // too near the shore: grass in the 5 x 5
  assert.equal(isOpenWater(lookup, new Vec3(1, 63, 5)), false)
  // 2 from the shore is the edge of it
  assert.equal(isOpenWater(lookup, new Vec3(2, 63, 2)), true)
  // a single layer of water is too shallow (the layer under the bobber is dirt)
  assert.equal(isOpenWater(pond(0, 10, 0, 10, 1), new Vec3(5, 63, 5)), false)
  // a lily pad counts as air
  assert.equal(isOpenWater(pond(0, 10, 0, 10, 3, { '5,64,5': 'lily_pad' }), new Vec3(5, 63, 5)), true)
  // a block over the water breaks it
  assert.equal(isOpenWater(pond(0, 10, 0, 10, 3, { '6,65,6': 'stone' }), new Vec3(5, 63, 5)), false)
  // flowing water isn't a source
  const flowing = (p: Vec3): FishBlock => p.equals(new Vec3(4, 62, 4)) ? { name: 'water', getProperties: () => ({ level: 3 }) } : pond(0, 10, 0, 10)(p)
  assert.equal(isOpenWater(flowing, new Vec3(5, 63, 5)), false)
  assert.equal(openWaterTypeForBlock({ name: 'seagrass' }), 'inside')
  assert.equal(openWaterTypeForBlock({ name: 'stone' }), 'invalid')
})

test('a cast flies a few blocks from the eyes and lands in the water ahead', () => {
  const lookup = pond(0, 20, -10, 10)
  // standing on the shore at x -2, looking +x (vanilla yaw -90), level
  const eye = new Vec3(-1.5, 64 + 1.62, 0.5)
  const level = simulateCast(lookup, eye, -90, 0)
  assert.ok(level != null)
  assert.equal(level.y, 63)
  assert.ok(level.x >= 3 && level.x <= 12, `landed at ${level.toString()}`)
  assert.equal(level.z, 0)
  // looking up throws further, looking down nearer
  const up = simulateCast(lookup, eye, -90, -30) as Vec3
  const down = simulateCast(lookup, eye, -90, 30) as Vec3
  assert.ok(up.x > level.x && down.x < level.x, `${down.x} < ${level.x} < ${up.x}`)
  // a wall in the way: no landing
  const walled = pond(0, 20, -10, 10, 3, { '0,64,0': 'stone', '0,65,0': 'stone', '0,66,0': 'stone', '1,64,0': 'stone', '1,65,0': 'stone', '1,66,0': 'stone' })
  assert.equal(simulateCast(walled, eye, -90, 0), null)
})

test('yaw conversions round trip, and a cast planned lands in open water', () => {
  for (const yaw of [0, 1, -2, Math.PI / 2]) assert.ok(Math.abs(fromVanillaYaw(toVanillaYaw(yaw)) - yaw) < 1e-9)
  const lookup = pond(0, 20, -10, 10)
  const eye = new Vec3(-1.5, 64 + 1.62, 0.5)
  const cast = planCast(lookup, eye, new Vec3(6, 63, 0))
  assert.ok(cast != null)
  assert.equal(cast.open, true)
  assert.ok(isOpenWater(lookup, cast.landing))
})

test('a fishing spot: a shore cell and the cast from it into open water; none with no open water', () => {
  const lookup = pond(0, 8, 0, 8)
  const waters: Vec3[] = []
  for (let x = 0; x <= 8; x++) for (let z = 0; z <= 8; z++) for (const y of [61, 62, 63]) waters.push(new Vec3(x, y, z))
  const spot = findFishingSpot(lookup, new Vec3(-5, 64, 4), waters)
  assert.ok(spot != null)
  assert.equal(spot.open, true)
  assert.equal(spot.stand.y, 64)
  assert.equal(lookup(spot.stand.offset(0, -1, 0)).name, 'grass_block')
  assert.ok(isOpenWater(lookup, spot.landing))
  // a pond 4 across has no open water at all
  const small = pond(0, 3, 0, 3)
  const smallWaters = waters.filter(w => w.x <= 3 && w.z <= 3)
  assert.equal(findFishingSpot(small, new Vec3(-5, 64, 4), smallWaters), null)
  // ...but can be fished for fish
  const any = findFishingSpot(small, new Vec3(-5, 64, 4), smallWaters, { open: false })
  assert.ok(any != null)
  assert.equal(any.open, false)
})

test('the best rod: luck of the sea first, then lure, then durability', () => {
  const rod = (enchants: Array<{ name: string, lvl: number }>, used = 0): any => ({ name: 'fishing_rod', enchants, maxDurability: 64, durabilityUsed: used })
  assert.ok(rodScore(rod([{ name: 'luck_of_the_sea', lvl: 1 }])) > rodScore(rod([{ name: 'lure', lvl: 3 }])))
  assert.ok(rodScore(rod([{ name: 'lure', lvl: 1 }], 60)) > rodScore(rod([])))
  assert.ok(rodScore(rod([])) > rodScore(rod([], 30)))
})
