import type { Pos } from '../core/memory'

/** EnderDragonPhase ids, in the order EnderDragonPhase.create numbers them (1.21.11) */
export const DRAGON_PHASES = [
  'holding_pattern', 'strafe_player', 'landing_approach', 'landing', 'takeoff',
  'sitting_flaming', 'sitting_scanning', 'sitting_attacking', 'charging_player', 'dying', 'hover'
] as const
export type DragonPhase = typeof DRAGON_PHASES[number]

/**
 * the ender_dragon's entity metadata index for EnderDragon.DATA_PHASE (after Mob's flags at 15), 16 on 1.21.11 and 26.3:
 * the fallback of metadataIndex(bot, 'ender_dragon', 'phase', ...), which reads the version's metadataKeys
 */
export const DRAGON_PHASE_METADATA = 16

/** what the bot should make of a phase */
export type DragonActivity =
  /** circling the spikes (holding_pattern, hover) */
  | 'circling'
  /** diving at a player or flying a strafe run to spit a fireball */
  | 'strafing'
  | 'charging'
  /** coming down to the fountain (landing_approach, landing) */
  | 'landing'
  /** on the fountain (the three sitting phases): melee time */
  | 'perched'
  /** leaving the fountain */
  | 'leaving'
  | 'dying'

export function phaseName (id: number): DragonPhase | null {
  return DRAGON_PHASES[id] ?? null
}

export function activityOf (phase: DragonPhase): DragonActivity {
  switch (phase) {
    case 'holding_pattern': case 'hover': return 'circling'
    case 'strafe_player': return 'strafing'
    case 'charging_player': return 'charging'
    case 'landing_approach': case 'landing': return 'landing'
    case 'sitting_flaming': case 'sitting_scanning': case 'sitting_attacking': return 'perched'
    case 'takeoff': return 'leaving'
    case 'dying': return 'dying'
  }
}

/** AbstractDragonSittingPhase.isSitting */
export function isSitting (phase: DragonPhase): boolean {
  return activityOf(phase) === 'perched'
}

/** DragonSittingFlamingPhase: FLAME_DURATION, the warmup before the cloud, and flames before takeoff */
export const FLAME_DURATION = 200
export const FLAME_WARMUP = 10
export const SITTING_FLAME_ATTACKS = 4
/** DragonSittingAttackingPhase: the roar before the flame */
export const SITTING_ATTACK_TICKS = 40
/** DragonSittingScanningPhase: a player in range for this long makes it attack; none for SITTING_SCANNING_IDLE_TICKS and it leaves */
export const SCANNING_ATTACK_TICKS = 25
export const SCANNING_IDLE_TICKS = 100
/** DragonSittingScanningPhase scanTargeting: players it turns to and attacks */
export const SCAN_RANGE = 20
export const SCAN_Y_RANGE = 10
/** EnderDragon.SITTING_ALLOWED_DAMAGE_PERCENTAGE of max health (200) taken while sitting makes it take off */
export const SITTING_DAMAGE_LIMIT = 0.25 * 200
/** the breath's AreaEffectCloud radius (DragonSittingFlamingPhase: setRadius(5)) */
export const BREATH_RADIUS = 5
/** EnderDragon.aiStep: the head part is 6.5 blocks out along (sin yRot, -cos yRot), 1 below the body when sitting */
export const HEAD_DISTANCE = 6.5
/** DragonSittingFlamingPhase: the cloud is 5 / 2 further out than the head */
export const BREATH_OFFSET = 2.5
/** player entity interaction range (Attributes.ENTITY_INTERACTION_RANGE default) */
export const MELEE_REACH = 3

/** the vanilla yaw in degrees from mineflayer's (radians, 0 = -z, counter-clockwise; fromNotchianYaw = π - yaw) */
export function vanillaYaw (mineflayerYaw: number): number {
  return 180 - mineflayerYaw * 180 / Math.PI
}

/** the horizontal way the dragon's head points, from its vanilla yaw: (sin yRot, -cos yRot), the opposite of other mobs */
export function headDirection (yawDegrees: number): { x: number, z: number } {
  const r = yawDegrees * Math.PI / 180
  return { x: Math.sin(r), z: -Math.cos(r) }
}

export interface DragonView {
  position: Pos
  /** vanilla yaw, degrees */
  yaw: number
}

