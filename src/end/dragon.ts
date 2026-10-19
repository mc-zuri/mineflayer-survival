import type { Pos } from '../core/memory'

/**
 * EnderDragonPhase ids, in the order EnderDragonPhase.create numbers them (1.21.11 and 26.3). The same in both too: the
 * parts' sizes and places, the sitting phases' timers, the 25% sitting damage, the breath's cloud. 26.3 hurts the neck
 * as the head (neckTakesFullDamage) and no longer knocks a perched dragon back (EnderDragon.knockback).
 */
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
/** EnderDragon.aiStep: the neck part (3 × 3) 5.5 blocks out, at the head's height */
export const NECK_DISTANCE = 5.5

/**
 * EnderDragon.hurt: a hit on a part other than these does f / 4 + min(f, 1). 1.21.11: the head only
 * (`enderDragonPart != this.head`); 26.3: the neck too (`part != this.head && part != this.neck`). 26.1 and 26.2 weren't
 * checked: they count as 1.21.11.
 */
export function neckTakesFullDamage (version: { '>=': (other: string) => boolean }): boolean {
  return version['>=']('26.3')
}
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
  /** in flight: getHeadYOffset (DragonFlightHistory y 5 ticks back less now), from DragonPhaseTracker.flight */
  headYOffset?: number
  /** in flight: the tilt in radians ((y 5 ticks back less 10 back) × 10°) */
  tilt?: number
}

/**
 * EnderDragon.aiStep's head and neck out `distance` along the head: getHeadYOffset (-1 sitting, else the flight
 * history's y 5 ticks back less now) and the tilt from the flight history (y 5 ticks back less 10 back, × 10°): a dragon
 * starting to climb off the perch has its head under its body before the tilt raises it
 */
function partOut (dragon: DragonView, distance: number, sitting: boolean): Pos {
  const d = headDirection(dragon.yaw)
  const tilt = sitting ? 0 : (dragon.tilt ?? 0)
  const yOffset = sitting ? -1 : (dragon.headYOffset ?? 0)
  const flat = distance * Math.cos(tilt)
  return { x: dragon.position.x + d.x * flat, y: dragon.position.y + yOffset + Math.sin(tilt) * distance, z: dragon.position.z + d.z * flat }
}

/** where the head part is (EnderDragon.aiStep: the sitting head offset -1 and a level body; in flight partOut's) */
export function headPosition (dragon: DragonView, sitting = true): Pos {
  return partOut(dragon, HEAD_DISTANCE, sitting)
}

/** where the neck part is: the bottom middle of its 3 × 3 box, NECK_DISTANCE out at the head's height */
export function neckPosition (dragon: DragonView, sitting = true): Pos {
  return partOut(dragon, NECK_DISTANCE, sitting)
}

/** a perched dragon's part boxes (EnderDragonPart sizes: head 1 × 1, neck 3 × 3, body 5 × 3 half a block forward) */
export function partBox (dragon: DragonView, part: 'head' | 'neck' | 'body', sitting = true): { min: Pos, max: Pos } {
  const d = headDirection(dragon.yaw)
  const body = { x: dragon.position.x + d.x * 0.5, y: dragon.position.y, z: dragon.position.z + d.z * 0.5 }
  const [at, w, h] = part === 'head' ? [headPosition(dragon, sitting), 1, 1] : part === 'neck' ? [neckPosition(dragon, sitting), 3, 3] : [body, 5, 3]
  return { min: { x: at.x - w / 2, y: at.y, z: at.z - w / 2 }, max: { x: at.x + w / 2, y: at.y + h, z: at.z + w / 2 } }
}

export interface PartBox { min: Pos, max: Pos }

/** EnderDragon.aiStep: the head and neck boxes inflated by this hurt a living entity touching them (EnderDragon.hurt) */
export const CONTACT_INFLATE = 1
/** EnderDragon.hurt(List): what a touch of the head or neck does (mobAttack), every time the dragon isn't wasHurtRecently */
export const CONTACT_DAMAGE = 10
/** EnderDragon.knockBack: what the wings do to a body under them when the dragon isn't sitting, besides the push */
export const WING_DAMAGE = 5
/** the player's box (Player's standing EntityDimensions 0.6 × 1.8) */
export const PLAYER_WIDTH = 0.6
export const PLAYER_HEIGHT = 1.8
/** a jump's peak over the ground (jumpPower 0.42, gravity 0.08, drag 0.98: 1.2522) */
export const JUMP_HEIGHT = 1.2522

export function playerBox (feet: Pos, lift = 0): PartBox {
  const w = PLAYER_WIDTH / 2
  return { min: { x: feet.x - w, y: feet.y, z: feet.z - w }, max: { x: feet.x + w, y: feet.y + PLAYER_HEIGHT + lift, z: feet.z + w } }
}

