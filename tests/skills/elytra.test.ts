// The elytra flight's steering and its durability rules, without a server; and a flight simulated with vanilla's
// gliding (LivingEntity.updateFallFlyingMovement) and a rocket's pull (FireworkRocketEntity.tick) over flat ground.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { CRUISE_HEIGHT, ELYTRA_LOW_DURABILITY, FLY_MIN_DISTANCE, ROCKET_MIN_TICKS, SAFE_SINK, canFly, durabilityLeft, steerFlight, yawToward, type FlightState } from '../../src/skills/elytra'

const state = (over: Partial<FlightState>): FlightState => ({
  pos: new Vec3(0, 100, 0),
  vel: new Vec3(0, 0, -1.2),
  target: new Vec3(0, 64, -400),
  groundUnder: 64,
  groundAhead: 64,
  cruiseY: 64 + CRUISE_HEIGHT,
  boosted: false,
  rockets: 16,
  durability: 400,
  ...over
})

test('durability left is the max less the damage; worn out under ELYTRA_LOW_DURABILITY', () => {
  assert.strictEqual(durabilityLeft({ maxDurability: 432, durabilityUsed: 30 }), 402)
  assert.strictEqual(durabilityLeft(null), 0)
  assert.ok(ELYTRA_LOW_DURABILITY > 1)
})

test('the yaw is mineflayer\'s: 0 toward -z (north), pi / 2 toward -x (west)', () => {
  assert.ok(Math.abs(yawToward(new Vec3(0, 0, 0), new Vec3(0, 0, -10))) < 1e-9)
  assert.ok(Math.abs(yawToward(new Vec3(0, 0, 0), new Vec3(-10, 0, 0)) - Math.PI / 2) < 1e-9)
})

test('the phases: a climb with a rocket under the cruise, a rocket when slow at it, a glide down within reach, a flare over the ground', () => {
  const climb = steerFlight(state({ pos: new Vec3(0, 66, 0), vel: new Vec3(0, 0.1, -0.2) }))
  assert.strictEqual(climb.phase, 'climb')
  assert.ok(climb.pitch > 0 && climb.rocket)
  // under a boost no second rocket
  assert.strictEqual(steerFlight(state({ pos: new Vec3(0, 66, 0), boosted: true })).rocket, false)
  const slow = steerFlight(state({ pos: new Vec3(0, 88, 0), vel: new Vec3(0, -0.1, -0.6) }))
  assert.strictEqual(slow.phase, 'cruise')
  assert.ok(slow.rocket)
  assert.strictEqual(steerFlight(state({ pos: new Vec3(0, 88, 0), vel: new Vec3(0, -0.1, -1.4) })).rocket, false)
  // 24 blocks over the target 60 off: down, no rocket
  const down = steerFlight(state({ pos: new Vec3(0, 88, -340) }))
  assert.strictEqual(down.phase, 'descend')
  assert.ok(down.pitch < 0 && !down.rocket)
  // 4 over the ground sinking fast: the look up
  const flare = steerFlight(state({ pos: new Vec3(0, 68, -395), vel: new Vec3(0, -0.8, -1) }))
  assert.strictEqual(flare.phase, 'flare')
  assert.ok(flare.pitch > 0)
  // worn out: down where it is, no rocket
  const worn = steerFlight(state({ pos: new Vec3(0, 88, 0), durability: 10, vel: new Vec3(0, 0, -0.5) }))
  assert.strictEqual(worn.phase, 'descend')
  assert.strictEqual(worn.rocket, false)
  // a hill ahead: up
  assert.strictEqual(steerFlight(state({ pos: new Vec3(0, 88, 0), groundAhead: 90 })).phase, 'climb')
})

