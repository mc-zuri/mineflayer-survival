import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Pos } from '../../core/memory'
import { motionTrackerOf } from '../../skills/motion'
import { steerToward } from '../../skills/steer'
import { eat, bestFoodInInventory } from '../../skills/eat'
import { TaskError, type SkillOptions, throwIfAborted, waitTicks, metadataIndex, metadataValue } from '../../skills/combatUtil'
import { DRAGON_PHASE_METADATA, phaseName } from '../dragon'
import { countItems, groundY, isOpenAt, SCAFFOLD_ITEMS, towerUp, VoidGuard, type BlockGetter } from './world'

// What the dragon throws at the ground, and getting out of it: the AreaEffectClouds of its breath (DragonSittingFlamingPhase)
// and of its fireballs (DragonFireball.onHit, a cloud of radius 3 growing to 7: instant damage every 20 ticks), the
// fireball's landing ahead of it, and the line of a charge (DragonChargePlayerPhase).

export interface Danger {
  center: { x: number, z: number }
  /** the ground height it lies at (a cloud is half a block high: a bot on a pillar over it is out of it) */
  y?: number
  radius: number
  why: 'breath' | 'cloud' | 'fireball' | 'charge'
}

export function inDanger (pos: Pos, dangers: Danger[], margin = 0.8): Danger | null {
  for (const d of dangers) {
    // AreaEffectCloud's box is half a block high: the body (1.8 high) touches it from 1.8 under to 0.5 over its y
    if (d.y != null && (pos.y > d.y + 1 || pos.y < d.y - 2.3)) continue
    if (Math.hypot(pos.x - d.center.x, pos.z - d.center.z) < d.radius + margin) return d
  }
  return null
}

/** the AreaEffectClouds on the ground (the dragon's breath, a fireball's cloud), with their radius metadata */
export function breathClouds (bot: Bot): Danger[] {
  const out: Danger[] = []
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'area_effect_cloud') continue
    const r = metadataValue(bot, e, 'radius')
    out.push({ center: { x: e.position.x, z: e.position.z }, y: e.position.y, radius: typeof r === 'number' ? r : 3, why: 'cloud' })
  }
  return out
}

/** where a dragon fireball lands: its straight line (DragonFireball has no gravity) down to the ground's height */
export function fireballLanding (position: Vec3, velocity: Vec3, ground: number, maxTicks = 200): { x: number, z: number } | null {
  if (velocity.y >= -1e-3) return null
  const t = (position.y - ground) / -velocity.y
  if (t > maxTicks) return null
  return { x: position.x + velocity.x * t, z: position.z + velocity.z * t }
}

/** the closest a straight-moving body comes to `pos` within `ticks` (horizontal), and when */
export function closestApproach (from: Vec3, velocity: Vec3, pos: Pos, ticks: number): { distance: number, tick: number } {
  const vx = velocity.x
  const vz = velocity.z
  const v2 = vx * vx + vz * vz
  let t = v2 < 1e-9 ? 0 : ((pos.x - from.x) * vx + (pos.z - from.z) * vz) / v2
  t = Math.max(0, Math.min(ticks, t))
  return { distance: Math.hypot(from.x + vx * t - pos.x, from.z + vz * t - pos.z), tick: t }
}

/**
 * the clouds, the fireballs' landings (radius 6: the cloud grows) at `ground`, and a charge's line passing within 8
 * blocks of a bot near the island's ground (`island`; up a pillar there's no stepping aside)
 */
export function dragonDangers (bot: Bot, ground: number, island = ground): Danger[] {
  const dangers = breathClouds(bot)
  const motion = motionTrackerOf(bot)
  const me = bot.entity.position
  for (const e of Object.values(bot.entities)) {
    if (e.name === 'dragon_fireball') {
      motion.track(e)
      const land = fireballLanding(e.position, motion.velocity(e), ground)
      if (land != null) dangers.push({ center: land, y: ground, radius: 6, why: 'fireball' })
    } else if (e.name === 'ender_dragon') {
      motion.track(e)
      if (phaseName((e.metadata as any)?.[metadataIndex(bot, 'ender_dragon', 'phase', DRAGON_PHASE_METADATA)]) !== 'charging_player') continue
      const v = motion.velocity(e)
      const pass = closestApproach(e.position, v, me, 60)
      if (pass.distance < 8) dangers.push({ center: { x: e.position.x + v.x * pass.tick, z: e.position.z + v.z * pass.tick }, y: island, radius: 8, why: 'charge' })
    }
  }
  return dangers
}

/**
 * The nearest standing spot out of every danger: rings of 16 headings at 2 to 10 blocks, ground at most 3 blocks
 * up or down, the body fitting, and no void near (the guard's margin).
 */
export function safeSpot (get: BlockGetter, from: Vec3, dangers: Danger[], guard: VoidGuard | null, opts: { home?: Pos, homeRadius?: number } = {}): Vec3 | null {
  for (let d = 2; d <= 10; d += 2) {
    let best: Vec3 | null = null
    let bestScore = Infinity
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8
      const x = Math.floor(from.x + Math.cos(a) * d) + 0.5
      const z = Math.floor(from.z + Math.sin(a) * d) + 0.5
      const y = groundY(get, x, z, from.y + 3, from.y - 3)
      if (y == null) continue
      const p = new Vec3(x, y, z)
      if (!isOpenAt(get, p.floored()) || !isOpenAt(get, p.floored().offset(0, 1, 0))) continue
      if (inDanger(p, dangers, 2.5) != null) continue
      if (guard?.risky(p) === true) continue
      const home = opts.home
      const off = home != null ? Math.hypot(x - home.x, z - home.z) : 0
      if (home != null && off > (opts.homeRadius ?? 30)) continue
      const score = off * 0.1
      if (score < bestScore) { bestScore = score; best = p }
    }
    if (best != null) return best
  }
  return null
}

