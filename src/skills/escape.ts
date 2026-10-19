import type { Bot } from 'mineflayer'
import { dig } from '../core/actions'
import { isAbort } from './errors'
import { trace } from './util'
import { Vec3 } from 'vec3'
import { creeperSwelling, lowerShield, raiseShield, SwellCounter } from './fight'
import { isDangerBlock, steerAway, steerToward, fleeHeading } from './steer'
import { type Entity, eyePosition, isAlive, type SkillOptions, TaskError, throwIfAborted, waitTicks, yawPitchOf } from './combatUtil'
import { hotFloorCell, noteHazardLeft } from './hazardCells'

// The escapes the reflexes run: out of lava and fire, up for air, away from a creeper or a crowd.

const BURNING = new Set(['lava', 'fire', 'soul_fire'])

function nameAt (bot: Bot, pos: Vec3): string | undefined {
  return bot.blockAt(pos)?.name
}

/** blocks that freeze a body in them (PowderSnowBlock: the freeze ticks climb, then the damage) */
const FREEZING = new Set(['powder_snow'])

/**
 * The cells the bot's box is in (its width and height, deflated by 1e-5), the middle's feet and head first: those whose
 * blocks act on it (Entity.checkInsideBlocks: a fire beside the bot's middle burns it once its box reaches in)
 */
export function boxCells (bot: Bot): Vec3[] {
  const pos = bot.entity.position
  const half = ((bot.entity as any).width ?? 0.6) / 2 - 1e-5
  const height = ((bot.entity as any).height ?? 1.8) - 1e-5
  const feet = pos.floored()
  const out: Vec3[] = [feet, feet.offset(0, 1, 0)]
  for (let y = Math.floor(pos.y + 1e-5); y <= Math.floor(pos.y + height); y++) {
    for (let x = Math.floor(pos.x - half); x <= Math.floor(pos.x + half); x++) {
      for (let z = Math.floor(pos.z - half); z <= Math.floor(pos.z + half); z++) {
        if (!out.some(c => c.x === x && c.y === y && c.z === z)) out.push(new Vec3(x, y, z))
      }
    }
  }
  return out
}

/**
 * In lava, fire or powder snow: a block of the cells the bot's box is in (boxCells), or mineflayer's lava flag. A
 * 26.3 bot stood 140 ticks by a fire on the netherrack, its box in the fire's cell and its middle out of it, hurt every
 * 10 ticks (in_fire), and the reflex, which looked at its middle's cells alone, never went. Or on a magma block not
 * sneaking (onHotFloor).
 */
export function inHazard (bot: Bot): boolean {
  const bad = (n: string | undefined): boolean => BURNING.has(n ?? '') || FREEZING.has(n ?? '')
  return (bot.entity as any).isInLava === true || boxCells(bot).some(p => bad(nameAt(bot, p))) || onHotFloor(bot)
}

/**
 * On a magma block, not sneaking: hurt every 10 ticks (MagmaBlock.stepOn, the block at Entity.getOnPos, 0.2 under the
 * feet, unless isSteppingCarefully). A 26.3 bot knocked onto one in a basalt delta by a magma cube swarm stood there
 * 150 ticks, the hostiles reflex 'cornered' over and over, and died of the floor (hot_floor 14 times) and the cubes.
 */
export function onHotFloor (bot: Bot): boolean {
  if (bot.entity.onGround !== true || bot.getControlState?.('sneak') === true) return false
  return nameAt(bot, bot.entity.position.offset(0, -0.2, 0).floored()) === 'magma_block'
}

const CLIMB_FILLERS = ['cobblestone', 'netherrack', 'cobbled_deepslate', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'blackstone', 'basalt', 'end_stone']

function inLava (bot: Bot): boolean {
  const feet = bot.entity.position.floored()
  return (bot.entity as any).isInLava === true || nameAt(bot, feet) === 'lava' || nameAt(bot, feet.offset(0, 1, 0)) === 'lava'
}

