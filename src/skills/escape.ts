import type { Bot } from 'mineflayer'
import { dig, placeAgainst } from '../core/actions'
import { isAbort } from './errors'
import { type Block, blockReach, trace, withinReach } from './util'
import { Vec3 } from 'vec3'
import { creeperSwelling, lowerShield, raiseShield, SwellCounter } from './fight'
import { isDangerBlock, steerAway, steerToward, fleeHeading } from './steer'
import { type Entity, distanceToBox, entityBox, eyePosition, isAlive, type SkillOptions, TaskError, throwIfAborted, waitTicks, waitUntil, yawPitchOf } from './combatUtil'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
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
/** per bot, the tasks that handle the fire's cells themselves (handleFire): the hazard reflex leaves fire to them */
const fireHandlers = new WeakMap<Bot, number>()

/**
 * The fire's cells (fire, soul fire) left to the task that calls this, till the release it returns: the hazard
 * reflex's escape from them is held off (lava, powder snow and a hot floor still its). The blaze fight puts out the
 * fire in its nook and steps off it itself: the reflex walking the bot out of a fire in the nook cut the camp's task
 * off some 9 times in a row, each time out among the blazes, and combat5's bots burned
 */
export function handleFire (bot: Bot): () => void {
  fireHandlers.set(bot, (fireHandlers.get(bot) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const k = (fireHandlers.get(bot) ?? 1) - 1
    if (k <= 0) fireHandlers.delete(bot)
    else fireHandlers.set(bot, k)
  }
}

/** whether a task handles the fire's cells itself (handleFire) */
export function fireHandled (bot: Bot): boolean {
  return (fireHandlers.get(bot) ?? 0) > 0
}

/** whether the hazard the bot is in is the fire's only (its cells' fire; no lava, powder snow nor hot floor) */
export function inFireOnly (bot: Bot): boolean {
  const cells = boxCells(bot).map(p => nameAt(bot, p))
  return (bot.entity as any).isInLava !== true && !onHotFloor(bot) && cells.some(n => n === 'fire' || n === 'soul_fire') &&
    !cells.some(n => n === 'lava' || FREEZING.has(n ?? ''))
}

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
  // any cell the box reaches into (Entity.isInPowderSnow is the box's: a 26.3 bot's side in the snow beside a slope,
  // its middle out of it, froze to death, the reflex going 40 times without digging any, and twice at the spot)
  for (const p of boxCells(bot)) if (FREEZING.has(nameAt(bot, p) ?? '')) return p
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

/** the blocks a way off the magma isn't dug through */
const NO_DIG = /^(bedrock|barrier|obsidian|crying_obsidian|reinforced_deepslate|end_portal_frame|magma_block|spawner|chest|.*_bed|furnace|crafting_table)$/

/**
 * The cells to dig for a way off the magma block under the bot where none is open (hotFloorStep's null: netherrack all
 * round a ruined portal's magma, a wall to jump onto with no room over the head): along one of the four sides, a tunnel
 * at the feet's level up to HOT_FLOOR_DIG_REACH columns out, to the first whose floor is a full block that isn't magma
 * nor a danger (the columns before it over magma or another full block: walked sneaking), each column's feet and head
 * cells open or dug (no liquid against them, nothing NO_DIG); the way with the fewest to dig. Resolves the cells to dig
 * (maybe none) and the stand they make, or null.
 */
export function hotFloorDigStep (bot: Bot): { dig: Vec3[], stand: Vec3 } | null {
  const feet = bot.entity.position.floored()
  let best: { dig: Vec3[], stand: Vec3 } | null = null
  const liquid = (p: Vec3): boolean => [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => /^(lava|water|bubble_column)$/.test(bot.blockAt(p.offset(dx, dy, dz))?.name ?? ''))
  for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const cells: Vec3[] = []
    for (let i = 1; i <= HOT_FLOOR_DIG_REACH; i++) {
      const stand = feet.plus(d.scaled(i))
      const under = bot.blockAt(stand.offset(0, -1, 0))
      if (under == null || under.boundingBox !== 'block' || (under.name !== 'magma_block' && isDangerBlock(under.name))) break
      let ok = true
      for (const c of [stand, stand.offset(0, 1, 0)]) {
        const b = bot.blockAt(c)
        if (b == null) { ok = false; break }
        if (passable(bot, c, false)) continue
        if (b.boundingBox !== 'block' || NO_DIG.test(b.name) || liquid(c)) { ok = false; break }
        cells.push(c)
      }
      if (!ok) break
      if (under.name === 'magma_block') continue
      if (best == null || cells.length < best.dig.length) best = { dig: [...cells], stand }
      break
    }
  }
  return best
}

