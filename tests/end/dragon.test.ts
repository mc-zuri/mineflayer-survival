import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { DragonPhaseTracker, activityOf, breathZone, headDirection, meleeSpots, neckTakesFullDamage, partBox, phaseName, vanillaYaw } from '../../src/end/dragon'
import { exitPortal } from '../../src/end/spikes'

test('phase ids are the EnderDragonPhase creation order', () => {
  assert.equal(phaseName(0), 'holding_pattern')
  assert.equal(phaseName(3), 'landing')
  assert.equal(phaseName(5), 'sitting_flaming')
  assert.equal(phaseName(8), 'charging_player')
  assert.equal(phaseName(10), 'hover')
  assert.equal(phaseName(11), null)
  assert.equal(activityOf('strafe_player'), 'strafing')
  assert.equal(activityOf('takeoff'), 'leaving')
})

test('the head points along (sin yRot, -cos yRot); mineflayer yaw converts back', () => {
  const d = headDirection(90)
  assert.ok(Math.abs(d.x - 1) < 1e-12 && Math.abs(d.z) < 1e-12)
  // mineflayer yaw = π - vanilla, in radians
  assert.ok(Math.abs(vanillaYaw(Math.PI - Math.PI / 2) - 90) < 1e-9)
})

test('the breath lands 9 blocks out along the head, and melee spots keep out of it', () => {
  const perch = exitPortal(63).perch
  const dragon = { position: perch, yaw: 0 } // head towards -z
  const b = breathZone(dragon)
  assert.ok(Math.abs(b.center.x - 0.5) < 1e-9 && Math.abs(b.center.z - (0.5 - 9)) < 1e-9)
  // before the cloud: the head (6.5 out, a block under the body) is in reach from the ground
  const free = meleeSpots(dragon, 63)
  assert.equal(free[0].target, 'head')
  // with the cloud out the head is too close to it; the spots left are by the body
  const spots = meleeSpots(dragon, 63, b)
  assert.ok(spots.length > 0)
  for (const s of spots) assert.ok(Math.hypot(s.x - b.center.x, s.z - b.center.z) >= b.radius + 0.8)
  assert.ok(spots.every(s => s.target === 'body'))
})

test('26.3 hurts the neck as the head (EnderDragon.hurt): with the head out of reach, the neck before the body', () => {
  assert.equal(neckTakesFullDamage(minecraftData('1.21.11').version as any), false)
  assert.equal(neckTakesFullDamage(minecraftData('26.3').version as any), true)
  const perch = exitPortal(63).perch
  const dragon = { position: perch, yaw: 0 }
  const neck = partBox(dragon, 'neck')
  assert.deepEqual([neck.min.z, neck.max.z], [perch.z - 5.5 - 1.5, perch.z - 5.5 + 1.5])
  assert.equal(neck.min.y, perch.y - 1)
  const b = breathZone(dragon)
  // 1.21.11: the neck takes body damage, so it is no target of its own
  assert.ok(meleeSpots(dragon, 63, b).every(s => s.target === 'body'))
  const spots = meleeSpots(dragon, 63, b, 0.8, true)
  assert.equal(spots[0].target, 'neck')
  for (const s of spots) assert.ok(Math.hypot(s.x - b.center.x, s.z - b.center.z) >= b.radius + 0.8)
  // without the breath the head still comes first
  assert.equal(meleeSpots(dragon, 63, null, 0.8, true)[0].target, 'head')
})

test('the tracker opens the melee window while the dragon sits and closes it on takeoff', () => {
  const t = new DragonPhaseTracker(exitPortal(63).perch)
  const at = { x: 0.5, y: 67, z: 0.5 }
  t.update({ tick: 0, phase: 0, position: { x: 40, y: 90, z: 0 }, yaw: 0 })
  assert.equal(t.window(0).open, false)
  t.update({ tick: 100, phase: 2, position: { x: 20, y: 80, z: 0 }, yaw: 0 })
  assert.equal(t.window(100).activity, 'landing')
  t.update({ tick: 200, phase: 6, position: at, yaw: 0 })
  const w = t.window(210)
  assert.equal(w.open, true)
  assert.ok(w.ticksLeft > 0)
  assert.equal(w.breath, null)
  t.update({ tick: 230, phase: 7, position: at, yaw: 45 })
  assert.deepEqual(t.window(231).breath, breathZone({ position: at, yaw: 45 }))
  t.update({ tick: 270, phase: 5, position: at, yaw: 45 })
  assert.equal(t.flames, 1)
  assert.ok(t.window(275).breath != null)
  // 25% of 200 health taken while sitting ends it early
  t.updateHealth(200)
  t.updateHealth(140)
  assert.equal(t.window(280).open, false)
  t.update({ tick: 300, phase: 4, position: at, yaw: 45 })
  assert.equal(t.window(300).open, false)
  assert.equal(t.sittingDamage, 0)
})

test('the sitting damage carries over to the next perch unless it passed 50 (EnderDragon.sittingDamageReceived)', () => {
  const t = new DragonPhaseTracker(exitPortal(63).perch)
  const at = { x: 0.5, y: 67, z: 0.5 }
  t.update({ tick: 0, phase: 6, position: at, yaw: 0 })
  t.updateHealth(200)
  t.updateHealth(170)
  // the perch ends on its timers: the 30 stay
  t.update({ tick: 500, phase: 4, position: at, yaw: 0 })
  assert.equal(t.sittingDamage, 30)
  t.update({ tick: 900, phase: 6, position: at, yaw: 0 })
  // 50 in all keeps it sitting; more than 50 makes it leave
  t.updateHealth(150)
  assert.equal(t.window(901).open, true)
  t.updateHealth(149)
  assert.equal(t.window(902).open, false)
})

test('without metadata the perch is told by position', () => {
  const t = new DragonPhaseTracker(exitPortal(63).perch)
  t.last = { tick: 0, phase: -1, position: { x: 0.6, y: 67, z: 0.4 }, yaw: 0 }
  assert.equal(t.window(0).open, true)
})