/**
 * Puts a block into a lava cell beside the bot at its feet's level, against the solid floor under it (a block held
 * of CLIMB_FILLERS), and resolves the cell on top of it to climb onto; null when there's no such cell or no block
 */
export async function blockToClimb (bot: Bot, signal?: AbortSignal): Promise<Vec3 | null> {
  const filler = CLIMB_FILLERS.find(n => bot.inventory.items().some(i => i.name === n))
  if (filler == null) return null
  const feet = bot.entity.position.floored()
  for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const cell = feet.plus(d)
    const b = bot.blockAt(cell)
    const under = bot.blockAt(cell.offset(0, -1, 0))
    if (b == null || under == null || (b.name !== 'lava' && b.boundingBox !== 'empty') || under.boundingBox !== 'block') continue
    if (!passable(bot, cell.offset(0, 1, 0), false) || !passable(bot, cell.offset(0, 2, 0), false)) continue
    try {
      const { placeBlock } = await import('./placeBlock')
      await placeBlock(bot, { pos: cell, item: filler, against: cell.offset(0, -1, 0), intoFluid: true }, signal)
      if (bot.blockAt(cell)?.boundingBox === 'block') return cell.offset(0, 1, 0)
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return null
}

/** a fire block in a cell of the bot's box (boxCells), else null */
export function fireToPutOut (bot: Bot): Vec3 | null {
  for (const p of boxCells(bot)) { const n = nameAt(bot, p); if (n === 'fire' || n === 'soul_fire') return p }
  return null
}

/**
 * The powder snow the bot is in, head first then feet (dug out, the bot drops or steps free: a 26.3 bot sunk in it
 * on a snowy slope failed to pillar out, the block refused there, and froze to death)
 */
export function powderSnowToDig (bot: Bot): Vec3 | null {
  const feet = bot.entity.position.floored()
  for (const p of [feet.offset(0, 1, 0), feet]) if (FREEZING.has(nameAt(bot, p) ?? '')) return p
  return null
}

/** Entity.isOnFire as the server tells it: the shared flags' bit 0 (DATA_SHARED_FLAGS_ID). */
export function isOnFire (bot: Bot): boolean {
  const flags = (bot.entity.metadata as any)?.[0]
  return typeof flags === 'number' && (flags & 1) !== 0
}

/** The head is under water (the block at the eyes is water or a bubble column). */
export function headInWater (bot: Bot): boolean {
  const block = bot.blockAt(eyePosition(bot).floored()) as any
  const name = block?.name
  // the water plants are water too (a river's seagrass or kelp at the eyes: no drowning reflex, and a 26.3 bot drowned
  // under it twice), and anything waterlogged
  return name === 'water' || name === 'bubble_column' || UNDERWATER_PLANTS.has(name) || block?.getProperties?.()?.waterlogged === true
}

/** the blocks that are always in water */
const UNDERWATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])

function passable (bot: Bot, pos: Vec3, waterOk: boolean): boolean {
  const b = bot.blockAt(pos)
  if (b == null) return false
  if (isDangerBlock(b.name)) return false
  if (b.name === 'water' || b.name === 'bubble_column') return waterOk
  return b.boundingBox === 'empty'
}

/** Somewhere to stand out of danger: feet and head free (no lava, no fire), solid ground under. */
export function isSafeStand (bot: Bot, feet: Vec3): boolean {
  const below = bot.blockAt(feet.offset(0, -1, 0))
  return passable(bot, feet, true) && passable(bot, feet.offset(0, 1, 0), true) && below != null && below.boundingBox === 'block' && !isDangerBlock(below.name)
}

