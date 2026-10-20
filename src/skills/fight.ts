import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
import { edgeAhead, steerAway, steerToward } from './steer'
import { onDripstone } from './hazardCells'
import { type Entity, hasLineOfSight, metadataIndex, metadataValue, distanceToBox, entityBox, entityName, eyePosition, isAlive, TaskError, type SkillOptions, throwIfAborted, waitTicks, yawPitchOf } from './combatUtil'

export interface FightOptions extends SkillOptions {
  /** the reach to swing from (Player.entityInteractionRange 3, less a margin) */
  reach?: number
  /** jump for critical hits (Player.attack: falling, not on the ground, not sprinting, a charged swing) */
  crits?: boolean
  /** raise the shield against skeletons drawing and creepers about to blow (default true) */
  shield?: boolean
  /** a creeper's fuse (ticks of swelling, Creeper.maxSwell 30) at which the bot blocks or backs off (default 18) */
  creeperSwellDanger?: number
  /** the distance a creeper stops swelling at (Creeper's SwellGoal: 7 blocks) plus a margin */
  creeperSafeDistance?: number
  /** ticks to give up after (default 1200) */
  maxTicks?: number
  /** give up when the target gets this far (default 32) */
  maxDistance?: number
  /** pick the inventory's best weapon first (default true) */
  equipWeapon?: boolean
  /** where on the target to look, as a fraction of its height (default 0.85; an enderman's legs at 0.3 keep the look off its eyes) */
  aimHeight?: number
  /**
   * the most blocks a step down while closing in or backing off may drop (default 3, a fall that does no harm): less
   * keeps the fight on the bot's own level (steerToward's maxDrop)
   */
  maxDrop?: number
  /** given up (returned, not killed) once this holds: the fight's odds turned (the hostiles reflex's flee) */
  until?: () => boolean
}

export interface FightResult {
  /** it died (EntityEvent.DEATH); false when it left otherwise (a creeper that blew up, a mob that despawned) */
  killed: boolean
  hits: number
  ticks: number
  /** where the target was last seen (its drops land there) */
  lastPosition: Vec3
}

// LivingEntity.DATA_LIVING_ENTITY_FLAGS (index 8 on 1.21.11 and 26.3): bit 1 is "using an item" (a skeleton drawing its bow)
const LIVING_FLAGS_INDEX = 8
// Creeper.DATA_SWELL_DIR (index 16 on 1.21.11 and 26.3): 1 swelling, -1 not
export const CREEPER_SWELL_DIR_INDEX = 16
// Creeper.DATA_IS_IGNITED (index 18 on 1.21.11 and 26.3): lit by flint and steel, it swells whatever the distance
export const CREEPER_IGNITED_INDEX = 18
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'piglin', 'drowned', 'parched'])

export function isUsingItem (bot: Bot, entity: Entity): boolean {
  const flags = (entity.metadata as any)?.[metadataIndex(bot, entityName(entity), 'living_entity_flags', LIVING_FLAGS_INDEX)]
  return typeof flags === 'number' && (flags & 1) !== 0
}

// Blaze.DATA_FLAGS_ID (index 16 on 1.21.11 and 26.3): bit 1 is set while it's charged, about to shoot (Blaze.setCharged)
const BLAZE_FLAGS_INDEX = 16

/** a blaze about to shoot its fireballs (BlazeAttackGoal sets it charged for the volley) */
export function blazeCharged (bot: Bot, entity: Entity): boolean {
  const flags = (entity.metadata as any)?.[metadataIndex(bot, 'blaze', 'flags', BLAZE_FLAGS_INDEX)]
  return typeof flags === 'number' && (flags & 1) !== 0
}

export function creeperSwelling (bot: Bot, entity: Entity): boolean {
  const meta = entity.metadata as any
  const dir = meta?.[metadataIndex(bot, 'creeper', 'swell_dir', CREEPER_SWELL_DIR_INDEX)]
  const ignited = meta?.[metadataIndex(bot, 'creeper', 'is_ignited', CREEPER_IGNITED_INDEX)]
  return dir === 1 || ignited === true
}

/**
 * Creeper.tick's swell count, followed on the client: up one a tick while it swells, down one while it doesn't,
 * between 0 and maxSwell (30, when it explodes).
 */
export class SwellCounter {
  swell = 0
  update (swelling: boolean): number {
    this.swell = Math.max(0, Math.min(30, this.swell + (swelling ? 1 : -1)))
    return this.swell
  }
}