/** where the head part is (EnderDragon.aiStep with the sitting head offset -1 and a level body) */
export function headPosition (dragon: DragonView, sitting = true): Pos {
  const d = headDirection(dragon.yaw)
  return { x: dragon.position.x + d.x * HEAD_DISTANCE, y: dragon.position.y + (sitting ? -1 : 0), z: dragon.position.z + d.z * HEAD_DISTANCE }
}

export interface BreathZone {
  /** the cloud's middle; it lies on the first block below the head's height, so y is the ground there */
  center: { x: number, z: number }
  radius: number
}

/** DragonSittingFlamingPhase.doServerTick at flameTicks 10: the cloud goes 2.5 past the head along the head's direction */
export function breathZone (dragon: DragonView): BreathZone {
  const d = headDirection(dragon.yaw)
  const reach = HEAD_DISTANCE + BREATH_OFFSET
  return { center: { x: dragon.position.x + d.x * reach, z: dragon.position.z + d.z * reach }, radius: BREATH_RADIUS }
}

export interface MeleeSpot extends Pos {
  /** what can be hit from here: the head takes full damage, other parts f / 4 + min(f, 1) (EnderDragon.hurt) */
  target: 'head' | 'body'
  /** eye-to-box distance to that part */
  reach: number
  /** horizontal distance from the breath cloud's edge, less the margin (Infinity with no breath) */
  breathClearance: number
}

/**
 * Standing spots on the ground (feet at groundY) around a perched dragon from which a part
 * can be hit, best first: the head (full damage) before the body. With a breath zone (the
 * cloud is out, or about to be: the tracker's window gives it) the spots inside it, with
 * `margin` for the player's width and drift, are left out; the head is then out of reach,
 * since the cloud lands just past it, and the spots under the body by the pillar remain.
 */
export function meleeSpots (dragon: DragonView, groundY: number, breath: BreathZone | null = null, margin = 0.8): MeleeSpot[] {
  const head = headPosition(dragon)
  const d = headDirection(dragon.yaw)
  const out: MeleeSpot[] = []
  const cx = Math.floor(dragon.position.x)
  const cz = Math.floor(dragon.position.z)
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      const x = cx + dx + 0.5
      const z = cz + dz + 0.5
      const clearance = breath == null ? Infinity : Math.hypot(x - breath.center.x, z - breath.center.z) - breath.radius - margin
      if (clearance < 0) continue
      // the 1×1 head box; the player's eyes are 1.62 above its feet
      const hx = Math.max(Math.abs(x - head.x) - 0.5, 0)
      const hz = Math.max(Math.abs(z - head.z) - 0.5, 0)
      const eyeY = groundY + 1.62
      const hy = Math.max(head.y - eyeY, eyeY - (head.y + 1), 0)
      const toHead = Math.hypot(hx, hy, hz)
      // the body: 5 wide, 3 high, 0.5 back from the dragon's position along the head line
      const bx = dragon.position.x + d.x * 0.5
      const bz = dragon.position.z + d.z * 0.5
      const toBody = Math.hypot(Math.max(Math.abs(x - bx) - 2.5, 0), Math.max(dragon.position.y - eyeY, eyeY - (dragon.position.y + 3), 0), Math.max(Math.abs(z - bz) - 2.5, 0))
      if (toHead <= MELEE_REACH) out.push({ x, y: groundY, z, target: 'head', reach: toHead, breathClearance: clearance })
      else if (toBody <= MELEE_REACH) out.push({ x, y: groundY, z, target: 'body', reach: toBody, breathClearance: clearance })
    }
  }
  // head first; then up to 2 blocks of clearance from the cloud is worth more than reach; then the closest
  const rank = (s: MeleeSpot): number => s.target === 'head' ? 0 : 1
  out.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    const clear = Math.min(b.breathClearance, 2) - Math.min(a.breathClearance, 2)
    return clear !== 0 ? clear : a.reach - b.reach
  })
  return out
}

export interface DragonSample {
  tick: number
  /** EnderDragon.DATA_PHASE, from entity metadata */
  phase: number
  position: Pos
  /** vanilla yaw, degrees */
  yaw: number
}

