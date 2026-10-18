import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { ARROW_EYE_OFFSET, type ArrowWorld, arrowHits, bowArrowSpeed, type Box, solveAim, type AimSolution } from './arrow'
import { motionTrackerOf } from './motion'
import { type Entity, entityBox, isAlive, TaskError, type SkillOptions, throwIfAborted, waitTicks } from './combatUtil'

export interface ShootOptions extends SkillOptions {
  /** ticks to draw the bow (default 22: full power from 20, BowItem.getPowerForTime, and two to spare) */
  drawTicks?: number
  /** arrows to loose before giving up (default 3) */
  maxShots?: number
  /** prefer the high arc */
  highArc?: boolean
  /** check the shot against the world's blocks (default true) */
  checkBlocks?: boolean
}

export interface ShootResult {
  shots: number
  /** the target died or was destroyed (an end crystal), or the arrow reached the position */
  hit: boolean
  /** the last aim */
  solution: AimSolution | null
}

const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow']

function hasArrows (bot: Bot): boolean {
  return bot.inventory.items().some(i => ARROWS.includes(i.name)) || ARROWS.includes(bot.inventory.slots[45]?.name ?? '')
}

/** The world for the arrow: water from the block at each position, blocks from mineflayer's raycast. */
export function arrowWorld (bot: Bot): ArrowWorld {
  return {
    isWater: (pos) => bot.blockAt(pos)?.name === 'water',
    clip: (from, to) => {
      const dir = to.minus(from)
      const len = dir.norm()
      if (len < 1e-9) return null
      const hit: any = (bot.world as any).raycast?.(from, dir.scaled(1 / len), len)
      if (hit == null || hit.boundingBox === 'empty' || hit.name === 'water') return null
      return hit.intersect ?? hit.position?.offset(0.5, 0.5, 0.5) ?? null
    }
  }
}

/** Where a bow shot leaves from: the shooter's eye less 0.1 (AbstractArrow's constructor from its owner). */
export function arrowStart (bot: Bot): Vec3 {
  const eye = (bot.entity as any).eyeHeight ?? 1.62
  return bot.entity.position.offset(0, eye - ARROW_EYE_OFFSET, 0)
}

function targetBox (target: Entity | Vec3): Box {
  if (target instanceof Vec3) return { min: target.offset(-0.05, -0.05, -0.05), max: target.offset(0.05, 0.05, 0.05) }
  return entityBox(target)
}

function targetPoint (target: Entity | Vec3): Vec3 {
  if (target instanceof Vec3) return target
  return target.position.offset(0, (target.height ?? 1) / 2, 0)
}

/**
 * Aims and looses arrows at an entity or a position: the bow drawn to full power, the aim solved over vanilla's
 * arrow physics each tick of the draw, a moving target (the dragon) led by its velocity from the motion tracker.
 * An end crystal is hit when it's gone; an entity when it dies (or maxShots arrows all land without killing it,
 * which reports hit false).
 */
export async function shoot (bot: Bot, target: Entity | Vec3, opts: ShootOptions = {}): Promise<ShootResult> {
  const signal = opts.signal
  const drawTicks = opts.drawTicks ?? 22
  const maxShots = opts.maxShots ?? 3
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (bow == null && bot.heldItem?.name !== 'bow') throw new TaskError('MISSING_ITEMS', 'no bow')
  if (!hasArrows(bot) && bot.game.gameMode !== 'creative') throw new TaskError('MISSING_ITEMS', 'no arrows')
  if (bot.heldItem?.name !== 'bow' && bow != null) await bot.equip(bow, 'hand')

  const isEntity = !(target instanceof Vec3)
  const tracker = motionTrackerOf(bot)
  if (isEntity) tracker.track(target)
  const world = opts.checkBlocks !== false ? arrowWorld(bot) : undefined
  let solution: AimSolution | null = null
  let shots = 0
  try {
    while (shots < maxShots) {
      throwIfAborted(signal)
      if (isEntity && !isAlive(bot, target)) return { shots, hit: shots > 0, solution }
      if (!hasArrows(bot) && bot.game.gameMode !== 'creative') throw new TaskError('MISSING_ITEMS', 'out of arrows')
      bot.clearControlStates()
      bot.deactivateItem()
      bot.activateItem()
      for (let t = 0; t < drawTicks; t++) {
        // the arrow leaves after the rest of the draw and the release's trip to the server
        solution = aim(bot, target, { leadTicks: drawTicks - t + 1, highArc: opts.highArc, world })
        if (solution != null) await bot.look(solution.yaw, solution.pitch, true)
        await waitTicks(bot, 1, signal)
        if (isEntity && !isAlive(bot, target)) break
      }
      if (isEntity && !isAlive(bot, target)) { bot.deactivateItem(); return { shots, hit: true, solution } }
      solution = aim(bot, target, { leadTicks: 1, highArc: opts.highArc, world })
      if (solution == null) {
        bot.deactivateItem()
        throw new TaskError('NO_PATH', 'no arc reaches the target')
      }
      await bot.look(solution.yaw, solution.pitch, true)
      // the look goes out with this tick's move packet; the release follows it
      await waitTicks(bot, 1, signal)
      bot.deactivateItem()
      shots++
      const flight = Math.ceil(solution.ticks) + 10
      if (isEntity) {
        for (let t = 0; t < flight && isAlive(bot, target); t++) await waitTicks(bot, 1, signal)
        if (!isAlive(bot, target)) return { shots, hit: true, solution }
      } else {
        await waitTicks(bot, flight, signal)
        return { shots, hit: Math.abs(solution.error) < 0.5, solution }
      }
    }
    return { shots, hit: false, solution }
  } finally {
    if (isEntity) tracker.untrack(target)
  }
}

/** The aim for a full-power shot now, or null if no arc reaches (or blocks are in the way of every one). */
export function aim (bot: Bot, target: Entity | Vec3, opts: { leadTicks?: number, highArc?: boolean, world?: ArrowWorld } = {}): AimSolution | null {
  const start = arrowStart(bot)
  const isEntity = !(target instanceof Vec3)
  const velocity = isEntity ? motionTrackerOf(bot).velocity(target) : undefined
  const shooterVelocity = bot.entity.onGround ? new Vec3(bot.entity.velocity.x, 0, bot.entity.velocity.z) : bot.entity.velocity
  const common = { speed: bowArrowSpeed(20), shooterVelocity, targetVelocity: velocity, leadTicks: opts.leadTicks ?? 0, world: opts.world }
  for (const highArc of opts.highArc === true ? [true, false] : [false, true]) {
    const solution = solveAim(start, targetPoint(target), { ...common, highArc })
    if (solution == null) continue
    if (opts.world == null) return solution
    // the arc has to reach the (predicted) box before any block
    const box = targetBox(target)
    const offset = solution.aimPoint.minus(targetPoint(target))
    const flight = arrowHits(start, solution.yaw, solution.pitch, { min: box.min.plus(offset), max: box.max.plus(offset) }, common)
    if (flight.hit != null) return solution
  }
  return null
}
