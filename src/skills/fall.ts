// A fall broken with a water bucket (the "MLG"): water poured on the landing block just before the bot meets it, the
// fall's damage gone (LivingEntity.causeFallDamage: none landing in water), and the water scooped back up. A player
// takes fall damage past 3 blocks (a point a block more); a dragon's hit off a crystal's pillar dropped a bot 16
// blocks onto the End's island (26.3).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { throwIfAborted } from './errors'
import { eyeHeight, findInventoryItem, trace, waitTicks, waitUntil } from './util'

/** blocks fallen past which a fall is broken with water (one of 5 does 2 hearts) */
export const FALL_BREAK_BLOCKS = 5

/**
 * how far below the bot a landing is looked for: a fall is taken in hand as soon as it is under way, whatever its
 * height (the bucket in the hand and the look first, the pour once the landing is in reach, POUR_ABOVE). The reflex
 * took a fall only 3.5 blocks over its landing and poured at once, out of the bucket's reach: a 26.3 bot at 2 health
 * fell 5 blocks with a water bucket in the bag and died (full-26.3-s31337-f, t156255); a bot that ran off a 31-block
 * cliff had it fire 2.5 blocks over the landing, too late to pour (full-26.3-fresh-o, t279814)
 */
export const LANDING_DEPTH = 64

/** a fall's speed (blocks a tick, down) from which it is a fall, not a step down (a walk off a ledge's 4th tick) */
export const FALLING_VY = -0.3

/**
 * how far under the eyes the landing's top may be for the pour: BucketItem.use's ray (Player.blockInteractionRange,
 * 4.5) from where the server has the bot, less a margin for the tick's move
 */
export const POUR_ABOVE = 4.4

/** the feet height of the first block with a collision box under the bot within `depth`, else null */
export function landingY (blockAt: (pos: Vec3) => { boundingBox: string, name: string } | null, pos: Vec3, depth = 40): number | null {
  const x = Math.floor(pos.x)
  const z = Math.floor(pos.z)
  for (let y = Math.floor(pos.y); y >= Math.floor(pos.y) - depth; y--) {
    const b = blockAt(new Vec3(x, y, z))
    if (b == null) return null
    if (b.name === 'water' || b.name === 'bubble_column') return null
    if (b.boundingBox === 'block') return y + 1
  }
  return null
}

/** LivingEntity.travel in the air for a player with no keys held: gravity 0.08, the speed kept 0.98 down and 0.91 across */
export const GRAVITY = 0.08
export const AIR_DRAG_Y = 0.98
export const AIR_DRAG_XZ = 0.91

/** where a fall comes down: the feet's height on the landing, and the point (x, z) it lands at */
export interface Landing {
  y: number
  x: number
  z: number
}

/**
 * Where the fall under way lands (LivingEntity.travel's air motion from the velocity it has, a tick at a time): the
 * first block top with a collision box the feet come down to in the column they are over, or null when that is water
 * (no damage) or none within LANDING_DEPTH or `maxTicks`
 */
export function predictLanding (blockAt: (pos: Vec3) => { boundingBox: string, name: string } | null, pos: Vec3, velocity: Vec3, maxTicks = 80): Landing | null {
  let x = pos.x
  let y = pos.y
  let z = pos.z
  let vx = velocity.x
  let vy = velocity.y
  let vz = velocity.z
  const bottom = pos.y - LANDING_DEPTH
  for (let t = 0; t < maxTicks && y > bottom; t++) {
    const top = landingY(blockAt, new Vec3(x, y, z), Math.ceil(y - bottom))
    if (top == null) {
      // water under the feet (or nothing loaded, or none that deep)
      const b = blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
      if (b == null || b.name === 'water' || b.name === 'bubble_column') return null
    }
    if (top != null && y + vy <= top) return { y: top, x, z }
    x += vx
    y += vy
    z += vz
    vy = (vy - GRAVITY) * AIR_DRAG_Y
    vx *= AIR_DRAG_XZ
    vz *= AIR_DRAG_XZ
  }
  return null
}

/** a water source block (level 0), not the flow the poured water makes */
function isSource (block: any): boolean {
  return Number(block?.getProperties?.().level ?? 0) === 0
}

/** LivingEntity.calculateFallDamage: the fall past the safe 3 blocks, rounded up */
export function fallDamage (blocks: number): number {
  return Math.max(0, Math.ceil(blocks - 3))
}