/** AbstractSkeleton.performRangedAttack: the arrow leaves at 1.6 blocks a tick (Projectile.shoot's velocity) */
export const MOB_ARROW_SPEED = 1.6

/**
 * When to hold the shield up against a mob's bow: from the start of its draw (LivingEntity's using-item flag) until its
 * arrow has had the time to get here. The flag clears on the tick the arrow leaves (RangedBowAttackGoal: stopUsingItem,
 * performRangedAttack), and the arrow is in the air a few ticks more: a shield lowered then took every arrow.
 */
export class ArrowGuard {
  private holdUntil = -1
  private drawing = false
  /** this tick's say: the mob drawing, its distance, the tick; whether to block */
  update (drawing: boolean, distance: number, tick: number): boolean {
    if (this.drawing && !drawing) this.holdUntil = tick + Math.ceil(distance / MOB_ARROW_SPEED) + 2
    this.drawing = drawing
    return drawing || tick <= this.holdUntil
  }
}

/** a mob that shoots a crossbow (CrossbowAttackMob: its is_charging_crossbow field, a pillager's or a piglin's) */
export function isCrossbowMob (bot: Bot, entity: Entity): boolean {
  const keys: string[] | undefined = (bot.registry.entitiesByName as any)[entity.name ?? '']?.metadataKeys
  return keys?.includes('is_charging_crossbow') === true
}

/** CrossbowAttackMob.isChargingCrossbow: the crossbow being drawn (Pillager.IS_CHARGING_CROSSBOW, its arm pose) */
export function isChargingCrossbow (bot: Bot, entity: Entity): boolean {
  return metadataValue(bot, entity, 'is_charging_crossbow') === true
}

/** ticks a crossbow is taken as loaded without its shot seen, at most (a mob out of sight holds it loaded) */
export const CROSSBOW_LOADED_TICKS = 200

/**
 * When to hold the shield up against a mob's crossbow (RangedCrossbowAttackGoal): it is CHARGING for the crossbow's
 * charge (is_charging_crossbow, CrossbowItem.getChargeDuration: 25 ticks), then CHARGED for its attackDelay (20 to 39
 * ticks), then READY_TO_ATTACK, and it shoots once it sees the target. The danger is the other way round from a bow's:
 * the loaded crossbow, from the charge's end to the shot, not the draw. A pillager's bolt left the bot's shield down
 * (ArrowGuard lowered it a few ticks after the draw, 20 to 39 before the shot). Held up from the charge's end until the
 * bolt has had the time to get here: a bolt seen leaving the mob, or its next charge begun (it shot).
 */
export class CrossbowGuard {
  private charging = false
  private loadedAt = -1
  private holdUntil = -1
  /** this tick's say: the mob charging, a bolt seen leaving it, its distance, the tick; whether to block */
  update (charging: boolean, shot: boolean, distance: number, tick: number): boolean {
    const flight = Math.ceil(distance / MOB_ARROW_SPEED) + 2
    if (this.charging && !charging) this.loadedAt = tick
    // a new charge begun while loaded: the bolt went unseen, and is on its way
    if (!this.charging && charging && this.loadedAt >= 0) { this.loadedAt = -1; this.holdUntil = tick + flight }
    this.charging = charging
    if (shot && this.loadedAt >= 0) { this.loadedAt = -1; this.holdUntil = tick + flight }
    if (this.loadedAt >= 0 && tick - this.loadedAt > CROSSBOW_LOADED_TICKS) this.loadedAt = -1
    return this.loadedAt >= 0 || tick <= this.holdUntil
  }

  /** charged and not shot yet */
  get loaded (): boolean {
    return this.loadedAt >= 0
  }
}

/** Pillager.performRangedAttack's bolt (CrossbowItem.performShooting, an arrow) leaves this close to the mob */
const BOLT_SPAWN_DISTANCE = 2.5

/** how far off a crossbow mob's loaded crossbow is watched by fight() (Pillager's FOLLOW_RANGE 32 and then some less) */
const CROSSBOW_WATCH_DISTANCE = 24

function findItem (bot: Bot, name: string): Item | undefined {
  return bot.inventory.items().find(i => i.name === name) ?? (bot.inventory.slots[45]?.name === name ? bot.inventory.slots[45] ?? undefined : undefined)
}

