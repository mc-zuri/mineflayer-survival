import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import {
  ARROW_GRAVITY, ARROW_INERTIA, arrowHits, bowArrowSpeed, bowPower, launchVelocity, mthCos, mthSin, simulateArrow, solveAim,
  toVanillaRotation, vanillaShotDirection
} from '../../src/skills/arrow'

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps ${eps})`)

test('the constants are vanilla\'s: gravity 0.05, inertia 0.99F (0.6F in water)', () => {
  assert.strictEqual(ARROW_GRAVITY, 0.05)
  assert.strictEqual(ARROW_INERTIA, 0.9900000095367432)
})

test('BowItem.getPowerForTime and the arrow speed (power x 3)', () => {
  assert.strictEqual(bowPower(0), 0)
  near(bowPower(5), 0.1875, 1e-7) // (0.0625 + 0.5) / 3
  near(bowPower(10), 0.4166666567325592, 1e-12) // (0.25 + 1) / 3 in floats
  assert.strictEqual(bowPower(20), 1)
  assert.strictEqual(bowPower(72000), 1)
  assert.strictEqual(bowArrowSpeed(20), 3)
  near(bowArrowSpeed(10), 1.25, 1e-6)
})

test('Mth.sin and Mth.cos come from the 65536-entry table', () => {
  assert.strictEqual(mthSin(0), 0)
  assert.strictEqual(mthCos(0), 1)
  near(mthSin(Math.PI / 2), 1, 1e-6)
  near(mthCos(Math.PI), -1, 1e-6)
  // the table's step: sin(1) is off by up to 2 pi / 65536
  near(mthSin(1), Math.sin(1), 1e-4)
})

test('Projectile.shootFromRotation\'s direction: yRot 0 is south, xRot -90 is up', () => {
  const south = vanillaShotDirection(0, 0)
  near(south.x, 0, 1e-7); near(south.y, 0, 1e-7); near(south.z, 1, 1e-7)
  const up = vanillaShotDirection(-90, 0)
  near(up.y, 1, 1e-6)
  const east = vanillaShotDirection(0, -90)
  near(east.x, 1, 1e-6)
  // mineflayer's yaw 0 faces north (-z): the same direction once turned into vanilla's rotation
  for (const [yaw, pitch] of [[0, 0], [1, 0.3], [-2, -0.5], [3, 1.2]]) {
    const { xRot, yRot } = toVanillaRotation(yaw, pitch)
    const v = vanillaShotDirection(xRot, yRot)
    const m = launchVelocity(yaw, pitch, 1)
    near(v.x, m.x, 2e-4); near(v.y, m.y, 2e-4); near(v.z, m.z, 2e-4)
  }
})

test('AbstractArrow.tick: move, then velocity x 0.99F and gravity 0.05, tick by tick', () => {
  const flight = simulateArrow(new Vec3(0, 64, 0), new Vec3(0, 0, 3), { maxTicks: 3 })
  const i = ARROW_INERTIA
  // tick 1: at z 3; velocity (0, -0.05, 3i)
  near(flight.path[1].position.z, 3)
  near(flight.path[1].velocity.y, -0.05)
  near(flight.path[1].velocity.z, 3 * i)
  // tick 2: z 3 + 3i, y 64 - 0.05; vy -0.05i - 0.05
  near(flight.path[2].position.z, 3 + 3 * i)
  near(flight.path[2].position.y, 63.95)
  near(flight.path[2].velocity.y, -0.05 * i - 0.05)
  // tick 3
  near(flight.path[3].position.z, 3 + 3 * i + 3 * i * i)
  near(flight.path[3].position.y, 63.95 - 0.05 * i - 0.05)
})

test('the flight matches the closed form of the recurrence over 60 ticks', () => {
  const v0 = new Vec3(1.2, 1.5, -2.1)
  const flight = simulateArrow(new Vec3(0, 0, 0), v0, { maxTicks: 60 })
  const i = ARROW_INERTIA
  for (const n of [1, 10, 30, 60]) {
    // x_n = v0 (1 - i^n) / (1 - i); y adds gravity's geometric part: -g (n - (1 - i^n) / (1 - i)) / (1 - i)
    const geo = (1 - Math.pow(i, n)) / (1 - i)
    const p = flight.path[n].position
    near(p.x, v0.x * geo, 1e-9)
    near(p.z, v0.z * geo, 1e-9)
    near(p.y, v0.y * geo - ARROW_GRAVITY * (n - geo) / (1 - i), 1e-9)
  }
})

test('water slows the arrow to 0.6F a tick', () => {
  const flight = simulateArrow(new Vec3(0, 0, 0), new Vec3(1, 0, 0), { maxTicks: 2, world: { isWater: () => true } })
  near(flight.path[1].velocity.x, Math.fround(0.6))
})

test('the target box is inflated by 0.3 (ProjectileUtil.getEntityHitResult)', () => {
  const box = { min: new Vec3(10, -1, -1), max: new Vec3(12, 1, 1) }
  // passes 1.25 to the side: inside the 0.3 margin
  assert.notStrictEqual(simulateArrow(new Vec3(0, 0.03, 1.25), new Vec3(3, 0.05, 0), { target: box }).hit, null)
  assert.strictEqual(simulateArrow(new Vec3(0, 0.03, 1.35), new Vec3(3, 0.05, 0), { target: box }).hit, null)
})

// an end crystal: 2 x 2, its position the bottom centre
const crystalBox = (pos: Vec3): { min: Vec3, max: Vec3 } => ({ min: pos.offset(-1, 0, -1), max: pos.offset(1, 2, 1) })

test('the aim solution hits an end crystal at 20, 40 and 60 blocks, above and below', () => {
  const start = new Vec3(0.5, 65.52, 0.5)
  for (const [dx, dy, dz] of [[20, 0, 0], [0, 0, -40], [35, 20, 35], [-60, -10, 5], [14, 30, 3]]) {
    const crystal = new Vec3(0.5 + dx, 64 + dy, 0.5 + dz)
    const solution = solveAim(start, crystal.offset(0, 1, 0))
    assert.ok(solution != null, `no solution for ${dx} ${dy} ${dz}`)
    near(solution.error, 0, 1e-3)
    const flight = arrowHits(start, solution.yaw, solution.pitch, crystalBox(crystal))
    assert.ok(flight.hit != null, `missed the crystal at ${dx} ${dy} ${dz}`)
    near(flight.hit.tick, Math.ceil(solution.ticks), 1)
  }
})

test('the flat arc is faster than the high one', () => {
  const start = new Vec3(0, 0, 0)
  const target = new Vec3(30, 0, 0)
  const flat = solveAim(start, target)
  const high = solveAim(start, target, { highArc: true })
  assert.ok(flat != null && high != null)
  assert.ok(high.pitch > flat.pitch + 0.3)
  assert.ok(flat.ticks < high.ticks)
})

test('vanilla\'s inaccuracy (a triangle of 0.0172275 a component) still hits a crystal at 20 blocks', () => {
  const start = new Vec3(0.5, 65.52, 0.5)
  const crystal = new Vec3(20.5, 64, 0.5)
  const solution = solveAim(start, crystal.offset(0, 1, 0))
  assert.ok(solution != null)
  const dir = launchVelocity(solution.yaw, solution.pitch, 1)
  for (const [ex, ey, ez] of [[1, 1, 1], [-1, -1, -1], [1, -1, 1], [-1, 1, -1]]) {
    const v = dir.offset(ex * 0.0172275, ey * 0.0172275, ez * 0.0172275).scaled(3)
    assert.ok(simulateArrow(start, v, { target: crystalBox(crystal) }).hit != null, `missed with noise ${ex} ${ey} ${ez}`)
  }
})

test('a moving target (the dragon) is led by its velocity', () => {
  const start = new Vec3(0, 70, 0)
  const dragon = new Vec3(0, 80, -40) // its box: 16 x 8, centre 4 up
  const velocity = new Vec3(0.6, 0, 0.1)
  const leadTicks = 2
  const solution = solveAim(start, dragon.offset(0, 4, 0), { targetVelocity: velocity, leadTicks })
  assert.ok(solution != null)
  // where the dragon will be when the arrow arrives
  const arrival = dragon.plus(velocity.scaled(solution.ticks + leadTicks))
  near(solution.aimPoint.x, arrival.x, 0.1)
  // the arrow meets the moving box: check tick by tick against the box where it is that tick
  const flight = simulateArrow(start, launchVelocity(solution.yaw, solution.pitch, 3), { maxTicks: 100 })
  const hitTick = flight.path.findIndex((step, t) => {
    const c = dragon.plus(velocity.scaled(t + leadTicks))
    // a 1 x 1 x 1 core of the dragon's box, to be sure it's not a graze
    return Math.abs(step.position.x - c.x) < 1 && Math.abs(step.position.y - (c.y + 4)) < 1 && Math.abs(step.position.z - c.z) < 1
  })
  assert.ok(hitTick > 0, 'the led shot never meets the dragon')
  // the unled shot passes behind it
  const unled = solveAim(start, dragon.offset(0, 4, 0))
  assert.ok(unled != null)
  const unledAt = simulateArrow(start, launchVelocity(unled.yaw, unled.pitch, 3), { maxTicks: 100 }).path[Math.round(unled.ticks)].position
  const dragonThen = dragon.plus(velocity.scaled(unled.ticks + leadTicks))
  assert.ok(Math.abs(unledAt.x - dragonThen.x) > 3)
})

test('blocks in the way stop the arrow', () => {
  const wall = (from: Vec3, to: Vec3): Vec3 | null => (from.x < 5 && to.x >= 5) ? from.plus(to.minus(from).scaled((5 - from.x) / (to.x - from.x))) : null
  const flight = simulateArrow(new Vec3(0, 0, 0), new Vec3(3, 0, 0), { target: { min: new Vec3(9, -1, -1), max: new Vec3(10, 1, 1) }, world: { clip: wall } })
  assert.strictEqual(flight.hit, null)
  near(flight.blocked?.x ?? 0, 5)
})
