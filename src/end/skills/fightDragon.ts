import type { Bot } from 'mineflayer'
import { normalizeDimension, type Pos } from '../../core/memory'
import { Vec3 } from 'vec3'
import type { Seed } from '../../worldgen/random'
import { solveAim, arrowHits, bowArrowSpeed, type AimSolution } from '../../skills/arrow'
import { arrowStart, arrowWorld } from '../../skills/shoot'
import { motionTrackerOf } from '../../skills/motion'
import { attackStrengthOf } from '../../skills/weapons'
import { bestFoodInInventory, eat } from '../../skills/eat'
import { steerToward } from '../../skills/steer'
import { type Entity, TaskError, type SkillOptions, throwIfAborted, waitTicks, metadataIndex, metadataValue, eyePosition, yawPitchOf, distanceToBox } from '../../skills/combatUtil'
import { DragonPhaseTracker, activityOf, dragonZones, isSitting, yawFacing, SCAN_TURN_SLACK, type DragonZone, phaseName, type DragonActivity, type DragonPhase, meleeSpots, neckTakesFullDamage, partBox, touchedZone, vanillaYaw, CONTACT_MARGIN, JUMP_HEIGHT, MELEE_REACH, type DragonView, type MeleeWindow, DRAGON_PHASE_METADATA } from '../dragon'
import { exitPortal } from '../spikes'
import { destroyCrystals } from './destroyCrystals'
import { blockGetter, groundY, isOpenAt, VoidGuard, findPortalY, exitPortalOpen, worldMinY, type BlockGetter } from './world'
import { dragonDangers, inDanger, safeSpot, type Danger } from './danger'

// fightDragon: the Ender Dragon fought until it dies and the exit portal opens. While it sits on the fountain (the
// phase tracker's melee window) the bot stands outside the breath and hits the head with crits; while it flies the
// bot shoots it when an arc reaches, keeps out of the breath clouds and the fireballs' landing, steps aside from a
// charge, and keeps away from the island's edge (water bucket ready for a fall).

/** the head part's entity id: EnderDragon.setId gives the parts the ids after the dragon's, the head first */
export function dragonPartId (dragon: { id: number }, part: 'head' | 'neck' | 'body' = 'head'): number {
  return dragon.id + 1 + ['head', 'neck', 'body'].indexOf(part)
}

export interface MeleeChoice {
  spot: Vec3
  target: 'head' | 'neck' | 'body'
  /** a jump here (a crit) keeps clear of the dragon's zones, with the headroom for it */
  crit: boolean
}

/**
 * The melee spot to stand at: meleeSpots for the ground levels round the podium (the end stone, and the bedrock rim
 * a block up), kept to the ones a body can actually stand at, out of every danger and the void's margin. The spots
 * where the body touches the dragon's head, neck or wings (dragonZones: 10 a touch from the head and neck, while it
 * isn't hurt recently) are out: on the perch they reach 2 under its feet, so the rim and the bumps a block over the
 * ground are mostly out, and a crit is jumped only where the jump clears them too (a 26.3 bot hitting the head from a
 * bump of end stone took 9 touches of it, 10 each, and died). A spot that allows a crit is worth a little more reach,
 * and one near `from` (the bot) a little less walking.
 */
export function chooseMeleeSpot (get: BlockGetter, view: DragonView, portalY: number, window: MeleeWindow, dangers: Danger[], guard: VoidGuard | null, neckFullDamage = false, from: Pos | null = null): MeleeChoice | null {
  const spots: Array<MeleeChoice & { score: number }> = []
  const zones = dragonZones(view, true)
  // scanning, it turns to the bot: each spot judged with the dragon facing it
  const turning = window.phase === 'sitting_scanning'
  for (const g of [portalY, portalY + 1, portalY - 1]) {
    for (const s of meleeSpots(view, g, window.breath, undefined, neckFullDamage, zones, turning)) {
      const cell = new Vec3(Math.floor(s.x), g, Math.floor(s.z))
      if (groundY(get, s.x, s.z, g + 2, g - 2) !== g) continue
      if (!isOpenAt(get, cell) || !isOpenAt(get, cell.offset(0, 1, 0))) continue
      if (inDanger(s, dangers, 1) != null) continue
      if (guard?.risky(s) === true) continue
      const crit = s.crit && isOpenAt(get, cell.offset(0, 2, 0))
      const walk = from != null ? Math.hypot(s.x - from.x, s.z - from.z) * 0.05 : 0
      const score = (s.target === 'head' ? 0 : s.target === 'neck' ? 1 : 10) + Math.abs(s.reach - 2.2) + (crit ? 0 : 0.8) + walk
      spots.push({ spot: new Vec3(s.x, g, s.z), target: s.target, crit, score })
    }
  }
  spots.sort((a, b) => a.score - b.score)
  // the walk there under the head or neck (over the rim, a bump) is a touch or two on the way: worth a long way round
  // (WALK_UNDER_COST), looked at for the best spots only
  let best: (MeleeChoice & { score: number }) | null = null
  for (const s of spots) {
    if (best != null && s.score >= best.score) break
    const score = from != null && !walkClear(get, from, s.spot, zones) ? s.score + WALK_UNDER_COST : s.score
    if (best == null || score < best.score) best = { ...s, score }
  }
  return best == null ? null : { spot: best.spot, target: best.target, crit: best.crit }
}

