import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { ArrowGuard, CROSSBOW_LOADED_TICKS, CrossbowGuard, MOB_ARROW_SPEED, blazeCharged, isChargingCrossbow, isCrossbowMob } from '../../src/skills/fight'
import { entity, fakeBot, item } from '../reflexes/fakeBot'

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

test('fight: given up, not killed, once its until holds (the hostiles reflex\'s odds turned)', async () => {
  const { fight } = await import('../../src/skills/fight')
  const spider = entity({ name: 'spider', position: new Vec3(5.5, 64, 0.5) })
  const bot = fakeBot({ entities: [spider] })
  bot.on = bot.on.bind(bot)
  const result = await fight(bot, spider, { until: () => true })
  assert.strictEqual(result.killed, false)
  assert.strictEqual(result.hits, 0)
})

test('inMobReach: a mob\'s attack box is its own widened sideways by sqrt(2.04) - 0.6, never up or down (Mob.getAttackBoundingBox)', async () => {
  const { inMobReach, MOB_ATTACK_REACH } = await import('../../src/skills/fight')
  assert.ok(Math.abs(MOB_ATTACK_REACH - 0.8283) < 1e-3)
  const bot = new Vec3(0.5, 64, 0.5)
  const ws = (x: number, y = 64, z = 0.5): any => ({ position: new Vec3(x, y, z), width: 0.7, height: 2.4 })
  // a wither skeleton's box 0.35 out, its reach 0.83 more, the bot's 0.3: 1.48 between the middles
  assert.equal(inMobReach(ws(1.9), bot), true)
  assert.equal(inMobReach(ws(2.1), bot), false)
  assert.equal(inMobReach(ws(2.1), bot, 1.2), true)
  // three over the bot's feet (a pillar, a cover): out of its reach whatever the sideways distance
  assert.equal(inMobReach(ws(0.6, 61.5), bot), false)
  assert.equal(inMobReach({ position: new Vec3(1.2, 61, 0.5), width: 0.6, height: 2.9 }, bot), false)
  assert.equal(inMobReach({ position: new Vec3(1.2, 61.2, 0.5), width: 0.6, height: 2.9 }, bot), true)
})

test('meleeGuard: the shield up while a melee mob is (about to be) in its reach and the sword is charging; let down a tick before the swing', async () => {
  const { meleeGuard } = await import('../../src/skills/fight')
  assert.equal(meleeGuard(true, true, false, false), 'block')
  assert.equal(meleeGuard(true, true, false, true), 'block')
  assert.equal(meleeGuard(true, true, true, true), 'lower')
  assert.equal(meleeGuard(true, true, true, false), 'swing')
  assert.equal(meleeGuard(false, true, true, false), 'swing')
  assert.equal(meleeGuard(false, false, false, false), 'none')
})

test('fight: against a wither skeleton in its reach, with a shield, the swings come with the shield down and it is up between them (full-26.3-fresh-d)', async () => {
  const { fight } = await import('../../src/skills/fight')
  const skeleton = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(1.9, 64, 0.5) })
  const bot = fakeBot({ entities: [skeleton], items: [item('diamond_sword')], offhand: item('shield') })
  bot.heldItem = bot.inventory.slots[9]
  bot.equip = async () => {}
  let using = false
  bot.activateItem = () => { using = true; bot.usingHeldItem = true }
  bot.deactivateItem = () => { using = false; bot.usingHeldItem = false }
  const swings: boolean[] = []
  const blockedTicks: boolean[] = []
  bot.attack = () => { swings.push(using) }
  bot.on('physicsTick', () => { blockedTicks.push(using) })
  // (a tick each wait: the swing's charge counts them)
  bot.waitForTicks = async (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  await fight(bot, skeleton as any, { maxTicks: 60 }).catch(() => {})
  assert.ok(swings.length >= 2, `${swings.length} swings`)
  assert.ok(swings.every(u => !u), 'a swing with the shield up')
  assert.ok(blockedTicks.filter(b => b).length > blockedTicks.length / 2, `the shield up ${blockedTicks.filter(b => b).length} of ${blockedTicks.length} ticks`)
})

test('fight: a swing goes to the hostile under the crosshair in front of the target; a swing the crosshair refuses keeps the shield up (full-26.3-fresh-l)', async () => {
  const { fight, swingVictim } = await import('../../src/skills/fight')
  const run = async (under: (z: { front: any, back: any }) => any): Promise<{ attacked: number[], blocked: number, ticks: number }> => {
    // down a 1-wide tunnel: the target 2.4 off, another zombie between it and the bot, 1.4 off
    const back = entity({ id: 9, name: 'zombie', position: new Vec3(2.9, 64, 0.5) })
    const front = entity({ id: 10, name: 'zombie', position: new Vec3(1.9, 64, 0.5) })
    const bot = fakeBot({ entities: [back, front], items: [item('diamond_sword')], offhand: item('shield') })
    bot.heldItem = bot.inventory.slots[9]
    bot.equip = async () => {}
    bot.activateItem = () => { bot.usingHeldItem = true }
    bot.deactivateItem = () => { bot.usingHeldItem = false }
    bot.raycastHitResult = () => under({ front, back })
    const attacked: number[] = []
    bot.attack = (e: any) => { attacked.push(e.id) }
    let blocked = 0
    let ticks = 0
    bot.on('physicsTick', () => { ticks++; if (bot.usingHeldItem === true) blocked++ })
    bot.waitForTicks = async (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
    assert.strictEqual(swingVictim(bot, back)?.id, under({ front, back }).type === 'entity' ? under({ front, back }).entity.id : undefined)
    await fight(bot, back as any, { maxTicks: 60 }).catch(() => {})
    return { attacked, blocked, ticks }
  }
  const inFront = await run(({ front }) => ({ type: 'entity', entity: front }))
  assert.ok(inFront.attacked.length >= 2, `${inFront.attacked.length} swings`)
  assert.ok(inFront.attacked.every(id => id === 10), `swung at ${inFront.attacked.join(', ')}`)
  // the crosshair on the tunnel's wall: no swing, the shield up the while
  const wall = await run(() => ({ type: 'block', block: { name: 'stone' } }))
  assert.strictEqual(wall.attacked.length, 0)
  assert.ok(wall.blocked >= wall.ticks - 2, `the shield up ${wall.blocked} of ${wall.ticks} ticks`)
})

test('swingVictim: a neutral mob (an enderman) in front of the target is never hit in passing', async () => {
  const { swingVictim } = await import('../../src/skills/fight')
  const target = entity({ name: 'zombie', position: new Vec3(2.9, 64, 0.5) })
  const enderman = entity({ name: 'enderman', position: new Vec3(1.9, 64, 0.5) })
  const bot = fakeBot({ entities: [target, enderman] })
  bot.raycastHitResult = () => ({ type: 'entity', entity: enderman })
  assert.strictEqual(swingVictim(bot, target), null)
  assert.strictEqual(swingVictim(bot, enderman)?.id, enderman.id)
})
