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

test('MeleeCycle: a swing of the bot\'s is let through in the ticks after the mob\'s own (its 20-tick cooldown) and from its coming into reach to its first swing held off; a mob that never swings in its reach is swung at after a cycle', async () => {
  const { MeleeCycle, MOB_ATTACK_INTERVAL, SWING_GAP_TICKS, meleeGuard } = await import('../../src/skills/fight')
  const c = new MeleeCycle()
  assert.strictEqual(c.update(false, 0), true)
  // in reach at 1: its cooldown may be over, it hits at once
  for (let t = 1; t < 4; t++) assert.strictEqual(c.update(true, t), false, `before its first swing, ${t}`)
  c.swung(4)
  for (let t = 4; t <= 4 + MOB_ATTACK_INTERVAL - SWING_GAP_TICKS; t++) assert.strictEqual(c.update(true, t), true, `in its cooldown, ${t}`)
  for (let t = 5 + MOB_ATTACK_INTERVAL - SWING_GAP_TICKS; t < 4 + MOB_ATTACK_INTERVAL; t++) assert.strictEqual(c.update(true, t), false, `its next swing due, ${t}`)
  // knocked out of reach: open; back in: shut till it swings
  assert.strictEqual(c.update(false, 30), true)
  assert.strictEqual(c.update(true, 31), false)
  // in reach and never swinging (no line of sight): open after a cycle and some
  const quiet = new MeleeCycle()
  let first = -1
  for (let t = 0; t < 60 && first < 0; t++) if (quiet.update(true, t)) first = t
  assert.strictEqual(first, MOB_ATTACK_INTERVAL + 5)
  // meleeGuard: charged and in both reaches, the swing only in the opening
  assert.equal(meleeGuard(true, true, true, true, false), 'block')
  assert.equal(meleeGuard(true, true, true, false, false), 'block')
  assert.equal(meleeGuard(true, true, true, true, true), 'lower')
  // out of its reach the opening doesn't matter
  assert.equal(meleeGuard(false, true, true, false, false), 'swing')
})

