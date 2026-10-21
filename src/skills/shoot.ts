import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { ARROW_EYE_OFFSET, type ArrowWorld, arrowHits, bowArrowSpeed, type Box, solveAim, type AimSolution } from './arrow'
import { motionTrackerOf } from './motion'
import { type Entity, entityBox, isAlive, TaskError, type SkillOptions, throwIfAborted, waitTicks } from './combatUtil'
import { SWEEP_SPARED } from './weapons'

export interface ShootOptions extends SkillOptions {
  /** ticks to draw the bow (default 22: full power from 20, BowItem.getPowerForTime, and two to spare) */
  drawTicks?: number
  /** arrows to loose before giving up (default 3) */
  maxShots?: number
  /** prefer the high arc */
  highArc?: boolean
  /** check the shot against the world's blocks (default true) */
  checkBlocks?: boolean
  /** where on an entity to aim, from its position (default: its middle, else high on its box when the middle's line is blocked) */
  aimOffset?: Vec3
  /** looked at before each draw and while an arrow flies: once true the shooting stops (a draw goes on to its shot) */
  until?: () => boolean
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
 * the points to try aiming at: the given one, or the middle and then near the top (a line over a ledge, a spike's
 * rim), then a quarter up and near the feet (a blaze under a slit's visor or over its sill, its middle out of the
 * slit's sight: one 3 to 5 off seen through a 26.3 bot's slit by seed 2's throne was never shot at, 4000 ticks)
 */
function aimPoints (target: Entity | Vec3, offset?: Vec3): Vec3[] {
  if (target instanceof Vec3) return [target]
  if (offset != null) return [target.position.plus(offset)]
  const h = target.height ?? 1
  return [targetPoint(target), target.position.offset(0, h - Math.min(0.2, h / 4), 0), target.position.offset(0, h / 4, 0), target.position.offset(0, Math.min(0.2, h / 4), 0)]
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
      if (opts.until?.() === true) return { shots, hit: false, solution }
      // no draw with a calm mob by the arrow's way (sparedInLine), a tick gone by first: a caller looping on the shot
      // went round with no tick between, and the game stopped (the nether's holdOffArcher at a skeleton with a
      // zombified piglin by the way: the event loop held 20 minutes, 26.3)
      if (sparedInLine(bot, target) != null) { await waitTicks(bot, 1, signal); return { shots, hit: false, solution } }
      if (!hasArrows(bot) && bot.game.gameMode !== 'creative') throw new TaskError('MISSING_ITEMS', 'out of arrows')
      bot.clearControlStates()
      bot.deactivateItem()
      bot.activateItem()
      for (let t = 0; t < drawTicks; t++) {
        // the arrow leaves after the rest of the draw and the release's trip to the server
        solution = aim(bot, target, { leadTicks: drawTicks - t + 1, highArc: opts.highArc, world, offset: opts.aimOffset })
        if (solution != null) await bot.look(solution.yaw, solution.pitch, true)
        await waitTicks(bot, 1, signal)
        if (isEntity && !isAlive(bot, target)) break
      }
      // (the target dead: the draw put away, not loosed off at nothing)
      if (isEntity && !isAlive(bot, target)) { cancelDraw(bot); return { shots, hit: true, solution } }
      // a calm mob in the way (sparedInLine): the bow held drawn till it's out of it, else put away unloosed
      for (let t = 0; t < SPARED_HOLD_TICKS && sparedInLine(bot, target) != null; t++) {
        solution = aim(bot, target, { leadTicks: 1, highArc: opts.highArc, world, offset: opts.aimOffset })
        if (solution != null) await bot.look(solution.yaw, solution.pitch, true)
        await waitTicks(bot, 1, signal)
      }
      if (sparedInLine(bot, target) != null) { cancelDraw(bot); return { shots, hit: false, solution } }
      solution = aim(bot, target, { leadTicks: 1, highArc: opts.highArc, world, offset: opts.aimOffset })
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
        for (let t = 0; t < flight && isAlive(bot, target) && opts.until?.() !== true; t++) await waitTicks(bot, 1, signal)
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

/** ticks a drawn bow is held for a calm mob to come out of the arrow's way */
export const SPARED_HOLD_TICKS = 40
/** how near the arrow's way a calm mob's middle may come, past its half width; and how far past the target the way runs (a miss flies on) */
export const SPARED_LINE_MARGIN = 0.8
export const SPARED_LINE_PAST = 6

/**
 * A mob calm till hurt (weapons' SWEEP_SPARED: a zombified piglin's hurt angers all of them about) by the straight way
 * from the bot's eye to the target and SPARED_LINE_PAST on past it, or null: an arrow is never let go at it. One of the
 * target's own kind is fought already. Zombified piglins by seed 2's throne were hit by the shots at a wither skeleton
 * and the blazes and came at the bot, and killed it (tests/integration/blaze BLAZE_WITHER=fresh-x)
 */
export function sparedInLine (bot: Bot, target: Entity | Vec3): Entity | null {
  const isEntity = !(target instanceof Vec3)
  const from = arrowStart(bot)
  const to = isEntity ? target.position.offset(0, (target.height ?? 1.8) / 2, 0) : target
  const way = to.minus(from)
  const len = way.norm()
  if (len < 1e-6) return null
  const dir = way.scaled(1 / len)
  for (const m of Object.values(bot.entities) as Entity[]) {
    if (m === bot.entity || !SWEEP_SPARED.has(m.name ?? '') || (isEntity && (m.id === target.id || m.name === target.name)) || !isAlive(bot, m)) continue
    const mid = m.position.offset(0, (m.height ?? 1.8) / 2, 0)
    const t = Math.max(0, Math.min(len + SPARED_LINE_PAST, mid.minus(from).dot(dir)))
    const off = mid.minus(from.plus(dir.scaled(t))).norm()
    if (off < (m.width ?? 0.6) / 2 + SPARED_LINE_MARGIN) return m
  }
  return null
}

/**
 * A draw put away without its arrow: the held slot changed and back (ServerGamePacketListenerImpl.handleSetCarriedItem
 * stops the use, LivingEntity.stopUsingItem, with no BowItem.releaseUsing); deactivateItem would loose it
 */
function cancelDraw (bot: Bot): void {
  const slot = bot.quickBarSlot
  if (typeof bot.setQuickBarSlot !== 'function' || typeof slot !== 'number') { bot.deactivateItem(); return }
  bot.setQuickBarSlot((slot + 1) % 9)
  bot.setQuickBarSlot(slot)
  ;(bot as any).usingHeldItem = false
}

/**
 * The aim for a full-power shot now, or null if no arc reaches (or blocks are in the way of every one). The flat arc
 * is tried at each aim point before the high one (a high arc flies for seconds and drifts).
 */
export function aim (bot: Bot, target: Entity | Vec3, opts: { leadTicks?: number, highArc?: boolean, world?: ArrowWorld, offset?: Vec3 } = {}): AimSolution | null {
  const start = arrowStart(bot)
  const isEntity = !(target instanceof Vec3)
  const velocity = isEntity ? motionTrackerOf(bot).velocity(target) : undefined
  const shooterVelocity = bot.entity.onGround ? new Vec3(bot.entity.velocity.x, 0, bot.entity.velocity.z) : bot.entity.velocity
  const common = { speed: bowArrowSpeed(20), shooterVelocity, targetVelocity: velocity, leadTicks: opts.leadTicks ?? 0, world: opts.world }
  for (const highArc of opts.highArc === true ? [true, false] : [false, true]) {
    for (const point of aimPoints(target, opts.offset)) {
      const solution = solveAim(start, point, { ...common, highArc })
      if (solution == null) continue
      if (opts.world == null) return solution
      // the arc has to reach the (predicted) box before any block
      const box = targetBox(target)
      const offset = solution.aimPoint.minus(point)
      const flight = arrowHits(start, solution.yaw, solution.pitch, { min: box.min.plus(offset), max: box.max.plus(offset) }, common)
      if (flight.hit != null) return solution
    }
  }
  return null
}
