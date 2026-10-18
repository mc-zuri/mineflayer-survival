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

/** Turns toward the point and walks (sprinting unless told not), jumping over steps and swimming up in water. */
export function steerToward (bot: Bot, point: Vec3, opts: { sprint?: boolean, lookPitch?: number } = {}): void {
  const pos = bot.entity.position
  const yaw = Math.atan2(-(point.x - pos.x), -(point.z - pos.z))
  void bot.look(yaw, opts.lookPitch ?? 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('sprint', opts.sprint !== false)
  const e = bot.entity as any
  bot.setControlState('jump', (e.isCollidedHorizontally === true && bot.entity.onGround) || e.isInWater === true || e.isInLava === true)
}

/** The heading (mineflayer yaw) that leads furthest from the threat over safe ground, or null if every way is shut. */
export function fleeHeading (bot: Bot, threat: Vec3, samples = 16): number | null {
  const pos = bot.entity.position
  const away = new Vec3(pos.x - threat.x, 0, pos.z - threat.z)
  const len = Math.hypot(away.x, away.z)
  const ax = len > 1e-6 ? away.x / len : 1
  const az = len > 1e-6 ? away.z / len : 0
  let best: number | null = null
  let bestScore = -Infinity
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2
    const dx = -Math.sin(angle)
    const dz = -Math.cos(angle)
    let cost = 0
    for (let step = 1; step <= 3 && cost !== Infinity; step++) cost += stepCost(bot, pos.offset(dx * step, 0, dz * step))
    if (cost === Infinity) continue
    const score = (dx * ax + dz * az) * 3 - cost
    if (score > bestScore) {
      bestScore = score
      best = angle
    }
  }
  return best
}

/** Runs from the threat this tick; false when there's no safe way. */
export function steerAway (bot: Bot, threat: Vec3): boolean {
  const heading = fleeHeading(bot, threat)
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
