// The fall broken with a water bucket: where the bot lands, when to pour, and the reflex that does it.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { breakFall, fallDamage, landingY, pourNow, POUR_ABOVE, predictLanding, shouldBreakFall } from '../../src/skills/fall'
import { fallReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { fakeBot, item } from '../reflexes/fakeBot'

test('landingY and shouldBreakFall: taken in hand as soon as a fall of 5 or more is under way, out of the nether, a bucket held', () => {
  const island = (p: Vec3) => ({ name: p.y <= 62 ? 'end_stone' : 'air', boundingBox: p.y <= 62 ? 'block' : 'empty' })
  assert.strictEqual(landingY(island, new Vec3(-32.5, 70, 20.5)), 63)
  assert.strictEqual(landingY((p: Vec3) => ({ name: 'air', boundingBox: 'empty' }), new Vec3(0, 70, 0)), null)
  const s = { y: 65.5, vy: -1.2, onGround: false, fallStart: 82, landing: 63, hasBucket: true, nether: false }
  assert.strictEqual(shouldBreakFall(s), true)
  // at once, however high (the 31-block fall: the reflex 2.5 blocks over the landing was too late)
  assert.strictEqual(shouldBreakFall({ ...s, y: 81, fallStart: 101, landing: 70 }), true)
  assert.strictEqual(shouldBreakFall({ ...s, y: 70 }), true)
  assert.strictEqual(shouldBreakFall({ ...s, y: 63.3 }), false)
  assert.strictEqual(shouldBreakFall({ ...s, fallStart: 66 }), false)
  assert.strictEqual(shouldBreakFall({ ...s, hasBucket: false }), false)
  assert.strictEqual(shouldBreakFall({ ...s, nether: true }), false)
  assert.strictEqual(shouldBreakFall({ ...s, vy: -0.1 }), false)
})

test('shouldBreakFall: a fall short of 5 blocks that would kill at the health left is broken too', () => {
  // 4.5 blocks: 2 damage
  assert.strictEqual(fallDamage(4.5), 2)
  assert.strictEqual(fallDamage(3), 0)
  const s = { y: 65, vy: -0.6, onGround: false, fallStart: 67.5, landing: 63, hasBucket: true, nether: false }
  assert.strictEqual(shouldBreakFall(s), false)
  assert.strictEqual(shouldBreakFall({ ...s, health: 6 }), false)
  assert.strictEqual(shouldBreakFall({ ...s, health: 2 }), true)
  // a 3-block step down hurts nothing at any health
  assert.strictEqual(shouldBreakFall({ ...s, fallStart: 66, health: 0.5 }), false)
})

test('pourNow: the bucket used once the landing is in its reach under the eyes, not again within two ticks', () => {
  // the 26.3 death: the pour at 3.3 blocks over the landing, the eyes 4.9 over it, out of the 4.5 reach
  assert.strictEqual(pourNow(123.3 + 1.62, 120, true, Infinity), false)
  assert.strictEqual(pourNow(120 + POUR_ABOVE - 0.01, 120, true, Infinity), true)
  assert.strictEqual(pourNow(122.5 + 1.62, 120, true, Infinity), true)
  assert.strictEqual(pourNow(122.5 + 1.62, 120, false, Infinity), false)
  assert.strictEqual(pourNow(122 + 1.62, 120, true, 1), false)
  assert.strictEqual(pourNow(122 + 1.62, 120, true, 3), true)
})

test('breakFall: the bucket held and the look down at once, the pour only once the landing is in reach', async () => {
  const bot = fakeBot({ position: new Vec3(0.5, 66.5, 0.5), items: [item('water_bucket', 1)], world: (p: Vec3) => p.y <= 62 ? 'stone' : 'air', onGround: false })
  bot.equip = async (it: any) => { bot.heldItem = it }
  const used: number[] = []
  bot.activateItem = () => { if (bot.heldItem?.name === 'water_bucket') { used.push(bot.entity.position.y); bot.heldItem = item('bucket', 1) } }
  bot.lookAt = async () => {}
  let done = false
  const fall = breakFall(bot, 63).finally(() => { done = true })
  // falling 0.8 a tick, then on the ground
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise(resolve => setImmediate(resolve))
    if (!bot.entity.onGround) bot.entity.position = bot.entity.position.offset(0, -0.8, 0)
    if (bot.entity.position.y <= 63) { bot.entity.position.y = 63; bot.entity.onGround = true }
    bot.emit('physicsTick')
  }
  assert.strictEqual(await fall, true)
  assert.strictEqual(used.length, 1, `used at ${used.join(', ')}`)
  assert.ok(used[0] + 1.62 - 63 <= POUR_ABOVE, `poured at ${used[0]}`)
  assert.ok(used[0] > 63.5, `poured at ${used[0]}`)
})