export function inflate (box: PartBox, x: number, y = x, z = x): PartBox {
  return { min: { x: box.min.x - x, y: box.min.y - y, z: box.min.z - z }, max: { x: box.max.x + x, y: box.max.y + y, z: box.max.z + z } }
}

/** AABB.intersects: overlapping on every axis (touching faces don't) */
export function boxesIntersect (a: PartBox, b: PartBox): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y && a.min.z < b.max.z && a.max.z > b.min.z
}

export interface DragonZone {
  box: PartBox
  /**
   * head, neck: CONTACT_DAMAGE to what touches them; wing: pushed away from the body (EnderDragon.knockBack, xd / dd * 4),
   * and WING_DAMAGE too when the dragon isn't sitting
   */
  part: 'head' | 'neck' | 'wing'
  /** what a touch does: the head and neck always hurt, the wings only when the dragon isn't sitting */
  hurts: boolean
}

/**
 * The boxes that hurt or throw a body touching them, as EnderDragon.aiStep checks them each tick while the dragon
 * isn't wasHurtRecently (its hurtTime, 10 ticks after a hit): the head (1 × 1) and neck (3 × 3) inflated by 1, and each
 * wing (4 × 2, 4.5 to the side and 2 up: tickPart(wing, cos yRot * 4.5, 2, sin yRot * 4.5)) inflated by (4, 2, 4) and
 * moved down 2. The same in 1.21.11 and 26.3. A sitting dragon's head and neck are a block under its body
 * (getHeadYOffset), so all three reach down to 2 under its feet: on a perch at portalY + 4, the ground round the
 * podium (feet at portalY, the top of the body 1.8 over it) is under every one of them, and a jump, the rim or a bump of
 * end stone is not.
 */
export function dragonZones (dragon: DragonView, sitting = true): DragonZone[] {
  const r = dragon.yaw * Math.PI / 180
  const zones: DragonZone[] = [
    { box: inflate(partBox(dragon, 'head', sitting), CONTACT_INFLATE), part: 'head', hurts: true },
    { box: inflate(partBox(dragon, 'neck', sitting), CONTACT_INFLATE), part: 'neck', hurts: true }
  ]
  for (const side of [1, -1]) {
    const cx = dragon.position.x + Math.cos(r) * 4.5 * side
    const cz = dragon.position.z + Math.sin(r) * 4.5 * side
    const wing = { min: { x: cx - 2, y: dragon.position.y + 2, z: cz - 2 }, max: { x: cx + 2, y: dragon.position.y + 4, z: cz + 2 } }
    const box = inflate(wing, 4, 2, 4)
    zones.push({ box: { min: { ...box.min, y: box.min.y - 2 }, max: { ...box.max, y: box.max.y - 2 } }, part: 'wing', hurts: !sitting })
  }
  return zones
}

/**
 * The zone a player with its feet at `feet` touches (its box `lift` taller, for a jump; `margin` wider for drift and the
 * dragon turning, and up to 0.1 higher: the ground round the podium is 0.2 under a perch's zones), the hurting ones
 * first; null when it touches none
 */
export function touchedZone (feet: Pos, zones: DragonZone[], lift = 0, margin = 0): DragonZone | null {
  const body = inflate(playerBox(feet, lift), margin, Math.min(margin, 0.1), margin)
  let pushed: DragonZone | null = null
  for (const z of zones) {
    if (!boxesIntersect(body, z.box)) continue
    if (z.hurts) return z
    pushed = pushed ?? z
  }
  return pushed
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
  /**
   * what can be hit from here: the head takes full damage, and on 26.3 the neck (neckTakesFullDamage); other parts
   * f / 4 + min(f, 1) (EnderDragon.hurt). Where the neck does no more than the body it counts as the body.
   */
  target: 'head' | 'neck' | 'body'
  /** eye-to-box distance to that part */
  reach: number
  /** horizontal distance from the breath cloud's edge, less the margin (Infinity with no breath) */
  breathClearance: number
  /** a jump here keeps clear of the dragon's zones too (dragonZones): a crit's fall is safe */
  crit: boolean
}

/** how much wider than the player's box the dragon's zones are kept from (drift, the dragon turning, rounding) */
export const CONTACT_MARGIN = 0.3

/**
 * Standing spots on the ground (feet at groundY) around a perched dragon from which a part
 * can be hit, best first: the head (full damage) before the body. With a breath zone (the
 * cloud is out, or about to be: the tracker's window gives it) the spots inside it, with
 * `margin` for the player's width and drift, are left out; the head is then out of reach,
 * since the cloud lands just past it, and the spots under the body by the pillar remain.
 * Spots where the body touches one of the dragon's zones (dragonZones: the head and neck
 * hurt 10 a touch, the wings throw) are left out too, and a jump (a crit) is allowed only
 * where the jumping body stays clear of them as well.
 */