// LivingEntity.updateFallFlyingMovement and FireworkRocketEntity.tick's pull, in doubles (the look's floats aside)
function glideTick (vel: Vec3, yaw: number, pitch: number, boosted: boolean): Vec3 {
  // vanilla's look from mineflayer's angles: xRot = -pitch, yRot = 180 - yaw (degrees)
  const xRot = -pitch
  const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  let m = vel.clone()
  if (boosted) m = m.plus(new Vec3(look.x * 0.1 + (look.x * 1.5 - m.x) * 0.5, look.y * 0.1 + (look.y * 1.5 - m.y) * 0.5, look.z * 0.1 + (look.z * 1.5 - m.z) * 0.5))
  const lookHor = Math.hypot(look.x, look.z)
  const moveHor = Math.hypot(m.x, m.z)
  const lift = Math.cos(xRot) ** 2
  m = m.offset(0, 0.08 * (-1 + lift * 0.75), 0)
  if (m.y < 0 && lookHor > 0) {
    const c = m.y * -0.1 * lift
    m = m.offset(look.x * c / lookHor, c, look.z * c / lookHor)
  }
  if (xRot < 0 && lookHor > 0) {
    const c = moveHor * -Math.sin(xRot) * 0.04
    m = m.offset(-look.x * c / lookHor, c * 3.2, -look.z * c / lookHor)
  }
  if (lookHor > 0) m = m.offset((look.x / lookHor * moveHor - m.x) * 0.1, 0, (look.z / lookHor * moveHor - m.z) * 0.1)
  return new Vec3(m.x * 0.99, m.y * 0.98, m.z * 0.99)
}

test('steered over vanilla\'s glide, a flight of 400 blocks over flat ground lands within 8 of the target, sinking slower than SAFE_SINK', () => {
  const ground = 64
  const target = new Vec3(0, ground, -400)
  let pos = new Vec3(0, ground + 1.5, 0)
  let vel = new Vec3(0, 0.3, 0)
  let boostUntil = -1
  let rockets = 0
  let lastVy = 0
  for (let t = 0; t < 2000; t++) {
    const cmd = steerFlight({ pos, vel, target, groundUnder: ground, groundAhead: ground, cruiseY: ground + CRUISE_HEIGHT, boosted: t < boostUntil, rockets: 32 - rockets, durability: 400 })
    if (cmd.rocket) { rockets++; boostUntil = t + ROCKET_MIN_TICKS }
    vel = glideTick(vel, cmd.yaw, cmd.pitch, t < boostUntil)
    pos = pos.plus(vel)
    if (pos.y <= ground) { lastVy = vel.y; pos.y = ground; break }
  }
  assert.strictEqual(pos.y, ground, 'never landed')
  assert.ok(Math.hypot(pos.x - target.x, pos.z - target.z) <= 8, `landed at ${pos.toString()}`)
  assert.ok(lastVy > -SAFE_SINK - 0.1, `sinking ${lastVy} on landing`)
  assert.ok(rockets >= 1 && rockets <= 12, `${rockets} rockets`)
})

test('a trip flies with an elytra with wear to spare, four rockets and the sky open over the bot on the ground', () => {
  const item = (name: string, count = 1, durabilityUsed = 0): any => ({ name, count, maxDurability: name === 'elytra' ? 432 : undefined, durabilityUsed })
  const bot = (items: any[], opts: { roof?: number, onGround?: boolean } = {}): any => ({
    inventory: { slots: new Array(46).fill(null), items: () => items },
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: opts.onGround ?? true },
    blockAt: (p: Vec3) => ({ name: opts.roof != null && p.y === 64 + opts.roof ? 'stone' : 'air', boundingBox: opts.roof != null && p.y === 64 + opts.roof ? 'block' : 'empty' })
  })
  assert.strictEqual(canFly(bot([item('elytra'), item('firework_rocket', 8)])), true)
  assert.strictEqual(canFly(bot([item('elytra'), item('firework_rocket', 3)])), false)
  assert.strictEqual(canFly(bot([item('elytra', 1, 400), item('firework_rocket', 8)])), false)
  assert.strictEqual(canFly(bot([item('firework_rocket', 8)])), false)
  assert.strictEqual(canFly(bot([item('elytra'), item('firework_rocket', 8)], { roof: 6 })), false)
  assert.strictEqual(canFly(bot([item('elytra'), item('firework_rocket', 8)], { roof: 20 })), true)
  assert.strictEqual(canFly(bot([item('elytra'), item('firework_rocket', 8)], { onGround: false })), false)
  assert.ok(FLY_MIN_DISTANCE >= 100)
})
