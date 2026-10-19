import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { ArrowGuard, MOB_ARROW_SPEED, blazeCharged } from '../../src/skills/fight'
import { entity, fakeBot } from '../reflexes/fakeBot'

test('blazeCharged: Blaze.DATA_FLAGS_ID bit 1, set for the volley', () => {
  const bot = fakeBot()
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0), meta: { flags: 1 } })), true)
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0), meta: { flags: 0 } })), false)
  assert.strictEqual(blazeCharged(bot, entity({ name: 'blaze', position: new Vec3(3, 64, 0) })), false)
})

test('ArrowGuard: the shield stays up from the draw until the arrow has had time to arrive', () => {
  const guard = new ArrowGuard()
  assert.strictEqual(guard.update(false, 9, 0), false)
  for (let t = 1; t <= 20; t++) assert.strictEqual(guard.update(true, 9, t), true)
  // released at tick 21 from 9 blocks: in the air ceil(9 / 1.6) = 6 ticks, and 2 to spare
  const flight = Math.ceil(9 / MOB_ARROW_SPEED) + 2
  for (let t = 21; t <= 21 + flight; t++) assert.strictEqual(guard.update(false, 9, t), true, `tick ${t}`)
  assert.strictEqual(guard.update(false, 9, 22 + flight), false)
  // the next draw raises it again
  assert.strictEqual(guard.update(true, 8, 60), true)
})

test('fight: no crit jump off a stalagmite\'s tip (each landing back on it impales), a jump on the ground beside it', async () => {
  // (26.3 run full-g: a bot on a stalagmite crit-jumped at zombies and was impaled 17 times, till it died)
  const { fight } = await import('../../src/skills/fight')
  const jumps = async (onTip: boolean): Promise<number> => {
    const tip = new Vec3(0, 64, 0)
    const zombie = entity({ id: 7, name: 'zombie', position: new Vec3(1.6, 64, 0.5) })
    const bot = fakeBot({
      position: new Vec3(0.5, onTip ? 64.6875 : 64, 0.5),
      entities: [zombie],
      world: (p: Vec3) => onTip && p.equals(tip) ? 'pointed_dripstone' : p.y < 64 ? 'stone' : 'air'
    })
    let n = 0
    const set = bot.setControlState
    bot.setControlState = (k: string, v: boolean) => { if (k === 'jump' && v) n++; set(k, v) }
    bot.attack = () => {}
    const ticking = setInterval(() => bot.emit('physicsTick'), 1)
    try {
      await fight(bot, zombie as any, { maxTicks: 40 }).catch(() => {})
    } finally {
      clearInterval(ticking)
    }
    return n
  }
  assert.strictEqual(await jumps(true), 0)
  assert.ok(await jumps(false) > 0, 'no crit jump on the ground either: the test proves nothing')
})
