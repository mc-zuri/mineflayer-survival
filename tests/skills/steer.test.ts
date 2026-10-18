import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { fleeHeading, stepCost } from '../../src/skills/steer'
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
