import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { ArrowGuard, CROSSBOW_LOADED_TICKS, CrossbowGuard, MOB_ARROW_SPEED, blazeCharged, isChargingCrossbow, isCrossbowMob } from '../../src/skills/fight'
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

test('CrossbowGuard: the shield up from the end of the crossbow charge (RangedCrossbowAttackGoal CHARGED, 20 to 39 ticks before the shot) until the bolt has had time to arrive', () => {
  const guard = new CrossbowGuard()
  const flight = Math.ceil(8 / MOB_ARROW_SPEED) + 2
  // CHARGING, ticks 0 - 24: no bolt can come
  for (let t = 0; t < 25; t++) assert.strictEqual(guard.update(true, false, 8, t), false, `charging at ${t}`)
  // CHARGED and READY_TO_ATTACK: loaded until the shot at 55
  for (let t = 25; t < 55; t++) assert.strictEqual(guard.update(false, false, 8, t), true, `loaded at ${t}`)
  assert.strictEqual(guard.loaded, true)
  assert.strictEqual(guard.update(false, true, 8, 55), true)
  assert.strictEqual(guard.loaded, false)
  for (let t = 56; t <= 55 + flight; t++) assert.strictEqual(guard.update(false, false, 8, t), true, `bolt in the air at ${t}`)
  assert.strictEqual(guard.update(false, false, 8, 56 + flight), false)
  // the next cycle, its bolt unseen: the next charge's start is the shot, the shield held for its flight
  for (let t = 100; t < 125; t++) guard.update(true, false, 8, t)
  for (let t = 125; t < 150; t++) assert.strictEqual(guard.update(false, false, 8, t), true)
  assert.strictEqual(guard.update(true, false, 8, 150), true)
  assert.strictEqual(guard.update(true, false, 8, 150 + flight), true)
  assert.strictEqual(guard.update(true, false, 8, 151 + flight), false)
  // loaded and out of sight for long: let go of after CROSSBOW_LOADED_TICKS
  for (let t = 200; t < 225; t++) guard.update(true, false, 8, t)
  guard.update(false, false, 8, 225)
  assert.strictEqual(guard.update(false, false, 8, 225 + CROSSBOW_LOADED_TICKS), true)
  assert.strictEqual(guard.update(false, false, 8, 226 + CROSSBOW_LOADED_TICKS), false)
})

test('the crossbow mobs: a pillager and a piglin, charging by is_charging_crossbow (index 17 on 1.21.11 and 26.3)', () => {
  for (const version of ['1.21.11', '26.3']) {
    const bot = fakeBot({ version })
    const keys: string[] = bot.registry.entitiesByName.pillager.metadataKeys
    assert.strictEqual(keys.indexOf('is_charging_crossbow'), 17, version)
    const pillager = entity({ name: 'pillager', position: new Vec3(5, 64, 0), meta: { is_charging_crossbow: true }, version })
    assert.strictEqual(isCrossbowMob(bot, pillager), true)
    assert.strictEqual(isChargingCrossbow(bot, pillager), true)
    assert.strictEqual(isChargingCrossbow(bot, entity({ name: 'pillager', position: new Vec3(5, 64, 0), meta: { is_charging_crossbow: false }, version })), false)
    assert.strictEqual(isCrossbowMob(bot, entity({ name: 'piglin', position: new Vec3(5, 64, 0), version })), true)
    assert.strictEqual(isCrossbowMob(bot, entity({ name: 'skeleton', position: new Vec3(5, 64, 0), version })), false)
  }
})