test('fight: a zombie in its reach swinging every 20 ticks: the bot\'s swings come in the ticks after its swing, the shield up again before its next (full-26.3-fresh-l)', async () => {
  const { fight, MOB_ATTACK_INTERVAL, SWING_GAP_TICKS } = await import('../../src/skills/fight')
  const zombie = entity({ id: 11, name: 'zombie', position: new Vec3(1.7, 64, 0.5) })
  const bot = fakeBot({ entities: [zombie], items: [item('diamond_sword')], offhand: item('shield') })
  bot.heldItem = bot.inventory.slots[9]
  bot.equip = async () => {}
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  let tick = 0
  const zombieSwings: number[] = []
  const botSwings: number[] = []
  // the shield's state on each of the zombie's swings
  const blockedHits: boolean[] = []
  bot.attack = () => { botSwings.push(tick) }
  bot.on('physicsTick', () => {
    tick++
    // its swing every 20 ticks from tick 7 on (MeleeAttackGoal), seen the tick after
    if (tick >= 7 && (tick - 7) % MOB_ATTACK_INTERVAL === 0) {
      zombieSwings.push(tick)
      blockedHits.push(bot.usingHeldItem === true)
      bot.emit('entitySwingArm', zombie)
    }
  })
  bot.waitForTicks = async (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  await fight(bot, zombie as any, { maxTicks: 150 }).catch(() => {})
  assert.ok(botSwings.length >= 4, `${botSwings.length} swings`)
  for (const s of botSwings) {
    const last = Math.max(...zombieSwings.filter(z => z <= s))
    assert.ok(s - last <= MOB_ATTACK_INTERVAL - SWING_GAP_TICKS + 2, `a swing at ${s}, ${s - last} after the zombie's at ${last}`)
  }
  // (each of its hits after the first cycle came on the raised shield)
  assert.ok(blockedHits.slice(1).every(b => b), `the shield on its hits: ${blockedHits.join(', ')}`)
})

test('fight: down a 1-wide tunnel a zombie coming is waited for with the shield, not walked at; in the open, or one that comes no nearer for HOLD_TICKS, closed in on', async () => {
  const { fight, holdsGround, HOLD_TICKS } = await import('../../src/skills/fight')
  const tunnel = (p: Vec3): string => p.z === 0 && p.y >= 64 && p.y <= 65 ? 'air' : 'stone'
  const run = async (world?: (p: Vec3) => string): Promise<{ firstStep: number, held: boolean }> => {
    const zombie = entity({ id: 12, name: 'zombie', position: new Vec3(6.5, 64, 0.5) })
    const bot = fakeBot({ entities: [zombie], items: [item('diamond_sword')], offhand: item('shield'), world })
    bot.heldItem = bot.inventory.slots[9]
    bot.equip = async () => {}
    bot.activateItem = () => { bot.usingHeldItem = true }
    bot.deactivateItem = () => { bot.usingHeldItem = false }
    bot.attack = () => {}
    let tick = 0
    let firstStep = -1
    bot.waitForTicks = async (n: number) => {
      for (let i = 0; i < n; i++) {
        tick++
        if (firstStep < 0 && bot.controls.forward === true) firstStep = tick
        bot.emit('physicsTick')
      }
    }
    await fight(bot, zombie as any, { maxTicks: HOLD_TICKS + 20 }).catch(() => {})
    return { firstStep, held: holdsGround(bot) }
  }
  const inTunnel = await run(tunnel)
  assert.strictEqual(inTunnel.held, true)
  // (it never comes: closed in on after HOLD_TICKS)
  assert.ok(inTunnel.firstStep >= HOLD_TICKS, `a step at ${inTunnel.firstStep}`)
  const open = await run()
  assert.strictEqual(open.held, false)
  assert.ok(open.firstStep >= 0 && open.firstStep < 5, `the first step at ${open.firstStep}`)
})

test('swingVictim: a hostile\'s mount under the crosshair (a chicken jockey\'s chicken) is hit; a chicken alone is not', async () => {
  const { swingVictim } = await import('../../src/skills/fight')
  const zombie = entity({ name: 'zombie', position: new Vec3(1.9, 64.7, 0.5) })
  const chicken = entity({ name: 'chicken', position: new Vec3(1.9, 64, 0.5) })
  const bot = fakeBot({ entities: [zombie, chicken] })
  bot.raycastHitResult = () => ({ type: 'entity', entity: chicken })
  assert.strictEqual(swingVictim(bot, zombie), null)
  chicken.passengers = [zombie]
  zombie.vehicle = chicken
  assert.strictEqual(swingVictim(bot, zombie)?.id, chicken.id)
})

test('shieldCover: among two melee mobs from two sides the shield is faced between them, both within its front; not with them on opposite sides; none for one', async () => {
  const { shieldCover, SHIELD_COVER_ANGLE } = await import('../../src/skills/fight')
  const at = new Vec3(0.5, 64, 0.5)
  // one to the west (-x), one to the south (+z): faced south-west
  const two = shieldCover(at, [new Vec3(-1.5, 64, 0.5), new Vec3(0.5, 64, 2.5)])
  assert.ok(two != null && two.covered)
  const look = { x: -Math.sin(two.yaw), z: -Math.cos(two.yaw) }
  assert.ok(Math.abs(look.x + Math.SQRT1_2) < 1e-6 && Math.abs(look.z - Math.SQRT1_2) < 1e-6, JSON.stringify(look))
  // one each side, 170 degrees apart: no front holds both
  const wide = shieldCover(at, [new Vec3(-1.5, 64, 0.5), new Vec3(2.5, 64, 0.85)])
  assert.ok(wide != null && !wide.covered)
  assert.ok(SHIELD_COVER_ANGLE < 90)
  assert.equal(shieldCover(at, [new Vec3(-1.5, 64, 0.5)]), null)
  assert.equal(shieldCover(at, [new Vec3(-1.5, 64, 0.5), new Vec3(2.5, 64, 0.5)]), null)
})

/** a fake fight's bot: a diamond sword in hand, a shield in the off hand, a tick each wait */
function fightBot (entities: any[]): any {
  const bot = fakeBot({ entities, items: [item('diamond_sword')], offhand: item('shield') })
  bot.heldItem = bot.inventory.slots[9]
  bot.equip = async () => {}
  bot.activateItem = () => { bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  bot.waitForTicks = async (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  bot.entity.yaw = 0
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  return bot
}

test('fight: two wither skeletons at the bot from the west and the south, the shield up faces between them, each in its front; one on each side, backed off from them with it up (full-26.3-fresh-u)', async () => {
  const { fight } = await import('../../src/skills/fight')
  const west = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(-0.9, 64, 0.5) })
  const south = entity({ id: 9, name: 'wither_skeleton', position: new Vec3(0.5, 64, 1.9) })
  const bot = fightBot([west, south])
  const blockedLooks: Array<{ x: number, z: number }> = []
  bot.on('physicsTick', () => { if (bot.usingHeldItem === true) blockedLooks.push({ x: -Math.sin(bot.entity.yaw), z: -Math.cos(bot.entity.yaw) }) })
  await fight(bot, west as any, { maxTicks: 60 }).catch(() => {})
  assert.ok(blockedLooks.length > 10, `${blockedLooks.length} ticks blocking`)
  const front = (look: { x: number, z: number }, m: any): number => {
    const dx = m.position.x - bot.entity.position.x; const dz = m.position.z - bot.entity.position.z; const d = Math.hypot(dx, dz)
    return (dx * look.x + dz * look.z) / d
  }
  const both = blockedLooks.filter(l => front(l, west) > 0 && front(l, south) > 0).length
  assert.ok(both >= blockedLooks.length - 2, `both in front ${both} of ${blockedLooks.length} blocking ticks`)
  // one each side of the bot (west and east): the shield up, backing off (the back key held) on open ground
  const east = entity({ id: 10, name: 'wither_skeleton', position: new Vec3(1.9, 64, 0.6) })
  const w2 = entity({ id: 11, name: 'wither_skeleton', position: new Vec3(-0.9, 64, 0.5) })
  const bot2 = fightBot([w2, east])
  let backing = 0
  bot2.on('physicsTick', () => { if (bot2.usingHeldItem === true && bot2.getControlState('back') === true) backing++ })
  await fight(bot2, w2 as any, { maxTicks: 40 }).catch(() => {})
  assert.ok(backing > 0, 'never backed off with the shield up')
})

test('fight with yieldToNearer: another melee mob at the bot while the target is out of the sword\'s reach ends the fight (the reflex fights the nearest next); without it the fight goes on', async () => {
  const { fight } = await import('../../src/skills/fight')
  const far = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(6.5, 64, 0.5) })
  const near = entity({ id: 9, name: 'wither_skeleton', position: new Vec3(0.5, 64, 1.9) })
  const bot = fightBot([far, near])
  const r = await fight(bot, far as any, { maxTicks: 60, yieldToNearer: true })
  assert.equal(r.killed, false)
  assert.ok(r.ticks <= 2, `${r.ticks} ticks`)
  const bot2 = fightBot([entity({ id: 8, name: 'wither_skeleton', position: new Vec3(6.5, 64, 0.5) }), entity({ id: 9, name: 'wither_skeleton', position: new Vec3(0.5, 64, 1.9) })])
  const r2 = await fight(bot2, bot2.entities[8], { maxTicks: 30 }).catch(err => err)
  assert.ok(r2 instanceof Error && /still alive/.test(r2.message), String(r2?.message ?? JSON.stringify(r2)))
  // the hostiles reflex's fights yield so
  const { meleeOptions } = await import('../../src/reflexes/rules')
  const { DEFAULT_REFLEX_CONFIG } = await import('../../src/reflexes/config')
  assert.equal(meleeOptions({ name: 'wither_skeleton' }, DEFAULT_REFLEX_CONFIG, true).yieldToNearer, true)
})

