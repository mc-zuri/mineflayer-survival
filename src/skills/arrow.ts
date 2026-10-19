import { Vec3 } from 'vec3'

// An arrow's flight as vanilla's AbstractArrow.tick moves it, one server tick at a time: it moves by its velocity
// (stopping at the first block or entity on the way), then its velocity is scaled by its inertia (0.99 in air,
// AbstractArrow.getWaterInertia 0.6 in water) and loses its gravity (AbstractArrow.getDefaultGravity 0.05).
// The same in 26.3, as are BowItem's power and speed, Projectile.shoot's spread and the arrow's damage.
export const ARROW_GRAVITY = 0.05
/** applyInertia(0.99F): the float widened to a double */
export const ARROW_INERTIA = Math.fround(0.99)
export const ARROW_WATER_INERTIA = Math.fround(0.6)
/** ProjectileUtil.getEntityHitResult inflates the target's box by 0.3 */
export const ARROW_HIT_MARGIN = 0.3
/** Arrow(level, owner, ...) starts at the shooter's eye height less 0.1 */
export const ARROW_EYE_OFFSET = 0.1
/** BowItem.releaseUsing: power x 3 */
export const BOW_MAX_SPEED = 3

const f32 = Math.fround

/**
 * How a projectile moves each server tick. An arrow (AbstractArrow.tick) moves by its velocity, then slows by its
 * inertia and loses its gravity; a thrown item (ThrowableProjectile.tick: an ender pearl, a snowball) loses its gravity
 * first, then slows by its inertia, then moves.
 */
export interface ProjectilePhysics {
  gravity: number
  /** the velocity's scale a tick in air */
  inertia: number
  /** and in water */
  waterInertia: number
  /** ThrowableProjectile's order (gravity, inertia, move), not the arrow's (move, inertia, gravity) */
  gravityFirst: boolean
  /** half the projectile's width: how far its box reaches past its middle into a cell */
  halfWidth: number
}

/** AbstractArrow: 0.05, 0.99, 0.6, moved first; EntityType.ARROW is 0.5 wide */
export const ARROW_PHYSICS: ProjectilePhysics = { gravity: ARROW_GRAVITY, inertia: ARROW_INERTIA, waterInertia: ARROW_WATER_INERTIA, gravityFirst: false, halfWidth: 0.25 }

/**
 * ThrownEnderpearl: ThrowableProjectile's getDefaultGravity 0.03, getAirDrag 0.99F and 0.8F in water, gravity and
 * drag before the move; EntityType.ENDER_PEARL is 0.25 wide. The same in 26.3.
 */
export const PEARL_PHYSICS: ProjectilePhysics = { gravity: 0.03, inertia: f32(0.99), waterInertia: f32(0.8), gravityFirst: true, halfWidth: 0.125 }

/**
 * EnderpearlItem.use: Projectile.spawnProjectileFromRotation's power 1.5, with an uncertainty of 1 (getMovementToShoot:
 * a triangle of 0.0172275 on each axis of the unit direction)
 */
export const PEARL_SPEED = 1.5
export const PEARL_SPREAD = 0.0172275
/** ThrowableItemProjectile(type, owner, ...) starts at the owner's eye less 0.1, as an arrow does */
export const PEARL_EYE_OFFSET = 0.1

/** one tick's change of a projectile's velocity, in place */
function applyPhysics (vel: { x: number, y: number, z: number }, physics: ProjectilePhysics, inWater: boolean): void {
  const inertia = inWater ? physics.waterInertia : physics.inertia
  if (physics.gravityFirst) {
    vel.y -= physics.gravity
    vel.x *= inertia
    vel.y *= inertia
    vel.z *= inertia
  } else {
    vel.x *= inertia
    vel.y = vel.y * inertia - physics.gravity
    vel.z *= inertia
  }
}

/** BowItem.getPowerForTime: the power of a bow drawn for the ticks, (t^2 + 2t) / 3 of the seconds, at most 1 (in floats). */
export function bowPower (useTicks: number): number {
  let f = f32(useTicks / 20)
  f = f32(f32(f32(f * f) + f32(f * 2)) / 3)
  return f > 1 ? 1 : f
}

