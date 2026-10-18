import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { exitPortal } from '../../src/end/spikes'
import { breathZone, DragonPhaseTracker, DRAGON_PHASES, headPosition } from '../../src/end/dragon'
import { chooseMeleeSpot, dragonPartId } from '../../src/end/skills/fightDragon'
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
