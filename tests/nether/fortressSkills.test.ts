import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { campSpots, levelSeed, seesFrom } from '../../src/nether/fortressSkills'
import { parseSeed } from '../../src/worldgen/random'
import { fakeBot } from '../reflexes/fakeBot'

test('levelSeed reads text as the server does', () => {
  assert.equal(levelSeed('4'), parseSeed('4'))
  assert.equal(levelSeed(4n), 4n)
})

test('campSpots: floor cells 3 or more from the spawner that see it, not through a wall', () => {
  // a floor at y 63, the spawner at (0, 64, 0), a wall at x = 4 from y 64 up
  const bot = fakeBot({ position: new Vec3(0.5, 64, 6.5), world: p => p.y < 64 ? 'stone' : (p.x === 4 && p.y < 67 ? 'stone' : 'air') })
  bot.blockAt = ((orig) => (p: Vec3) => { const b = orig(p); if (p.x === 0 && p.y === 64 && p.z === 0) return { ...b, name: 'spawner', boundingBox: 'block' }; return b })(bot.blockAt)
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.05) {
        const p = from.plus(dir.scaled(t))
        const b = bot.blockAt(p)
        if (b.boundingBox === 'block') return { position: p.floored(), intersect: p }
      }
      return null
    }
  }
  const spots = campSpots(bot, new Vec3(0, 64, 0), 5)
  assert.ok(spots.length > 0)
  for (const s of spots) {
    assert.ok(Math.hypot(s.x, s.z) >= 3, `${s.toString()} is too near`)
    assert.ok(s.x < 4, `${s.toString()} is behind the wall`)
    assert.equal(s.y, 64)
  }
  assert.equal(seesFrom(bot, new Vec3(6.5, 65.62, 0.5), new Vec3(0.5, 64.5, 0.5), new Vec3(0, 64, 0)), false)
})

test('nextCampSpot: the first untried spot that sees a blaze, else the first untried, else none', async () => {
  const { nextCampSpot } = await import('../../src/nether/fortressSkills')
  // a wall at x = 4 from y 64 up: a blaze behind it at x 8 is seen only from spots past it
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: p => p.y < 64 ? 'stone' : (p.x === 4 && p.y < 70 ? 'stone' : 'air') })
  bot.world = {
    raycast: (from: Vec3, dir: Vec3, range: number) => {
      for (let t = 0; t <= range; t += 0.05) {
        const p = from.plus(dir.scaled(t))
        if (bot.blockAt(p).boundingBox === 'block') return { position: p.floored(), intersect: p }
      }
      return null
    }
  }
  const spots = [new Vec3(0, 64, 0), new Vec3(1, 64, 2), new Vec3(6, 64, 0)]
  const blaze = [new Vec3(8.5, 65, 0.5)]
  assert.deepEqual(nextCampSpot(bot, spots, blaze, new Set()), new Vec3(6, 64, 0))
  assert.deepEqual(nextCampSpot(bot, spots, blaze, new Set(['(6, 64, 0)'])), new Vec3(0, 64, 0))
  assert.equal(nextCampSpot(bot, spots, blaze, new Set(spots.map(s => s.toString()))), null)
})
