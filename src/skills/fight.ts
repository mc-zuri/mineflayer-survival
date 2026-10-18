import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
import { steerAway, steerToward } from './steer'
import { type Entity, metadataIndex, metadataValue, distanceToBox, entityBox, entityName, eyePosition, isAlive, TaskError, type SkillOptions, throwIfAborted, waitTicks, yawPitchOf } from './combatUtil'

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
}

export interface FightResult {
  /** it died (EntityEvent.DEATH); false when it left otherwise (a creeper that blew up, a mob that despawned) */
  killed: boolean
  hits: number
  ticks: number
  /** where the target was last seen (its drops land there) */
  lastPosition: Vec3
}

// LivingEntity.DATA_LIVING_ENTITY_FLAGS (index 8 on 1.21.11): bit 1 is "using an item" (a skeleton drawing its bow)
const LIVING_FLAGS_INDEX = 8
// Creeper.DATA_SWELL_DIR (index 16 on 1.21.11): 1 swelling, -1 not
export const CREEPER_SWELL_DIR_INDEX = 16
// Creeper.DATA_IS_IGNITED (index 18): lit by flint and steel, it swells whatever the distance
export const CREEPER_IGNITED_INDEX = 18
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'piglin', 'drowned', 'parched'])

export function isUsingItem (bot: Bot, entity: Entity): boolean {
  const flags = (entity.metadata as any)?.[metadataIndex(bot, entityName(entity), 'living_entity_flags', LIVING_FLAGS_INDEX)]
  return typeof flags === 'number' && (flags & 1) !== 0
}

// Blaze.DATA_FLAGS_ID (index 16 on 1.21.11): bit 1 is set while it's charged, about to shoot (Blaze.setCharged)
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
      lastPosition = target.position.clone()
      const eye = eyePosition(bot)
      const box = entityBox(target)
      const distance = distanceToBox(eye, box)
      if (bot.entity.position.distanceTo(target.position) > maxDistance) throw new TaskError('NO_PATH', `${name} got away`)
      const center = target.position.offset(0, (target.height ?? 1.8) * (opts.aimHeight ?? 0.85), 0)

      // what to do about the shield this tick
      let wantBlock = false
      let wantRetreat = false
      if (isCreeper) {
        const fuse = swell.update(creeperSwelling(bot, target))
        if (fuse >= swellDanger) {
          if (hasShield()) wantBlock = true
          else wantRetreat = bot.entity.position.distanceTo(target.position) < creeperSafe
        }
        // back off until it stops swelling (it stops past 7 blocks), then come back
        if (retreating && (fuse === 0 || bot.entity.position.distanceTo(target.position) >= creeperSafe)) retreating = false
        if (retreating && !hasShield()) wantRetreat = true
      } else if (RANGED.has(name) && isUsingItem(bot, target) && distance > reach && hasShield()) {
        wantBlock = true
      } else if (name === 'blaze' && blazeCharged(bot, target) && distance > reach && hasShield()) {
        // its three small fireballs: the shield takes them (Player.isDamageSourceBlocked)
        wantBlock = true
      }

      if (wantBlock) {
        bot.clearControlStates()
        lookAt(bot, center)
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
        // close in, sprinting (a sprint hit knocks back further)
        steerToward(bot, target.position, { sprint: true })
        lookAt(bot, center)
        await waitTicks(bot, 1, signal)
        continue
      }

      // in reach: hold position (step back if it's on top of us) and time the swing
      bot.setControlState('forward', false)
      bot.setControlState('back', distance < 1)
      lookAt(bot, center)
      const e = bot.entity as any
      const canCrit = crits && !isCreeper && e.isInWater !== true && e.isInLava !== true && e.onClimbable !== true
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
        strength.attack(target)
        hits++
        if (isCreeper) retreating = true
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    bot.off('entityDead', onDead)
    if (blocking) lowerShield(bot)
    bot.clearControlStates()
  }
  return { killed: died || metadataValue(bot, target, 'health') === 0, hits, ticks, lastPosition }
}