/** The arrow's speed (blocks a tick) for the ticks the bow was drawn: BowItem.releaseUsing's power x 3.0F. */
export function bowArrowSpeed (useTicks: number): number {
  return f32(bowPower(useTicks) * BOW_MAX_SPEED)
}

// Mth.sin / Mth.cos: a table of 65536 float sines
const SIN = new Float32Array(65536)
for (let i = 0; i < 65536; i++) SIN[i] = Math.sin(i * Math.PI * 2 / 65536)
const SIN_SCALE = f32(10430.378)
export function mthSin (x: number): number {
  return SIN[Math.trunc(f32(f32(x) * SIN_SCALE)) & 65535]
}
export function mthCos (x: number): number {
  return SIN[Math.trunc(f32(f32(f32(x) * SIN_SCALE) + 16384)) & 65535]
}

/**
 * Projectile.shootFromRotation's direction for vanilla's rotations in degrees (xRot down positive, yRot 0 south), in
 * its floats and Mth's table sines, normalized as Projectile.shoot does (before the inaccuracy's noise).
 */
export function vanillaShotDirection (xRotDeg: number, yRotDeg: number): Vec3 {
  const r = f32(Math.PI / 180)
  const x = f32(-mthSin(f32(yRotDeg * r)) * mthCos(f32(xRotDeg * r)))
  const y = f32(-mthSin(f32(xRotDeg * r)))
  const z = f32(mthCos(f32(yRotDeg * r)) * mthCos(f32(xRotDeg * r)))
  const len = Math.sqrt(x * x + y * y + z * z)
  return len < 1e-5 ? new Vec3(0, 0, 0) : new Vec3(x / len, y / len, z / len)
}

/** mineflayer's yaw and pitch (radians) as the rotations vanilla gets in the move packet (degrees, as floats). */
export function toVanillaRotation (yaw: number, pitch: number): { xRot: number, yRot: number } {
  return { yRot: f32(180 - yaw * 180 / Math.PI), xRot: f32(-pitch * 180 / Math.PI) }
}

export interface Box { min: Vec3, max: Vec3 }

export interface ArrowWorld {
  /** whether the position is in water (the arrow slows to 0.6 a tick) */
  isWater?: (pos: Vec3) => boolean
  /** where the segment first meets a block, or null (Level.clip with ClipContext.Block.COLLIDER) */
  clip?: (from: Vec3, to: Vec3) => Vec3 | null
}

export interface ArrowStep {
  tick: number
  position: Vec3
  velocity: Vec3
}

export interface ArrowFlight {
  /** the arrow's position at the start of each tick (index 0 the launch) */
  path: ArrowStep[]
  /** the tick and point it entered the (inflated) target box, if it did */
  hit: { tick: number, point: Vec3 } | null
  /** the block it stopped at, if any */
  blocked: Vec3 | null
}

/** Simulates the arrow for at most maxTicks or until it hits the target box or a block. */
export function simulateArrow (position: Vec3, velocity: Vec3, opts: { maxTicks?: number, target?: Box, world?: ArrowWorld, stopBelowY?: number, physics?: ProjectilePhysics, hitMargin?: number } = {}): ArrowFlight {
  const maxTicks = opts.maxTicks ?? 200
  const physics = opts.physics ?? ARROW_PHYSICS
  const target = opts.target != null ? inflate(opts.target, opts.hitMargin ?? ARROW_HIT_MARGIN) : null
  let pos = position.clone()
  const vel = velocity.clone()
  const path: ArrowStep[] = [{ tick: 0, position: pos.clone(), velocity: vel.clone() }]
  for (let tick = 1; tick <= maxTicks; tick++) {
    // a thrown item's velocity changes before its move, in the water it starts the tick in
    if (physics.gravityFirst) applyPhysics(vel, physics, opts.world?.isWater?.(pos) === true)
    let next = pos.plus(vel)
    const block = opts.world?.clip?.(pos, next) ?? null
    if (block != null) next = block
    if (target != null) {
      const t = segmentBoxIntersection(pos, next, target)
      if (t != null) return { path, hit: { tick, point: pos.plus(next.minus(pos).scaled(t)) }, blocked: null }
    }
    if (block != null) return { path, hit: null, blocked: block }
    pos = next
    if (!physics.gravityFirst) applyPhysics(vel, physics, opts.world?.isWater?.(pos) === true)
    path.push({ tick, position: pos.clone(), velocity: vel.clone() })
    if (opts.stopBelowY != null && pos.y < opts.stopBelowY && vel.y < 0) break
  }
  return { path, hit: null, blocked: null }
}