export function meleeSpots (dragon: DragonView, groundY: number, breath: BreathZone | null = null, margin = 0.8, neckFullDamage = false, zones: DragonZone[] = dragonZones(dragon)): MeleeSpot[] {
  const head = headPosition(dragon)
  const neck = partBox(dragon, 'neck')
  const d = headDirection(dragon.yaw)
  const out: MeleeSpot[] = []
  const cx = Math.floor(dragon.position.x)
  const cz = Math.floor(dragon.position.z)
  for (let dx = -10; dx <= 10; dx++) {
    for (let dz = -10; dz <= 10; dz++) {
      const x = cx + dx + 0.5
      const z = cz + dz + 0.5
      const clearance = breath == null ? Infinity : Math.hypot(x - breath.center.x, z - breath.center.z) - breath.radius - margin
      if (clearance < 0) continue
      const feet = { x, y: groundY, z }
      if (touchedZone(feet, zones, 0, CONTACT_MARGIN) != null) continue
      const crit = touchedZone(feet, zones, JUMP_HEIGHT, CONTACT_MARGIN) == null
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
      const toNeck = Math.hypot(Math.max(neck.min.x - x, x - neck.max.x, 0), Math.max(neck.min.y - eyeY, eyeY - neck.max.y, 0), Math.max(neck.min.z - z, z - neck.max.z, 0))
      if (toHead <= MELEE_REACH) out.push({ x, y: groundY, z, target: 'head', reach: toHead, breathClearance: clearance, crit })
      else if (neckFullDamage && toNeck <= MELEE_REACH) out.push({ x, y: groundY, z, target: 'neck', reach: toNeck, breathClearance: clearance, crit })
      else if (toBody <= MELEE_REACH) out.push({ x, y: groundY, z, target: 'body', reach: toBody, breathClearance: clearance, crit })
    }
  }
  // head first, then a neck that takes full damage; then a spot a crit can be jumped at (Player.attack: × 1.5); then up
  // to 2 blocks of clearance from the cloud is worth more than reach; then the closest
  const rank = (s: MeleeSpot): number => s.target === 'head' ? 0 : s.target === 'neck' ? 1 : 2
  out.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.crit !== b.crit) return a.crit ? -1 : 1
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
  /**
   * it may take off within a hit or a few ticks: the 4th flame ending (DragonSittingFlamingPhase: flameCount 4 at
   * FLAME_DURATION), or the sitting damage a hit short of the limit (EnderDragon.hurt). A taking-off dragon's wings hurt
   * too (EnderDragon.knockBack, not sitting), so no jump then.
   */
  takeoffSoon: boolean
}

/** the ticks before a flame's end that count as a takeoff soon */
export const TAKEOFF_WARNING_TICKS = 15
/** a hit's worth of sitting damage (a diamond sword's crit, 10.5): this close to the limit a takeoff may come with the next */
export const TAKEOFF_HIT_MARGIN = 12

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
  private readonly ys: Array<{ tick: number, y: number }> = []
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
    // DragonFlightHistory: the y a tick, the last 11 kept here
    if (this.ys.length === 0 || this.ys[this.ys.length - 1].tick !== sample.tick) this.ys.push({ tick: sample.tick, y: sample.position.y })
    if (this.ys.length > 11) this.ys.shift()
  }

  /** the y `ticksBack` ticks before the last sample (the oldest kept when the history is shorter) */
  private yAgo (ticksBack: number): number {
    const ys = this.ys
    return ys[Math.max(0, ys.length - 1 - ticksBack)]?.y ?? this.last?.position.y ?? 0
  }

  /**
   * EnderDragon.getHeadYOffset and the tilt for the head and neck in flight, from the y history: (y 5 ago - y now) and
   * (y 5 ago - y 10 ago) × 10°
   */
  flight (): { headYOffset: number, tilt: number } {
    return { headYOffset: this.yAgo(5) - this.yAgo(0), tilt: (this.yAgo(5) - this.yAgo(10)) * 10 * Math.PI / 180 }
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
    const takeoffSoon = activity === 'perched' && ((phase === 'sitting_flaming' && this.flames >= SITTING_FLAME_ATTACKS && phaseTicks >= FLAME_DURATION - TAKEOFF_WARNING_TICKS) ||
      this.sittingDamage > SITTING_DAMAGE_LIMIT - TAKEOFF_HIT_MARGIN)
    return { open, phase, activity, phaseTicks, ticksLeft: open ? ticksLeft : 0, breath, sittingDamage: this.sittingDamage, takeoffSoon }
  }
}
