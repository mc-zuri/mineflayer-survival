import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { exitPortal } from '../../src/end/spikes'
import { breathZone, CONTACT_MARGIN, DragonPhaseTracker, DRAGON_PHASES, JUMP_HEIGHT, dragonZones, headPosition, touchedZone } from '../../src/end/dragon'
import { ARROW_FLIGHT_TICKS, EAT_CLEAR_PERCHED, RETREAT_DISTANCE, arrowHit, TAKEOFF_CLEARANCE, canHeal, chooseMeleeSpot, dragonPartId, fightDragon, foodToEat, hurtContext, hurtingContact, retreatSpot, safeToEat, takeoffStepBack } from '../../src/end/skills/fightDragon'
import { entity, fakeBot, item } from '../reflexes/fakeBot'
import { endIsland, world } from './endWorld'

test('dragonPartId: the head is the id after the dragon\'s (EnderDragon.setId)', () => {
  assert.strictEqual(dragonPartId({ id: 40 }), 41)
  assert.strictEqual(dragonPartId({ id: 40 }, 'body'), 43)
})

test('chooseMeleeSpot: a standing spot within reach of the perched dragon\'s head, out of the breath it is about to breathe', () => {
  const blocks = endIsland([], 40)
  const get = world(blocks)
  const perch = exitPortal(62).perch
  // facing +x: vanilla yaw 90 (the head along (sin, -cos) = (1, 0))
  const view = { position: new Vec3(perch.x, perch.y, perch.z), yaw: 90 }
  const tracker = new DragonPhaseTracker(perch)
  tracker.update({ tick: 0, phase: DRAGON_PHASES.indexOf('sitting_scanning'), position: view.position, yaw: 90 })
  const scanning = chooseMeleeSpot(get, view, 62, tracker.window(5), [], null)
  assert.ok(scanning != null)
  assert.strictEqual(scanning.target, 'head')
  const head = headPosition(view)
  assert.ok(Math.hypot(scanning.spot.x - head.x, scanning.spot.z - head.z) < 3.5)
  // flaming: the cloud past the head; the spot left is by the body, outside it
  tracker.update({ tick: 10, phase: DRAGON_PHASES.indexOf('sitting_flaming'), position: view.position, yaw: 90 })
  const window = tracker.window(12)
  const flaming = chooseMeleeSpot(get, view, 62, window, [], null)
  assert.ok(flaming != null)
  const breath = breathZone(view)
  assert.ok(Math.hypot(flaming.spot.x - breath.center.x, flaming.spot.z - breath.center.z) > breath.radius)
})

test('chooseMeleeSpot: never a bump a block over the ground under the head (its zone reaches 2 under the perched dragon), and a crit only where the jump clears the zones', () => {
  const blocks = endIsland([], 40)
  const perch = exitPortal(62).perch
  // facing +x, sat a little high (it lands within a block of the perch): the head over (7, 65, 0)
  const view = { position: new Vec3(perch.x, perch.y + 0.6, perch.z), yaw: 90 }
  // end stone a block over the ground all round under the head and neck: x 4 to 10, z -3 to 3
  for (let x = 4; x <= 10; x++) for (let z = -3; z <= 3; z++) blocks.set(`${x},62,${z}`, 'end_stone')
  const get = world(blocks)
  const tracker = new DragonPhaseTracker(perch)
  tracker.update({ tick: 0, phase: DRAGON_PHASES.indexOf('sitting_scanning'), position: view.position, yaw: 90 })
  const zones = dragonZones(view)
  // the bump right under the head: in the head's zone
  assert.ok(touchedZone({ x: 7.5, y: 63, z: 0.5 }, zones) != null)
  const choice = chooseMeleeSpot(get, view, 62, tracker.window(5), [], null, true, { x: 7.5, y: 63, z: 0.5 })
  assert.ok(choice != null)
  assert.equal(touchedZone(choice.spot, zones, 0, CONTACT_MARGIN), null)
  if (choice.crit) assert.equal(touchedZone(choice.spot, zones, JUMP_HEIGHT, CONTACT_MARGIN), null)
  assert.notEqual(choice.target, 'body')
})

