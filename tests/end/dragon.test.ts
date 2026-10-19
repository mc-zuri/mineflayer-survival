import { test } from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import { SCAN_TURN_SLACK, yawFacing, CONTACT_MARGIN, DragonPhaseTracker, FLAME_DURATION, JUMP_HEIGHT, SITTING_DAMAGE_LIMIT, TAKEOFF_HIT_MARGIN, TAKEOFF_WARNING_TICKS, headPosition, activityOf, breathZone, dragonZones, headDirection, meleeSpots, neckTakesFullDamage, partBox, phaseName, touchedZone, vanillaYaw } from '../../src/end/dragon'
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

test('dragonZones: the head and neck inflated by 1 and the wings reach 2 under a sitting dragon\'s feet; the ground round the podium is under them all', () => {
  const portalY = 63
  const perch = exitPortal(portalY).perch
  const dragon = { position: perch, yaw: 0 } // head towards -z
  const zones = dragonZones(dragon)
  assert.deepEqual(zones.map(z => z.part), ['head', 'neck', 'wing', 'wing'])
  const head = zones[0].box
  // the head part (1 × 1 at 6.5 out, a block under the body) inflated by 1
  assert.deepEqual([head.min.x, head.max.x, head.min.y, head.max.y, head.min.z, head.max.z], [perch.x - 1.5, perch.x + 1.5, perch.y - 2, perch.y + 1, perch.z - 8, perch.z - 5])
  // the wings (4.5 to each side, 2 up) inflated by (4, 2, 4) and down 2: from 2 under the feet, 6 out from each wing
  const wing = zones[2].box
  assert.deepEqual([wing.min.y, wing.max.y], [perch.y - 2, perch.y + 4])
  assert.deepEqual([wing.min.x, wing.max.x], [perch.x + 4.5 - 6, perch.x + 4.5 + 6])
  // a sitting dragon's wings only push; the head and neck always hurt
  assert.deepEqual(zones.map(z => z.hurts), [true, true, false, false])
  assert.ok(dragonZones(dragon, false).every(z => z.hurts))
  // right under the head on the ground: clear of them all; a jump there touches the head
  const under = { x: perch.x, y: portalY, z: perch.z - 6.5 }
  assert.equal(touchedZone(under, zones, 0, CONTACT_MARGIN), null)
  assert.equal(touchedZone(under, zones, JUMP_HEIGHT)?.part, 'head')
  // a block up (the rim's height, a bump of end stone) the body touches the head
  assert.equal(touchedZone({ ...under, y: portalY + 1 }, zones)?.part, 'head')
})

test('meleeSpots leaves out the spots where the body touches the dragon (a 26.3 bot died to its head on a bump a block over the ground, 9 hits of 10)', () => {
  // the death: the dragon perched at 68.6 over a portal at 64, the bot hitting it from the end stone at 65
  // facing the bot (DragonSittingScanningPhase turns it to the player): (sin yRot, -cos yRot) along the way to it
  const dragon = { position: { x: 0.25, y: 68.6, z: 0.06 }, yaw: Math.atan2(-6.12 - 0.25, -(3.44 - 0.06)) * 180 / Math.PI }
  const zones = dragonZones(dragon)
  assert.equal(touchedZone({ x: -6.12, y: 65, z: 3.44 }, zones)?.part, 'head')
  for (const g of [64, 65]) {
    for (const s of meleeSpots(dragon, g)) assert.equal(touchedZone(s, zones, 0, CONTACT_MARGIN), null, `${s.x} ${s.y} ${s.z}`)
  }
  // the head is still in reach from the ground at 64, under it
  const low = meleeSpots(dragon, 64)
  assert.equal(low[0].target, 'head')
  // crits only where a jump clears the zones too
  const perch = exitPortal(63).perch
  const facing = { position: perch, yaw: 0 }
  const spots = meleeSpots(facing, 63)
  assert.ok(spots.some(s => s.crit) && spots.some(s => !s.crit))
  for (const s of spots.filter(s => s.crit)) assert.equal(touchedZone(s, dragonZones(facing), JUMP_HEIGHT, CONTACT_MARGIN), null)
  // a crit is preferred among the head's spots
  assert.equal(spots[0].crit, true)
})

test('without metadata the perch is told by position', () => {
  const t = new DragonPhaseTracker(exitPortal(63).perch)
  t.last = { tick: 0, phase: -1, position: { x: 0.6, y: 67, z: 0.4 }, yaw: 0 }
  assert.equal(t.window(0).open, true)
})

