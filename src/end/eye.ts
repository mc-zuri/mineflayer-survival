/** EyeOfEnder.TOO_FAR_DISTANCE: a stronghold farther than this horizontally gets a stand-in target this far out */
export const TOO_FAR_DISTANCE = 12
/** EyeOfEnder.TOO_FAR_SIGNAL_HEIGHT: the stand-in target is this far above the eye */
export const TOO_FAR_SIGNAL_HEIGHT = 8
/** EyeOfEnder.tick: the eye is discarded once life passes 80 */
export const EYE_LIFE = 80
/** EyeOfEnder.signalTo: surviveAfterDeath = random.nextInt(5) > 0 */
export const EYE_SURVIVE_CHANCE = 4 / 5
/** EntityType.EYE_OF_ENDER updateInterval: the server sends its position every 4 ticks */
export const EYE_UPDATE_INTERVAL = 4

export interface Vec { x: number, y: number, z: number }

export interface EyeState {
  position: Vec
  deltaMovement: Vec
  target: Vec
  life: number
}

/** where EnderEyeItem.use spawns the eye: the player's x and z, at half its height (player.getY(0.5)) */
export function eyeSpawnPosition (playerFeet: Vec, playerHeight = 1.8): Vec {
  return { x: playerFeet.x, y: playerFeet.y + playerHeight * 0.5, z: playerFeet.z }
}

/**
 * EyeOfEnder.signalTo: the target is the structure's locate pos when it is within 12 blocks
 * horizontally, otherwise a point 12 blocks towards it and 8 up.
 */
export function signalTo (position: Vec, structure: Vec): Vec {
  const dx = structure.x - position.x
  const dz = structure.z - position.z
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d > TOO_FAR_DISTANCE) return { x: position.x + dx / d * 12.0, y: position.y + 8.0, z: position.z + dz / d * 12.0 }
  return { ...structure }
}

/** EyeOfEnder.updateDeltaMovement (1.21.11): steer the horizontal speed towards the target, ease the vertical one */
export function updateDeltaMovement (delta: Vec, position: Vec, target: Vec): Vec {
  const lx = target.x - position.x
  const lz = target.z - position.z
  const d = Math.sqrt(lx * lx + lz * lz)
  const horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
  let e = horizontal + 0.0025 * (d - horizontal) // Mth.lerp(0.0025, horizontal, d)
  let f = delta.y
  if (d < 1.0) {
    e *= 0.8
    f *= 0.8
  }
  const g = position.y - delta.y < target.y ? 1.0 : -1.0
  const s = e / d
  // lv.scale(e / d).add(0, f + (g - f) * 0.015, 0), lv having no y
  return { x: lx * s, y: f + (g - f) * 0.015, z: lz * s }
}

/** a fresh eye as EnderEyeItem.use throws it: still, at the spawn position, signalled to the structure */
export function throwEye (spawn: Vec, structure: Vec): EyeState {
  return { position: { ...spawn }, deltaMovement: { x: 0, y: 0, z: 0 }, target: signalTo(spawn, structure), life: 0 }
}

/** EyeOfEnder.tick on the server: move by the old delta, then steer from the new position */
export function tickEye (eye: EyeState): EyeState {
  const p = eye.position
  const v = eye.deltaMovement
  const next = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
  return { position: next, deltaMovement: updateDeltaMovement(v, next, eye.target), target: eye.target, life: eye.life + 1 }
}

/** the eye's positions after each tick until it is discarded (81 ticks) */
export function simulateEye (spawn: Vec, structure: Vec, ticks = EYE_LIFE + 1): EyeState[] {
  const out: EyeState[] = []
  let eye = throwEye(spawn, structure)
  for (let t = 0; t < ticks; t++) {
    eye = tickEye(eye)
    out.push(eye)
  }
  return out
}

export interface ObservedEye {
  /** the eye's spawn position (its add_entity packet), when seen */
  spawn?: Vec
  /** positions seen afterwards, oldest first */
  positions: Vec[]
}

export interface ThrowDirection {
  origin: { x: number, z: number }
  /** unit horizontal direction the eye flew */
  direction: { x: number, z: number }
  /** the same as a vanilla yaw in degrees (0 = +z, 90 = -x) */
  yaw: number
  /** RMS distance of the points from the fitted line, in blocks */
  residual: number
  /** how far the eye got horizontally */
  travelled: number
  /**
   * when the eye settled short of 12 blocks the stronghold's locate pos is within 12 blocks:
   * this is that point (the eye's horizontal resting place)
   */
  near?: { x: number, z: number }
}

/**
 * The direction an eye of ender flew, from its observed positions. EyeOfEnder only ever
 * moves horizontally along the line from its spawn to its target (each tick's horizontal
 * delta points at the target, overshoots included), so the points lie on one ray: fit the
 * line through them (principal axis) and point it from the spawn towards where it went.
 */
export function inferThrowDirection (eye: ObservedEye): ThrowDirection | null {
  const pts = eye.positions.map(p => ({ x: p.x, z: p.z }))
  const spawn = eye.spawn != null ? { x: eye.spawn.x, z: eye.spawn.z } : pts.shift()
  if (spawn == null || pts.length === 0) return null
  let far = pts[0]
  let farD = -1
  for (const p of pts) {
    const d = Math.hypot(p.x - spawn.x, p.z - spawn.z)
    if (d > farD) { farD = d; far = p }
  }
  if (farD < 1e-6) return null
  // principal axis of the points about the spawn (the line must pass through the spawn)
  let sxx = 0
  let sxz = 0
  let szz = 0
  for (const p of pts) {
    const dx = p.x - spawn.x
    const dz = p.z - spawn.z
    sxx += dx * dx
    sxz += dx * dz
    szz += dz * dz
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  let dir = { x: Math.cos(angle), z: Math.sin(angle) }
  if (dir.x * (far.x - spawn.x) + dir.z * (far.z - spawn.z) < 0) dir = { x: -dir.x, z: -dir.z }
  let sq = 0
  for (const p of pts) {
    const perp = (p.x - spawn.x) * -dir.z + (p.z - spawn.z) * dir.x
    sq += perp * perp
  }
  const last = pts[pts.length - 1]
  const lastD = Math.hypot(last.x - spawn.x, last.z - spawn.z)
  const out: ThrowDirection = {
    origin: spawn,
    direction: dir,
    yaw: Math.atan2(-dir.x, dir.z) * 180 / Math.PI,
    residual: Math.sqrt(sq / pts.length),
    travelled: lastD
  }
  // a 12-block stand-in target is reached by tick ~40 and held to within a few hundredths;
  // an eye seen for 50+ ticks that rests clearly short of 12 was aimed at the stronghold itself
  if (settled(pts) && lastD < TOO_FAR_DISTANCE - 0.5) out.near = { x: last.x, z: last.z }
  return out
}

/** the last few horizontal positions are within a tenth of a block of each other */
function settled (pts: Array<{ x: number, z: number }>): boolean {
  if (pts.length < 4) return false
  const tail = pts.slice(-4)
  const a = tail[0]
  return tail.every(p => Math.hypot(p.x - a.x, p.z - a.z) < 0.1)
}