test('fightDragon waits for the podium\'s chunk to find the exit portal, and is done at once when the portal is open and no dragon is left', async () => {
  const blocks = endIsland([], 30)
  for (const p of exitPortal(62).portal) blocks.set(`${p.x},${p.y},${p.z}`, 'end_portal')
  const get = world(blocks)
  let ticks = 0
  const bot = fakeBot({ position: new Vec3(10.5, 62, 0.5) })
  bot.game.dimension = 'the_end'
  bot.game.minY = 0
  // the column at 0, 0 unloaded for the first 30 ticks
  bot.blockAt = (pos: Vec3) => {
    const p = pos.floored()
    if (ticks < 30 && Math.abs(p.x) < 16 && Math.abs(p.z) < 16) return null
    const b = get(p)
    return b == null ? null : { ...b, position: p }
  }
  bot.waitForTicks = async () => { ticks++; bot.emit('physicsTick') }
  const result = await fightDragon(bot, { destroyCrystals: false, maxTicks: 50 })
  assert.ok(result.killed)
  assert.ok(ticks >= 30)
})

test('the end milestone gets a bow and arrows before the End, not optional: no bow is no way in', async () => {
  const { endHandler, END_ARROWS } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('arrow', 64)] })
  bot.game.dimension = 'overworld'
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    obtain: async (reqs: any[]) => {
      calls.push(reqs.map(r => `${r.item}${r.optional === true ? '?' : ''}`).join(','))
      if (reqs.some(r => r.item === 'bow' && r.optional !== true)) throw new Error('NOT_FOUND: no string')
    },
    task: async (name: string) => { calls.push(name) }
  }
  await assert.rejects(endHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: { goals: () => [{ item: 'bow', count: 1 }] } as any, state: null as any }), /no string/)
  assert.deepStrictEqual(calls, ['bow?', 'bow,arrow'])
  assert.ok(END_ARROWS > 0)
})

test('in the End with few blocks and a full bag, room is made before the end stone is dug', async () => {
  const { endHandler } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ items: [item('bow', 1), item('arrow', 64), item('cobblestone', 15)] })
  bot.game.dimension = 'the_end'
  ;(bot.inventory as any).emptySlotCount = () => 0
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    makeRoom: async (_n: unknown, _s: unknown, force: boolean) => { calls.push(`room ${String(force)}`) },
    obtain: async () => {},
    task: async (name: string) => { calls.push(name); if (name === 'fight the dragon') throw new Error('stop here') }
  }
  await assert.rejects(endHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: { goals: () => [] } as any, state: null as any }), /stop here/)
  assert.ok(calls.indexOf('room true') >= 0 && calls.indexOf('room true') < calls.indexOf('end stone'), calls.join(', '))
})

test('endStoneTopLayer: the island\'s top layer round the bot, not under it nor below it', async () => {
  const { endStoneTopLayer } = await import('../../src/milestones')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 60, 0.5), world: (p: any) => p.y < 60 ? 'end_stone' : 'air' })
  const id = bot.registry.blocksByName.end_stone.id
  bot.findBlocks = () => { const out: any[] = []; for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (const y of [59, 58]) out.push(new Vec3(x, y, z)); return out } 
  const top = endStoneTopLayer(bot, 10)
  assert.equal(top.length, 10)
  for (const p of top) {
    assert.equal(p.y, 59)
    assert.ok(Math.hypot(p.x, p.z) >= 2, p.toString())
  }
  assert.ok(id != null)
})

test('safeToEat: eating (32 ticks standing still) only out of a perched dragon\'s scan range, far from one circling, further from one strafing or charging', () => {
  assert.equal(safeToEat(null, 0), true)
  assert.equal(safeToEat('dying', 3), true)
  assert.equal(safeToEat('perched', 8), false)
  assert.equal(safeToEat('perched', EAT_CLEAR_PERCHED), true)
  assert.equal(safeToEat('landing', 15), false)
  assert.equal(safeToEat('circling', 20), false)
  assert.equal(safeToEat('circling', 30), true)
  assert.equal(safeToEat('strafing', 30), false)
  assert.equal(safeToEat('charging', 60), true)
  assert.equal(safeToEat('leaving', 10), false)
})