/** Puts the shield in the off hand and raises it; false without a shield. */
export async function raiseShield (bot: Bot): Promise<boolean> {
  if (bot.inventory.slots[45]?.name !== 'shield') {
    const shield = findItem(bot, 'shield')
    if (shield == null) return false
    await bot.equip(shield, 'off-hand')
  }
  if ((bot as any).usingHeldItem !== true) bot.activateItem(true)
  return true
}

export function lowerShield (bot: Bot): void {
  if ((bot as any).usingHeldItem === true) bot.deactivateItem()
}

function lookAt (bot: Bot, point: Vec3): void {
  const dir = point.minus(eyePosition(bot))
  const { yaw, pitch } = yawPitchOf(dir)
  void bot.look(yaw, pitch, true)
}

/**
 * Melee until the target dies: the best weapon in hand, a swing each time the attack strength is full
 * (Player.getAttackStrengthScale), jump crits when it can, the shield up against a drawn bow or a creeper about to
 * blow. Returns once the target is dead or gone; throws noTarget if it's gone before the first hit, timeout or
 * noPath if it can't finish it.
 */
export async function fight (bot: Bot, target: Entity, opts: FightOptions = {}): Promise<FightResult> {
  const signal = opts.signal
  const reach = opts.reach ?? 2.9
  const crits = opts.crits !== false
  const useShield = opts.shield !== false
  const maxTicks = opts.maxTicks ?? 1200
  const maxDistance = opts.maxDistance ?? 32
  const swellDanger = opts.creeperSwellDanger ?? 18
  const creeperSafe = opts.creeperSafeDistance ?? 7.5
  const name = entityName(target)
  const isCreeper = name === 'creeper'
  if (!isAlive(bot, target)) throw new TaskError('NOT_FOUND', `${name} is gone`)

  if (opts.equipWeapon !== false) {
    const weapon = bestMeleeWeapon(bot, name)
    if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
  }
  const strength = attackStrengthOf(bot)
  const swell = new SwellCounter()
  const arrows = new ArrowGuard()
  // every crossbow mob about, the target or not (a patrol's others shoot while the bot closes in on one)
  const crossbows = new Map<number, CrossbowGuard>()
  const shotFrom = new Set<number>()
  const onSpawn = (e: Entity): void => {
    if (e.name !== 'arrow') return
    let best: Entity | null = null
    let bestD = BOLT_SPAWN_DISTANCE
    for (const m of Object.values(bot.entities)) {
      if (m === bot.entity || !isCrossbowMob(bot, m)) continue
      const d = m.position.offset(0, (m.height ?? 1.95) * 0.85, 0).distanceTo(e.position)
      if (d < bestD) { best = m; bestD = d }
    }
    if (best != null) shotFrom.add(best.id)
  }
  bot.on('entitySpawn', onSpawn)
  let hits = 0
  let ticks = 0
  let lastPosition = target.position.clone()
  let jumpedAt = -100
  let blocking = false
  let retreating = false
  let died = false
  const onDead = (e: Entity): void => { if (e.id === target.id) died = true }
  bot.on('entityDead', onDead)
  const hasShield = (): boolean => useShield && (bot.inventory.slots[45]?.name === 'shield' || findItem(bot, 'shield') != null)

  try {
    while (isAlive(bot, target)) {
      throwIfAborted(signal)
      if (ticks++ >= maxTicks) throw new TaskError('TIMEOUT', `${name} still alive after ${maxTicks} ticks`)
      if (opts.until?.() === true) break
      lastPosition = target.position.clone()
      const eye = eyePosition(bot)
      const box = entityBox(target)
      const distance = distanceToBox(eye, box)
      if (bot.entity.position.distanceTo(target.position) > maxDistance) throw new TaskError('NO_PATH', `${name} got away`)
      const center = target.position.offset(0, (target.height ?? 1.8) * (opts.aimHeight ?? 0.85), 0)

      // the crossbows about: the nearest loaded one in sight (CrossbowGuard)
      let loadedCrossbow: Entity | null = null
      let loadedDistance = Infinity
      for (const m of Object.values(bot.entities)) {
        if (m === bot.entity || !isCrossbowMob(bot, m)) continue
        const d = bot.entity.position.distanceTo(m.position)
        if (d > CROSSBOW_WATCH_DISTANCE || !isAlive(bot, m)) { crossbows.delete(m.id); continue }
        let guard = crossbows.get(m.id)
        if (guard == null) crossbows.set(m.id, guard = new CrossbowGuard())
        if (guard.update(isChargingCrossbow(bot, m), shotFrom.has(m.id), d, ticks) && d < loadedDistance && hasLineOfSight(bot, m)) {
          loadedCrossbow = m
          loadedDistance = d
        }
      }
      shotFrom.clear()

      // what to do about the shield this tick
      let wantBlock = false
      let wantRetreat = false
      // closing in under the shield on a crossbow mob that's loaded (the player's walk while using an item)
      let advance = false
      if (isCreeper) {
        const fuse = swell.update(creeperSwelling(bot, target))
        if (fuse >= swellDanger) {
          if (hasShield()) wantBlock = true
          else wantRetreat = bot.entity.position.distanceTo(target.position) < creeperSafe
        }
        // back off until it stops swelling (it stops past 7 blocks), then come back
        if (retreating && (fuse === 0 || bot.entity.position.distanceTo(target.position) >= creeperSafe)) retreating = false
        if (retreating && !hasShield()) wantRetreat = true
      } else if (loadedCrossbow != null && distance > reach && hasShield()) {
        wantBlock = true
        advance = loadedCrossbow.id === target.id
      } else if (RANGED.has(name) && !isCrossbowMob(bot, target) && arrows.update(isUsingItem(bot, target), distance, ticks) && distance > reach && hasShield()) {
        wantBlock = true
      } else if (name === 'blaze' && blazeCharged(bot, target) && distance > reach && hasShield()) {
        // its three small fireballs: the shield takes them (Player.isDamageSourceBlocked)
        wantBlock = true
      }

      if (wantBlock) {
        bot.clearControlStates()
        if (advance) steerToward(bot, target.position, { sprint: false, guard: true, maxDrop: opts.maxDrop })
        // (the shield blocks what comes from in front: Player's BlocksAttacks, faced to the loaded one)
        lookAt(bot, loadedCrossbow != null && !isCreeper ? loadedCrossbow.position.offset(0, (loadedCrossbow.height ?? 1.95) * 0.85, 0) : center)
        if (!blocking) blocking = await raiseShield(bot)
        await waitTicks(bot, 1, signal)
        continue
      }
      if (blocking) {
        lowerShield(bot)
        blocking = false
      }
      if (wantRetreat) {
        steerAway(bot, target.position)
        await waitTicks(bot, 1, signal)
        continue
      }

      if (distance > reach) {
        // close in, sprinting (a sprint hit knocks back further), but not over a deadly edge: a magma cube in a basalt
        // delta was chased into a lava pocket, a blaze off a ledge over the lava sea (26.3); it comes to the bot
        steerToward(bot, target.position, { sprint: true, guard: true, maxDrop: opts.maxDrop })
        lookAt(bot, center)
        await waitTicks(bot, 1, signal)
        continue
      }

      // in reach: hold position (step back if it's on top of us, unless that's over a deadly edge: a blaze hovering
      // over a 26.3 bot on a ledge walked it backwards off the end, into the lava sea) and time the swing
      bot.setControlState('forward', false)
      bot.setControlState('sneak', false)
      bot.setControlState('back', distance < 1 && !edgeAhead(bot, bot.entity.yaw + Math.PI, 1.2, opts.maxDrop ?? 3))
      lookAt(bot, center)
      const e = bot.entity as any
      // no crit jump off a stalagmite: each landing back on its tip impales (PointedDripstoneBlock.fallOn; a 26.3 bot
      // jumped at zombies from one 17 times, till it died)
      const canCrit = crits && !isCreeper && e.isInWater !== true && e.isInLava !== true && e.onClimbable !== true &&
        !onDripstone(p => bot.blockAt(p), bot.entity.position.floored())
      const airborne = ticks - jumpedAt <= 14 && !bot.entity.onGround
      const falling = !bot.entity.onGround && bot.entity.velocity.y < 0
      const jumpNow = canCrit && bot.entity.onGround && !airborne && strength.ticksToFull() <= 5
      if (jumpNow) {
        // jump so the fall comes when the swing is charged (a jump peaks after about 6 ticks)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', true)
        jumpedAt = ticks
      } else {
        bot.setControlState('jump', false)
      }
      if (!jumpNow && strength.scale(0.5) >= 1 && (!canCrit || falling || !airborne)) {
        if (strength.attack(target)) {
          hits++
          if (isCreeper) retreating = true
        }
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    bot.off('entityDead', onDead)
    bot.off('entitySpawn', onSpawn)
    if (blocking) lowerShield(bot)
    bot.clearControlStates()
  }
  return { killed: died || metadataValue(bot, target, 'health') === 0, hits, ticks, lastPosition }
}