/** The nearest block position within radius (by a breadth-first search over neighbours) that passes the test. */
export function nearestSpot (bot: Bot, radius: number, test: (pos: Vec3) => boolean): Vec3 | null {
  const start = bot.entity.position.floored()
  const seen = new Set<string>()
  const queue: Vec3[] = [start]
  seen.add(start.toString())
  const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0), new Vec3(0, -1, 0)]
  while (queue.length > 0) {
    const pos = queue.shift() as Vec3
    if (test(pos)) return pos
    for (const d of dirs) {
      const next = pos.plus(d)
      const key = next.toString()
      if (seen.has(key) || next.distanceTo(start) > radius) continue
      seen.add(key)
      // search through what a body can move through (lava and water too: that's where it starts)
      const b = bot.blockAt(next)
      if (b == null || (b.boundingBox === 'block' && !test(next))) continue
      queue.push(next)
    }
  }
  return null
}

/** ticks the hazard reflex steps toward ground beside a magma block before it puts a block on the magma instead */
export const HOT_FLOOR_STEP_TICKS = 20

/**
 * The ground beside the magma block the bot stands on that a step gets it to: of the eight cells round it, one that's
 * a safe stand (isSafeStand: no magma under) at the feet's level, a jump up (room over the head for it) or a drop of
 * 1 or 2, the cells on the way free of lava and fire; the nearest the bot's middle. Null when there's none.
 */
export function hotFloorStep (bot: Bot): Vec3 | null {
  const pos = bot.entity.position
  const feet = pos.floored()
  const headroom = passable(bot, feet.offset(0, 2, 0), false)
  let best: { cell: Vec3, d: number } | null = null
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      const column = feet.offset(dx, 0, dz)
      let cell: Vec3 | null = null
      if (isSafeStand(bot, column.offset(0, 1, 0)) && headroom && passable(bot, column.offset(0, 2, 0), false)) cell = column.offset(0, 1, 0)
      else if (passable(bot, column, false) && passable(bot, column.offset(0, 1, 0), false)) {
        for (let dy = 0; dy >= -2 && cell == null; dy--) {
          const c = column.offset(0, dy, 0)
          if (!passable(bot, c, false)) break
          if (isSafeStand(bot, c)) cell = c
        }
      }
      // a diagonal step goes by both its sides' cells: both open at the feet and the head
      if (cell == null || (dx !== 0 && dz !== 0 && (!passable(bot, feet.offset(dx, 0, 0), false) || !passable(bot, feet.offset(0, 0, dz), false) ||
        !passable(bot, feet.offset(dx, 1, 0), false) || !passable(bot, feet.offset(0, 1, dz), false)))) continue
      const d = Math.hypot(cell.x + 0.5 - pos.x, cell.z + 0.5 - pos.z)
      if (best == null || d < best.d) best = { cell, d }
    }
  }
  return best?.cell ?? null
}

/**
 * A block put on the magma block under the feet, by a pillar's jump (towerUp, a block of the bag's scaffolding),
 * for the bot to stand on: resolves whether it stands a block up off the magma
 */
export async function coverHotFloor (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const feet = bot.entity.position.floored()
  const { towerUp } = await import('../end/skills/world')
  // (a jump cut short is tried again: on 1.21.11 the first jump off the magma came straight back down, the server's
  // position put on it a tick in, and towerUp's 12 ticks ran out before the next one cleared the block)
  for (let attempt = 1; attempt <= COVER_TRIES; attempt++) {
    try {
      await towerUp(bot, feet.y + 1, { signal })
      break
    } catch (err) {
      if (isAbort(err)) throw err
      trace('coverHotFloor: no block put on the magma:', (err as Error).message)
      if (attempt === COVER_TRIES || bot.blockAt(feet)?.boundingBox === 'block') break
    }
  }
  return Math.floor(bot.entity.position.y + 1e-6) > feet.y && !onHotFloor(bot)
}

/** pillar jumps coverHotFloor tries */
export const COVER_TRIES = 3

export interface EscapeHazardOptions extends SkillOptions {
  searchRadius?: number
  /** how far ground is looked for when none is within searchRadius (default 16) */
  farRadius?: number
  /** puts a block on the magma under the feet (default coverHotFloor) */
  cover?: (bot: Bot, signal?: AbortSignal) => Promise<boolean>
  /** run to water this close when burning (0 off) */
  waterRadius?: number
  maxTicks?: number
}

