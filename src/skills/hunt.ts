import type { Bot } from 'mineflayer'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import { fight, type FightOptions } from './fight'
import { steerToward } from './steer'
import { navigate } from './navigate'
import { isAbort } from './errors'
import { type Entity, isAlive, metadataValue, TaskError, type SkillOptions, waitTicks } from './combatUtil'

export interface HuntOptions extends FightOptions {
  /** how far to look for the animal (default 64) */
  range?: number
  /** walk with the pathfinder when the target is further than this (default 12) */
  pathDistance?: number
  /** pick up what it drops (default true) */
  collectDrops?: boolean
}

export interface HuntResult {
  killed: boolean
  /** item name to count picked up */
  drops: Record<string, number>
}

function inventoryCounts (bot: Bot): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  return counts
}

/**
 * Walks near the position with the pathfinder; resolves false if there's no path or the bot stops getting anywhere
 * (navigate's stuck check: a bare goto can go on forever where the pathfinder keeps failing to make a move).
 */
async function walkNear (bot: Bot, pos: Vec3, distance: number, signal?: AbortSignal): Promise<boolean> {
  if (bot.pathfinder == null) return false
  try {
    await navigate(bot, { goal: goals.GoalNear.fromVec(pos.floored(), distance), stuckTicks: 100 }, signal)
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    return false
  }
}

/** Walks over the item entities within radius of the position until they're picked up (ItemEntity.playerTouch). */
export async function collectDropsNear (bot: Bot, center: Vec3, opts: SkillOptions & { radius?: number, maxTicks?: number } = {}): Promise<Record<string, number>> {
  const radius = opts.radius ?? 4
  const maxTicks = opts.maxTicks ?? 200
  const before = inventoryCounts(bot)
  // the drops spawn on death (LivingEntity.dropAllDeathLoot); give them a few ticks to arrive
  await waitTicks(bot, 5, opts.signal)
  for (let t = 0; t < maxTicks; t++) {
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(center) <= radius)
    if (drops.length === 0) break
    drops.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    const next = drops[0]
    if (next.position.distanceTo(bot.entity.position) > 6) {
      bot.clearControlStates()
      if (!await walkNear(bot, next.position, 1, opts.signal)) break
    } else {
      steerToward(bot, next.position, { sprint: false })
      await waitTicks(bot, 1, opts.signal)
    }
  }
  bot.clearControlStates()
  const after = inventoryCounts(bot)
  const gained: Record<string, number> = {}
  for (const [name, n] of after) if (n > (before.get(name) ?? 0)) gained[name] = n - (before.get(name) ?? 0)
  return gained
}

export function nearestOfType (bot: Bot, names: string[], range: number, exclude?: (e: Entity) => boolean): Entity | null {
  let best: Entity | null = null
  let bestDistance = range
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || e.name == null || !names.includes(e.name) || exclude?.(e) === true) continue
    // babies drop nothing (AgeableMob.DATA_BABY_ID; Mob.shouldDropLoot)
    if (metadataValue(bot, e, 'baby') === true) continue
    // one just killed lies there for its death animation (LivingEntity.tickDeath: 20 ticks at health 0), and the
    // client may keep one it no longer hears of: fight gives up on those at once
    if (!isAlive(bot, e)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d < bestDistance) {
      best = e
      bestDistance = d
    }
  }
  return best
}

/** Kills the nearest animal of the kind (or the entity given) and picks up its drops. */
export async function hunt (bot: Bot, animal: string | string[] | Entity, opts: HuntOptions = {}): Promise<HuntResult> {
  const signal = opts.signal
  const target = typeof animal === 'object' && !Array.isArray(animal)
    ? animal
    : nearestOfType(bot, Array.isArray(animal) ? animal : [animal], opts.range ?? 64)
  if (target == null) throw new TaskError('NOT_FOUND', `no ${String(animal)} within ${opts.range ?? 64} blocks`)
  const pathDistance = opts.pathDistance ?? 12
  if (target.position.distanceTo(bot.entity.position) > pathDistance) {
    if (!await walkNear(bot, target.position, 3, signal)) throw new TaskError('NO_PATH', `can't reach the ${String(target.name)}`)
  }
  const result = await fight(bot, target, { ...opts, maxDistance: opts.maxDistance ?? 48 })
  const drops = opts.collectDrops === false ? {} : await collectDropsNear(bot, result.lastPosition, { signal })
  return { killed: result.killed, drops }
}
