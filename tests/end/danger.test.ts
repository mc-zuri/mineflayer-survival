import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { CONTACT_MARGIN, DRAGON_PHASES, breathZone, dragonZones, touchedZone } from '../../src/end/dragon'
import { exitPortal } from '../../src/end/spikes'
import { closestApproach, dragonDangers, fireballLanding, inDanger, safeSpot, underDragonWatch } from '../../src/end/skills/danger'
import { VoidGuard } from '../../src/end/skills/world'
import { motionTrackerOf } from '../../src/skills/motion'
import { TaskError } from '../../src/core/errors'
import { entity, fakeBot } from '../reflexes/fakeBot'
import { endIsland, world } from './endWorld'

test('fireballLanding and closestApproach follow straight lines', () => {
  const land = fireballLanding(new Vec3(0, 92, 0), new Vec3(1, -1, 0.5), 62)
  assert.deepStrictEqual(land, { x: 30, z: 15 })
  assert.strictEqual(fireballLanding(new Vec3(0, 92, 0), new Vec3(1, 0.1, 0), 62), null)
  const pass = closestApproach(new Vec3(-20, 70, 3), new Vec3(1, 0, 0), { x: 0, y: 62, z: 0 }, 60)
  assert.strictEqual(pass.tick, 20)
  assert.ok(Math.abs(pass.distance - 3) < 1e-9)
})

test('safeSpot steps out of a breath cloud to open ground away from the void', () => {
  const get = world(endIsland([], 40))
  const dangers = [{ center: { x: 10, z: 0 }, radius: 5, why: 'cloud' as const }]
  const from = new Vec3(10.5, 62, 0.5)
  assert.ok(inDanger(from, dangers) != null)
  const to = safeSpot(get, from, dangers, new VoidGuard(get, 3))
  assert.ok(to != null)
  assert.ok(inDanger(to, dangers, 1.2) == null)
  assert.strictEqual(to.y, 62)
  // at the island's edge it won't pick the way off it
  const edge = new Vec3(37.5, 62, 0.5)
  const away = safeSpot(get, edge, [{ center: { x: 35, z: 0 }, radius: 4, why: 'cloud' }], new VoidGuard(get, 3))
  assert.ok(away != null && Math.hypot(away.x, away.z) < 37, `${String(away)}`)
})

test('inDanger: a cloud touches a body from 1.8 below to half a block over it, not a bot up a pillar', () => {
  const cloud = [{ center: { x: 0, z: 0 }, y: 62, radius: 3, why: 'cloud' as const }]
  assert.ok(inDanger({ x: 1, y: 62, z: 1 }, cloud) != null)
  assert.ok(inDanger({ x: 1, y: 60.5, z: 1 }, cloud) != null)
  assert.strictEqual(inDanger({ x: 1, y: 64, z: 1 }, cloud), null)
  assert.strictEqual(inDanger({ x: 5, y: 62, z: 0 }, cloud), null)
  assert.ok(inDanger({ x: 5, y: 62, z: 0 }, cloud, 2.5) != null)
})

test('dragonDangers: the clouds by their radius, a fireball\'s landing ahead of it, a charge passing close', () => {
  const cloud = entity({ name: 'area_effect_cloud', position: new Vec3(10, 62, 0), meta: { radius: 4.5 } })
  const fireball = entity({ name: 'dragon_fireball', position: new Vec3(0, 82, 0) })
  const dragon = entity({ name: 'ender_dragon', position: new Vec3(-30, 70, 2), meta: { phase: DRAGON_PHASES.indexOf('charging_player') } })
  const bot = fakeBot({ position: new Vec3(0.5, 62, 0.5), entities: [cloud, fireball, dragon] })
  const motion = motionTrackerOf(bot)
  motion.track(fireball)
  motion.track(dragon)
  // two ticks of motion: the fireball down and east, the dragon east at the bot
  fireball.position = new Vec3(1, 81, 0); dragon.position = new Vec3(-28, 70, 2); motion.sample()
  const dangers = dragonDangers(bot, 62)
  const byWhy = new Map(dangers.map(d => [d.why, d]))
  assert.strictEqual(byWhy.get('cloud')?.radius, 4.5)
  assert.deepStrictEqual(byWhy.get('fireball')?.center, { x: 20, z: 0 })
  const charge = byWhy.get('charge')
  assert.ok(charge != null && Math.abs(charge.center.x - 0.5) < 1e-9 && charge.center.z === 2)
  // up a pillar, the charge's line is no reason to move
  bot.entity.position = new Vec3(0.5, 80, 0.5)
  assert.strictEqual(inDanger(bot.entity.position, dragonDangers(bot, 62)), null)
})

test('underDragonWatch: work that runs into a cloud is cut off, the bot steps out of it, and the caller hears to plan again', async () => {
  const cloud = entity({ name: 'area_effect_cloud', position: new Vec3(0.5, 64, 0.5), meta: { radius: 2 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.deactivateItem = () => {}
  bot.stopDigging = () => {}
  // the physics: the controls move the bot a block a tick along its yaw
  let yaw = 0
  bot.look = async (y: number) => { yaw = y }
  bot.waitForTicks = async () => {
    if (bot.controls.forward === true) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw), 0, -Math.cos(yaw))
    bot.emit('physicsTick')
    await new Promise(resolve => setImmediate(resolve))
  }
  let aborted: unknown = null
  const done = underDragonWatch(bot, 64, async (signal) => {
    bot.entities[cloud.id] = cloud
    await new Promise((resolve) => signal.addEventListener('abort', () => { aborted = signal.reason; resolve(null) }))
    await new Promise(() => {})
  })
  const ticker = setInterval(() => { bot.emit('physicsTick') }, 1)
  try {
    assert.strictEqual(await done, false)
  } finally {
    clearInterval(ticker)
  }
  assert.ok(TaskError.is(aborted) && aborted.code === 'PREEMPTED')
  assert.strictEqual(inDanger(bot.entity.position, dragonDangers(bot, 64), 2), null, `still in the cloud at ${bot.entity.position.toString()}`)
})

test('safeSpot out of the coming breath keeps off the perched dragon\'s head and neck, there and on the way (a 26.3 bot stepped out of the breath along the neck and was hit)', () => {
  const blocks = endIsland([], 40)
  // the ground a block up round the podium: no room under the zones
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) if (Math.abs(x) > 3 || Math.abs(z) > 3) blocks.set(`${x},62,${z}`, 'end_stone')
  const get = world(blocks)
  const perch = exitPortal(62).perch
  // facing +z: the head over z 7, the breath's cloud 9 out
  const view = { position: perch, yaw: 180 }
  const zones = dragonZones(view).filter(z => z.hurts)
  const b = breathZone(view)
  const dangers = [{ center: b.center, y: 63, radius: b.radius, why: 'breath' as const }]
  const from = new Vec3(perch.x - 2.5, 63, perch.z + 8.5)
  const plain = safeSpot(get, from, dangers, null)
  const kept = safeSpot(get, from, dangers, null, { zones })
  assert.ok(plain != null && kept != null)
  assert.equal(touchedZone(kept, zones, 0, CONTACT_MARGIN), null)
  assert.equal(touchedZone(new Vec3((from.x + kept.x) / 2, 63, (from.z + kept.z) / 2), zones, 0, 0.1), null)
  assert.equal(inDanger(kept, dangers), null)
})