test('takeoffSoon: the 4th flame\'s last ticks, or the sitting damage a hit short of its limit', () => {
  const t = new DragonPhaseTracker(exitPortal(63).perch)
  const at = { x: 0.5, y: 67, z: 0.5 }
  t.update({ tick: 0, phase: 6, position: at, yaw: 0 })
  assert.equal(t.window(1).takeoffSoon, false)
  // four flames (scanning, attacking, flaming over again)
  let tick = 10
  for (let f = 0; f < 4; f++) {
    t.update({ tick: tick++, phase: 7, position: at, yaw: 0 })
    t.update({ tick: tick, phase: 5, position: at, yaw: 0 })
    if (f < 3) { tick += FLAME_DURATION; t.update({ tick: tick++, phase: 6, position: at, yaw: 0 }) }
  }
  assert.equal(t.flames, 4)
  assert.equal(t.window(tick + 100).takeoffSoon, false)
  assert.equal(t.window(tick + FLAME_DURATION - TAKEOFF_WARNING_TICKS).takeoffSoon, true)
  const d = new DragonPhaseTracker(exitPortal(63).perch)
  d.update({ tick: 0, phase: 6, position: at, yaw: 0 })
  d.updateHealth(200)
  d.updateHealth(200 - (SITTING_DAMAGE_LIMIT - TAKEOFF_HIT_MARGIN))
  assert.equal(d.window(1).takeoffSoon, false)
  d.updateHealth(200 - (SITTING_DAMAGE_LIMIT - TAKEOFF_HIT_MARGIN) - 1)
  assert.equal(d.window(2).takeoffSoon, true)
})

test('flight: the head\'s y offset and tilt from the y history (EnderDragon.getHeadYOffset, DragonFlightHistory): under the body as it starts to climb', () => {
  const t = new DragonPhaseTracker(exitPortal(63).perch)
  // sat at 67 for 10 ticks, then climbing faster and faster
  for (let i = 0; i <= 10; i++) t.update({ tick: i, phase: 4, position: { x: 0.5, y: 67, z: 0.5 }, yaw: 0 })
  assert.deepEqual(t.flight(), { headYOffset: 0, tilt: 0 })
  const ys = [67.1, 67.3, 67.6, 68, 68.5]
  ys.forEach((y, i) => t.update({ tick: 11 + i, phase: 4, position: { x: 0.5, y, z: 0.5 }, yaw: 0 }))
  const f = t.flight()
  // 5 ticks back it was at 67: 1.5 under now; 10 back at 67 too: no tilt yet
  assert.ok(Math.abs(f.headYOffset + 1.5) < 1e-9)
  assert.equal(f.tilt, 0)
  const view = { position: { x: 0.5, y: 68.5, z: 0.5 }, yaw: 0, ...f }
  assert.ok(Math.abs(headPosition(view, false).y - 67) < 1e-9)
  // a level flight's head is level with the body; a sitting one's a block under
  assert.equal(headPosition({ position: view.position, yaw: 0 }, false).y, 68.5)
  assert.equal(headPosition(view, true).y, 67.5)
})

test('meleeSpots while it scans: each spot judged with the dragon turned to face it; with the ground a block up (no room under its zones) the head is hit from in front, past its reach (a 26.3 bot stood in reach of the head as it turned to it, and took 9 touches)', () => {
  // the 26.3 run's perch: the dragon at 68 over a portal at 64, the island's ground round the podium at 65
  const dragon = { position: { x: -0.1, y: 67.97, z: 0.9 }, yaw: 90 }
  const spots = meleeSpots(dragon, 65, null, 0.8, true, undefined, true)
  assert.ok(spots.length > 0)
  assert.notEqual(spots[0].target, 'body')
  for (const s of spots) {
    for (const t of [-SCAN_TURN_SLACK, 0, SCAN_TURN_SLACK]) {
      assert.equal(touchedZone(s, dragonZones({ ...dragon, yaw: yawFacing(dragon.position, s) + t }), 0, CONTACT_MARGIN), null, `${s.x} ${s.z}`)
    }
  }
  // the death's spot: at the head's edge once the dragon faced it (within the margin; the server's hits came there)
  const death = { x: -8.4, y: 65, z: 2.5 }
  assert.ok(touchedZone(death, dragonZones({ ...dragon, yaw: yawFacing(dragon.position, death) }), 0, CONTACT_MARGIN) != null)
  assert.ok(!spots.some(s => Math.hypot(s.x - death.x, s.z - death.z) < 0.6))
  // not turning: judged as it faces now, the same spot is clear (the head points the other way)
  assert.equal(touchedZone(death, dragonZones(dragon), 0, CONTACT_MARGIN), null)
})