/** what a walk to a melee spot under the dragon's head or neck counts for, against the spots' scores */
export const WALK_UNDER_COST = 6

/** at or below this health the bot leaves the perched dragon to eat out of its reach (the emergency apple is at 8) */
export const RETREAT_HEALTH = 10
/** and comes back to it at this health */
export const RETURN_HEALTH = 16
/**
 * how far (horizontally) a perched or landing dragon is left to eat: out of DragonSittingScanningPhase's 20 (a player
 * in it is turned to and roared at, then breathed on)
 */
export const EAT_CLEAR_PERCHED = 22
/** a flying dragon circling the spikes this far off leaves time to eat; one strafing or charging this far */
export const EAT_CLEAR_CIRCLING = 24
export const EAT_CLEAR_FLYING = 48
/** where a retreat from the perch goes: this far from the dragon */
export const RETREAT_DISTANCE = 26

/**
 * Whether 32 ticks of eating (standing still, no hits back) are safe now, from what the dragon does and how far off it
 * is horizontally: no dragon in sight, or dying; one sitting or landing on the podium out of its scan range; one
 * circling the spikes 24 off; any other (strafing with fireballs, charging, taking off) 48 off.
 */
export function safeToEat (activity: DragonActivity | null, distance: number): boolean {
  switch (activity) {
    case null: case 'dying': return true
    case 'perched': case 'landing': return distance >= EAT_CLEAR_PERCHED
    case 'circling': return distance >= EAT_CLEAR_CIRCLING
    default: return distance >= EAT_CLEAR_FLYING
  }
}

/** health comes back: food to eat, or the food bar at 18 or over (FoodData.tick's natural regeneration) */
export function canHeal (bot: Bot): boolean {
  return bot.food >= 18 || bestFoodInInventory(bot) != null
}

/**
 * What to eat now in the fight, if anything: hurt (under eatBelow, or retreating for it), hungry (under 14), or hurt
 * with the food bar under 18 (no regeneration under it); the best food for it (a golden apple when low: chooseFood's
 * reserved foods), none when nothing can be eaten (a full food bar and no golden apple)
 */
export function foodToEat (bot: Bot, retreating: boolean, eatBelow: number): string | null {
  const want = retreating || bot.health < eatBelow || bot.food < 14 || (bot.health < 20 && bot.food < 18)
  if (!want) return null
  return bestFoodInInventory(bot)?.name ?? null
}

/**
 * A spot to retreat to from the perched dragon: RETREAT_DISTANCE from it on the bot's side, or turned by 30° steps
 * either way when that's off the island, near the void or in a danger; ground within 8 of the bot's height
 */
export function retreatSpot (get: BlockGetter, dragon: Pos, from: Vec3, guard: VoidGuard | null, dangers: Danger[], distance = RETREAT_DISTANCE): Vec3 | null {
  const base = Math.atan2(from.z - dragon.z, from.x - dragon.x)
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
    const a = base + k * Math.PI / 6
    const x = Math.floor(dragon.x + Math.cos(a) * distance) + 0.5
    const z = Math.floor(dragon.z + Math.sin(a) * distance) + 0.5
    const y = groundY(get, x, z, from.y + 8, from.y - 8)
    if (y == null) continue
    const p = new Vec3(x, y, z)
    if (!isOpenAt(get, p.floored()) || !isOpenAt(get, p.floored().offset(0, 1, 0))) continue
    if (guard?.risky(p) === true) continue
    if (inDanger(p, dangers, 2) != null) continue
    return p
  }
  return null
}

/**
 * Eats `food`, cut short (PREEMPTED, quietly) when a danger comes over the bot or the dragon comes close enough that
 * eating isn't safe any more (safeToEat with 8 blocks to spare)
 */
export async function eatAwayFromDragon (bot: Bot, food: string, portalY: number, signal?: AbortSignal, log: (line: string) => void = () => {}): Promise<boolean> {
  const controller = new AbortController()
  const onParent = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onParent)
  const watch = (): void => {
    const me = bot.entity.position
    const dragon = Object.values(bot.entities).find(e => e.name === 'ender_dragon')
    const phase = dragon != null ? phaseName((dragon.metadata as any)?.[metadataIndex(bot, 'ender_dragon', 'phase', DRAGON_PHASE_METADATA)]) : null
    const near = dragon != null && !safeToEat(phase != null ? activityOf(phase) : null, Math.hypot(dragon.position.x - me.x, dragon.position.z - me.z) + 8)
    if (near || inDanger(me, dragonDangers(bot, portalY), 0.5) != null) controller.abort(new TaskError('PREEMPTED', 'the dragon comes'))
  }
  bot.on('physicsTick', watch)
  try {
    await eat(bot, { signal: controller.signal, food })
    log(`ate ${food}: health ${bot.health.toFixed(1)}, food ${bot.food}`)
    return true
  } catch (err) {
    throwIfAborted(signal)
    if (TaskError.is(err, 'DIED')) throw err
    log(`eating ${food} cut short: ${(err as Error).message}`)
    return false
  } finally {
    bot.off('physicsTick', watch)
    signal?.removeEventListener('abort', onParent)
  }
}

