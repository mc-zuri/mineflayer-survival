import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { deadlyStep, edgeAhead, fleeHeading, stepCost, steerToward } from '../../src/skills/steer'
import { fakeBot } from '../reflexes/fakeBot'

test('fleeHeading runs away from the threat, around lava and walls', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  // a threat at -x: run toward +x (mineflayer yaw -pi/2 faces +x)
  const heading = fleeHeading(bot, new Vec3(-3, 64, 0.5))
  assert.ok(heading != null)
  assert.ok(-Math.sin(heading) > 0.9, `heading ${heading}`)
  // lava all along +x: not that way
  const lavaEast = (p: Vec3): string => p.x >= 1 && p.y === 63 ? 'lava' : p.y < 64 ? 'stone' : 'air'
  const bot2 = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: lavaEast })
  const h2 = fleeHeading(bot2, new Vec3(-3, 64, 0.5))
  assert.ok(h2 != null)
  assert.ok(-Math.sin(h2) < 0.5, `ran into the lava: heading ${h2}`)
  assert.strictEqual(stepCost(bot2, new Vec3(3, 64, 0)), Infinity)
  // walled in: nowhere
  const box = (p: Vec3): string => (Math.abs(p.x) >= 1 || Math.abs(p.z) >= 1) ? 'stone' : p.y < 64 ? 'stone' : 'air'
  assert.strictEqual(fleeHeading(fakeBot({ position: new Vec3(0.5, 64, 0.5), world: box }), new Vec3(-3, 64, 0.5)), null)
})

test('deadlyStep: lava or fire at the feet, a fall into lava or past 3 blocks; not a wall, a step down, or water under', () => {
  // stone floor to y 63 west of x 2; east of it: a pocket of lava at y 62 (z < 0) and the void (z >= 0), a wall at x -2
  const world = (p: Vec3): string => {
    if (p.x <= -2) return p.y < 66 ? 'stone' : 'air'
    if (p.x < 2) return p.y < 64 ? 'stone' : 'air'
    if (p.z < 0) return p.y === 62 ? 'lava' : p.y < 62 ? 'stone' : 'air'
    if (p.z >= 4) return p.y === 60 ? 'water' : 'air'
    return 'air'
  }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, 0)), false, 'level ground')
  assert.strictEqual(deadlyStep(bot, new Vec3(-2, 64, 0)), false, 'a wall')
  assert.strictEqual(deadlyStep(bot, new Vec3(2, 64, -1)), true, 'a lava pocket under a drop of 1')
  assert.strictEqual(deadlyStep(bot, new Vec3(2, 64, 1)), true, 'the void')
  assert.strictEqual(deadlyStep(bot, new Vec3(2, 64, 5)), false, 'water under a drop of 3')
})

test('steerToward with guard stops at a deadly edge (sneaking: the speed had doesn\'t carry it over), and walks on away from it', () => {
  // a ledge: ground to x < 1, the lava sea far under it east
  const world = (p: Vec3): string => p.x < 1 ? (p.y < 64 ? 'stone' : 'air') : (p.y === 31 ? 'lava' : 'air')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  // east: over the edge
  assert.strictEqual(edgeAhead(bot, -Math.PI / 2), true)
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5), { guard: true }), false)
  assert.strictEqual(bot.getControlState('forward'), false)
  assert.strictEqual(bot.getControlState('sprint'), false)
  assert.strictEqual(bot.getControlState('sneak'), true)
  // without the guard it walks on (an escape through lava wants that)
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5)), true)
  assert.strictEqual(bot.getControlState('forward'), true)
  // west, along the ground: on it goes
  bot.clearControlStates()
  assert.strictEqual(edgeAhead(bot, Math.PI / 2), false)
  assert.strictEqual(steerToward(bot, new Vec3(-5, 64, 0.5), { guard: true, sprint: true }), true)
  assert.strictEqual(bot.getControlState('forward'), true)
  assert.strictEqual(bot.getControlState('sprint'), true)
  assert.strictEqual(bot.getControlState('sneak'), false)
  // two blocks from the edge it isn't one yet (the check reaches 1.2 blocks on)
  bot.entity.position = new Vec3(-1.5, 64, 0.5)
  assert.strictEqual(edgeAhead(bot, -Math.PI / 2), false)
})

test('steerToward with guard and maxDrop 1 keeps a chase on its level: it stops at a step down of 2 or 3 (not deadly) and takes a step down of 1', () => {
  // stone to y 63 west of x 1; a step down of 1 east of it along z < 0, of 3 along z >= 0
  const world = (p: Vec3): string => p.x < 1 ? (p.y < 64 ? 'stone' : 'air') : (p.y < (p.z < 0 ? 63 : 61) ? 'stone' : 'air')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, 0)), false, 'a drop of 3')
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, 0), 1), true, 'a drop of 3, with 1 at most')
  assert.strictEqual(deadlyStep(bot, new Vec3(1, 64, -1), 1), false, 'a drop of 1, with 1 at most')
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5), { guard: true }), true)
  bot.clearControlStates()
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, 0.5), { guard: true, maxDrop: 1 }), false)
  assert.strictEqual(bot.getControlState('forward'), false)
  bot.entity.position = new Vec3(0.5, 64, -0.5)
  assert.strictEqual(steerToward(bot, new Vec3(5, 64, -0.5), { guard: true, maxDrop: 1 }), true)
  // a magma block's top is deadly at any drop (the hot floor)
  const magma = (p: Vec3): string => p.x === 1 && p.y === 63 ? 'magma_block' : p.y < 64 ? 'stone' : 'air'
  const onMagma = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: magma })
  assert.strictEqual(edgeAhead(onMagma, -Math.PI / 2), true)
})

test('fleeHeading: in a tunnel shut behind the bot, the way at the threat is none (cornered), not the flee (nether-26.3-q3: fled into a creeper\'s blast)', () => {
  const tunnel = (p: Vec3): string => (p.z === 0 && (p.y === 64 || p.y === 65) && p.x >= 0 && p.x < 12) ? 'air' : 'stone'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: tunnel })
  assert.equal(fleeHeading(bot, new Vec3(8.5, 64, 0.5)), null)
  // the creeper behind it the other way: on down the tunnel, away
  const bot2 = fakeBot({ position: new Vec3(4.5, 64, 0.5), world: tunnel })
  const h = fleeHeading(bot2, new Vec3(1.5, 64, 0.5))
  assert.ok(h != null && -Math.sin(h) > 0.9, String(h))
})