/** Gets out of lava or fire onto safe ground (swimming up in lava), then to water if still burning and near. */
export async function escapeHazard (bot: Bot, opts: EscapeHazardOptions = {}): Promise<{ ticks: number }> {
  const radius = opts.searchRadius ?? 6
  const maxTicks = opts.maxTicks ?? 200
  let target: Vec3 | null = null
  let hotTicks = 0
  let covered = false
  try {
    for (let t = 0; t < maxTicks; t++) {
      throwIfAborted(opts.signal)
      const here = bot.entity.position.floored()
      // the magma block's cell is kept out of by the walks for a while (hazardCells): the walk handed back to took the
      // bot straight back onto it
      if (onHotFloor(bot)) noteHazardLeft(bot, hotFloorCell(bot))
      if (!inHazard(bot) && bot.entity.onGround && isSafeStand(bot, here)) {
        // out; still burning with water close: put it out (Entity.updateInWaterStateAndDoFluidPushing clears the fire)
        const waterRadius = opts.waterRadius ?? 6
        if (!isOnFire(bot) || waterRadius <= 0) return { ticks: t }
        const water = nearestSpot(bot, waterRadius, p => nameAt(bot, p) === 'water')
        if (water == null) return { ticks: t }
        if ((bot.entity as any).isInWater === true) return { ticks: t }
        steerToward(bot, water.offset(0.5, 0, 0.5), { sprint: true })
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      // a fire the bot stands in (a blaze's fireball lights the netherrack, which burns for good: a 26.3 bot 'went up
      // in flames' by a fortress's spawner) is put out with a hit, as a player does
      const fire = fireToPutOut(bot)
      if (fire != null) {
        const block = bot.blockAt(fire)
        if (block != null) await bot.dig(block as any, true).catch(() => {})
      }
      const snow = powderSnowToDig(bot)
      if (snow != null) {
        bot.clearControlStates()
        const block = bot.blockAt(snow)
        if (block != null) await bot.dig(block as any, true).catch(() => {})
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      // on a magma block (not in lava or fire): off it by a step onto ground beside it, never through lava; a pocket
      // with none, or a step that doesn't get the bot off in HOT_FLOOR_STEP_TICKS (magma cubes in the way), gets a
      // block put on the magma under the feet (a pillar's jump) to stand on. In seed 2's basalt delta a 26.3 bot stood
      // on a magma block with the lava sea on two sides and a wall two high on the others for 170 ticks, the reflex
      // steering at a stand it couldn't climb to, the floor hurting it every 12 and the magma cubes about, till it died
      if ((onHotFloor(bot) || (bot.entity.onGround && nameAt(bot, bot.entity.position.offset(0, -0.2, 0).floored()) === 'magma_block')) && !inLava(bot)) {
        hotTicks++
        const step = hotFloorStep(bot)
        if ((step == null || hotTicks > HOT_FLOOR_STEP_TICKS) && !covered) {
          covered = true
          bot.clearControlStates()
          if (await (opts.cover ?? coverHotFloor)(bot, opts.signal)) continue
        }
        if (step != null) {
          steerToward(bot, step.offset(0.5, 0, 0.5), { sprint: false })
          await waitTicks(bot, 1, opts.signal)
          continue
        }
        // no step and no block put: sneaking where it is (MagmaBlock.stepOn spares a player stepping carefully), not
        // a run across the lava at a stand past it (a 1.21.11 bot so jumped a lava strip)
        bot.clearControlStates()
        bot.setControlState('sneak', true)
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      if (target == null || t % 10 === 0 || !isSafeStand(bot, target)) {
        // the near ground first, then any within farRadius: in the nether's lava sea none was within 6 and the bot
        // swam up in place for 200 ticks till it burned (26.3)
        target = nearestSpot(bot, radius, p => isSafeStand(bot, p) && !p.equals(here)) ??
          (t % 40 === 0 ? nearestSpot(bot, opts.farRadius ?? 16, p => isSafeStand(bot, p) && !p.equals(here)) : target)
      }
      // in lava a while with no ground near: a block put into the lava beside the bot, against the floor under it,
      // to climb out onto (the basalt deltas' pools: lava all round, no stand within reach, 26.3's deaths in the nether)
      if (inLava(bot) && t >= 10 && t % 20 === 10 && (target == null || target.distanceTo(here) > 3)) {
        const step = await blockToClimb(bot, opts.signal)
        if (step != null) target = step
      }
      if (target == null) {
        // nowhere known: swim up and hope
        bot.setControlState('jump', true)
      } else {
        steerToward(bot, target.offset(0.5, 0, 0.5), { sprint: true })
        if ((bot.entity as any).isInLava === true) bot.setControlState('jump', true)
      }
      await waitTicks(bot, 1, opts.signal)
    }
    throw new TaskError('TIMEOUT', 'still in lava or fire')
  } finally {
    bot.clearControlStates()
  }
}

export interface SurfaceOptions extends SkillOptions {
  /** stay up until bot.oxygenLevel is back to this (0 - 20, default 18) */
  recoverTo?: number
  searchRadius?: number
  maxTicks?: number
}

/** blocks a bot under water doesn't dig its way up through */
const UNBREAKABLE_CEILING = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate', 'obsidian', 'crying_obsidian', 'lava'])

/**
 * The block to dig for air when the bot is under a ceiling: up from the eyes' cell through the water (up to 3 cells),
 * the first block that isn't water when it is solid and can be dug (a frozen sea's ice, a cave's roof), else null
 * (air there, or nothing to dig). Ice dug over water turns to water (IceBlock.playerDestroy), with the air over it.
 */
export function ceilingToDig (nameAt: (pos: Vec3) => { name: string, boundingBox: string } | null, eyes: Vec3): Vec3 | null {
  for (let dy = 1; dy <= 3; dy++) {
    const pos = eyes.offset(0, dy, 0)
    const b = nameAt(pos)
    if (b == null) return null
    if (b.name === 'water' || b.name === 'bubble_column') continue
    if (b.boundingBox !== 'block' || UNBREAKABLE_CEILING.has(b.name)) return null
    return pos
  }
  return null
}

/**
 * Swims up to air and stays there until the air bar is back. Under ice with no air in reach (a frozen sea) it digs
 * the ice over its head (ceilingToDig): the jump alone held it against the ice until it drowned (26.3).
 */
export async function surface (bot: Bot, opts: SurfaceOptions = {}): Promise<{ ticks: number }> {
  const recoverTo = opts.recoverTo ?? 18
  const radius = opts.searchRadius ?? 8
  const maxTicks = opts.maxTicks ?? 300
  let target: Vec3 | null = null
  try {
    for (let t = 0; t < maxTicks; t++) {
      throwIfAborted(opts.signal)
      if (!headInWater(bot)) {
        if (bot.oxygenLevel >= recoverTo) return { ticks: t }
        // keep the head up
        bot.setControlState('forward', false)
        bot.setControlState('jump', true)
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      // the nearest place the head can be in the air: a free block over water or ground
      if (target == null || t % 20 === 0) {
        target = nearestSpot(bot, radius, p => {
          const name = nameAt(bot, p)
          return (name === 'water' || passable(bot, p, false)) && passable(bot, p.offset(0, 1, 0), false)
        })
      }
      bot.setControlState('jump', true)
      if (target == null && t % 10 === 0) {
        const ceiling = ceilingToDig(p => bot.blockAt(p) as any, eyePosition(bot).floored())
        const block = ceiling != null ? bot.blockAt(ceiling) : null
        if (block != null) {
          try {
            await dig(bot, block as any, { signal: opts.signal })
          } catch (err) {
            if (isAbort(err)) throw err
          }
          target = null
          continue
        }
      }
      if (target != null) {
        const dx = target.x + 0.5 - bot.entity.position.x
        const dz = target.z + 0.5 - bot.entity.position.z
        if (Math.hypot(dx, dz) > 0.4) {
          void bot.look(Math.atan2(-dx, -dz), 0.6, true)
          bot.setControlState('forward', true)
        } else {
          bot.setControlState('forward', false)
        }
      }
      await waitTicks(bot, 1, opts.signal)
    }
    throw new TaskError('TIMEOUT', 'no air reached')
  } finally {
    bot.clearControlStates()
  }
}

export interface EvadeCreeperOptions extends SkillOptions {
  /** run until this far and it's stopped swelling (default 7.5) */
  safeDistance?: number
  /** raise the shield when its fuse is this far along and it's this close (default 24, 5) */
  blockAtSwell?: number
  blockDistance?: number
  maxTicks?: number
  /** its swell count so far (the reflex follows it) */
  swell?: number
}

export interface EvadeResult {
  /** gone: it blew up or died; away: out of reach and not swelling */
  outcome: 'gone' | 'away'
  blocked: boolean
  ticks: number
}

/**
 * Gets clear of a creeper: sprints away past its blast (and past the 7 blocks it stops swelling at), or, cornered or
 * about to be caught by the blast, faces it with the shield up (explosions are blocked from the front).
 */
export async function evadeCreeper (bot: Bot, creeper: Entity, opts: EvadeCreeperOptions = {}): Promise<EvadeResult> {
  const safe = opts.safeDistance ?? 7.5
  const blockAtSwell = opts.blockAtSwell ?? 24
  const blockDistance = opts.blockDistance ?? 5
  const maxTicks = opts.maxTicks ?? 200
  const counter = new SwellCounter()
  counter.swell = opts.swell ?? 0
  let blocked = false
  let blocking = false
  try {
    for (let t = 0; t < maxTicks; t++) {
      throwIfAborted(opts.signal)
      if (!isAlive(bot, creeper)) return { outcome: 'gone', blocked, ticks: t }
      const swelling = creeperSwelling(bot, creeper)
      const swell = counter.update(swelling)
      const distance = bot.entity.position.distanceTo(creeper.position)
      if (distance >= safe && !swelling) return { outcome: 'away', blocked, ticks: t }
      const hasShield = bot.inventory.slots[45]?.name === 'shield' || bot.inventory.items().some(i => i.name === 'shield')
      const cornered = fleeHeading(bot, creeper.position) == null
      if (hasShield && distance < blockDistance && (swell >= blockAtSwell || cornered)) {
        bot.clearControlStates()
        const { yaw, pitch } = yawPitchOf(creeper.position.offset(0, 1, 0).minus(eyePosition(bot)))
        void bot.look(yaw, pitch, true)
        if (!blocking) blocking = await raiseShield(bot)
        blocked = blocked || blocking
      } else {
        if (blocking) { lowerShield(bot); blocking = false }
        steerAway(bot, creeper.position)
      }
      await waitTicks(bot, 1, opts.signal)
    }
    throw new TaskError('TIMEOUT', 'the creeper is still close')
  } finally {
    if (blocking) lowerShield(bot)
    bot.clearControlStates()
  }
}

/** Runs from the threats until none is within distance. */
export async function fleeFrom (bot: Bot, threats: () => Entity[], opts: SkillOptions & { distance?: number, maxTicks?: number } = {}): Promise<{ ticks: number }> {
  const distance = opts.distance ?? 16
  const maxTicks = opts.maxTicks ?? 300
  try {
    for (let t = 0; t < maxTicks; t++) {
      throwIfAborted(opts.signal)
      const near = threats().filter(e => isAlive(bot, e) && e.position.distanceTo(bot.entity.position) < distance)
      if (near.length === 0) return { ticks: t }
      const centroid = near.reduce((sum, e) => sum.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / near.length)
      if (!steerAway(bot, centroid)) throw new TaskError('NO_PATH', 'cornered')
      await waitTicks(bot, 1, opts.signal)
    }
    throw new TaskError('TIMEOUT', 'still chased')
  } finally {
    bot.clearControlStates()
  }
}
