// The fall broken with a water bucket: where the bot lands, when to pour, and the reflex that does it.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { landingY, shouldBreakFall } from '../../src/skills/fall'
import { fallReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { fakeBot, item } from '../reflexes/fakeBot'

test('landingY and shouldBreakFall: poured 1 to 3.5 blocks over the landing of a fall of 5 or more, out of the nether, a bucket held', () => {
  const island = (p: Vec3) => ({ name: p.y <= 62 ? 'end_stone' : 'air', boundingBox: p.y <= 62 ? 'block' : 'empty' })
  assert.strictEqual(landingY(island, new Vec3(-32.5, 70, 20.5)), 63)
  assert.strictEqual(landingY((p: Vec3) => ({ name: 'air', boundingBox: 'empty' }), new Vec3(0, 70, 0)), null)
  const s = { y: 65.5, vy: -1.2, onGround: false, fallStart: 82, landing: 63, hasBucket: true, nether: false }
  assert.strictEqual(shouldBreakFall(s), true)
  assert.strictEqual(shouldBreakFall({ ...s, y: 70 }), false)
  assert.strictEqual(shouldBreakFall({ ...s, fallStart: 66 }), false)
  assert.strictEqual(shouldBreakFall({ ...s, hasBucket: false }), false)
  assert.strictEqual(shouldBreakFall({ ...s, nether: true }), false)
  assert.strictEqual(shouldBreakFall({ ...s, vy: -0.1 }), false)
})

test('the fall reflex fires near the end of a long fall with a water bucket, from the height the fall began at', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 82, 0.5), items: [item('water_bucket', 1)], world: (p: Vec3) => p.y <= 62 ? 'stone' : 'air' })
  bot.game.dimension = 'the_end'
  const engine = new ReflexEngine(bot, { enabled: false })
  // standing on the pillar's top, then falling
  assert.strictEqual(fallReflex.check(engine.context()), null)
  bot.entity.onGround = false
  bot.entity.velocity = new Vec3(0, -1.5, 0)
  bot.entity.position = new Vec3(0.5, 72, 0.5)
  assert.strictEqual(fallReflex.check(engine.context()), null)
  bot.entity.position = new Vec3(0.5, 65.4, 0.5)
  assert.strictEqual(fallReflex.check(engine.context())?.detail, 'water at 63')
  engine.stop()
})