test('foodToEat: hurt, retreating, hungry or short of the 18 that heals; a full bar and no golden apple is nothing to eat', () => {
  const bot = fakeBot({ health: 20, food: 20, items: [item('cooked_beef', 8)] })
  assert.equal(foodToEat(bot, false, 12), null)
  bot.health = 11
  // hurt, but the bar is full: beef can't be eaten
  assert.equal(foodToEat(bot, false, 12), null)
  bot.food = 15
  assert.equal(foodToEat(bot, false, 12), 'cooked_beef')
  bot.health = 20
  bot.food = 13
  assert.equal(foodToEat(bot, false, 12), 'cooked_beef')
  bot.food = 19
  assert.equal(foodToEat(bot, false, 12), null)
  bot.health = 9
  assert.equal(foodToEat(bot, true, 12), 'cooked_beef')
  assert.equal(canHeal(bot), true)
  const starving = fakeBot({ health: 9, food: 10, items: [] })
  assert.equal(canHeal(starving), false)
})

test('retreatSpot: RETREAT_DISTANCE from the perched dragon on the bot\'s side, turned when that is off the island', () => {
  const blocks = endIsland([], 40)
  const get = world(blocks)
  const perch = exitPortal(62).perch
  const spot = retreatSpot(get, perch, new Vec3(8.5, 62, 0.5), null, [])
  assert.ok(spot != null)
  assert.ok(Math.abs(Math.hypot(spot.x - perch.x, spot.z - perch.z) - RETREAT_DISTANCE) < 1)
  assert.ok(spot.x > 20)
  // a small island: 26 out is the void that way and round about; nothing within reach of the margin
  const small = world(endIsland([], 20))
  assert.equal(retreatSpot(small, perch, new Vec3(8.5, 62, 0.5), null, []), null)
  // a cloud on the bot's side: turned
  const turned = retreatSpot(get, perch, new Vec3(8.5, 62, 0.5), null, [{ center: { x: 26.5, z: 0.5 }, y: 62, radius: 6, why: 'cloud' }])
  assert.ok(turned != null && Math.hypot(turned.x - 26.5, turned.z - 0.5) > 8)
})

test('fightDragon holds the eat reflex off for the fight and lets it go after', async () => {
  const blocks = endIsland([], 30)
  for (const p of exitPortal(62).portal) blocks.set(`${p.x},${p.y},${p.z}`, 'end_portal')
  const get = world(blocks)
  const bot = fakeBot({ position: new Vec3(10.5, 62, 0.5) })
  bot.game.dimension = 'the_end'
  bot.game.minY = 0
  bot.blockAt = (pos: Vec3) => { const b = get(pos.floored()); return b == null ? null : { ...b, position: pos.floored() } }
  bot.waitForTicks = async () => { bot.emit('physicsTick') }
  const held: string[][] = []
  let released = 0
  bot.survival = { reflexes: { inhibit: (names: string[]) => { held.push(names); return () => { released++ } } } }
  const result = await fightDragon(bot, { destroyCrystals: false, maxTicks: 50 })
  assert.ok(result.killed)
  assert.deepEqual(held, [['eat']])
  assert.equal(released, 1)
})

test('takeoffStepBack: during a takeoff, after a hit near the sitting damage\'s limit, and as the 4th flame ends; not otherwise', () => {
  const base = { open: true, phase: 'sitting_scanning' as const, activity: 'perched' as const, phaseTicks: 0, ticksLeft: 100, breath: null, sittingDamage: 0, takeoffSoon: false }
  assert.equal(takeoffStepBack(base, false), false)
  assert.equal(takeoffStepBack(base, true), true)
  assert.equal(takeoffStepBack({ ...base, takeoffSoon: true }, false), false)
  assert.equal(takeoffStepBack({ ...base, phase: 'sitting_flaming', takeoffSoon: true }, false), true)
  assert.equal(takeoffStepBack({ ...base, open: false, phase: 'takeoff', activity: 'leaving' }, false), true)
})