test('sweepSpared: a sword\'s sweep (on the ground, charged, not sprinting) at a wither skeleton with a zombified piglin beside it would hit the piglin; not from the air, sprinting, with an axe, a piglin farther off, or fighting the piglins themselves (full-26.3-fresh-x)', async () => {
  const { sweepSpared } = await import('../../src/skills/weapons')
  const skeleton = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(1.9, 64, 0.5) })
  const piglin = entity({ id: 9, name: 'zombified_piglin', position: new Vec3(2.2, 64, 1.6) })
  const bot = fightBot([skeleton, piglin])
  assert.deepEqual(sweepSpared(bot, skeleton, 1).map(e => e.id), [9])
  assert.deepEqual(sweepSpared(bot, skeleton, 0.5), [])
  bot.entity.onGround = false
  assert.deepEqual(sweepSpared(bot, skeleton, 1), [])
  bot.entity.onGround = true
  bot.controls.sprint = true
  assert.deepEqual(sweepSpared(bot, skeleton, 1), [])
  bot.controls.sprint = false
  bot.heldItem = item('iron_axe')
  assert.deepEqual(sweepSpared(bot, skeleton, 1), [])
  bot.heldItem = bot.inventory.slots[9]
  // the piglin 2 off the skeleton's side: out of the sweep's box
  piglin.position = new Vec3(1.9, 64, 3.2)
  assert.deepEqual(sweepSpared(bot, skeleton, 1), [])
  // a zombified piglin fought: the others of its kind are angry already
  const other = entity({ id: 10, name: 'zombified_piglin', position: new Vec3(2.2, 64, 1.4) })
  const bot2 = fightBot([piglin, other])
  piglin.position = new Vec3(1.9, 64, 0.5)
  assert.deepEqual(sweepSpared(bot2, piglin, 1), [])
})

