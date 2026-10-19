// Breeding and the cane farm without a server: the pairs fed, the spots canes stand on, a water hole's site.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { BREED_COOLDOWN_TICKS, breedingPairs } from '../../src/skills/husbandry'
import { caneSpot, caneSpots, waterHoleSite } from '../../src/skills/caneFarm'

test('breedingPairs: adults within 8 blocks of each other, not fed in the cooldown, nearest first', () => {
  const a = (id: number, x: number, adult = true) => ({ id, position: new Vec3(x, 64, 0), adult })
  const herd = [a(1, 2), a(2, 4), a(3, 6), a(4, 30), a(5, 3, false), a(6, 7)]
  assert.deepStrictEqual(breedingPairs(herd, new Map(), 10000, new Vec3(0, 64, 0), 4), [[1, 2], [3, 6]])
  // one pair at most
  assert.deepStrictEqual(breedingPairs(herd, new Map(), 10000, new Vec3(0, 64, 0), 1), [[1, 2]])
  // the ones fed lately wait
  const fed = new Map([[1, 9000], [2, 10000 - BREED_COOLDOWN_TICKS]])
  assert.deepStrictEqual(breedingPairs(herd, fed, 10000, new Vec3(0, 64, 0), 4), [[2, 3]])
  // a lone adult far off has no partner
  assert.deepStrictEqual(breedingPairs([a(4, 30), a(1, 2)], new Map(), 10000, new Vec3(0, 64, 0), 4), [])
})

// grass at y 63 with air over it, a pond at x 5..6, z 0, sand at x 7, stone at x 8
const world = (p: Vec3): { name: string } => {
  if (p.y > 63) return { name: 'air' }
  if (p.y < 63) return { name: 'dirt' }
  if (p.z === 0 && (p.x === 5 || p.x === 6)) return { name: 'water' }
  if (p.z === 0 && p.x === 7) return { name: 'sand' }
  if (p.z === 0 && p.x === 8) return { name: 'stone' }
  return { name: 'grass_block' }
}

test('caneSpot: dirt or sand with water on a side and room over it; not stone, not away from water', () => {
  assert.strictEqual(caneSpot(world, new Vec3(4, 63, 0)), true)
  assert.strictEqual(caneSpot(world, new Vec3(7, 63, 0)), true)
  assert.strictEqual(caneSpot(world, new Vec3(5, 63, 1)), true)
  assert.strictEqual(caneSpot(world, new Vec3(8, 63, 1)), false)
  assert.strictEqual(caneSpot(world, new Vec3(0, 63, 3)), false)
  const spots = caneSpots(world, new Vec3(5, 64, 0), 4)
  assert.strictEqual(spots.length, 6)
  assert.ok(spots.every(s => caneSpot(world, s)))
})

test('waterHoleSite: level cane ground with the same on its four sides, not under the bot', () => {
  const flat = (p: Vec3) => ({ name: p.y > 63 ? 'air' : p.y === 63 ? 'grass_block' : 'dirt' })
  const site = waterHoleSite(flat, new Vec3(0.5, 64, 0.5)) as Vec3
  assert.ok(site != null)
  assert.strictEqual(site.y, 63)
  assert.ok(Math.abs(site.x) > 1 || Math.abs(site.z) > 1)
  assert.strictEqual(waterHoleSite((p: Vec3) => ({ name: p.y > 63 ? 'air' : 'stone' }), new Vec3(0, 64, 0)), null)
})
