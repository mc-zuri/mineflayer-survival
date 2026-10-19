// crossToIsland: from the obsidian platform the End puts an arrival on (ServerLevel's END_SPAWN_POINT, 100 blocks out
// on +x, EndPlatformFeature) over the void to the main island, a sneaking bridge with rails (bridgeOverLava, the
// safe bridge) toward 0, 0, digging through the island's edge where the bridge runs into it.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError, throwIfAborted, type SkillOptions } from '../../skills/combatUtil'
import { bridgeOverLava } from '../../nether/safety'
import { trace, waitTicks } from '../../skills/util'
import { blockGetter, holdOneOf, isOpenAt, isSolidAt, isVoidColumn, PICKAXES, type BlockGetter } from './world'

/** the step toward the island from where the bot stands */
export type IslandStep = 'walk' | 'dig' | 'bridge'

/** cells of island ground in a row ahead the crossing is over at */
export const ISLAND_GROUND_AHEAD = 3

/** the cardinal direction toward 0, 0 from a point (the platform is out along an axis) */
export function towardCenter (pos: { x: number, z: number }): Vec3 {
  return Math.abs(pos.x) >= Math.abs(pos.z) ? new Vec3(-Math.sign(pos.x) || -1, 0, 0) : new Vec3(0, 0, -Math.sign(pos.z) || -1)
}

/**
 * Whether the bot is out in the void off the main island: the way toward 0, 0 meets a void column within 6 blocks
 * (the arrival platform's edge)
 */
export function offTheIsland (get: BlockGetter, feet: Vec3): boolean {
  const dir = towardCenter(feet)
  for (let i = 1; i <= 6; i++) {
    const p = feet.plus(dir.scaled(i))
    if (isVoidColumn(get, p.x, p.z, feet.y - 1)) return true
  }
  return false
}

/**
 * The next step toward the island: the cell ahead walkable (ground under it, the body's room free) is walked onto,
 * one with a block in the body's way (the island's side) is dug, one over the void is bridged
 */
export function islandStep (get: BlockGetter, feet: Vec3, dir: Vec3): IslandStep {
  const next = feet.plus(dir)
  if (isSolidAt(get, next) || isSolidAt(get, next.offset(0, 1, 0))) return 'dig'
  if (isSolidAt(get, next.offset(0, -1, 0)) && isOpenAt(get, next) && isOpenAt(get, next.offset(0, 1, 0))) return 'walk'
  return 'bridge'
}

/**
 * Over to the main island from the arrival platform (a no-op on the island): straight toward 0, 0, bridging the void
 * with rails, sneaking, and digging through the island's edge, until there is ground ahead for ISLAND_GROUND_AHEAD
 * cells. The dragon fight walked straight off the platform for the podium and the bot fell out of the world (26.3).
 */
export async function crossToIsland (bot: Bot, opts: SkillOptions & { maxSteps?: number } = {}): Promise<{ steps: number, bridged: number }> {
  const signal = opts.signal
  const get = blockGetter(bot)
  let steps = 0
  let bridged = 0
  if (!offTheIsland(get, bot.entity.position.floored())) return { steps, bridged }
  const dir = towardCenter(bot.entity.position)
  trace('crossToIsland: from', bot.entity.position.toString(), 'along', dir.toString())
  let ground = 0
  try {
    for (; steps < (opts.maxSteps ?? 200) && ground < ISLAND_GROUND_AHEAD; steps++) {
      throwIfAborted(signal)
      const feet = bot.entity.position.floored()
      const step = islandStep(get, feet, dir)
      if (step === 'dig') {
        for (const p of [feet.plus(dir).offset(0, 1, 0), feet.plus(dir)]) {
          const b = bot.blockAt(p)
          if (b == null || b.boundingBox !== 'block') continue
          await holdOneOf(bot, PICKAXES)
          await bot.dig(b, true)
        }
        continue
      }
      if (step === 'bridge') {
        ground = 0
        bridged += (await bridgeOverLava(bot, { direction: dir, length: 1 }, signal)).placed
        continue
      }
      // a sneaking step onto the ground ahead
      const target = feet.plus(dir).offset(0.5, 0, 0.5)
      bot.setControlState('sneak', true)
      for (let t = 0; t < 40 && Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) > 0.35; t++) {
        await bot.lookAt(target.offset(0, 1.6, 0), true)
        bot.setControlState('forward', true)
        await waitTicks(bot, 1, signal)
      }
      bot.setControlState('forward', false)
      if (isSolidAt(get, bot.entity.position.floored().offset(0, -1, 0)) && !isVoidColumn(get, target.x, target.z, feet.y - 1)) ground++
    }
  } finally {
    bot.clearControlStates()
  }
  if (ground < ISLAND_GROUND_AHEAD) throw new TaskError('NO_PATH', `no way over to the island after ${steps} steps (${bridged} blocks placed)`)
  trace('crossToIsland: on the island at', bot.entity.position.toString(), 'after', steps, 'steps,', bridged, 'blocks placed')
  return { steps, bridged }
}