export function inflate (box: Box, by: number): Box {
  return { min: box.min.offset(-by, -by, -by), max: box.max.offset(by, by, by) }
}

/** AABB.clip: the fraction of the segment where it enters the box (0 if it starts inside), or null. */
export function segmentBoxIntersection (from: Vec3, to: Vec3, box: Box): number | null {
  let tMin = 0
  let tMax = 1
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = to[axis] - from[axis]
    if (Math.abs(d) < 1e-12) {
      if (from[axis] < box.min[axis] || from[axis] > box.max[axis]) return null
      continue
    }
    let t1 = (box.min[axis] - from[axis]) / d
    let t2 = (box.max[axis] - from[axis]) / d
    if (t1 > t2) [t1, t2] = [t2, t1]
    tMin = Math.max(tMin, t1)
    tMax = Math.min(tMax, t2)
    if (tMin > tMax) return null
  }
  return tMin
}

export interface AimSolution {
  /** mineflayer yaw and pitch (radians) to look along */
  yaw: number
  pitch: number
  /** the ticks of flight to the target point */
  ticks: number
  /** the point aimed at (the predicted one for a moving target) */
  aimPoint: Vec3
  /** how far above (+) or below (-) the aim point the arrow passes */
  error: number
}

export interface AimOptions {
  /** the arrow's launch speed (default 3, a full draw) */
  speed?: number
  /** the shooter's velocity added to the arrow's (Projectile.shoot: its known movement, y only when airborne) */
  shooterVelocity?: Vec3
  /** prefer the high arc (default false: the flat, faster one) */
  highArc?: boolean
  /** the target's velocity a tick (to lead a moving target) */
  targetVelocity?: Vec3
  /** extra ticks before the arrow leaves (the rest of the draw, the packet's trip) */
  leadTicks?: number
  maxTicks?: number
  world?: ArrowWorld
  /** the projectile's physics (default an arrow's, ARROW_PHYSICS; PEARL_PHYSICS for a pearl at PEARL_SPEED) */
  physics?: ProjectilePhysics
  /** how far arrowHits inflates the target box (default ARROW_HIT_MARGIN, an entity's: ProjectileUtil.getEntityHitResult) */
  hitMargin?: number
}

function launchVelocity (yaw: number, pitch: number, speed: number, shooterVelocity?: Vec3): Vec3 {
  const c = Math.cos(pitch)
  const v = new Vec3(-Math.sin(yaw) * c * speed, Math.sin(pitch) * speed, -Math.cos(yaw) * c * speed)
  return shooterVelocity != null ? v.plus(shooterVelocity) : v
}

/** The arrow's height where it reaches the target's horizontal distance, and the ticks it takes; null if it never does. */
function heightAtDistance (start: Vec3, yaw: number, pitch: number, horizontal: number, opts: AimOptions): { y: number, ticks: number } | null {
  // simulateArrow's steps without the allocations (the solver runs this thousands of times)
  const v = launchVelocity(yaw, pitch, opts.speed ?? BOW_MAX_SPEED, opts.shooterVelocity)
  let vx = v.x
  let vy = v.y
  let vz = v.z
  let x = start.x
  let y = start.y
  let z = start.z
  let d0 = 0
  const isWater = opts.world?.isWater
  const maxTicks = opts.maxTicks ?? 200
  const physics = opts.physics ?? ARROW_PHYSICS
  const vel = { x: vx, y: vy, z: vz }
  const step = (): void => {
    vel.x = vx
    vel.y = vy
    vel.z = vz
    applyPhysics(vel, physics, isWater?.(new Vec3(x, y, z)) === true)
    vx = vel.x
    vy = vel.y
    vz = vel.z
  }
  for (let tick = 1; tick <= maxTicks; tick++) {
    if (physics.gravityFirst) step()
    const nx = x + vx
    const ny = y + vy
    const nz = z + vz
    const d1 = Math.hypot(nx - start.x, nz - start.z)
    if (d1 >= horizontal) {
      const f = d1 === d0 ? 0 : (horizontal - d0) / (d1 - d0)
      return { y: y + (ny - y) * f, ticks: tick - 1 + f }
    }
    if (d1 <= d0 && vy < 0) return null // going straight down, or back
    x = nx
    y = ny
    z = nz
    d0 = d1
    if (!physics.gravityFirst) step()
  }
  return null
}