/** how many columns out hotFloorDigStep digs for a floor that isn't magma (a ruined portal's patch is 3 or 4 across) */
export const HOT_FLOOR_DIG_REACH = 4

/**
 * Whether the hazard reflex sneaks on the magma under the bot as it makes for `step` (MagmaBlock.stepOn spares a player
 * stepping carefully, Entity.isSteppingCarefully): always, but for a step down (a sneak keeps a player from walking off
 * an edge, Player.maybeBackOffFromEdge)
 */
export function sneakOnMagma (feet: Vec3, step: Vec3 | null): boolean {
  return step == null || step.y >= feet.y
}

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

const inTheNether = (bot: Bot): boolean => /nether/.test(String(bot.game?.dimension ?? ''))

/** Gets out of lava or fire onto safe ground (swimming up in lava), then to water if still burning and near. */
export async function escapeHazard (bot: Bot, opts: EscapeHazardOptions = {}): Promise<{ ticks: number }> {
  const radius = opts.searchRadius ?? 6
  const maxTicks = opts.maxTicks ?? 200
  let target: Vec3 | null = null
  let hotTicks = 0
  let covered = false
  let dug = false
  let dugStand: Vec3 | null = null
  let watered: Vec3 | null = null
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
        // the water poured scooped up again (the bucket's the portal's and the next fall's)
        if (watered != null && nameAt(bot, watered) === 'water' && bot.inventory.items().some(i => i.name === 'bucket')) {
          const { fillBucket } = await import('./bucket')
          await fillBucket(bot, { fluid: 'water', pos: watered }, opts.signal).catch(err => { if (isAbort(err)) throw err })
          watered = null
        }
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
        // sneaking at once, the floor hurting no more while the way off is worked out (MagmaBlock.stepOn spares a
        // player stepping carefully): a 26.3 bot on a ruined portal's magma among netherrack at y 46 was hurt every 10
        // ticks through 12 hazard reflexes, its step a jump with no room over its head, and it burned (ls4-26.3)
        bot.setControlState('sneak', true)
        // (or the stand a way dug off it leads to, over the magma between: walked sneaking)
        let step = hotFloorStep(bot) ?? dugStand
        if ((step == null || hotTicks > HOT_FLOOR_STEP_TICKS) && !covered) {
          covered = true
          bot.clearControlStates()
          if (await (opts.cover ?? coverHotFloor)(bot, opts.signal)) continue
          bot.setControlState('sneak', true)
        }
        // no step to take, or the one there doesn't get it off (a jump that bonks its head): a way dug through the wall
        // beside it, sneaking the while
        if ((step == null || hotTicks > 2 * HOT_FLOOR_STEP_TICKS) && !dug) {
          dug = true
          const way = hotFloorDigStep(bot)
          if (way != null) {
            bot.clearControlStates()
            bot.setControlState('sneak', true)
            for (const cell of way.dig) {
              const block = bot.blockAt(cell)
              if (block == null) continue
              try {
                await dig(bot, block as any, { signal: opts.signal })
              } catch (err) {
                if (isAbort(err)) throw err
                trace('escapeHazard: no way dug off the magma at', cell.toString(), (err as Error).message)
              }
            }
            if (passable(bot, way.stand, false) && passable(bot, way.stand.offset(0, 1, 0), false)) { step = dugStand = way.stand; hotTicks = 0 }
          }
        }
        if (step != null) {
          steerToward(bot, step.offset(0.5, 0, 0.5), { sprint: false })
          bot.setControlState('sneak', sneakOnMagma(here, step))
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
      // in the overworld's lava with a water bucket: the water poured where the bot is (the lava's cell taken by it,
      // the sources about set to obsidian, the burning put out), once. A 26.3 bot at a deep pool's shore swam in the
      // lava 110 ticks till it died, its water bucket in the bag
      if (inLava(bot) && t >= 2 && watered == null && !inTheNether(bot) && bot.inventory.items().some(i => i.name === 'water_bucket')) {
        watered = here
        bot.clearControlStates()
        const { emptyBucket } = await import('./bucket')
        await emptyBucket(bot, { pos: here, fluid: 'water' }, opts.signal).catch(err => {
          if (isAbort(err)) throw err
          trace('escapeHazard: no water poured:', (err as Error).message)
        })
        continue
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
  /** how far the way to air is looked for (default 8) */
  searchRadius?: number
  /** the game ticks it takes at most (default 300) */
  maxTicks?: number
  /** the air back, out of the water onto dry ground beside it when there is some (default true) */
  climbOut?: boolean
}

/** blocks a bot under water doesn't dig its way up through */
const UNBREAKABLE_CEILING = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate', 'obsidian', 'crying_obsidian', 'lava'])

/** what the escape's searches look at of a cell */
export type CellLookup = (pos: Vec3) => { name: string, boundingBox: string, getProperties?: () => Record<string, unknown> } | null

/** water as the eyes take it (Entity.isEyeInFluid): a water or bubble column block, a water plant, anything waterlogged */
export function isWaterCell (b: ReturnType<CellLookup>): boolean {
  if (b == null) return false
  return b.name === 'water' || b.name === 'bubble_column' || UNDERWATER_PLANTS.has(b.name) || b.getProperties?.()?.waterlogged === true
}

/** a cell a body moves through: nothing solid, no lava or fire (water too) */
function swimmable (b: ReturnType<CellLookup>): boolean {
  return b != null && b.boundingBox === 'empty' && !isDangerBlock(b.name)
}

/** a cell the eyes breathe in: no water in it, nothing solid, no lava or fire */
export function breathable (b: ReturnType<CellLookup>): boolean {
  return swimmable(b) && !isWaterCell(b)
}

/**
 * The block to dig for air when the bot is under a ceiling: up from the eyes' cell through the water (up to 3 cells),
 * the first block that isn't water when it is solid and can be dug (a frozen sea's ice, a cave's roof), else null
 * (air there, or nothing to dig). Ice dug over water turns to water (IceBlock.playerDestroy), with the air over it; a
 * flooded cave's roof dug leaves air in its cell (water flows down and sideways, never up: FlowingFluid.spread), the
 * eyes come up into.
 */
export function ceilingToDig (nameAt: CellLookup, eyes: Vec3): Vec3 | null {
  for (let dy = 1; dy <= 3; dy++) {
    const pos = eyes.offset(0, dy, 0)
    const b = nameAt(pos)
    if (b == null) return null
    if (isWaterCell(b) && b.boundingBox === 'empty') continue
    if (b.boundingBox !== 'block' || UNBREAKABLE_CEILING.has(b.name)) return null
    return pos
  }
  return null
}

const SWIM_DIRS = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]

/**
 * The way from the feet's cell to the nearest one whose head room breathes (breathable: air over water or ground),
 * by a breadth-first search over the cells a body 2 high moves through (water or air, nothing solid, no lava): the
 * cells, the start left out ([] when the start's head room breathes), or null when none is within radius (blocks from
 * the start) and maxNodes cells. A cave's water reaches the air round its walls this way, not by a straight line.
 */
export function pathToAir (lookup: CellLookup, start: Vec3, radius = 8, maxNodes = 6000): Vec3[] | null {
  start = start.floored()
  const ok = (p: Vec3): boolean => swimmable(lookup(p))
  const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`
  const parent = new Map<string, Vec3 | null>([[key(start), null]])
  const queue: Vec3[] = [start]
  for (let head = 0; head < queue.length && head < maxNodes; head++) {
    const p = queue[head]
    if (breathable(lookup(p.offset(0, 1, 0))) && (p.equals(start) || ok(p))) {
      const path: Vec3[] = []
      for (let at: Vec3 | null = p; at != null && !at.equals(start); at = parent.get(key(at)) ?? null) path.unshift(at)
      return path
    }
    for (const d of SWIM_DIRS) {
      const n = p.plus(d)
      if (parent.has(key(n)) || Math.abs(n.x - start.x) > radius || Math.abs(n.y - start.y) > radius || Math.abs(n.z - start.z) > radius) continue
      // up: the head comes into the cell over the old head's; down: the feet into the one under; across: both
      const fits = d.y > 0 ? ok(n) && ok(n.offset(0, 1, 0)) : d.y < 0 ? ok(n) : ok(n) && ok(n.offset(0, 1, 0))
      if (!fits) continue
      parent.set(key(n), p)
      queue.push(n)
    }
  }
  return null
}

/**
 * Dry ground to climb out onto from the water's top: a cell beside the feet's (the four sides), level with them or
 * up to 2 over, solid under it, its cell and the one over it breathable; the nearest, the lowest first. Null when
 * there's none.
 */
export function dryStandBeside (lookup: CellLookup, position: Vec3): Vec3 | null {
  const feet = position.floored()
  let best: { cell: Vec3, d: number } | null = null
  for (const side of CARDINAL_SIDES) {
    for (let dy = 0; dy <= 2; dy++) {
      const cell = feet.plus(side).offset(0, dy, 0)
      if (lookup(cell.offset(0, -1, 0))?.boundingBox !== 'block' || !breathable(lookup(cell)) || !breathable(lookup(cell.offset(0, 1, 0)))) continue
      // the way over: the room over the bot's head for the climb's rise
      if (dy >= 1 && !swimmable(lookup(feet.offset(0, dy + 1, 0)))) continue
      const d = Math.hypot(cell.x + 0.5 - position.x, cell.z + 0.5 - position.z) + dy * 0.1
      if (best == null || d < best.d) best = { cell, d }
      break
    }
  }
  return best?.cell ?? null
}

const CARDINAL_SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

/**
 * How far the box's middle may be from its column's middle and the box still within the column: its half width (0.3)
 * from the 0.5 to the column's sides, less a margin. Rising under a ledge, the box must be clear of it: a 26.3 bot
 * 0.12 into its column, its box under the rock beside the column's air, bumped its head at 36.2 with its eyes 0.07
 * under the water's top and drowned there (full-26.3-fresh-z, t95955); the reflex had stopped steering 0.4 off.
 */
export const COLUMN_TOLERANCE = 0.15

/** ticks a cell of a swim takes, about (LivingEntity.travel in water: 0.02 a tick at 0.8 a tick's drag, ~0.1 a tick) */
export const SWIM_TICKS_PER_CELL = 10

/** ticks a swim to air may go on with no cell gained before the escape turns to digging */
export const SWIM_STUCK_TICKS = 40

/** the blocks the escape puts under its feet to dig from, or to seal its head's cell (the ones carried most) */
const POCKET_FILLERS = CLIMB_FILLERS

/**
 * The keys the escape holds, put on the bot at the start of each tick (physicsTickBegin, before the move): a goto
 * called off but still running (navigate's 'left behind') set its own between the escape's, and the bot's yaw went
 * back and forth a tick each way under the ledge it had to get out from under (full-26.3-fresh-z).
 */
class Helm {
  keys: { forward?: boolean, jump?: boolean, sneak?: boolean } = {}
  yaw: number | null = null
  private readonly listener = (): void => this.apply()

  constructor (private readonly bot: Bot) { bot.on('physicsTickBegin' as any, this.listener) }

  set (keys: Helm['keys'], yaw: number | null = null): void { this.keys = keys; this.yaw = yaw; this.apply() }

  apply (): void {
    for (const k of ['forward', 'back', 'left', 'right', 'sprint'] as const) this.bot.setControlState(k, k === 'forward' && this.keys.forward === true)
    this.bot.setControlState('jump', this.keys.jump === true)
    this.bot.setControlState('sneak', this.keys.sneak === true)
    if (this.yaw != null) void this.bot.look(this.yaw, 0, true)
  }

  release (): void {
    this.bot.off('physicsTickBegin' as any, this.listener)
    this.bot.clearControlStates()
  }
}

/** the yaw that faces the point from the bot (mineflayer's: 0 north, toward -z) */
function yawToward (bot: Bot, x: number, z: number): number {
  return Math.atan2(-(x - bot.entity.position.x), -(z - bot.entity.position.z))
}

/** the inventory's item that digs the block soonest (the bare hand if none beats it), with its ticks under water */
function fastestDigger (bot: Bot, block: Block, onGround: boolean): { item: any | null, ticks: number } {
  // (the helmet's aqua affinity and the effects counted, as mineflayer's bot.digTime does)
  const helmet: any[] = (bot.inventory.slots[bot.getEquipmentDestSlot('head')] as any)?.enchants ?? []
  const effects = (bot.entity as any).effects ?? {}
  const time = (item: any | null): number => typeof block.digTime === 'function'
    ? block.digTime(item?.type ?? null, false, true, !onGround, [...(item?.enchants ?? []), ...helmet], effects) / 50
    : Infinity
  let best: { item: any | null, ticks: number } = { item: null, ticks: time(null) }
  for (const item of bot.inventory.items()) {
    const ticks = time(item)
    if (ticks < best.ticks) best = { item, ticks }
  }
  return best
}

/**
 * Swims up to air and stays there until the air bar is back, then climbs out of the water onto dry ground beside it
 * (climbOut). Each look picks the way the air comes soonest:
 * - a swim (pathToAir): straight up a column whose top breathes, the box first got within the column
 *   (COLUMN_TOLERANCE), or round a cave's walls to its air, cell by cell;
 * - a dig of the ceiling over the head (ceilingToDig) with the best tool carried, from the floor (the bot sunk onto it
 *   when it's near, else a block put under its feet: a dig in water off the ground is 25 times slower,
 *   Player.getDestroySpeed); the roof's cell comes out air, the head swum up into it;
 * - with neither, the head's cell sealed with blocks round it and its water scooped with an empty bucket (bucketPocket).
 * A swim that gains no cell in SWIM_STUCK_TICKS goes to the dig. Under ice with no air in reach (a frozen sea) the ice
 * is dug: the jump alone held a 26.3 bot against the ice until it drowned.
 */
export async function surface (bot: Bot, opts: SurfaceOptions = {}): Promise<{ ticks: number }> {
  const recoverTo = opts.recoverTo ?? 18
  const radius = opts.searchRadius ?? 8
  const maxTicks = opts.maxTicks ?? 300
  const lookup: CellLookup = p => bot.blockAt(p) as any
  let ticks = 0
  const onTick = (): void => { ticks++ }
  const timeLeft = (): boolean => ticks < maxTicks
  bot.on('physicsTick', onTick)
  const helm = new Helm(bot)
  let path: Vec3[] | null = null
  let plannedAt = -Infinity
  let progressAt = 0
  let progressLeft = Infinity
  let swimStuck = false
  let pocketTried = false
  let climbTicks = 0
  let climbTo: Vec3 | null = null
  const failedDigs = new Set<string>()
  let start: Vec3 | null = null
  try {
    // a goto still under way (one a reflex's preemption called off, not yet back) is told again
    void (bot.pathfinder as any)?.cancel?.()?.catch?.(() => {})
    while (timeLeft()) {
      throwIfAborted(opts.signal)
      const pos = bot.entity.position
      // a climb under way goes on through the bobs that put the eyes back under the water's top
      const climbing = climbTicks > 0 && climbTicks < CLIMB_OUT_TICKS && bot.oxygenLevel > CLIMB_MIN_AIR
      if (!headInWater(bot) || climbing) {
        if (bot.oxygenLevel >= recoverTo || climbing) {
          // out onto dry ground: the foreground's walk starts from it, not from a jump over the water it sinks back
          // into (the same 26.3 bot came up under the tunnel 260 times a night, the path planned from its jump each
          // time and failed 'too low' as it sank, until the air ran out: full-26.3-fresh-z)
          // (done once it stands on the ground out of the water: not on its jump out, over the water still)
          const inWater = (bot.entity as any).isInWater === true
          const ashore = bot.entity.onGround && !inWater
          if (climbTo == null && inWater && !ashore && (opts.climbOut ?? true)) climbTo = dryStandBeside(lookup, pos)
          if (climbTo == null || ashore || climbTicks >= CLIMB_OUT_TICKS) {
            if (!headInWater(bot)) return { ticks }
            climbTicks = CLIMB_OUT_TICKS
            continue
          }
          climbTicks++
          helm.set({ forward: true, jump: true }, yawToward(bot, climbTo.x + 0.5, climbTo.z + 0.5))
          await waitTicks(bot, 1, opts.signal)
          continue
        }
        // keep the head up, the box in its column
        const c = pos.floored()
        const off = Math.max(Math.abs(c.x + 0.5 - pos.x), Math.abs(c.z + 0.5 - pos.z))
        helm.set({ forward: off > COLUMN_TOLERANCE, jump: true }, off > COLUMN_TOLERANCE ? yawToward(bot, c.x + 0.5, c.z + 0.5) : null)
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      const feet = pos.floored()
      if (path == null || ticks - plannedAt >= 20 || !(path.some(p => p.equals(feet)) || feet.equals(start as Vec3))) {
        path = swimStuck ? null : pathToAir(lookup, feet, radius)
        plannedAt = ticks
        start = feet
      }
      // drop the cells reached
      if (path != null) {
        const i = path.findIndex(p => p.equals(feet))
        if (i >= 0) path = path.slice(i + 1)
        if (path.length < progressLeft) { progressLeft = path.length; progressAt = ticks }
        if (ticks - progressAt > SWIM_STUCK_TICKS) { swimStuck = true; path = null }
      }
      const eyes = eyePosition(bot).floored()
      const ceiling = ceilingToDig(lookup, eyes)
      const roof = ceiling != null && !failedDigs.has(ceiling.toString()) ? bot.blockAt(ceiling) : null
      const digTicks = roof != null ? fastestDigger(bot, roof, true).ticks + 20 : Infinity
      const swimTicks = path != null ? Math.max(1, path.length) * SWIM_TICKS_PER_CELL : Infinity
      // the way that fits the breath left, the sooner first; the pocket only when neither fits; else the sooner
      const left = breathTicksLeft(bot)
      const pocket = !pocketTried && pocketPossible(bot)
      const swim = path != null && swimTicks <= left && (swimTicks <= digTicks || digTicks > left)
      const digNow = !swim && roof != null && (digTicks <= left || !pocket)
      if (path != null && (swim || (!digNow && !pocket))) {
        swimStep(bot, helm, feet, path)
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      if (digNow && roof != null && ceiling != null) {
        trace('surface: digging the ceiling', roof.name, 'at', ceiling.toString(), 'in about', Math.round(digTicks), 'ticks; the swim', swimTicks, 'the breath left', left)
        const dug = await digCeiling(bot, helm, roof, opts.signal)
        if (!dug) failedDigs.add(ceiling.toString())
        // a new look: the roof's cell open, the swim's way may be the column now
        path = null
        swimStuck = false
        progressLeft = Infinity
        progressAt = ticks
        continue
      }
      if (pocket) {
        pocketTried = true
        trace('surface: an air pocket at the head, the swim', swimTicks, 'and the dig', Math.round(digTicks), 'over the breath left', left)
        if (await bucketPocket(bot, helm, opts.signal)) continue
      }
      // nowhere known: swim up and hope, and look again
      helm.set({ jump: true })
      if (swimStuck && ticks - progressAt > 2 * SWIM_STUCK_TICKS) { swimStuck = false; progressLeft = Infinity; progressAt = ticks }
      await waitTicks(bot, 1, opts.signal)
    }
    throw new TaskError('TIMEOUT', 'no air reached')
  } finally {
    bot.off('physicsTick', onTick)
    helm.release()
  }
}

/**
 * The ticks the bot holds out under water from now, about: its air (15 ticks a bubble), then a drowning hit of 2 every
 * 20 ticks (LivingEntity.baseTick at -20 air) till the health is gone
 */
export function breathTicksLeft (bot: Bot): number {
  return Math.max(0, bot.oxygenLevel) * 15 + Math.max(0, Math.ceil(bot.health / 2) - 1) * 20
}

/** an air pocket can be made where the head is (bucketPocket): an empty bucket, a filler, the head's cell a source */
function pocketPossible (bot: Bot): boolean {
  const water = bot.blockAt(eyePosition(bot).floored())
  return water?.name === 'water' && Number(water.getProperties?.()?.level) === 0 &&
    bot.inventory.items().some(i => i.name === 'bucket') && POCKET_FILLERS.some(n => bot.inventory.items().some(i => i.name === n))
}

/** ticks the escape tries to climb out of the water onto the ground beside it, its air back */
export const CLIMB_OUT_TICKS = 60

/** the air (bot.oxygenLevel) under which a climb out with the eyes under water is let go for the way up again */
export const CLIMB_MIN_AIR = 12

/**
 * A tick of the swim along a way to air: toward the next cell's middle, up with the jump, down with the sneak (in
 * water it sinks the body, LocalPlayer.aiStep's goDownInWater); a cell over or under is gone to only with the box in
 * the column (COLUMN_TOLERANCE)
 */
function swimStep (bot: Bot, helm: Helm, feet: Vec3, path: Vec3[]): void {
  const pos = bot.entity.position
  const next = path[0] ?? feet
  const across = next.x !== feet.x || next.z !== feet.z
  const column = across ? next : feet
  const dx = column.x + 0.5 - pos.x
  const dz = column.z + 0.5 - pos.z
  const off = Math.max(Math.abs(dx), Math.abs(dz))
  const steer = across ? off > 0.05 : off > COLUMN_TOLERANCE
  const down = next.y < feet.y || (path[1] != null && path[1].y < next.y && !across)
  // rising with the box still under a ledge is a head bumped short of the air: centred first
  const rise = !down && (across || off <= COLUMN_TOLERANCE || next.y === feet.y)
  helm.set({ forward: steer, jump: rise, sneak: down }, steer ? yawToward(bot, column.x + 0.5, column.z + 0.5) : null)
}

/**
 * Digs the ceiling block over the head from a stand: the bot sunk onto the floor under it when that's near enough for
 * the block to be in reach from it, else a block put under its feet against a solid side, else as it floats. False when
 * the block stayed (out of reach, the dig refused).
 */
async function digCeiling (bot: Bot, helm: Helm, roof: Block, signal?: AbortSignal): Promise<boolean> {
  const lookup: CellLookup = p => bot.blockAt(p) as any
  if (!bot.entity.onGround) {
    const feet = bot.entity.position.floored()
    let floor: number | null = null
    for (let dy = 1; dy <= 3 && floor == null; dy++) {
      const under = lookup(feet.offset(0, -dy, 0))
      if (under?.boundingBox === 'block') floor = feet.y - dy + 1
      else if (!swimmable(under)) break
    }
    const reach = blockReach(bot)
    if (floor != null && roof.position.y + 0.5 - (floor + 1.62) <= reach - 0.3) {
      // down onto it with the sneak, the jump let go
      helm.set({ sneak: true })
      await waitUntil(bot, () => bot.entity.onGround, 40, signal)
    } else {
      const cell = feet.offset(0, -1, 0)
      const filler = POCKET_FILLERS.find(n => bot.inventory.items().some(i => i.name === n))
      if (filler != null && swimmable(lookup(cell)) && bot.entity.position.y - cell.y >= 1) {
        helm.set({})
        if (await placeInto(bot, cell, filler, signal)) await waitUntil(bot, () => bot.entity.onGround, 20, signal)
      }
    }
  }
  helm.set({})
  const { item } = fastestDigger(bot, roof, bot.entity.onGround)
  try {
    if (item != null && bot.heldItem?.type !== item.type) await bot.equip(item, 'hand')
    await dig(bot, roof, { signal })
  } catch (err) {
    if (isAbort(err)) throw err
    trace('surface: the ceiling not dug:', (err as Error).message)
  }
  // the water about it settles (a fluid's tick is 5)
  await waitTicks(bot, 2, signal)
  return bot.blockAt(roof.position)?.boundingBox !== 'block'
}

/** puts the filler into the (water or air) cell against a solid block beside it, the crosshair on its face */
async function placeInto (bot: Bot, cell: Vec3, filler: string, signal?: AbortSignal): Promise<boolean> {
  const item = bot.inventory.items().find(i => i.name === filler)
  if (item == null) return false
  for (const face of [new Vec3(0, -1, 0), ...CARDINAL_SIDES, new Vec3(0, 1, 0)]) {
    const against = bot.blockAt(cell.plus(face))
    if (against?.boundingBox !== 'block' || !withinReach(bot, against.position)) continue
    try {
      if (bot.heldItem?.type !== item.type) await bot.equip(item, 'hand')
      throwIfAborted(signal)
      if (await placeAgainst(bot, against as any, face.scaled(-1))) {
        await waitTicks(bot, 2, signal)
        if (bot.blockAt(cell)?.boundingBox === 'block') return true
      }
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return false
}

/**
 * An air pocket where the head is, with nothing else for it (no way to air, no ceiling to dig): the water cells round
 * the head's cell (its sides and over it) filled with blocks, then the head's water scooped with an empty bucket
 * (BucketItem.use takes a source block, and the cell sealed, none flows back into it: FlowingFluid.spread). True when
 * the head's cell came out of the water.
 */
async function bucketPocket (bot: Bot, helm: Helm, signal?: AbortSignal): Promise<boolean> {
  const bucket = bot.inventory.items().find(i => i.name === 'bucket')
  const filler = POCKET_FILLERS.find(n => bot.inventory.items().some(i => i.name === n))
  if (bucket == null || filler == null || !pocketPossible(bot)) return false
  // up against the ceiling first, if one's near: the sides of the head's cell then have its underside to go against
  helm.set({ jump: true })
  await waitUntil(bot, () => bot.blockAt(eyePosition(bot).floored().offset(0, 1, 0))?.boundingBox === 'block', 30, signal)
  const head = eyePosition(bot).floored()
  if (!pocketPossible(bot)) return false
  for (const side of [new Vec3(0, 1, 0), ...CARDINAL_SIDES]) {
    const cell = head.plus(side)
    if (!isWaterCell(bot.blockAt(cell) as any)) continue
    if (!await placeInto(bot, cell, filler, signal)) { trace('surface: the pocket side at', cell.toString(), 'not sealed'); return false }
  }
  try {
    await bot.equip(bucket, 'hand')
    await bot.lookAt(head.offset(0.5, 0.5, 0.5), true)
    bot.activateItem()
    await waitTicks(bot, 2, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('surface: no pocket scooped:', (err as Error).message)
  }
  trace('surface: pocket scooped at', head.toString(), 'now', bot.blockAt(head)?.name)
  return !headInWater(bot)
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
 * ticks fleeFrom keeps running from a threat after it was last among its threats (in sight): the flee ended as a
 * skeleton or a creeper went out of sight a step on, the task walked back into its sight, and the reflex fled a step
 * again, 230 times in 3400 ticks; a 26.3 bot bare by its death spot dithered so in a skeleton's sight till it was shot
 * dead twice (full-26.3-fresh-d), and one hunting a cow at a creeper's edge of sight till it blew (nether-26.3-q3)
 */
export const FLEE_MEMORY = 60

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
      } else if (cornered && !hasShield) {
        // nowhere to run and no shield (a tunnel): hit it, each hit's knockback putting it back from the bot (its
        // fuse runs within 7 of it, SwellGoal; a kill stops it); stood still, a 26.3 bot at y 11 was blown up
        // (nether-26.3-q3)
        bot.clearControlStates()
        const weapon = bestMeleeWeapon(bot, 'creeper')
        if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
        const { yaw, pitch } = yawPitchOf(creeper.position.offset(0, 0.9, 0).minus(eyePosition(bot)))
        await bot.look(yaw, pitch, true)
        const strength = attackStrengthOf(bot)
        if (distanceToBox(eyePosition(bot), entityBox(creeper)) <= 2.9 && strength.scale(0.5) >= 1) strength.attack(creeper)
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

/** Runs from the threats until none is within distance (leaning toward `toward`, the base say, when given: fleeHeading). */
export async function fleeFrom (bot: Bot, threats: () => Entity[], opts: SkillOptions & { distance?: number, maxTicks?: number, toward?: Vec3 } = {}): Promise<{ ticks: number }> {
  const distance = opts.distance ?? 16
  const maxTicks = opts.maxTicks ?? 300
  // each threat kept FLEE_MEMORY ticks after it was last among `threats` (out of sight behind a tree or a rise)
  const seen = new Map<number, { e: Entity, at: number }>()
  try {
    for (let t = 0; t < maxTicks; t++) {
      throwIfAborted(opts.signal)
      for (const e of threats()) seen.set(e.id, { e, at: t })
      const near = [...seen.values()].filter(s => t - s.at <= FLEE_MEMORY).map(s => s.e).filter(e => isAlive(bot, e) && bot.entities[e.id] != null && e.position.distanceTo(bot.entity.position) < distance)
      if (near.length === 0) return { ticks: t }
      const centroid = near.reduce((sum, e) => sum.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / near.length)
      if (!steerAway(bot, centroid, opts.toward)) throw new TaskError('NO_PATH', 'cornered')
      await waitTicks(bot, 1, opts.signal)
    }
    throw new TaskError('TIMEOUT', 'still chased')
  } finally {
    bot.clearControlStates()
  }
}