/**
 * Whether a fall is to be broken: falling (velocity under FALLING_VY), FALL_BREAK_BLOCKS or more from where it began
 * to its landing, or a fall whose damage would kill at the health there is (2.2 health: a fall of 5 blocks), the
 * landing over half a block below, a water bucket held, out of the nether (water boils away there,
 * DimensionType.ultraWarm). Taken as soon as the fall is under way: the bucket's equip and the look have the fall's
 * ticks.
 */
export function shouldBreakFall (state: { y: number, vy: number, onGround: boolean, fallStart: number, landing: number | null, hasBucket: boolean, nether: boolean, health?: number }): boolean {
  if (state.onGround || state.vy > FALLING_VY || !state.hasBucket || state.nether || state.landing == null) return false
  const fall = state.fallStart - state.landing
  const deadly = state.health != null && fallDamage(fall) >= state.health
  if (fall < FALL_BREAK_BLOCKS && !deadly) return false
  return state.y - state.landing > 0.5
}

/**
 * The tick to pour on: the landing's top within POUR_ABOVE under the eyes, the bucket held, none poured in the last
 * two ticks (the server's slot update takes a tick: a second use on its empty bucket takes the water back up)
 */
export function pourNow (eyeY: number, landing: number, holdsWater: boolean, ticksSincePour: number): boolean {
  return holdsWater && eyeY - landing <= POUR_ABOVE && ticksSincePour > 2
}

/** the look (mineflayer's yaw and pitch) from the eyes at a point */
function lookAtPoint (from: Vec3, to: Vec3): { yaw: number, pitch: number } {
  const d = to.minus(from)
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }
}

/**
 * Pours the water bucket on the landing (predictLanding: where the fall comes down, its drift across counted) once it
 * is in reach (pourNow), the bucket in the hand and the look at the landing's top before, each tick of the fall till
 * then; waits to land, and takes the water back up
 */
export async function breakFall (bot: Bot, landing: number, signal?: AbortSignal): Promise<boolean> {
  const bucket = findInventoryItem(bot, 'water_bucket')
  if (bucket == null) return false
  if (bot.heldItem?.name !== 'water_bucket') await bot.equip(bucket, 'hand')
  const lookup = (p: Vec3): any => bot.blockAt(p)
  let target: Landing = predictLanding(lookup, bot.entity.position, bot.entity.velocity) ?? { y: landing, x: bot.entity.position.x, z: bot.entity.position.z }
  const aim = (): void => {
    const eye = bot.entity.position.offset(0, eyeHeight(bot), 0)
    const at = lookAtPoint(eye, new Vec3(Math.floor(target.x) + 0.5, target.y, Math.floor(target.z) + 0.5))
    void bot.look(at.yaw, at.pitch, true)
  }
  aim()
  let sincePour = Infinity
  let poured = false
  const landed = (): boolean => bot.entity.onGround || (bot.entity as any).isInWater === true || bot.blockAt(bot.entity.position.floored())?.name === 'water'
  const step = (): boolean => {
    if (landed()) return true
    sincePour++
    target = predictLanding(lookup, bot.entity.position, bot.entity.velocity) ?? target
    aim()
    if (pourNow(bot.entity.position.y + eyeHeight(bot), target.y, bot.heldItem?.name === 'water_bucket', sincePour)) {
      bot.activateItem()
      trace('fall: water poured at', bot.entity.position.y.toFixed(2), 'over the landing at', target.y)
      sincePour = 0
      poured = true
    }
    return false
  }
  if (!step()) await waitUntil(bot, step, 120, signal)
  throwIfAborted(signal)
  await waitTicks(bot, 2, signal)
  const cell = new Vec3(Math.floor(target.x), target.y, Math.floor(target.z))
  // the water back into the bucket: where it was poured (the landing's cell; the one over it when the ray met a thin
  // block in the landing's cell, a snow layer's outline, and BucketItem.use put the water on its face; the one under
  // when the landing was taken over such a block), or where the bot floats in it
  const feet = bot.entity.position.floored()
  const water = [cell, cell.offset(0, 1, 0), cell.offset(0, -1, 0), feet, feet.offset(0, 1, 0), feet.offset(0, -1, 0)].find(p => bot.blockAt(p)?.name === 'water' && isSource(bot.blockAt(p)))
  trace('fall: landed at', bot.entity.position.toString(), 'the water', water?.toString() ?? 'not found', 'held', bot.heldItem?.name ?? 'nothing')
  if (water != null) {
    const empty = findInventoryItem(bot, 'bucket')
    if (empty != null) {
      if (bot.heldItem?.name !== 'bucket') await bot.equip(empty, 'hand')
      await bot.lookAt(water.offset(0.5, 0.5, 0.5), true)
      bot.activateItem()
      await waitTicks(bot, 2, signal)
    }
  }
  return poured
}