/**
 * The part of the dragon whose hurting zone (dragonZones, for its phase: sitting or not) the body at `feet` touches, if
 * any: a margin of 0.1 for the turn of a tick
 */
export function hurtingContact (view: DragonView, feet: Pos, phase: DragonPhase | null): 'head' | 'neck' | 'wing' | null {
  const zone = touchedZone(feet, dragonZones(view, phase != null && isSitting(phase)), 0, 0.1)
  return zone?.hurts === true ? zone.part : null
}

/** how far from the body a takeoff is waited out (the head turning round 6.5 out with its 1-block zone, the wings' 6) */
export const TAKEOFF_CLEARANCE = 10
/** after a hit that may have sent it off: kept back this long (DragonTakeoffPhase leaves within 10 of the podium) */
export const TAKEOFF_STEP_BACK_TICKS = 30

/**
 * Back out of the dragon's way for a takeoff: under way (DragonTakeoffPhase), the 4th flame ending (the window's
 * takeoffSoon in sitting_flaming), or just after a hit that may have passed the sitting damage's limit (`afterHit`)
 */
export function takeoffStepBack (window: MeleeWindow, afterHit: boolean): boolean {
  return window.activity === 'leaving' || afterHit || (window.takeoffSoon && window.phase === 'sitting_flaming')
}

/** where the bot and the dragon are when it is hurt, for the log: the bot's feet, the dragon's place, yaw and phase, the part it touches, the clouds over it */
export function hurtContext (bot: Bot, portalY: number, tracker: DragonPhaseTracker): string {
  const me = bot.entity.position
  const parts = [`bot at ${me.x.toFixed(1)} ${me.y.toFixed(2)} ${me.z.toFixed(1)}${bot.entity.onGround ? '' : ' (airborne)'}`]
  const dragon = Object.values(bot.entities).find(e => e.name === 'ender_dragon')
  if (dragon != null) {
    const view = { position: dragon.position, yaw: vanillaYaw(dragon.yaw), ...tracker.flight() }
    const zone = touchedZone(me, dragonZones(view, tracker.phase != null && isSitting(tracker.phase)))
    parts.push(`dragon at ${dragon.position.x.toFixed(1)} ${dragon.position.y.toFixed(2)} ${dragon.position.z.toFixed(1)} yaw ${view.yaw.toFixed(0)} (${String(tracker.phase)})${zone != null ? `, touching its ${zone.part}` : ''}`)
  }
  const cloud = inDanger(me, dragonDangers(bot, portalY), 0)
  if (cloud != null) parts.push(`in a ${cloud.why} (${cloud.center.x.toFixed(1)}, ${cloud.center.z.toFixed(1)}, radius ${cloud.radius.toFixed(1)})`)
  return parts.join(', ')
}

/**
 * The nearest spot the bot can walk straight to (16 headings, 1.5 to 6 blocks out, the ground at most a step up or 2
 * down on the way) where its body is out of the given zones (CONTACT_MARGIN), the dangers and the void's margin
 */
export function escapeSpot (get: BlockGetter, from: Vec3, zones: DragonZone[], dangers: Danger[], guard: VoidGuard | null): Vec3 | null {
  for (const d of [1.5, 2.5, 3.5, 4.5, 6]) {
    let best: Vec3 | null = null
    let bestScore = Infinity
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8
      const p = walkable(get, from, a, d)
      if (p == null) continue
      if (touchedZone(p, zones, 0, CONTACT_MARGIN) != null || inDanger(p, dangers, 0.5) != null || guard?.risky(p) === true) continue
      // level ground first
      const score = Math.abs(p.y - from.y)
      if (score < bestScore) { bestScore = score; best = p }
    }
    if (best != null) return best
  }
  return null
}

/** where a straight walk from `from` along heading `a` (radians, x = cos, z = sin) for `distance` ends, null if a wall or a drop of more than 2 is on the way */
function walkable (get: BlockGetter, from: Vec3, a: number, distance: number): Vec3 | null {
  let y = Math.floor(from.y + 1e-6)
  const steps = Math.ceil(distance / 0.5)
  let x = from.x
  let z = from.z
  for (let i = 1; i <= steps; i++) {
    x = from.x + Math.cos(a) * distance * i / steps
    z = from.z + Math.sin(a) * distance * i / steps
    // a step up (the ground a block over) to 2 down
    const g = groundY(get, x, z, y + 2, y - 3)
    if (g == null) return null
    const cell = new Vec3(Math.floor(x), g, Math.floor(z))
    if (!isOpenAt(get, cell) || !isOpenAt(get, cell.offset(0, 1, 0))) return null
    y = g
  }
  return new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5)
}