export interface MeleeWindow {
  open: boolean
  phase: DragonPhase | null
  activity: DragonActivity | null
  /** ticks the dragon has been in this phase */
  phaseTicks: number
  /** an upper bound on the ticks left on the fountain, from the sitting phases' timers */
  ticksLeft: number
  /** the breath to keep out of now (flaming) or next (attacking: it flames where it faces) */
  breath: BreathZone | null
  /** sitting damage dealt since it last took off for it (it carries over from perch to perch); over 50 makes it take off */
  sittingDamage: number
}

/**
 * Follows the dragon's phase from its metadata and tells when it is safe to melee: it is
 * on the fountain from SITTING_SCANNING until TAKEOFF. Without the metadata (none received
 * yet) it falls back on position: within 1.5 blocks of the perch and still.
 */
export class DragonPhaseTracker {
  phase: DragonPhase | null = null
  phaseStart = 0
  last: DragonSample | null = null
  /** flames since it landed (DragonSittingFlamingPhase.flameCount, reset by DragonLandingPhase) */
  flames = 0
  sittingDamage = 0
  private lastHealth: number | null = null

  constructor (readonly perch: Pos | null = null) {}

  update (sample: DragonSample): void {
    const name = phaseName(sample.phase)
    if (name !== this.phase) {
      if (name === 'sitting_scanning' && (this.phase === 'landing' || this.phase === 'landing_approach' || this.phase == null)) this.flames = 0
      if (name === 'sitting_flaming') this.flames++
      // EnderDragon.hurt: sittingDamageReceived goes back to 0 only when it passes the limit (the dragon takes off for
      // it), not when a perch ends for its timers: the next perch starts from what the last one took
      if (name != null && !isSitting(name) && this.sittingDamage > SITTING_DAMAGE_LIMIT) this.sittingDamage = 0
      this.phase = name
      this.phaseStart = sample.tick
    }
    this.last = sample
  }

  /** feed the dragon's health (metadata) to count the sitting damage */
  updateHealth (health: number): void {
    if (this.lastHealth != null && health < this.lastHealth && this.phase != null && isSitting(this.phase)) this.sittingDamage += this.lastHealth - health
    this.lastHealth = health
  }

  /** the phase from position alone: perched when within 1.5 blocks of the perch and nearly still */
  private guessPerched (): boolean {
    if (this.last == null || this.perch == null) return false
    const p = this.last.position
    return Math.hypot(p.x - this.perch.x, p.y - this.perch.y, p.z - this.perch.z) < 1.5
  }

  window (tick: number): MeleeWindow {
    const phase = this.phase
    const activity = phase != null ? activityOf(phase) : (this.guessPerched() ? 'perched' : null)
    const phaseTicks = tick - this.phaseStart
    const view = this.last != null ? { position: this.last.position, yaw: this.last.yaw } : null
    let ticksLeft = 0
    let breath: BreathZone | null = null
    switch (phase) {
      case 'sitting_scanning':
        // at most: the idle timeout, then attack + flame for every flame left
        ticksLeft = Math.max(0, SCANNING_IDLE_TICKS - phaseTicks) + (SITTING_FLAME_ATTACKS - this.flames) * (SITTING_ATTACK_TICKS + FLAME_DURATION + SCANNING_ATTACK_TICKS)
        break
      case 'sitting_attacking':
        ticksLeft = Math.max(0, SITTING_ATTACK_TICKS - phaseTicks) + FLAME_DURATION + (SITTING_FLAME_ATTACKS - this.flames - 1) * (SITTING_ATTACK_TICKS + FLAME_DURATION + SCANNING_ATTACK_TICKS)
        if (view != null) breath = breathZone(view)
        break
      case 'sitting_flaming':
        ticksLeft = Math.max(0, FLAME_DURATION - phaseTicks) + (SITTING_FLAME_ATTACKS - this.flames) * (SITTING_ATTACK_TICKS + FLAME_DURATION + SCANNING_ATTACK_TICKS)
        if (view != null) breath = breathZone(view)
        break
      case null:
        if (activity === 'perched') ticksLeft = SCANNING_IDLE_TICKS
        break
      default:
        break
    }
    // it takes off once the sitting damage is over the limit (sittingDamageReceived > 0.25F * getMaxHealth())
    const open = activity === 'perched' && this.sittingDamage <= SITTING_DAMAGE_LIMIT
    return { open, phase, activity, phaseTicks, ticksLeft: open ? ticksLeft : 0, breath, sittingDamage: this.sittingDamage }
  }
}
