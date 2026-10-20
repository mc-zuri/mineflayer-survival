import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

// Tick-by-tick steering for combat and escapes: one look and a set of keys a tick, no path search (too slow for a
// creeper's 30-tick fuse). The pathfinder is for getting somewhere; this is for getting away or getting close.

const DANGER_BLOCKS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose', 'pointed_dripstone'])

export function isDangerBlock (name: string | undefined): boolean {
  return name != null && DANGER_BLOCKS.has(name)
}

function blockName (bot: Bot, pos: Vec3): string | undefined {
  return bot.blockAt(pos)?.name
}

function isSolid (bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos)
  return b != null && b.boundingBox === 'block'
}

function isPassable (bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos)
  return b == null || (b.boundingBox === 'empty' && !isDangerBlock(b.name))
}

/** How safe a step onto the column at pos is: 0 is fine, more is worse, Infinity is never (lava, a wall, a deep drop). */
export function stepCost (bot: Bot, feet: Vec3): number {
  const f = feet.floored()
  if (isDangerBlock(blockName(bot, f)) || isDangerBlock(blockName(bot, f.offset(0, 1, 0)))) return Infinity
  if (!isPassable(bot, f)) {
    // a step up (a jump) when the two blocks over it are free, else a wall
    return isPassable(bot, f.offset(0, 1, 0)) && isPassable(bot, f.offset(0, 2, 0)) ? 1 : Infinity
  }
  if (!isPassable(bot, f.offset(0, 1, 0))) return Infinity
  for (let d = 1; d <= 4; d++) {
    const below = f.offset(0, -d, 0)
    const name = blockName(bot, below)
    if (name === 'water') return 0.5
    if (isDangerBlock(name)) return Infinity
    if (isSolid(bot, below)) return d <= 3 ? (d - 1) * 0.5 : Infinity
  }
  return Infinity
}

/**
 * Whether a step into the column at `feet` is one to die of: lava, fire or another danger block at the feet or the
 * head, or a fall into one, or of more than `maxDrop` blocks (default 3: LivingEntity.causeFallDamage) with no water
 * under. A wall or a step up is none (walking into it does no harm).
 */
export function deadlyStep (bot: Bot, feet: Vec3, maxDrop = 3): boolean {
  const f = feet.floored()
  if (isDangerBlock(blockName(bot, f)) || isDangerBlock(blockName(bot, f.offset(0, 1, 0)))) return true
  if (isSolid(bot, f)) return false
  for (let d = 1; d <= maxDrop + 1; d++) {
    const below = f.offset(0, -d, 0)
    const name = blockName(bot, below)
    if (name === 'water') return false
    if (isDangerBlock(name)) return true
    if (isSolid(bot, below)) return false
  }
  return true
}

/**
 * Whether walking on along `yaw` (mineflayer's: the look's direction is -sin, -cos) steps into a deadly column
 * (deadlyStep) within `reach` blocks of the bot's middle, at its feet's height: the edge of a ledge over the lava sea,
 * a basalt delta's lava pocket. Checked from the near side of the bot's box on (its half width, 0.3).
 */
export function edgeAhead (bot: Bot, yaw: number, reach = 1.2, maxDrop = 3): boolean {
  const pos = bot.entity.position
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  for (const k of [0.45, 0.8, reach]) {
    if (k > reach) continue
    if (deadlyStep(bot, new Vec3(pos.x + dx * k, pos.y + 0.01, pos.z + dz * k), maxDrop)) return true
  }
  return false
}

export interface SteerOptions {
  sprint?: boolean
  lookPitch?: number
  /**
   * stop short of a deadly edge ahead (edgeAhead), sneaking for the tick so the speed already had doesn't carry the bot
   * over (Player.maybeBackOffFromEdge): for a fight or a chase that only wants to get near, not for an escape through
   * lava (default false)
   */
  guard?: boolean
  /**
   * with `guard`, the most blocks a step down may drop (default 3, a fall that does no harm): less keeps a chase on its
   * own level
   */
  maxDrop?: number
}

/**
 * Turns toward the point and walks (sprinting unless told not), jumping over steps and swimming up in water; with
 * `guard`, stops at a deadly edge instead. Returns whether it walked on.
 */
export function steerToward (bot: Bot, point: Vec3, opts: SteerOptions = {}): boolean {
  const pos = bot.entity.position
  const yaw = Math.atan2(-(point.x - pos.x), -(point.z - pos.z))
  void bot.look(yaw, opts.lookPitch ?? 0, true)
  if (opts.guard === true && edgeAhead(bot, yaw, 1.2, opts.maxDrop ?? 3)) {
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    bot.setControlState('sneak', true)
    return false
  }
  if (opts.guard === true) bot.setControlState('sneak', false)
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('sprint', opts.sprint !== false)
  const e = bot.entity as any
  bot.setControlState('jump', (e.isCollidedHorizontally === true && bot.entity.onGround) || e.isInWater === true || e.isInLava === true)
  return true
}

/** the most a flee's heading may turn toward the threat (the cosine to the way straight away from it): across, not at */
export const FLEE_TOWARD = -0.25

/** a flee's lean toward a place to run to (fleeHeading's `toward`): its weight against the way straight away's 3 */
export const FLEE_LEAN = 2

/**
 * The heading (mineflayer yaw) that leads furthest from the threat over safe ground, or null if every way is shut;
 * with `toward` (the base, a lit place), the ways nearer it are the better by FLEE_LEAN, still never back at the threat
 */
export function fleeHeading (bot: Bot, threat: Vec3, samples = 16, toward?: Vec3): number | null {
  const pos = bot.entity.position
  const away = new Vec3(pos.x - threat.x, 0, pos.z - threat.z)
  const len = Math.hypot(away.x, away.z)
  const ax = len > 1e-6 ? away.x / len : 1
  const az = len > 1e-6 ? away.z / len : 0
  const tlen = toward == null ? 0 : Math.hypot(toward.x - pos.x, toward.z - pos.z)
  const tx = toward != null && tlen > 1e-6 ? (toward.x - pos.x) / tlen : 0
  const tz = toward != null && tlen > 1e-6 ? (toward.z - pos.z) / tlen : 0
  let best: number | null = null
  let bestScore = -Infinity
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2
    const dx = -Math.sin(angle)
    const dz = -Math.cos(angle)
    // never at the threat: in a tunnel shut behind it, the one open way led a 26.3 bot fleeing a creeper toward it,
    // into its blast (nether-26.3-q3); none open but that way is no way (cornered)
    if (dx * ax + dz * az < FLEE_TOWARD) continue
    let cost = 0
    for (let step = 1; step <= 3 && cost !== Infinity; step++) cost += stepCost(bot, pos.offset(dx * step, 0, dz * step))
    if (cost === Infinity) continue
    const score = (dx * ax + dz * az) * 3 + (dx * tx + dz * tz) * FLEE_LEAN - cost
    if (score > bestScore) {
      bestScore = score
      best = angle
    }
  }
  return best
}

/** Runs from the threat this tick (leaning toward `toward`, when given: fleeHeading); false when there's no safe way. */
export function steerAway (bot: Bot, threat: Vec3, toward?: Vec3): boolean {
  const heading = fleeHeading(bot, threat, 16, toward)
  if (heading == null) {
    bot.clearControlStates()
    return false
  }
  void bot.look(heading, 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('sprint', true)
  const e = bot.entity as any
  bot.setControlState('jump', (e.isCollidedHorizontally === true && bot.entity.onGround) || e.isInWater === true || e.isInLava === true)
  return true
}