/** a point `distance` from `from` straight away from `threat` (horizontally) */
export function awayFrom (from: Vec3, threat: Pos, distance: number): Vec3 {
  const away = new Vec3(from.x - threat.x, 0, from.z - threat.z)
  const len = Math.hypot(away.x, away.z)
  return len < 1e-6 ? from.offset(distance, 0, 0) : from.plus(away.scaled(distance / len))
}

/**
 * The straight walk from `from` to `to` keeps the body out of the zones that hurt: the ground under each half block of
 * it (the rim, a bump of end stone) clear of them
 */
export function walkClear (get: BlockGetter, from: Pos, to: Pos, zones: DragonZone[]): boolean {
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.5)
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * i / steps
    const z = from.z + (to.z - from.z) * i / steps
    const y = groundY(get, x, z, Math.max(from.y, to.y) + 2, Math.min(from.y, to.y) - 3)
    if (y == null) continue
    if (touchedZone({ x, y, z }, zones.filter(zone => zone.hurts), 0, 0.1) != null) return false
  }
  return true
}

export interface FightDragonOptions extends SkillOptions {
  /** the world seed (the crystals' spikes, when their blocks aren't loaded) */
  seed?: Seed
  /** destroy the crystals left first, so they can't heal it (default true) */
  destroyCrystals?: boolean
  /** shoot it in flight (default true, with a bow and arrows) */
  bow?: boolean
  /** give up after this many ticks (default 48000) */
  maxTicks?: number
  /** eat below this health when the dragon is away (default 12) */
  eatBelowHealth?: number
  /** at or below this health, off out of the dragon's reach to eat (default RETREAT_HEALTH) */
  retreatHealth?: number
  /** back to the fight from there at this health (default RETURN_HEALTH) */
  returnHealth?: number
  /** keep this far from the void (default 4) */
  voidMargin?: number
  /** stay within this distance of the podium while it flies (default 24) */
  homeRadius?: number
  /** progress lines */
  log?: (line: string) => void
}

export interface FightDragonResult {
  killed: boolean
  ticks: number
  meleeHits: number
  arrows: number
  /** the arrows seen to hit (the dragon's health down in flight soon after a shot) */
  arrowHits: number
  /** the perches seen (melee windows opened) */
  perches: number
  /** the dragon's health when last seen */
  health: number
}

const ARROW_NAMES = ['arrow', 'spectral_arrow', 'tipped_arrow']
/** a health drop in flight this soon after a shot counts as the arrow's (aimAtDragon's flights are 60 ticks at most) */
export const ARROW_FLIGHT_TICKS = 60

/** the dragon's health went down while it flew, within ARROW_FLIGHT_TICKS of a shot: the arrow hit */
export function arrowHit (before: number, after: number, phase: DragonPhase | null, ticksSinceShot: number): boolean {
  return after < before && phase != null && !isSitting(phase) && ticksSinceShot <= ARROW_FLIGHT_TICKS
}

/**
 * Fights the Ender Dragon until it dies and the exit portal opens. Each tick it reads the dragon (phase from its
 * metadata into the DragonPhaseTracker, health), then in order: a water bucket for a fall, out of any danger (breath
 * clouds, a fireball's landing, a charge's line, the breath the tracker expects), melee while the window is open,
 * eat when hurt and the dragon is far, a bow shot while it flies, else back towards the podium. Throws TIMEOUT
 * after maxTicks, DIED with the bot.
 */