test('the fall reflex fires as soon as a long fall with a water bucket is under way, from the height the fall began at', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 82, 0.5), items: [item('water_bucket', 1)], world: (p: Vec3) => p.y <= 62 ? 'stone' : 'air' })
  bot.game.dimension = 'the_end'
  const engine = new ReflexEngine(bot, { enabled: false })
  // standing on the pillar's top, then falling
  assert.strictEqual(fallReflex.check(engine.context()), null)
  bot.entity.onGround = false
  bot.entity.velocity = new Vec3(0, -1.5, 0)
  bot.entity.position = new Vec3(0.5, 80, 0.5)
  assert.strictEqual(fallReflex.check(engine.context())?.detail, 'water at 63')
  // a hop's way down is none
  bot.entity.onGround = true
  assert.strictEqual(fallReflex.check(engine.context()), null)
  engine.stop()
})

test('breakFall: the water poured in place of a snow layer (a block off the landing it was aimed at) is taken back up', async () => {
  // the ground: stone under 62, a snow layer at 62 (a full box to mineflayer: the landing at 63)
  const placed = new Set<string>()
  const world = (p: Vec3): string => placed.has(p.toString()) ? 'water' : p.y < 62 ? 'stone' : p.y === 62 ? 'snow' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 66, 0.5), items: [item('water_bucket', 1)], world, onGround: false })
  const blockAt = bot.blockAt
  bot.blockAt = (p: Vec3) => { const b = blockAt(p); return { ...b, boundingBox: b.name === 'snow' ? 'block' : b.boundingBox, getProperties: () => ({ level: 0 }) } }
  bot.equip = async (it: any) => { bot.heldItem = it }
  const looks: Vec3[] = []
  bot.lookAt = async (p: Vec3) => { looks.push(p) }
  let scooped = false
  bot.activateItem = () => {
    if (bot.heldItem?.name === 'water_bucket') { placed.add(new Vec3(0, 62, 0).toString()); bot.heldItem = item('bucket', 1) } else if (bot.heldItem?.name === 'bucket') scooped = true
  }
  bot.inventory.items = () => [bot.heldItem ?? item('water_bucket', 1)]
  let done = false
  const fall = breakFall(bot, 63).finally(() => { done = true })
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise(resolve => setImmediate(resolve))
    if (!bot.entity.onGround) bot.entity.position = bot.entity.position.offset(0, -0.7, 0)
    if (bot.entity.position.y <= 62.2) { bot.entity.position.y = 62.2; bot.entity.onGround = true }
    bot.emit('physicsTick')
  }
  assert.strictEqual(await fall, true)
  assert.ok(scooped, 'the water left')
  assert.ok(looks.some(p => p.equals(new Vec3(0.5, 62.5, 0.5))), looks.map(String).join(' '))
})

test('predictLanding: where a fall comes down, its drift across counted; none into water', () => {
  // a cliff: the top at x < 2 is at 101, the foot at 70
  const cliff = (p: Vec3): any => {
    const top = p.x < 2 ? 100 : 69
    return { name: p.y <= top ? 'stone' : 'air', boundingBox: p.y <= top ? 'block' : 'empty' }
  }
  // off the edge at a sprint (0.28 a tick across): over the foot, 31 blocks down
  const l = predictLanding(cliff, new Vec3(2.1, 100.9, 0.5), new Vec3(0.28, -0.08, 0))
  assert.ok(l != null)
  assert.strictEqual(l.y, 70)
  assert.ok(l.x > 3 && l.x < 6, `lands at x ${l.x}`)
  // straight down from where it is
  assert.strictEqual(predictLanding(cliff, new Vec3(5.5, 90, 0.5), new Vec3(0, -1, 0))?.y, 70)
  const pond = (p: Vec3): any => ({ name: p.y <= 69 ? 'water' : 'air', boundingBox: 'empty' })
  assert.strictEqual(predictLanding(pond, new Vec3(5.5, 90, 0.5), new Vec3(0, -1, 0)), null)
})