test('fight: a wither skeleton with a zombified piglin at its side is never swung at with the sword (its sweep would anger the piglins), the shield kept up; swung at once the piglin is off (full-26.3-fresh-x)', async () => {
  const { fight } = await import('../../src/skills/fight')
  const skeleton = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(1.9, 64, 0.5) })
  const piglin = entity({ id: 9, name: 'zombified_piglin', position: new Vec3(2.2, 64, 1.6) })
  const bot = fightBot([skeleton, piglin])
  const swung: number[] = []
  bot.attack = (e: any) => { swung.push(e.id) }
  let blocked = 0
  let ticks = 0
  bot.on('physicsTick', () => { ticks++; if (bot.usingHeldItem === true) blocked++ })
  await fight(bot, skeleton as any, { maxTicks: 60 }).catch(() => {})
  assert.deepEqual(swung, [])
  assert.ok(blocked >= ticks - 3, `the shield up ${blocked} of ${ticks} ticks`)
  piglin.position = new Vec3(8, 64, 8)
  await fight(bot, skeleton as any, { maxTicks: 60 }).catch(() => {})
  assert.ok(swung.length >= 2 && swung.every(id => id === 8), swung.join(', '))
})

test('AttackStrength.attack refuses a charged sword swing whose sweep would hit a zombified piglin (nothing sent), and lets it through with none about', async () => {
  const { AttackStrength } = await import('../../src/skills/weapons')
  const skeleton = entity({ id: 8, name: 'wither_skeleton', position: new Vec3(1.9, 64, 0.5) })
  const piglin = entity({ id: 9, name: 'zombified_piglin', position: new Vec3(2.2, 64, 1.6) })
  const bot = fightBot([skeleton, piglin])
  const sent: number[] = []
  bot.attack = (e: any) => { sent.push(e.id) }
  const s = new AttackStrength(bot)
  for (let i = 0; i < 20; i++) bot.emit('physicsTick')
  assert.strictEqual(s.attack(skeleton as any), false)
  assert.deepEqual(sent, [])
  delete bot.entities[9]
  assert.strictEqual(s.attack(skeleton as any), true)
  assert.deepEqual(sent, [8])
  s.detach()
})

test('FIGHT_REACH: the fight swings from 2.75 of the eye, under the 3 the server measures (Grim Reach: 3.048 from a swing at 2.9, grim-2: the zombie had moved on the server)', async () => {
  const { FIGHT_REACH } = await import('../../src/skills/fight')
  assert.ok(FIGHT_REACH <= 2.75 && FIGHT_REACH > 2.5, String(FIGHT_REACH))
})