export async function fightDragon (bot: Bot, opts: FightDragonOptions = {}): Promise<FightDragonResult> {
  const signal = opts.signal
  const log = opts.log ?? (() => {})
  const get = blockGetter(bot)
  const maxTicks = opts.maxTicks ?? 48000
  const eatBelow = opts.eatBelowHealth ?? 12
  const homeRadius = opts.homeRadius ?? 24
  // not in the End (resumed after the exit portal carried it out): won when the server says so
  if (normalizeDimension(bot.game?.dimension) !== 'the_end') {
    const won = bot.survival?.advancements?.has('end/kill_dragon') === true
    return { killed: won, ticks: 0, meleeHits: 0, arrows: 0, arrowHits: 0, perches: 0, health: won ? 0 : 200 }
  }
  // the podium's chunk may still be on its way when the bot has just come to the island
  let foundY = findPortalY(get)
  for (let t = 0; t < 100 && foundY == null; t++) {
    await waitTicks(bot, 1, signal)
    foundY = findPortalY(get)
  }
  const portalY = foundY ?? 64
  let portal = exitPortal(portalY)
  const home = new Vec3(0.5, portalY, 0.5)
  const guard = new VoidGuard(get, opts.voidMargin ?? 4, worldMinY(bot))
  const tracker = new DragonPhaseTracker(portal.perch)
  const motion = motionTrackerOf(bot)
  const strength = attackStrengthOf(bot)

  if (opts.destroyCrystals !== false && Object.values(bot.entities).some(e => e.name === 'end_crystal')) {
    log('crystals first')
    try {
      await destroyCrystals(bot, { signal, seed: opts.seed, log: opts.log })
    } catch (err) {
      // a crystal no way reached (its cage's bars, no arc over the spike's rim) is left: the dragon heals at it only
      // while it flies by, and the fight goes on (a 1.21.11 run's End milestone failed five times on one caged crystal)
      if (!TaskError.is(err, 'NO_PATH')) throw err
      log(`crystals left: ${(err as Error).message}`)
    }
  }

  let dragonId: number | null = null
  let killed = false
  let health = 200
  const onGone = (e: Entity): void => { if (e.id === dragonId) killed = killed || health <= 0 || tracker.phase === 'dying' }
  bot.on('entityGone', onGone)
  // each hurt logged with where the bot and the dragon were (what hurt it: the head, the breath, a fireball's cloud)
  let lastHealth = bot.health
  const onHealth = (): void => {
    if (bot.health < lastHealth) log(`hurt ${lastHealth.toFixed(1)} -> ${bot.health.toFixed(1)}: ${hurtContext(bot, portalY, tracker)}`)
    lastHealth = bot.health
  }
  bot.on('health', onHealth)
  let tick = 0
  let meleeHits = 0
  let crits = 0
  let arrows = 0
  /** the dragon's health went down in flight within ARROW_FLIGHT_TICKS of a shot */
  let arrowHits = 0
  let lastShot = -Infinity
  let perches = 0
  let wasOpen = false
  let drawing: number | null = null
  let jumpedAt = -100
  let water: Vec3 | null = null
  let wasRisky = false
  let wasOverVoid = false
  let retreating = false
  let wasInContact = false
  /** stepping back from a perch that may end with the last hit, till this tick */
  let stepBackUntil = -1
  const retreatHealth = opts.retreatHealth ?? RETREAT_HEALTH
  const returnHealth = opts.returnHealth ?? RETURN_HEALTH
  const hasArrows = (): boolean => bot.inventory.items().some(i => ARROW_NAMES.includes(i.name))
  const bow = (): boolean => opts.bow !== false && bot.inventory.items().some(i => i.name === 'bow') && hasArrows()
  const hold = async (name: string): Promise<boolean> => {
    if (bot.heldItem?.name === name) return true
    const item = bot.inventory.items().find(i => i.name === name)
    if (item == null) return false
    await bot.equip(item, 'hand')
    return true
  }
  const sword = (): string | null => {
    const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'netherite_axe', 'diamond_axe', 'stone_sword', 'iron_axe', 'wooden_sword']
    return order.find(n => bot.inventory.items().some(i => i.name === n) || bot.heldItem?.name === n) ?? null
  }
  const stopDraw = (): void => {
    if (drawing != null) { bot.deactivateItem(); drawing = null }
  }

  // the fight eats when the dragon is away (foodToEat, safeToEat): the eat reflex fired mid-melee
  const releaseEat = (bot as any).survival?.reflexes?.inhibit?.(['eat']) as (() => void) | undefined
  try {
    for (;;) {
      throwIfAborted(signal)
      // out of the End (carried through the exit portal when the dragon died over the podium): the fight's over, won
      // when the server says so (minecraft:end/kill_dragon); a 26.3 bot so came out at the spawn and fought on in
      // the overworld for 130000 ticks
      if (normalizeDimension(bot.game?.dimension) !== 'the_end') {
        stopDraw()
        bot.clearControlStates()
        const won = killed || bot.survival?.advancements?.has('end/kill_dragon') === true
        log(`out of the End after ${tick} ticks: the dragon ${won ? 'dead' : 'alive'}; ${meleeHits} hits, ${arrows} arrows (${arrowHits} hit)`)
        return { killed: won, ticks: tick, meleeHits, arrows, arrowHits, perches, health: won ? 0 : health }
      }
      if (tick++ > maxTicks) throw new TaskError('TIMEOUT', `the dragon is alive after ${maxTicks} ticks (health ${health})`)
      const dragon = Object.values(bot.entities).find(e => e.name === 'ender_dragon') ?? null
      if (dragon != null) {
        dragonId = dragon.id
        motion.track(dragon)
        const phase = (dragon.metadata as any)?.[metadataIndex(bot, 'ender_dragon', 'phase', DRAGON_PHASE_METADATA)]
        const view = { position: dragon.position.clone(), yaw: vanillaYaw(dragon.yaw) }
        tracker.update({ tick, phase: typeof phase === 'number' ? phase : 0, ...view })
        const h = metadataValue(bot, dragon, 'health')
        if (typeof h === 'number') {
          // a drop in flight soon after a shot: the arrow's (no melee reaches it up there)
          if (arrowHit(health, h, tracker.phase, tick - lastShot)) {
            arrowHits++
            log(`arrow hit: the dragon at ${h.toFixed(1)} (${arrowHits} of ${arrows})`)
          }
          health = h
          tracker.updateHealth(h)
        }
        if (tick % 1200 === 0) log(`tick ${tick}: the dragon at ${health.toFixed(1)} (${String(tracker.phase)}), the bot at ${bot.health.toFixed(1)}; ${meleeHits} hits (${crits} crits), ${arrows} arrows (${arrowHits} hit), ${perches} perches`)
        if (health <= 0 || tracker.phase === 'dying') killed = true
      }
      if (killed || (dragon == null && exitPortalOpen(get, portal))) {
        stopDraw()
        bot.clearControlStates()
        // EnderDragon.tickDeath: 200 ticks of dying, then the exit portal (EndDragonFight.setDragonKilled)
        if (foundY == null) portal = exitPortal(findPortalY(get) ?? portalY)
        for (let t = 0; t < 600 && !exitPortalOpen(get, portal); t++) await waitTicks(bot, 1, signal)
        if (!exitPortalOpen(get, portal)) throw new TaskError('TIMEOUT', 'the dragon died but the exit portal stayed shut')
        log(`dragon dead after ${tick} ticks: ${meleeHits} hits (${crits} crits), ${arrows} arrows (${arrowHits} hit), ${perches} perches`)
        return { killed: true, ticks: tick, meleeHits, arrows, arrowHits, perches, health: 0 }
      }

      const me = bot.entity.position
      guard.update(me, bot.entity.onGround)

      // 1. falling: a water bucket under the landing (and picked back up once in it)
      if (water != null && bot.entity.onGround) {
        if (bot.blockAt(water)?.name === 'water' && await hold('bucket')) {
          await bot.lookAt(water.offset(0.5, 0.5, 0.5), true)
          bot.activateItem()
        }
        water = null
      }
      if (!bot.entity.onGround && bot.entity.velocity.y < -0.6) {
        const ground = groundY(get, me.x, me.z, me.y, me.y - 40)
        if (ground != null && me.y - ground < 3.5 && me.y - ground > 1 && bot.inventory.items().some(i => i.name === 'water_bucket')) {
          stopDraw()
          await hold('water_bucket')
          await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          bot.activateItem()
          water = new Vec3(Math.floor(me.x), ground, Math.floor(me.z))
        }
        await waitTicks(bot, 1, signal)
        continue
      }

      // 2. dangers: the clouds on the ground, the breath the perched dragon is about to breathe, a fireball's landing, a charge
      const window = tracker.window(tick)
      if (window.open && !wasOpen) { perches++; log(`perched (${String(window.phase)}) at tick ${tick}, health ${health}`) }
      wasOpen = window.open
      const dangers = dragonDangers(bot, portalY)
      if (window.breath != null) {
        dangers.push({ center: window.breath.center, y: portalY, radius: window.breath.radius, why: 'breath' })
      }
      // under its head, neck or wings as they are now (taking off, landing, a sitting dragon turned to the bot): out
      // from under them, away from its body, before anything else (EnderDragon.aiStep: 10 a touch, the wings 5 when it
      // isn't sitting)
      const contact = dragon != null ? hurtingContact({ position: dragon.position, yaw: vanillaYaw(dragon.yaw), ...tracker.flight() }, me, window.phase) : null
      if (contact != null && dragon != null) {
        stopDraw()
        if (!wasInContact) log(`under the dragon's ${contact}: out from under it; ${hurtContext(bot, portalY, tracker)}`)
        wasInContact = true
        const view = { position: dragon.position, yaw: vanillaYaw(dragon.yaw), ...tracker.flight() }
        const zones = dragonZones(view, window.phase != null && isSitting(window.phase)).filter(z => z.hurts)
        // the nearest ground out of them the bot can walk to (straight away from the body may be a wall, or a step up
        // further into them)
        steerToward(bot, escapeSpot(get, me, zones, dangers, guard) ?? awayFrom(me, dragon.position, 6), { sprint: true })
        await waitTicks(bot, 1, signal)
        continue
      }
      wasInContact = false
      const danger = inDanger(me, dangers)
      if (danger != null) {
        stopDraw()
        // not out of the breath along the dragon's neck: its head and neck as they are, kept clear on the way
        const zones = dragon != null ? dragonZones({ position: dragon.position, yaw: vanillaYaw(dragon.yaw), ...tracker.flight() }, window.phase != null && isSitting(window.phase)).filter(z => z.hurts) : undefined
        const to = safeSpot(get, me, dangers, guard, { home, homeRadius: homeRadius + 8, zones })
        if (to != null) steerToward(bot, to, { sprint: true })
        else bot.clearControlStates()
        await waitTicks(bot, 1, signal)
        continue
      }

      // knocked near the edge (the wings, a charge): back to where it last stood safe, or to the podium
      if (bot.entity.onGround && guard.risky(me)) {
        stopDraw()
        if (!wasRisky) log(`near the void at ${me.floored().toString()}: back to ${String(guard.lastSafe ?? home)}`)
        wasRisky = true
        steerToward(bot, guard.lastSafe ?? home, { sprint: false })
        await waitTicks(bot, 1, signal)
        continue
      }
      wasRisky = false
      if (guard.overVoid && !wasOverVoid) log(`over the void at ${me.floored().toString()}`)
      wasOverVoid = guard.overVoid

      // low on health: off out of its reach to eat, back when healed (an eat reflex at 7.7 health under the perched
      // dragon's head kept a 26.3 bot there 32 ticks with no hits back, and it died)
      const dragonDistance = dragon == null ? Infinity : Math.hypot(dragon.position.x - me.x, dragon.position.z - me.z)
      const healing = canHeal(bot)
      if (!retreating && bot.health <= retreatHealth && healing) {
        retreating = true
        log(`health ${bot.health.toFixed(1)}: off out of its reach to eat`)
      } else if (retreating && (bot.health >= returnHealth || !healing)) {
        retreating = false
        log(`health ${bot.health.toFixed(1)}: back to the fight`)
      }
      // 3. eat when it's safe: out of its reach while it sits, far while it flies (the eat reflex is held off meanwhile)
      const meal = foodToEat(bot, retreating, eatBelow)
      if (meal != null && safeToEat(window.activity, dragonDistance)) {
        stopDraw()
        bot.clearControlStates()
        await eatAwayFromDragon(bot, meal, portalY, signal, log)
        continue
      }
      if (retreating && dragon != null && (window.activity === 'perched' || window.activity === 'landing')) {
        stopDraw()
        bot.setControlState('jump', false)
        const to = retreatSpot(get, dragon.position, me, guard, dangers)
        if (to != null) steerToward(bot, to, { sprint: true })
        else bot.clearControlStates()
        await waitTicks(bot, 1, signal)
        continue
      }

      // 4. a takeoff coming or under way (the 4th flame ending, the hit that may have passed the sitting damage's limit,
      // the takeoff itself): TAKEOFF_CLEARANCE off its body, where neither the head turning round nor the wings, which
      // hurt once it isn't sitting (EnderDragon.knockBack), come
      if (dragon != null && takeoffStepBack(window, tick < stepBackUntil) && Math.hypot(me.x - dragon.position.x, me.z - dragon.position.z) < TAKEOFF_CLEARANCE) {
        stopDraw()
        steerToward(bot, awayFrom(me, dragon.position, 6), { sprint: true })
        bot.setControlState('jump', false)
        await waitTicks(bot, 1, signal)
        continue
      }

      // 5. the dragon on the fountain: to a melee spot, and hit the head
      if (window.open && dragon != null) {
        stopDraw()
        const view = { position: dragon.position, yaw: vanillaYaw(dragon.yaw) }
        const zones = dragonZones(view, true)
        // scanning, it turns to the bot (DragonSittingScanningPhase): where it stands is judged with the dragon facing it too
        const zoneSets = window.phase === 'sitting_scanning' ? [zones, ...[-SCAN_TURN_SLACK, 0, SCAN_TURN_SLACK].map(t => dragonZones({ ...view, yaw: yawFacing(view.position, me) + t }))] : [zones]
        const neckFull = neckTakesFullDamage(bot.registry.version as any)
        const choice = chooseMeleeSpot(get, view, portalY, window, dangers, guard, neckFull, me)
        const weapon = sword()
        if (weapon != null) await hold(weapon)
        const eye = eyePosition(bot)
        const reachTo = (part: 'head' | 'neck' | 'body'): number => {
          const b = partBox(view, part)
          return distanceToBox(eye, { min: new Vec3(b.min.x, b.min.y, b.min.z), max: new Vec3(b.max.x, b.max.y, b.max.z) })
        }
        // the part to hit from here: the head, the neck where it takes full damage (26.3), else the body
        const target = reachTo('head') <= MELEE_REACH ? 'head' : neckFull && reachTo('neck') <= MELEE_REACH ? 'neck' : reachTo('body') <= MELEE_REACH ? 'body' : null
        const touching = zoneSets.map(zs => touchedZone(me, zs, 0, CONTACT_MARGIN)).find(z => z != null) ?? null
        const at = choice != null && Math.hypot(me.x - choice.spot.x, me.z - choice.spot.z) < 0.6 && Math.abs(me.y - choice.spot.y) < 0.5
        // where it stands will do: on the ground clear of the zones, and a full-damage part in reach (or the body, when
        // no spot has better)
        const here = bot.entity.onGround && touching == null && target != null && (target !== 'body' || choice?.target === 'body')
        if (!at && !here) {
          if (choice != null) {
            steerToward(bot, choice.spot, { sprint: Math.hypot(me.x - choice.spot.x, me.z - choice.spot.z) > 4 })
          } else if (touching != null) {
            // nowhere clear to hit from: out from under its head, neck and wings at least
            steerToward(bot, me.plus(new Vec3(me.x - dragon.position.x, 0, me.z - dragon.position.z).normalize().scaled(4)), { sprint: true })
          } else {
            bot.clearControlStates()
          }
          await waitTicks(bot, 1, signal)
          continue
        }
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        if (target == null) {
          bot.setControlState('jump', false)
          await waitTicks(bot, 1, signal)
          continue
        }
        const box = partBox(view, target)
        const aimAt = target === 'body' ? dragon.position.offset(0, 1.5, 0) : new Vec3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2)
        const { yaw, pitch } = yawPitchOf(aimAt.minus(eye))
        await bot.look(yaw, pitch, true)
        // a crit only where the jump stays clear of the head, neck and wings (a jump under the head touches it)
        // and none when it may take off (its wings hurt then)
        const critOk = !window.takeoffSoon && (at && choice != null ? choice.crit : zoneSets.every(zs => touchedZone(me, zs, JUMP_HEIGHT, CONTACT_MARGIN) == null))
        const airborne = tick - jumpedAt <= 14 && !bot.entity.onGround
        const falling = !bot.entity.onGround && bot.entity.velocity.y < 0
        if (critOk && bot.entity.onGround && !airborne && strength.ticksToFull() <= 5 && strength.ticksToFull() > 0) {
          // a jump peaks after about 6 ticks: the fall comes with a full swing (Player.attack's crit)
          bot.setControlState('jump', true)
          jumpedAt = tick
        } else {
          bot.setControlState('jump', false)
        }
        if (strength.scale(0.5) >= 1 && (falling || (bot.entity.onGround && tick - jumpedAt > 14))) {
          strength.attack({ id: dragonPartId(dragon, target) } as any)
          // a hit near the sitting damage's limit may be the one that sends it off: back out of its way
          if (window.takeoffSoon) stepBackUntil = tick + TAKEOFF_STEP_BACK_TICKS
          meleeHits++
          if (falling) crits++
        }
        await waitTicks(bot, 1, signal)
        continue
      }
      bot.setControlState('jump', false)

      // 7. a bow shot while it flies (arrows are wasted on it sitting: AbstractDragonSittingPhase.onHurt)
      if (dragon != null && bow() && window.activity !== 'perched' && window.activity !== 'landing') {
        const solution = aimAtDragon(bot, dragon, drawing != null ? Math.max(1, 21 - (tick - drawing)) : 22)
        if (drawing == null) {
          if (solution != null && dragon.position.distanceTo(me) < 90) {
            await hold('bow')
            bot.clearControlStates()
            bot.activateItem()
            drawing = tick
          }
        } else {
          if (solution != null) await bot.look(solution.yaw, solution.pitch, true)
          if (tick - drawing >= 21 && solution != null) {
            bot.deactivateItem()
            drawing = null
            arrows++
            lastShot = tick
            log(`arrow ${arrows} at the dragon (${String(window.phase)}, ${dragon.position.distanceTo(me).toFixed(0)} off, ${solution.ticks} ticks of flight, the dragon at ${health.toFixed(1)})`)
          } else if (tick - drawing > 80) {
            stopDraw()
          }
        }
        await waitTicks(bot, 1, signal)
        continue
      }
      stopDraw()

      // 8. wait near the podium, out of the way
      const off = Math.hypot(me.x - home.x, me.z - home.z)
      if (off > homeRadius * 0.6 || off < 6) {
        const to = off < 6 ? me.plus(new Vec3(me.x - home.x, 0, me.z - home.z).normalize().scaled(4)) : home
        steerToward(bot, to, { sprint: false })
      } else {
        bot.clearControlStates()
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    releaseEat?.()
    bot.off('entityGone', onGone)
    bot.off('health', onHealth)
    if (dragonId != null) motion.untrack({ id: dragonId } as any)
    stopDraw()
    bot.clearControlStates()
  }
}

/**
 * The bow's aim at the flying dragon: the middle of its body part (a 5×3 box at its position), led by its velocity
 * over the arrow's flight; null when no arc gets there before a block.
 */
export function aimAtDragon (bot: Bot, dragon: Entity, leadTicks: number): AimSolution | null {
  const start = arrowStart(bot)
  const point = dragon.position.offset(0, 1.5, 0)
  const velocity = motionTrackerOf(bot).velocity(dragon)
  // blocks only: the End's sky has no water to slow the arrow (and the water lookups each step are most of the cost)
  const world = { clip: arrowWorld(bot).clip }
  const common = { speed: bowArrowSpeed(20), targetVelocity: velocity, leadTicks, world }
  const solution = solveAim(start, point, { ...common, highArc: false })
  if (solution == null || solution.ticks > 60) return null
  const offset = solution.aimPoint.minus(point)
  const box = { min: dragon.position.offset(-2.5, 0, -2.5).plus(offset), max: dragon.position.offset(2.5, 3, 2.5).plus(offset) }
  return arrowHits(start, solution.yaw, solution.pitch, box, common).hit != null ? solution : null
}
