// pillarRefuge: the hostiles reflex's retreat from melee mobs about the bot on an open floor (a cave's, where no box of
// SEAL_MAX_BLOCKS shuts it in): PILLAR_HEIGHT blocks up where it stands (towerUp, the player's pillar jump), out of their reach,
// healed there and hitting them from the top. A mob's swing lands only where its attack box meets the target's
// (Mob.isWithinMeleeAttackRange: its bounding box inflated by DEFAULT_ATTACK_REACH across, not up), and a zombie's box
// is 1.95 high: feet three blocks up are over it and over its jump, while the sword's reach (Player's 3) still finds
// its head.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { type Entity, eyePosition, isAlive, yawPitchOf, distanceToBox, entityBox, throwIfAborted } from './combatUtil'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
import { bestFoodInInventory, eat } from './eat'
import { countItems, waitTicks } from './util'
import { isAbort } from './errors'

/**
 * blocks up: a zombie's box is 1.95 high, but one by the pillar jumps at the bot (its MoveControl after a target over
 * it, 1.25 up), and two up its hits landed and their knockback put the bot off its 1 by 1 top
 * (tests/integration/zombieFloor); three up a fall off is no damage (LivingEntity.causeFallDamage: over 3)
 */
export const PILLAR_HEIGHT = 3
/** tries at the pillar (towerUp) before it's given up */
export const PILLAR_TRIES = 3
/** ticks held on the pillar at most */
export const PILLAR_HOLD_TICKS = 1200
/** the health it heals to on the pillar before it lets the work go on */
export const PILLAR_HEAL_TO = 18
/** the mobs that climb (Spider's climbing) or fly: a pillar is no refuge from them */
export const PILLAR_CLIMBERS = new Set(['spider', 'cave_spider', 'phantom', 'vex', 'blaze', 'ghast', 'bee'])
/** the blocks a pillar is made of (the pathfinder's scaffolding, towerUp's) */
export const PILLAR_BLOCKS = ['dirt', 'coarse_dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'basalt', 'end_stone', 'cobbled_deepslate', 'cobblestone', 'blackstone', 'deepslate', 'stone', 'stone_bricks', 'sandstone']

function solid (bot: Bot, p: Vec3): boolean {
  return bot.blockAt(p)?.boundingBox === 'block'
}

function open (bot: Bot, p: Vec3): boolean {
  const b = bot.blockAt(p)
  return b != null && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava'
}

/**
 * Whether a pillar goes up where the bot stands: on its feet on a full block, out of the water and the lava, the cells
 * over its head open to the pillar's top (feet + 2 to feet + PILLAR_HEIGHT + 1), and PILLAR_HEIGHT blocks carried
 */
export function pillarFits (bot: Bot): boolean {
  const e = bot.entity as any
  if (e?.onGround !== true || e.isInWater === true || e.isInLava === true) return false
  const feet = bot.entity.position.floored()
  if (!solid(bot, feet.offset(0, -1, 0))) return false
  for (let dy = 0; dy <= PILLAR_HEIGHT + 1; dy++) if (!open(bot, feet.offset(0, dy, 0))) return false
  return countItems(bot, PILLAR_BLOCKS) >= PILLAR_HEIGHT
}

export interface PillarRefugeResult {
  /** the pillar's top (the bot's feet there) */
  top: Vec3
  ticks: number
  hits: number
  health: number
}

/**
 * Up PILLAR_HEIGHT blocks where the bot stands (towerUp), then held there: the nearest of `threats` in the sword's
 * reach hit as the swing charges, a meal when none is, till the health is back to PILLAR_HEAL_TO with none in reach,
 * none is left within 8, PILLAR_HOLD_TICKS go by, or the bot is off the top. Left on the pillar: the work's next walk
 * steps down off it.
 */
export async function pillarRefuge (bot: Bot, threats: () => Entity[], opts: { signal?: AbortSignal, maxTicks?: number } = {}): Promise<PillarRefugeResult> {
  const signal = opts.signal
  const { towerUp } = await import('../end/skills/world')
  const base = Math.floor(bot.entity.position.y + 1e-6)
  // (a hit's knockback mid-jump puts the bot off its block: 'nothing to build on', up again from where it came down)
  for (let tries = 1; ; tries++) {
    try {
      await towerUp(bot, base + PILLAR_HEIGHT, { signal })
      break
    } catch (err) {
      if (isAbort(err) || tries >= PILLAR_TRIES || bot.health <= 0) throw err
      for (let t = 0; t < 20 && !bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
      if (!pillarFits(bot) && Math.floor(bot.entity.position.y + 1e-6) <= base) throw err
    }
  }
  const top = bot.entity.position.floored()
  const strength = attackStrengthOf(bot)
  const weapon = bestMeleeWeapon(bot)
  if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
  let hits = 0
  let ticks = 0
  const maxTicks = opts.maxTicks ?? PILLAR_HOLD_TICKS
  for (; ticks < maxTicks; ticks++) {
    throwIfAborted(signal)
    if (bot.health <= 0 || bot.entity.position.y < top.y - 0.5) break
    const mobs = threats().filter(e => isAlive(bot, e)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    const near = mobs.filter(e => e.position.distanceTo(bot.entity.position) <= 8)
    const reach = near.find(e => distanceToBox(eyePosition(bot), entityBox(e)) <= 2.9)
    if (near.length === 0 && bot.health >= PILLAR_HEAL_TO) break
    if (reach != null) {
      const { yaw, pitch } = yawPitchOf(reach.position.offset(0, (reach.height ?? 1.95) * 0.8, 0).minus(eyePosition(bot)))
      await bot.look(yaw, pitch, true)
      if (strength.scale(0.5) >= 1 && strength.attack(reach)) hits++
    } else if (near.length === 0 || bot.food < 20) {
      if (bot.food < 20 && bestFoodInInventory(bot) != null) {
        try { await eat(bot, { signal }) } catch (err) { if (isAbort(err)) throw err }
        if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand').catch(() => {})
        continue
      }
      if (near.length === 0) break
    }
    await waitTicks(bot, 1, signal)
  }
  return { top, ticks, hits, health: bot.health }
}

/** the melee mobs `near` hold the bot with: no climber among them (a spider would come up after it) */
export function pillarRefugeFrom (near: readonly { name?: string }[]): boolean {
  return near.length > 0 && near.every(e => !PILLAR_CLIMBERS.has(e.name ?? ''))
}