test('hurtingContact: the zones as the dragon is now, a sitting one\'s wings harmless, a flying one\'s not', () => {
  const view = { position: new Vec3(0.5, 66, 0.5), yaw: 90 }
  // on the ground (62) under the head: clear; on a bump (63) under it: the head
  assert.equal(hurtingContact(view, { x: 7.5, y: 62, z: 0.5 }, 'sitting_scanning'), null)
  assert.equal(hurtingContact(view, { x: 7.5, y: 63, z: 0.5 }, 'sitting_scanning'), 'head')
  // by its side a block up: under a wing, which only pushes while it sits and hurts once it doesn't
  assert.equal(hurtingContact(view, { x: 0.5, y: 63, z: 6.5 }, 'sitting_scanning'), null)
  assert.equal(hurtingContact(view, { x: 0.5, y: 63, z: 6.5 }, 'takeoff'), 'wing')
})

test('fightDragon steps back from a dragon taking off, out to TAKEOFF_CLEARANCE from its body', async () => {
  const blocks = endIsland([], 30)
  const get = world(blocks)
  const dragon = entity({ name: 'ender_dragon', position: new Vec3(0.5, 66.2, 0.5), meta: { phase: DRAGON_PHASES.indexOf('takeoff'), health: 150 } })
  dragon.yaw = 0
  const bot = fakeBot({ position: new Vec3(7.5, 62, 0.5), entities: [dragon] })
  bot.game.dimension = 'the_end'
  bot.game.minY = 0
  bot.blockAt = (pos: Vec3) => { const b = get(pos.floored()); return b == null ? null : { ...b, position: pos.floored() } }
  const looks: number[] = []
  bot.look = async (yaw: number) => { looks.push(yaw) }
  bot.waitForTicks = async () => { bot.emit('physicsTick') }
  await assert.rejects(fightDragon(bot, { destroyCrystals: false, maxTicks: 3 }), /alive after 3 ticks/)
  // away along +x: mineflayer yaw atan2(-dx, -dz) = -π/2, sprinting
  assert.ok(looks.length > 0)
  assert.ok(looks.every(y => Math.abs(y + Math.PI / 2) < 1e-6), looks.join(' '))
  // past the clearance it stands
  bot.entity.position = new Vec3(0.5 + TAKEOFF_CLEARANCE + 1, 62, 0.5)
  looks.length = 0
  await assert.rejects(fightDragon(bot, { destroyCrystals: false, bow: false, maxTicks: 3 }), /alive after 3 ticks/)
  assert.deepEqual(looks, [])
  assert.notEqual(bot.controls.forward, true)
})

test('arrowHit: a health drop in flight within ARROW_FLIGHT_TICKS of a shot; none on the perch (arrows do nothing there) or long after', () => {
  assert.equal(arrowHit(200, 191, 'holding_pattern', 20), true)
  assert.equal(arrowHit(200, 191, 'strafe_player', ARROW_FLIGHT_TICKS), true)
  assert.equal(arrowHit(200, 191, 'holding_pattern', ARROW_FLIGHT_TICKS + 1), false)
  assert.equal(arrowHit(200, 191, 'sitting_scanning', 5), false)
  assert.equal(arrowHit(191, 192, 'holding_pattern', 5), false)
  assert.equal(arrowHit(200, 191, null, 5), false)
})


test('hurtContext: where the bot was hurt, the dragon\'s place and phase, the part it touched', () => {
  const dragon = entity({ name: 'ender_dragon', position: new Vec3(0.5, 66, 0.5), meta: { phase: DRAGON_PHASES.indexOf('sitting_scanning'), health: 150 } })
  dragon.yaw = Math.PI - Math.PI / 2 // vanilla 90: the head along +x
  const bot = fakeBot({ position: new Vec3(7.5, 63, 0.5), entities: [dragon] })
  const tracker = new DragonPhaseTracker(exitPortal(62).perch)
  tracker.update({ tick: 0, phase: DRAGON_PHASES.indexOf('sitting_scanning'), position: dragon.position, yaw: 90 })
  const line = hurtContext(bot, 62, tracker)
  assert.match(line, /bot at 7\.5 63\.00 0\.5/)
  assert.match(line, /dragon at 0\.5 66\.00 0\.5 yaw 90 \(sitting_scanning\), touching its head/)
})