/** out of the dangers, a tick at a time, until none holds the bot (or maxTicks); false if it stayed in one */
export async function evadeDangers (bot: Bot, dangers: () => Danger[], guard: VoidGuard | null, opts: SkillOptions & { maxTicks?: number, home?: Pos, homeRadius?: number, island?: number } = {}): Promise<boolean> {
  const get: BlockGetter = (pos) => bot.blockAt(pos) as any
  try {
    for (let t = 0; t < (opts.maxTicks ?? 100); t++) {
      throwIfAborted(opts.signal)
      const now = dangers()
      // out with room to spare: the watch fires nearer in (0.5), so the walk back past it doesn't set it off again
      if (inDanger(bot.entity.position, now, 2) == null) return true
      // up a pillar: no stepping off it
      const elevated = opts.island != null && bot.entity.position.y > opts.island + 3
      const to = elevated ? null : safeSpot(get, bot.entity.position, now, guard, opts)
      if (to != null) {
        steerToward(bot, to, { sprint: true })
      } else if (bot.entity.onGround && countItems(bot, SCAFFOLD_ITEMS) >= 2) {
        // nowhere to step to (up a pillar): up out of the cloud, which is half a block high
        bot.clearControlStates()
        await towerUp(bot, Math.floor(bot.entity.position.y + 1e-6) + 2, { signal: opts.signal })
        continue
      } else {
        bot.clearControlStates()
      }
      await waitTicks(bot, 1, opts.signal)
    }
    return inDanger(bot.entity.position, dangers()) == null
  } finally {
    bot.clearControlStates()
  }
}

/** the TaskError a DangerWatch aborts its work with */
export const DANGER = 'the dragon threatens'

/**
 * Runs a piece of work (a walk, a pillar, a shot) under a watch: each tick it reads the dragon's dangers, and when the
 * bot stands in one (on the ground: not up a pillar, the clouds lie on the ground) it aborts the work with PREEMPTED
 * (DANGER), gets the bot out, eats if it's hurt, and resolves false so the caller plans again. True when the work
 * finished.
 */
export async function underDragonWatch (bot: Bot, ground: number, work: (signal: AbortSignal) => Promise<unknown>, opts: SkillOptions & { guard?: VoidGuard | null, eatBelowHealth?: number, log?: (line: string) => void } = {}): Promise<boolean> {
  const parent = opts.signal
  const controller = new AbortController()
  const onParent = (): void => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onParent)
  let threatened = false
  let onThreat: () => void = () => {}
  const threat = new Promise<void>(resolve => { onThreat = resolve })
  const check = (): void => {
    if (threatened) return
    // a fireball lands where the bot stands, when it stands: its own ground is the best guess
    const g = bot.entity.onGround ? bot.entity.position.y : ground
    const danger = inDanger(bot.entity.position, dragonDangers(bot, g, ground), 0.5)
    if (danger != null) {
      opts.log?.(`in the way of a ${danger.why} (${danger.center.x.toFixed(1)}, ${danger.center.z.toFixed(1)}, radius ${danger.radius.toFixed(1)})`)
      threatened = true
      controller.abort(new TaskError('PREEMPTED', DANGER))
      onThreat()
    }
  }
  bot.on('physicsTick', check)
  const running = work(controller.signal)
  try {
    // the work stops at its next check of the signal; a dig or a place in flight may take a while, so it is not waited for
    const finished = await Promise.race([running.then(() => true), threat.then(() => false)])
    if (finished) return true
  } catch (err) {
    if (!threatened) throw err
  } finally {
    bot.off('physicsTick', check)
    parent?.removeEventListener('abort', onParent)
  }
  if ((bot as any).targetDigBlock != null) bot.stopDigging()
  // give the work a moment to see the abort and stop (a walk's pathfinder cancelling), not forever
  await Promise.race([running.catch(() => {}), bot.waitForTicks(40)])
  throwIfAborted(parent)
  bot.clearControlStates()
  bot.deactivateItem()
  await evadeDangers(bot, () => dragonDangers(bot, bot.entity.onGround ? bot.entity.position.y : ground, ground), opts.guard ?? null, { signal: parent, island: ground })
  await eatIfHurt(bot, opts.eatBelowHealth ?? 12, parent)
  return false
}

/** eats when below the health (or hungry) and there is food; skips quietly when it can't */
export async function eatIfHurt (bot: Bot, belowHealth: number, signal?: AbortSignal): Promise<void> {
  if ((bot.health >= belowHealth && bot.food >= 14) || bestFoodInInventory(bot) == null) return
  try {
    await eat(bot, { signal })
  } catch (err) {
    if (!TaskError.is(err) || ['ABORTED', 'PREEMPTED', 'DIED'].includes(err.code)) throw err
  }
}