/** The pitch whose arrow passes through the point, by bisection on the arc (the flat one unless highArc). */
function solveStatic (start: Vec3, point: Vec3, opts: AimOptions): AimSolution | null {
  const dx = point.x - start.x
  const dz = point.z - start.z
  const horizontal = Math.hypot(dx, dz)
  const yaw = Math.atan2(-dx, -dz)
  const errorAt = (pitch: number): { error: number, ticks: number } | null => {
    const h = heightAtDistance(start, yaw, pitch, horizontal, opts)
    return h == null ? null : { error: h.y - point.y, ticks: h.ticks }
  }
  // the pitch that throws furthest splits the flat arc from the high one; scan to find a bracket on the wanted side
  const steps = 90
  const lo = -Math.PI / 2 + 0.01
  const hi = Math.PI / 2 - 0.01
  let best: AimSolution | null = null
  let prevPitch = lo
  let prevErr = errorAt(lo)
  const brackets: Array<[number, number]> = []
  for (let i = 1; i <= steps; i++) {
    const pitch = lo + (hi - lo) * i / steps
    const err = errorAt(pitch)
    if (prevErr != null && err != null && Math.sign(prevErr.error) !== Math.sign(err.error)) brackets.push([prevPitch, pitch])
    prevPitch = pitch
    prevErr = err
  }
  if (brackets.length === 0) return null
  let [a, b] = opts.highArc === true ? brackets[brackets.length - 1] : brackets[0]
  let ea = errorAt(a)
  for (let i = 0; i < 40 && ea != null; i++) {
    const m = (a + b) / 2
    const em = errorAt(m)
    if (em == null) break
    if (Math.sign(em.error) === Math.sign(ea.error)) { a = m; ea = em } else b = m
  }
  const pitch = (a + b) / 2
  const e = errorAt(pitch)
  if (e != null) best = { yaw, pitch, ticks: e.ticks, aimPoint: point.clone(), error: e.error }
  return best
}

/**
 * The yaw and pitch that put an arrow from start through the target point. A moving target is led: its position is
 * advanced by its velocity over the flight (plus leadTicks), and the solution recomputed until it settles.
 */
export function solveAim (start: Vec3, target: Vec3, opts: AimOptions = {}): AimSolution | null {
  let solution = solveStatic(start, target, opts)
  const v = opts.targetVelocity
  if (solution == null || v == null || (v.x === 0 && v.y === 0 && v.z === 0)) return solution
  for (let i = 0; i < 8; i++) {
    const t = solution.ticks + (opts.leadTicks ?? 0)
    const predicted = target.plus(v.scaled(t))
    const next = solveStatic(start, predicted, opts)
    if (next == null) return solution
    const settled = Math.abs(next.ticks - solution.ticks) < 0.05
    solution = next
    if (settled) break
  }
  return solution
}

/** Whether an arrow shot along the solution enters the target box (inflated as vanilla does). */
export function arrowHits (start: Vec3, yaw: number, pitch: number, box: Box, opts: AimOptions = {}): ArrowFlight {
  return simulateArrow(start, launchVelocity(yaw, pitch, opts.speed ?? BOW_MAX_SPEED, opts.shooterVelocity), { target: box, world: opts.world, maxTicks: opts.maxTicks ?? 200, physics: opts.physics, hitMargin: opts.hitMargin })
}

export { launchVelocity }
