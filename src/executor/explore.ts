// Looking for what the plan needs when neither the loaded chunks nor the memory show one: a square spiral out over
// the surface (trees, animals, water, sand), and for ores a staircase down to the ore's best level and a tunnel
// along it. Every block opened is checked for lava (and water) around it first, so the bot stays out of both.
import type { Bot } from 'mineflayer'
import { TORCH_SPACING } from '../planner/schedule'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { findBlocks } from '../core/findBlocks'
import { SkillError, isAbort, isSkillError, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { navigate, walkTo } from '../skills/navigate'
import { settlePickups } from '../skills/pickupDrops'
import { keepRoom } from '../skills/bag'
import { headInWater, surface } from '../skills/escape'
import { placeBlock } from '../skills/placeBlock'
import { AIR_BLOCKS, CARDINALS, countItems, trace, waitUntil } from '../skills/util'
import { isInfested } from '../core/infested'
import { DIGGING_PICKAXE, wantsDiggingPickaxe } from '../skills/digTool'
import { atCave, caveRuleOn, caveStep, sealCaveOpenings, withCavesShut } from '../skills/caves'

export type Lookup = (pos: Vec3) => { name: string, boundingBox: string } | null

/**
 * The y to mine an ore at in 1.21.11 (the ore features of OrePlacements): iron's middle triangle peaks at 16 (it peaks
 * again at 232 in mountains), diamonds' triangle at -59 (from -64, rising to 16: -58 keeps the bedrock below), gold at
 * -16, redstone and lapis (both near the bottom) at -58 and 0, coal at 96, copper at 48, emerald in mountains at 100.
 */
export const ORE_LEVELS: Record<string, number> = {
  iron_ore: 16,
  deepslate_iron_ore: 16,
  diamond_ore: -58,
  deepslate_diamond_ore: -58,
  gold_ore: -16,
  deepslate_gold_ore: -16,
  redstone_ore: -58,
  deepslate_redstone_ore: -58,
  lapis_ore: 0,
  deepslate_lapis_ore: 0,
  coal_ore: 96,
  deepslate_coal_ore: 0,
  copper_ore: 48,
  deepslate_copper_ore: 48,
  emerald_ore: 100,
  deepslate_emerald_ore: 100
}

/** the level to mine for any of the blocks, or null when none is an ore (the deepest of their levels below the bot first) */
export function oreLevel (blocks: readonly string[]): number | null {
  const levels = blocks.map(b => ORE_LEVELS[b]).filter((y): y is number => y != null)
  return levels.length === 0 ? null : Math.min(...levels)
}

/** the corners of a square spiral out from `center`, `step` blocks a side to start, out to `maxRadius` */
export function spiralWaypoints (center: { x: number, z: number }, step: number, maxRadius: number): Array<{ x: number, z: number }> {
  const out: Array<{ x: number, z: number }> = []
  let x = Math.floor(center.x)
  let z = Math.floor(center.z)
  // east, south, west, north, each leg one step longer every second turn
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  let leg = 1
  for (let i = 0; ; i++) {
    const [dx, dz] = dirs[i % 4]
    x += dx * leg * step
    z += dz * leg * step
    if (Math.max(Math.abs(x - center.x), Math.abs(z - center.z)) > maxRadius) break
    out.push({ x, z })
    if (i % 2 === 1) leg++
  }
  return out
}

const LIQUIDS = new Set(['lava', 'water', 'bubble_column'])

/** whether opening `cell` lets lava or water in (or onto the bot): the cell itself or a neighbour holds one */
export function liquidAround (lookup: Lookup, cell: Vec3): string | null {
  for (const d of [new Vec3(0, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), ...CARDINALS]) {
    const name = lookup(cell.plus(d))?.name
    if (name != null && LIQUIDS.has(name)) return `${name} at ${cell.plus(d).toString()}`
  }
  return null
}

/**
 * The cells to open for one step of a staircase down from feet `feet` along `dir`: the head room over the next
 * column, the cell the bot walks through, and the new feet cell a block lower (its head is the walked-through cell).
 */
export function staircaseStep (feet: Vec3, dir: Vec3): { open: Vec3[], next: Vec3, floor: Vec3 } {
  const ahead = feet.plus(dir)
  return { open: [ahead.offset(0, 1, 0), ahead, ahead.offset(0, -1, 0)], next: ahead.offset(0, -1, 0), floor: ahead.offset(0, -2, 0) }
}

/** the cells of a tunnel step: the feet and head cells of the next column */
export function tunnelStep (feet: Vec3, dir: Vec3): { open: Vec3[], next: Vec3, floor: Vec3 } {
  const ahead = feet.plus(dir)
  return { open: [ahead, ahead.offset(0, 1, 0)], next: ahead, floor: ahead.offset(0, -1, 0) }
}

/**
 * why a step is unsafe (lava or water next to a cell it opens, nothing to stand on over a drop into lava, pointed
 * dripstone in a cell it opens, as its floor or under it: a dripstone cave's stalagmites), or null
 */
export function unsafeStep (lookup: Lookup, step: { open: Vec3[], floor: Vec3 }): string | null {
  for (const cell of step.open) {
    const liquid = liquidAround(lookup, cell)
    if (liquid != null) return liquid
  }
  // an infested block is never opened: its silverfish, and the nest it wakes (isInfested; f5-26.3)
  for (const cell of step.open) {
    const name = lookup(cell)?.name
    if (isInfested(name)) return `${name ?? 'an infested block'} at ${cell.toString()}`
  }
  // a stalagmite stood on or fallen onto impales (PointedDripstoneBlock.fallOn), and a stalactite whose block is
  // broken falls (a 26.3 staircase to the deep lava came out in a dripstone cave, where the bot was impaled)
  for (const cell of step.open) {
    if (lookup(cell)?.name === 'pointed_dripstone') return `pointed dripstone at ${cell.toString()}`
  }
  // (the floor, and down a cave under it to its ground)
  for (let dy = 0; dy >= -3; dy--) {
    const cell = step.floor.offset(0, dy, 0)
    const b = lookup(cell)
    if (b?.name === 'pointed_dripstone') return `pointed dripstone at ${cell.toString()}`
    if (b == null || b.boundingBox === 'block') break
  }
  // the floor and what's under it: a bot doesn't stand over lava (a block broken under it drops it in)
  for (let dy = 0; dy >= -2; dy--) {
    const name = lookup(step.floor.offset(0, dy, 0))?.name
    if (name === 'lava') return `lava under ${step.floor.toString()}`
    if (name != null && !AIR_BLOCKS.has(name) && name !== 'water') break
  }
  return null
}

/**
 * Whether a step's floor is there to stand on, or can be put there (`plug`: a building block carried) against a solid
 * block beside it that the step doesn't open: checked before the step's cells are dug. A staircase down from a bridge
 * the pathfinder built over a valley (26.3 seed 31337, at y 144) opened the bridge's block behind it each step, found
 * no floor under it (nothing left to put one against), and turned to a level step along the bridge: 32 steps cut it
 * behind the bot, which was left on one block in the air with no way anywhere ('no safe way down', then noPath for
 * every goal, and the game stopped).
 */
export function floorHeld (lookup: Lookup, step: { open: Vec3[], floor: Vec3 }, plug: boolean): boolean {
  if (lookup(step.floor)?.boundingBox === 'block') return true
  if (!plug) return false
  const opened = (p: Vec3): boolean => step.open.some(o => o.equals(p))
  return [new Vec3(0, -1, 0), new Vec3(0, 1, 0), ...CARDINALS].some(d => {
    const p = step.floor.plus(d)
    return !opened(p) && lookup(p)?.boundingBox === 'block'
  })
}

/** blocks a pickaxe doesn't break (Blocks' destroyTime -1) or a nook isn't dug into */
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate', 'obsidian', 'crying_obsidian', 'spawner'])

/**
 * A wall block beside the bot's feet to dig out for a block to be put in (a table or a furnace in a one-wide tunnel or
 * a shaft, where every cell around is rock): a solid block at feet level with a solid one under it, no liquid next to
 * it, nothing a click opens. Null when there's none.
 */
export function nookCell (lookup: Lookup, feet: Vec3): Vec3 | null {
  for (const d of CARDINALS) {
    const cell = feet.plus(d)
    if (isNookCell(lookup, cell)) return cell
  }
  return null
}

function isNookCell (lookup: Lookup, cell: Vec3): boolean {
  const b = lookup(cell)
  // (nor what the bot built: a fence of the herd's pen, a wall; a 26.3 bot with no room for its furnace in the pen dug
  // a nook through its ring, and the herd walked out)
  if (b == null || b.boundingBox !== 'block' || UNBREAKABLE.has(b.name) || /(chest|furnace|table|barrel|bed|door|fence|wall)/.test(b.name)) return false
  if (lookup(cell.offset(0, -1, 0))?.boundingBox !== 'block') return false
  return liquidAround(lookup, cell) == null
}

/**
 * Room for a block next to the bot where there's none: a nook dug into the wall beside its feet (nookCell). Resolves
 * whether one was dug.
 */
export async function digNook (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const cell = nookCell(lookupOf(bot), feetOf(bot))
  if (cell == null) return false
  trace('explore: digging a nook at', cell.toString())
  try {
    await open(bot, [cell], signal)
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no nook', (err as Error).message)
    return false
  }
}

/**
 * A place off the way for a chest (a mine depot): a nook two high dug into the wall beside the bot's feet (nookCell,
 * and the block over it, so the chest opens: ChestBlock.isChestBlockedAt), or null when there's no wall to dig into.
 * The chest stands out of the staircase or tunnel, which the way back walks.
 */
export async function digDepotNook (bot: Bot, signal?: AbortSignal): Promise<Vec3 | null> {
  const lookup = lookupOf(bot)
  const feet = feetOf(bot)
  for (const d of CARDINALS) {
    const cell = feet.plus(d)
    if (!isNookCell(lookup, cell)) continue
    const over = lookup(cell.offset(0, 1, 0))
    if (over == null || UNBREAKABLE.has(over.name) || LIQUIDS.has(over.name) || liquidAround(lookup, cell.offset(0, 1, 0)) != null) continue
    trace('explore: digging a depot nook at', cell.toString())
    try {
      await open(bot, [cell.offset(0, 1, 0), cell], signal)
      return cell
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: no depot nook', (err as Error).message)
    }
  }
  return null
}

/**
 * Which cells round the bot a pit may go in, of the way `facing` it goes next: 'any', a side first, then behind, ahead
 * last; 'behind', behind it, then its sides, never ahead (a trip's: the bot walks away from it); 'sides', its sides
 * only (a dug route's next step: behind is the way back, ahead the way on)
 */
export type PitWays = 'any' | 'behind' | 'sides'

/**
 * A pit beside the bot's feet to throw what it doesn't want into: the column of the side cell `side` (feet level),
 * opened from head height down to `depth` blocks under the floor, `bottom` the cell the items lie in. An item there is
 * out of the bot's reach as it walks by (Player.aiStep touches what its box, inflated by 0.5 vertically, meets: the
 * item's top is 0.75 under the floor at a depth of 1), and the pit is off the way (`ways`, of the way `facing` the bot
 * goes next). A staircase's next step is a block lower, its box down to 0.5 over the floor of a pit 1 deep beside
 * it: its pit goes 2 down (a 26.3 staircase to the deep lava threw its dirt into the pit at its side and picked it up
 * with the next step, 30 steps running). Rock under the bottom, no liquid against the cells, nothing that doesn't
 * break; null when no side will do.
 */
export function dumpPitCells (lookup: Lookup, feet: Vec3, facing: Vec3, ways: PitWays = 'any', depth = 1): { side: Vec3, bottom: Vec3, open: Vec3[] } | null {
  const left = new Vec3(-facing.z, 0, facing.x)
  const order = ways === 'sides' ? [left, left.scaled(-1)] : ways === 'behind' ? [facing.scaled(-1), left, left.scaled(-1)] : [left, left.scaled(-1), facing.scaled(-1), facing]
  for (const d of order) {
    const side = feet.plus(d)
    const bottom = side.offset(0, -depth, 0)
    const cells = [side.offset(0, 1, 0), side]
    for (let dy = 1; dy <= depth; dy++) cells.push(side.offset(0, -dy, 0))
    if (lookup(bottom.offset(0, -1, 0))?.boundingBox !== 'block') continue
    if (cells.some(c => { const b = lookup(c); return b == null || UNBREAKABLE.has(b.name) || /(chest|furnace|table|barrel|bed|door|torch|portal)/.test(b.name) || liquidAround(lookup, c) != null })) continue
    return { side, bottom, open: cells }
  }
  return null
}

/** how far off a `toward` is a dug route's next step (the cell beside the bot it walks into), not a trip's goal */
const ROUTE_STEP_RANGE = 2

/**
 * How deep a pit goes under the floor where it can (a block less where it can't): what lies in a pit 2 deep is out of
 * the reach of the bot walking by on its floor and of one a block lower (Player.aiStep's box inflated 0.5 down meets an
 * item 0.75 under its feet, not 1.75). A 26.3 bot's pits 1 deep beside it, its makeRoom between steps with no
 * `toward`, were walked by a block lower on the way to the next ore, the stone picked up again each time, and the
 * third throw refused (full-26.3-fresh-f)
 */
export const PIT_DEPTH = 2

/**
 * Where a pit goes for a bot at `feet` (its look `yaw`) that goes to `toward` next: by a dug route's next step or the
 * block it breaks next (a cell within ROUTE_STEP_RANGE), to its sides, 2 under the floor (a step a block down and one
 * more); behind a trip's way (farther off); else (`toward` over or under the feet, or none) by the facing
 * (dumpPitCells); PIT_DEPTH deep but by a route's step, a block less where no side has the rock for it
 */
export function dumpPitFor (lookup: Lookup, feet: Vec3, yaw: number, toward?: Vec3): ReturnType<typeof dumpPitCells> {
  const deepest = (facing: Vec3, ways: PitWays): ReturnType<typeof dumpPitCells> => dumpPitCells(lookup, feet, facing, ways, PIT_DEPTH) ?? dumpPitCells(lookup, feet, facing, ways, PIT_DEPTH - 1)
  // from the feet's cell to the cell of `toward` (a goal's block, a block, a point): a GoalBlock's corner seen from the
  // bot off its cell's middle pointed along the route, the pit dug in the next step's floor
  const dx = toward != null ? Math.floor(toward.x) - feet.x : 0
  const dz = toward != null ? Math.floor(toward.z) - feet.z : 0
  const dist = Math.hypot(dx, dz)
  if (toward != null && dist >= 1) {
    const way = facingDir(Math.atan2(-dx, -dz))
    if (dist <= ROUTE_STEP_RANGE) return dumpPitCells(lookup, feet, way, 'sides', 2 + Math.min(1, Math.max(0, feet.y - Math.floor(toward.y) - 1)))
    const behind = deepest(way, 'behind')
    if (behind != null) return behind
  }
  return deepest(facingDir(yaw), 'any')
}

/**
 * Digs a pit beside the bot (dumpPitFor) to throw things into, or finds the one dug before beside it still open;
 * the cell the items are to land in, or null. `toward`: where the bot goes next (the pit off its way: beside a dug
 * route's next step and under its reach, behind a trip)
 */
export async function dumpPit (bot: Bot, signal?: AbortSignal, toward?: Vec3): Promise<Vec3 | null> {
  const cells = dumpPitFor(lookupOf(bot), feetOf(bot), bot.entity.yaw, toward)
  if (cells == null) return null
  if (cells.open.every(c => isOpen(bot, c))) return cells.bottom
  trace('explore: digging a pit to throw into at', cells.side.toString())
  // (twice: a dig the pathfinder left going aborts the first)
  for (let tries = 0; tries < 2; tries++) {
    try {
      await open(bot, cells.open, signal)
      return cells.bottom
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: no pit', (err as Error).message)
    }
  }
  return null
}

/** a thrown stack's flight (Player.drop, ItemEntity.tick): its gravity, its drag in the air, its speed along the look */
const ITEM_GRAVITY = 0.04
const ITEM_DRAG = 0.98
const THROW_SPEED = 0.3
/** Player.drop's lift and its random part up or down (random.nextFloat() - random.nextFloat()) * 0.1 */
const THROW_LIFT = 0.1
const THROW_LIFT_SPREAD = 0.1
/** an item entity's box: 0.25 a side (EntityType.ITEM) */
const ITEM_HALF = 0.125

/**
 * Where a stack thrown along the look `yaw`, `pitch` (mineflayer's: yaw 0 to -z, pitch up) by a player whose eyes are at
 * `eye` goes, with its random lift `lift` (Player.drop: spawned at the eyes less 0.3, at 0.3 a tick along the look and
 * 0.1 up; ItemEntity.tick: the gravity, the move stopped by solid blocks, the air's drag): 'lava' once its box is in a
 * lava block, else where it comes to rest (null: still flying after 60 ticks)
 */
export function itemFlight (lookup: Lookup, eye: Vec3, yaw: number, pitch: number, lift = THROW_LIFT): 'lava' | Vec3 | null {
  const pos = eye.offset(0, -0.3, 0)
  const v = new Vec3(-Math.sin(yaw) * Math.cos(pitch) * THROW_SPEED, Math.sin(pitch) * THROW_SPEED + lift, -Math.cos(yaw) * Math.cos(pitch) * THROW_SPEED)
  // the cells the item's box (pos the bottom's middle) is in
  const cells = (p: Vec3): Vec3[] => {
    const out: Vec3[] = []
    for (let x = Math.floor(p.x - ITEM_HALF); x <= Math.floor(p.x + ITEM_HALF); x++) {
      for (let y = Math.floor(p.y); y <= Math.floor(p.y + 2 * ITEM_HALF); y++) {
        for (let z = Math.floor(p.z - ITEM_HALF); z <= Math.floor(p.z + ITEM_HALF); z++) out.push(new Vec3(x, y, z))
      }
    }
    return out
  }
  const solid = (p: Vec3): boolean => cells(p).some(c => lookup(c)?.boundingBox === 'block')
  for (let tick = 0; tick < 60; tick++) {
    v.y -= ITEM_GRAVITY
    let grounded = false
    for (const axis of ['x', 'y', 'z'] as const) {
      const next = pos.clone()
      next[axis] += v[axis]
      if (solid(next)) {
        // (down onto the full block it hit: on its top)
        if (axis === 'y' && v.y < 0) {
          grounded = true
          const top = Math.floor(next.y) + 1
          if (top <= pos.y && !solid(new Vec3(pos.x, top, pos.z))) pos.y = top
        }
        v[axis] = 0
      } else {
        pos[axis] = next[axis]
      }
    }
    if (cells(pos).some(c => lookup(c)?.name === 'lava')) return 'lava'
    if (grounded) return pos
    v.x *= ITEM_DRAG
    v.y *= ITEM_DRAG
    v.z *= ITEM_DRAG
  }
  return null
}

/**
 * A throw into lava near the bot (lava burns a thrown stack: Entity.lavaHurt, an item's 5 health gone in two ticks),
 * where nothing thrown can ever be picked up again: the look (yaw, pitch) whose flight ends in lava with Player.drop's
 * lift at both ends of its spread and between, toward the lava within 6 blocks across and 8 down, the nearest first;
 * null when none does. A pit beside the bot wasn't out of its reach for good: by a 26.3 lake the bot mining the lake's obsidian came
 * down beside the pit and picked its stone up again.
 */
export function lavaThrow (lookup: Lookup, feet: Vec3, eyeHeight = 1.62): { yaw: number, pitch: number, lava: Vec3 } | null {
  const eye = feet.offset(0, eyeHeight, 0)
  const base = feet.floored()
  const lava: Vec3[] = []
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -8; dy <= 1; dy++) {
        const p = base.offset(dx, dy, dz)
        if ((dx !== 0 || dz !== 0) && lookup(p)?.name === 'lava') lava.push(p)
      }
    }
  }
  lava.sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(eye) - b.offset(0.5, 0.5, 0.5).distanceTo(eye))
  for (const p of lava.slice(0, 12)) {
    const yaw = Math.atan2(-(p.x + 0.5 - eye.x), -(p.z + 0.5 - eye.z))
    for (let deg = -80; deg <= 30; deg += 5) {
      const pitch = deg * Math.PI / 180
      const lands = [-THROW_LIFT_SPREAD, 0, THROW_LIFT_SPREAD].every(spread => itemFlight(lookup, eye, yaw, pitch, THROW_LIFT + spread) === 'lava')
      if (lands) return { yaw, pitch, lava: p }
    }
  }
  return null
}

/**
 * A throw into the pit `bottom` (dumpPitCells) from a bot at `pos`: the look (yaw, pitch) whose flight (itemFlight)
 * comes to rest in the pit's bottom cell with Player.drop's lift at both ends of its spread and between, the steepest
 * first; null when none does. Aimed at the bottom's middle, a pit 2 deep beside a one-wide staircase took a look so
 * steep that the stack came down on the edge of the bot's own floor (an item's box is 0.25 wide) and was picked up there.
 */
export function pitThrow (lookup: Lookup, pos: Vec3, bottom: Vec3, eyeHeight = 1.62): { yaw: number, pitch: number } | null {
  const eye = pos.offset(0, eyeHeight, 0)
  const yaw = Math.atan2(-(bottom.x + 0.5 - eye.x), -(bottom.z + 0.5 - eye.z))
  const inPit = (at: Vec3): boolean => Math.floor(at.y) === bottom.y &&
    Math.floor(at.x - ITEM_HALF) === bottom.x && Math.floor(at.x + ITEM_HALF) === bottom.x &&
    Math.floor(at.z - ITEM_HALF) === bottom.z && Math.floor(at.z + ITEM_HALF) === bottom.z
  for (let deg = -80; deg <= 30; deg += 5) {
    const pitch = deg * Math.PI / 180
    const lands = [-THROW_LIFT_SPREAD, 0, THROW_LIFT_SPREAD].every(spread => {
      const at = itemFlight(lookup, eye, yaw, pitch, THROW_LIFT + spread)
      return at instanceof Vec3 && inPit(at)
    })
    if (lands) return { yaw, pitch }
  }
  return null
}

function lookupOf (bot: Bot): Lookup {
  return pos => bot.blockAt(pos) as any
}

function isOpen (bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos)
  return b != null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name)
}

/** the horizontal direction the bot looks along, snapped to a cardinal */
export function facingDir (yaw: number): Vec3 {
  // mineflayer's yaw: 0 looks to -z, increasing counter-clockwise seen from above (to -x at pi/2)
  const x = -Math.sin(yaw)
  const z = -Math.cos(yaw)
  return Math.abs(x) > Math.abs(z) ? new Vec3(Math.sign(x), 0, 0) : new Vec3(0, 0, Math.sign(z))
}

export interface ExploreArgs {
  /** stop once this holds (checked after each leg and before setting out) */
  found: () => boolean
  /** where the spiral turns around (default the bot) */
  center?: Vec3
  /** the spiral's first leg (default 16) */
  step?: number
  maxRadius?: number
  /** blocks to note in the memory along the way */
  remember?: string[]
  memory?: WorldMemory
  /**
   * the legs walked so far, kept by the caller across the attempts a reflex's preemption makes: a step preempted
   * every few ticks (swimming, a fight) started its spiral over each time, 1400 times on seed 5, and never left the
   * first leg
   */
  progress?: { leg: number }
  /** the legs within this of the center passed over (walked by an exploration before, which found nothing) */
  skipWithin?: number
}

/** notes the blocks of the given names within `radius` in the memory */
export function rememberAround (bot: Bot, memory: WorldMemory, names: readonly string[], radius = 48, perName = 32): number {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  if (ids.length === 0) return 0
  const dimension = normalizeDimension(bot.game?.dimension)
  let n = 0
  const counts = new Map<number, number>()
  for (const pos of findBlocks(bot, { matching: ids, maxDistance: radius, count: perName * ids.length })) {
    const block = bot.blockAt(pos)
    if (block == null) continue
    const seen = counts.get(block.type) ?? 0
    if (seen >= perName) continue
    counts.set(block.type, seen + 1)
    memory.rememberBlock(block.name, pos, dimension)
    n++
  }
  return n
}

const TREE = /_(leaves|log|wood)$/

/**
 * Under the open sky: nothing above the cell that a body stands on or swims in, up to 64 blocks (leaves and logs
 * left out: under a tree is outdoors). Heightmap-free, from the client's chunks.
 */
export function openSky (lookup: Lookup, feet: Vec3, limit = 64): boolean {
  for (let dy = 2; dy <= limit; dy++) {
    const b = lookup(feet.offset(0, dy, 0))
    if (b == null) return true
    if (TREE.test(b.name)) continue
    if (b.boundingBox === 'block' || LIQUIDS.has(b.name)) return false
  }
  return true
}

/**
 * What tops a column in the loaded chunks, looked down from 40 blocks above `y` to 40 below: the first block that
 * isn't air or a tree (water for the sea), or null where the column isn't loaded or is all air
 */
export function columnSurface (lookup: Lookup, x: number, z: number, y: number): string | null {
  for (let at = y + 40; at > y - 40; at--) {
    const b = lookup(new Vec3(x, at, z))
    if (b == null) return null
    if (AIR_BLOCKS.has(b.name) || TREE.test(b.name)) continue
    return b.name
  }
  return null
}

/** the feet (or the head) in water */
export function inWater (bot: Bot): boolean {
  const feet = bot.blockAt(bot.entity.position.floored())
  return feet?.name === 'water' || headInWater(bot)
}

/** the nearest column in the loaded chunks topped by something but water, 4 to 32 blocks off in the eight directions */
export function nearestShore (lookup: Lookup, from: Vec3): Vec3 | null {
  for (const r of [4, 8, 12, 16, 24, 32]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = Math.floor(from.x) + dx * r
      const z = Math.floor(from.z) + dz * r
      const top = columnSurface(lookup, x, z, Math.floor(from.y))
      if (top != null && top !== 'water' && !LIQUIDS.has(top)) return new Vec3(x, from.y, z)
    }
  }
  return null
}

/** how far across (and up or down: DRY_STAND_RISE) the shore's dry cells are looked for from the water (dryStandNear) */
export const DRY_STAND_RADIUS = 8
export const DRY_STAND_RISE = 4

/**
 * The nearest cell to stand in on dry ground by the water the bot is in: its feet's and head's cells open and no
 * liquid, a full block under them that isn't one, within DRY_STAND_RADIUS across, DRY_STAND_RISE down and 6 more up
 * (out of a flooded pit, up its walls). Null when there's none.
 */
export function dryStandNear (lookup: Lookup, from: Vec3): Vec3 | null {
  const f = from.floored()
  let best: Vec3 | null = null
  let bestScore = Infinity
  const dry = (p: Vec3): boolean => { const b = lookup(p); return b != null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name) && !/kelp|seagrass/.test(b.name) }
  for (let dx = -DRY_STAND_RADIUS; dx <= DRY_STAND_RADIUS; dx++) {
    for (let dz = -DRY_STAND_RADIUS; dz <= DRY_STAND_RADIUS; dz++) {
      for (let dy = -DRY_STAND_RISE; dy <= DRY_STAND_RISE + 6; dy++) {
        const c = f.offset(dx, dy, dz)
        const score = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
        if (score >= bestScore) continue
        if (!dry(c) || !dry(c.offset(0, 1, 0))) continue
        const under = lookup(c.offset(0, -1, 0))
        if (under == null || under.boundingBox !== 'block' || LIQUIDS.has(under.name)) continue
        best = c
        bestScore = score
      }
    }
  }
  return best
}

/** ticks swimTo swims for a dry stand at most */
export const SWIM_OUT_TICKS = 200
/** ticks toShore swims for a shore's column (up to 32 off) at most */
export const SWIM_SHORE_TICKS = 600

/** the y of the highest solid block of a column within 40 of `y`, null for none (a shore's top) */
function columnTopOf (lookup: Lookup, x: number, z: number, y: number): number | null {
  for (let at = y + 40; at > y - 40; at--) {
    const b = lookup(new Vec3(x, at, z))
    if (b != null && b.boundingBox === 'block' && !TREE.test(b.name)) return at
  }
  return null
}

/**
 * Swims to a dry stand by hand (the keys, as a player does: forward toward it, the jump held to keep up and climb out
 * onto it), till out of the water or SWIM_OUT_TICKS; resolves whether the bot's out. A 1.21.11 Grim game's bot in a
 * pond whose pathfinder moves out all failed 'bot is too low' was taken up by the drowning reflex 71 times in 48000
 * ticks, never out of the pond (f1-grim resumed from its diamonds, t77572 to t109250).
 */
export async function swimTo (bot: Bot, stand: Vec3, signal?: AbortSignal, ticks = SWIM_OUT_TICKS): Promise<boolean> {
  const { steerToward } = await import('../skills/steer')
  try {
    for (let t = 0; t < ticks && inWater(bot); t++) {
      throwIfAborted(signal)
      steerToward(bot, stand.offset(0.5, 0, 0.5), { sprint: false })
      bot.setControlState('jump', true)
      await waitUntil(bot, () => false, 1, signal)
    }
  } finally {
    bot.clearControlStates()
  }
  return !inWater(bot)
}

/**
 * out of the water onto dry ground: the nearest dry cell by it (dryStandNear) walked to, else the nearest shore
 * (nearestShore), swimming up first; resolves whether the bot is out. A GoalNearXZ of 2 by the shore's column ended
 * with the bot still swimming at a flooded pit's top, and the next walk took it down the pit again, the drowning reflex
 * every 320 ticks (grimls-2, t155000 on)
 */
export async function toShore (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  if (headInWater(bot)) await surface(bot, { signal, maxTicks: 200 }).catch(err => { if (isAbort(err)) throw err })
  const stand = dryStandNear(lookupOf(bot), bot.entity.position)
  if (stand != null) {
    trace('explore: in the water: to dry ground at', stand.toString())
    try {
      await navigate(bot, { goal: new goals.GoalBlock(stand.x, stand.y, stand.z), maxTicks: 600 }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: no way to', stand.toString(), (err as Error).message)
    }
    if (!inWater(bot)) return true
    // the pathfinder's way out of the water failing (its moves from a swimmer 'bot is too low'): swum out by hand
    if (await swimTo(bot, stand, signal)) return true
  }
  const shore = nearestShore(lookupOf(bot), bot.entity.position)
  if (shore == null) return !inWater(bot)
  trace('explore: in the water: to the shore at', shore.x, shore.z)
  try {
    await navigate(bot, { goal: new goals.GoalNearXZ(shore.x, shore.z, 2), maxTicks: 1200 }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no way to the shore', (err as Error).message)
  }
  // (and swum to by the keys when the pathfinder's way failed, as to a dry stand: its column's top)
  if (inWater(bot)) {
    const top = columnTopOf(lookupOf(bot), shore.x, shore.z, Math.floor(bot.entity.position.y))
    if (top != null) await swimTo(bot, new Vec3(shore.x, top + 1, shore.z), signal, SWIM_SHORE_TICKS)
  }
  return !inWater(bot)
}

/** the highest block of a column a body can't pass (trees left out), from `from` up; `from.y` when there's none */
function columnTop (lookup: Lookup, from: Vec3, limit = 64): number {
  let top = from.y
  for (let dy = 1; dy <= limit; dy++) {
    const b = lookup(from.offset(0, dy, 0))
    if (b == null) break
    if (!TREE.test(b.name) && (b.boundingBox === 'block' || LIQUIDS.has(b.name))) top = from.y + dy
  }
  return top
}

/**
 * A goal to be under the open sky (out of a pit, a cave or a mine): a short climb the pathfinder plans quickly, where a
 * trip far off from the bottom of a shaft is a search it doesn't finish.
 */
/**
 * The overworld's surface is no lower than this: a ravine's floor or a pit is open to the sky as well, but no way
 * to the animals or the trees (seed 4: the bot climbed out of the night's mine into a ravine at y 8, took it for the
 * surface, and its search for animals went round the ravine's floor for 10000 ticks until a zombie killed it)
 */
export const SURFACE_MIN_Y = 50

/** under the open sky and, in the overworld, no lower than SURFACE_MIN_Y */
export function onSurface (lookup: Lookup, feet: Vec3, overworld = true): boolean {
  return openSky(lookup, feet) && (!overworld || feet.y >= SURFACE_MIN_Y)
}

function inOverworld (bot: Bot): boolean {
  return normalizeDimension(bot.game?.dimension) === 'overworld'
}

export class GoalSurface extends goals.Goal {
  private readonly tops = new Map<string, number>()
  constructor (private readonly lookup: Lookup, private readonly overworld = true) {
    super()
  }

  isEnd (node: { x: number, y: number, z: number }): boolean {
    return onSurface(this.lookup, new Vec3(node.x, node.y, node.z), this.overworld)
  }

  private top (node: { x: number, y: number, z: number }): number {
    const key = `${node.x},${node.z}`
    let t = this.tops.get(key)
    if (t == null) { t = columnTop(this.lookup, new Vec3(node.x, node.y, node.z)); this.tops.set(key, t) }
    return t
  }

  heuristic (node: { x: number, y: number, z: number }): number {
    return this.distHeuristic(node) * (20 / 4.317)
  }

  distHeuristic (node: { x: number, y: number, z: number }): number {
    return Math.max(0, this.top(node) + 1 - node.y)
  }
}

/**
 * The cells to open for one step of a staircase up from `feet` along `dir`: the room over the bot's head (it jumps),
 * and the feet and head cells of the column ahead a block up.
 */
export function staircaseUpStep (feet: Vec3, dir: Vec3): { open: Vec3[], next: Vec3, floor: Vec3 } {
  const ahead = feet.plus(dir).offset(0, 1, 0)
  return { open: [feet.offset(0, 2, 0), ahead, ahead.offset(0, 1, 0)], next: ahead, floor: ahead.offset(0, -1, 0) }
}

type Crafter = (bot: Bot, args: { item: string, pickUpTable?: boolean }, signal?: AbortSignal) => Promise<unknown>

/**
 * A pickaxe in the bag, made from what's held when there's none (the last one broke down a mine, where the rock
 * wants one): stone, else wood. Resolves the one there is, or null. `digging`: a stone one beside the iron one carried
 * (digTool.ts wantsDiggingPickaxe: the stone dug with it, the iron one saved for the ores), only a stone one made.
 */
export async function ensurePickaxe (bot: Bot, signal?: AbortSignal, craftFn?: Crafter, digging = false): Promise<string | null> {
  const held = (): string | null => digging
    ? (wantsDiggingPickaxe(bot.inventory.items()) ? null : DIGGING_PICKAXE)
    : bot.inventory.items().find(i => i.name.endsWith('_pickaxe'))?.name ?? null
  if (held() != null) return held()
  const make = craftFn ?? (await import('../skills/craft')).craft
  let nook = false
  for (const pickaxe of digging ? [DIGGING_PICKAXE] : ['stone_pickaxe', 'wooden_pickaxe']) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        await make(bot, { item: pickaxe, pickUpTable: true }, signal)
        if (held() != null) return held()
        break
      } catch (err) {
        if (isAbort(err)) throw err
        trace('explore: no', pickaxe, ':', (err as Error).message)
        // no room for the table in a one-wide staircase or tunnel: a nook dug into the wall beside the bot, once
        if (!isSkillError(err, 'CANNOT_PLACE') || nook) break
        nook = true
        if (!(await digNook(bot, signal))) break
      }
    }
  }
  return null
}

/** a dug route's steps between tries at a pickaxe after one failed (pickaxeKeeper) */
export const PICKAXE_RETRY_STEPS = 16

/** and between tries at a stone one to dig with beside the iron one after one failed (no sticks: the iron one digs) */
export const DIGGING_PICKAXE_RETRY_STEPS = 64

/**
 * A dug route's pickaxe kept, a step at a time: when the bag has none (the last one broke on the way, the wear watch
 * having found nothing to make another from, or none was carried), one made from what's carried before the step is
 * dug (ensurePickaxe: the route's own cobblestone, a stick, the table carried), tried again PICKAXE_RETRY_STEPS steps
 * on when none can be. A 26.3 whole game's staircase to the deep lava dug from y 12 to -50 by hand after its diamond
 * pickaxe broke, some 50000 ticks (a block of deepslate takes 300 ticks by hand, 23 with a stone pickaxe), with 17
 * sticks, a crafting table and 600 cobblestone in the bag. And with the iron pickaxe the best carried, a stone one to
 * dig the route with (digTool.ts: the iron one saved for the ores that need it), made when the last one broke, tried
 * again DIGGING_PICKAXE_RETRY_STEPS steps on when none can be.
 */
export function pickaxeKeeper (bot: Bot, craftFn?: Crafter): (signal?: AbortSignal) => Promise<void> {
  let step = 0
  let next = 0
  let nextDigger = 0
  return async (signal) => {
    step++
    const items = bot.inventory.items()
    if (items.some(i => i.name.endsWith('_pickaxe'))) {
      if (step < nextDigger || !wantsDiggingPickaxe(items)) return
      const made = await ensurePickaxe(bot, signal, craftFn, true)
      if (made == null) nextDigger = step + DIGGING_PICKAXE_RETRY_STEPS
      trace('explore: no stone pickaxe to dig the route with:', made != null ? 'one made' : `none made, again in ${DIGGING_PICKAXE_RETRY_STEPS} steps`)
      return
    }
    if (step < next) return
    const made = await ensurePickaxe(bot, signal, craftFn)
    if (made == null) next = step + PICKAXE_RETRY_STEPS
    trace('explore: no pickaxe for the route:', made != null ? `a ${made} made` : `none made, again in ${PICKAXE_RETRY_STEPS} steps`)
  }
}

/**
 * What keeps a climb's step from being dug (unsafeStep's), for a bot `wet` already: the water by a cell it opens lets
 * in none it isn't in (lava still does). A 26.3 bot whose night mine opened into a flooded cave under a stone roof at
 * y 10 turned from every step up, 'water at', and swam there 8000 ticks and more on the drowning reflex
 * (full-26.3-fresh-l)
 */
export function climbHazard (why: string | null, wet: boolean): string | null {
  if (why == null || !wet) return why
  return /^(water|bubble_column) at /.test(why) ? null : why
}

/**
 * Whether the pathfinder is kept from breaking the block at `pos` (its break exclusions put 1e9 on it: the base's
 * shell, protectBase; the trip kit's chest and the beds, keepUnbroken): a dig by hand leaves it too
 */
export function breakKept (bot: Bot, pos: Vec3): boolean {
  const block = bot.blockAt(pos)
  if (block == null || block.boundingBox === 'empty') return false
  // (the pathfinder breaks no infested block either: its BlockInfo.blocksCantBreak)
  if (isInfested(block.name)) return true
  const areas: Array<(block: any) => number> | undefined = (bot as any).pathfinder?.defaultMoveSettings?.exclusionAreasBreak
  if (areas == null || areas.length === 0) return false
  const info = { position: pos.floored(), block }
  return areas.reduce((n, f) => n + f(info), 0) >= 1e9
}

/**
 * A staircase up and out, dug by hand where the pathfinder plans no way up: a block forward and a block up each
 * step, turning from lava and water and from what the pathfinder is kept from breaking, until the bot is under the
 * open sky.
 */
export async function climbOut (bot: Bot, args: DigRouteArgs = {}, signal?: AbortSignal): Promise<boolean> {
  const lookup = lookupOf(bot)
  let dir = facingDir(bot.entity.yaw)
  const maxSteps = args.maxSteps ?? 128
  const pickaxe = pickaxeKeeper(bot)
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    const feet = feetOf(bot)
    if (onSurface(lookup, feet, inOverworld(bot))) return true
    await pickaxe(signal)
    await routeRoom(bot, args, signal, staircaseUpStep(feet, dir).next)
    const turns = [dir, new Vec3(-dir.z, 0, dir.x), new Vec3(dir.z, 0, -dir.x), dir.scaled(-1)]
    let stepped = false
    for (const d of turns) {
      const step = staircaseUpStep(feet, d)
      // the step stands on the block ahead: it has to be there (or be put there)
      // (nor into a cave's cells or against them for a bot under the cave rule, once out of the cave it began in)
      const why = climbHazard(unsafeStep(lookup, { open: step.open, floor: step.floor }), inWater(bot)) ?? (atCave(bot) || args.caves === false ? null : caveStep(bot, step))
      if (why != null) { trace('explore: climb turns from', d.toString(), why); continue }
      // (nor through a block the pathfinder is kept from breaking: a 1.21.11 bot shut in its house dug its staircase up
      // through the roof the base's protection kept, onto its crafting table, ls-1.21.11 t102592)
      const kept = step.open.find(c => breakKept(bot, c))
      if (kept != null) { trace('explore: climb turns from', d.toString(), 'kept unbroken at', kept.toString()); continue }
      if (!floorHeld(lookup, step, hasPlug(bot))) { trace('explore: climb turns from', d.toString(), 'no floor at', step.floor.toString()); continue }
      try {
        await open(bot, step.open, signal)
        if (!(await ensureFloor(bot, step.floor, signal))) continue
        await walkInto(bot, step.next, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('explore: climb step failed', (err as Error).message)
        continue
      }
      if (feetOf(bot).y <= feet.y) continue
      dir = d
      stepped = true
      break
    }
    if (!stepped) return false
  }
  return onSurface(lookup, feetOf(bot), inOverworld(bot))
}

/**
 * A staircase dug up toward `target` (climbOut's steps, the way nearest it tried first) till the feet are at its
 * height: for a walk the pathfinder plans no way for, the target over a rise it can't climb. Resolves whether the
 * feet got there, within `maxSteps` (default 16)
 */
export async function climbToward (bot: Bot, target: Vec3, args: DigRouteArgs = {}, signal?: AbortSignal): Promise<boolean> {
  const lookup = lookupOf(bot)
  const maxSteps = args.maxSteps ?? 16
  const pickaxe = pickaxeKeeper(bot)
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    const feet = feetOf(bot)
    if (feet.y >= target.y || args.found?.() === true) return feet.y >= target.y
    await pickaxe(signal)
    const dx = target.x + 0.5 - (feet.x + 0.5)
    const dz = target.z + 0.5 - (feet.z + 0.5)
    const dir = Math.abs(dx) < 1 && Math.abs(dz) < 1 ? facingDir(bot.entity.yaw) : Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
    const side = Math.abs(dx) >= Math.abs(dz) ? new Vec3(0, 0, Math.sign(dz) === 0 ? 1 : Math.sign(dz)) : new Vec3(Math.sign(dx) === 0 ? 1 : Math.sign(dx), 0, 0)
    const turns = [dir, side, side.scaled(-1), dir.scaled(-1)]
    await routeRoom(bot, args, signal, staircaseUpStep(feet, dir).next)
    let stepped = false
    for (const d of turns) {
      const step = staircaseUpStep(feet, d)
      const why = climbHazard(unsafeStep(lookup, { open: step.open, floor: step.floor }), inWater(bot)) ?? (atCave(bot) || args.caves === false ? null : caveStep(bot, step))
      if (why != null) { trace('explore: climb toward', target.toString(), 'turns from', d.toString(), why); continue }
      const kept = step.open.find(c => breakKept(bot, c))
      if (kept != null) { trace('explore: climb toward', target.toString(), 'turns from', d.toString(), 'kept unbroken at', kept.toString()); continue }
      if (!floorHeld(lookup, step, hasPlug(bot))) continue
      try {
        await open(bot, step.open, signal)
        if (!(await ensureFloor(bot, step.floor, signal))) continue
        await walkInto(bot, step.next, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('explore: climb toward step failed', (err as Error).message)
        continue
      }
      if (feetOf(bot).y <= feet.y) continue
      stepped = true
      break
    }
    if (!stepped) return false
  }
  return feetOf(bot).y >= target.y
}

/** climbs out to the open sky first when the bot is underground; resolves whether it's out */
export async function ensureSurface (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const lookup = lookupOf(bot)
  const overworld = inOverworld(bot)
  if (onSurface(lookup, feetOf(bot), overworld)) return true
  trace('explore: underground at', feetOf(bot).toString(), ': up to the surface first')
  // (for a bot under the cave rule, by the rock only: its own tunnel back, or a way dug, never up through a cave,
  // withCavesShut; f5-26.3, cave spiders at y 27)
  const up = async (): Promise<void> => { await navigate(bot, { goal: new GoalSurface(lookup, overworld) }, signal) }
  try {
    if (caveRuleOn(bot)) await withCavesShut(bot, up)
    else await up()
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no way up', (err as Error).message)
  }
  if (onSurface(lookup, feetOf(bot), overworld)) return true
  // the pathfinder planned no way up (or none it could walk): a staircase dug by hand
  trace('explore: digging a staircase up from', feetOf(bot).toString())
  if (await climbOut(bot, {}, signal)) return true
  if (!caveRuleOn(bot)) return false
  // none by the rock alone for a bot under the cave rule: the cave's cells by it (its way out, CAVE_ESCAPE_RADIUS) to the
  // open sky, then a staircase that may open onto a cave (the caves reflex seals what it opens); never no way at all. A
  // 26.3 bot at y 61 just under the surface found no way up but through a cave, its stone milestone failed 5 times on
  // 'no exploring from here' and play stopped (f8-26.3, t54094 to t55902)
  trace('explore: no way up by the rock alone from', feetOf(bot).toString(), ': by the cave by it')
  try {
    await up()
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no way up by the cave', (err as Error).message)
  }
  if (onSurface(lookup, feetOf(bot), overworld)) return true
  return await climbOut(bot, { caves: false }, signal)
}

/**
 * Gets the bot moving again where the pathfinder's moves don't (a trip that went nowhere twice from one spot): out to
 * the open sky when underground, the leaves over its head broken (a jump out of a dip under a tree needs the room),
 * then a few steps by hand to a free neighbouring cell with ground under it.
 */
export async function unstick (bot: Bot, signal?: AbortSignal): Promise<void> {
  const lookup = lookupOf(bot)
  const feet = feetOf(bot)
  trace('explore: unstick at', feet.toString())
  if (!openSky(lookup, feet)) {
    if (await ensureSurface(bot, signal)) return
  }
  for (const dy of [2, 3]) {
    const above = bot.blockAt(feet.offset(0, dy, 0))
    if (above != null && TREE.test(above.name) && above.name.endsWith('_leaves')) {
      await collectBlock(bot, { positions: [above.position], pickup: false }, signal).catch(err => { if (isAbort(err)) throw err })
    }
  }
  const { walkTo } = await import('../skills/navigate')
  for (const d of CARDINALS) {
    const cell = feet.plus(d)
    const up = cell.offset(0, 1, 0)
    const ground = (p: Vec3): boolean => bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
    let target: Vec3 | null = null
    if (isOpen(bot, cell) && isOpen(bot, cell.offset(0, 1, 0)) && ground(cell)) target = cell
    else if (isOpen(bot, up) && isOpen(bot, up.offset(0, 1, 0)) && isOpen(bot, feet.offset(0, 2, 0)) && ground(up)) target = up
    if (target == null) continue
    if (await walkTo(bot, target.offset(0.5, 0, 0.5), { within: 0.3, maxTicks: 30 }, signal)) return
  }
}

/** the extra cost, in ticks, of each step a trip over the surface takes under a roof (see surfaceStepCost) */
export const UNDER_ROOF_STEP_COST = 30

/**
 * A step cost for the pathfinder (an exclusion area) that keeps a trip over the surface on it: a step into a cell with
 * a block over it (trees left out), or more than SURFACE_DIP below `refY`, costs UNDER_ROOF_STEP_COST more, so a way down a ravine or through a cave, where
 * the mobs spawn in the dark at any hour (Monster.isDarkEnoughToSpawn), is taken only when it saves a long way round.
 * Each column's top is looked up once.
 */
export function surfaceStepCost (lookup: Lookup, refY: number, range = 64): (block: { position: Vec3 }) => number {
  const tops = new Map<string, number | null>()
  return (block) => {
    const pos = block.position
    const key = `${pos.x},${pos.z}`
    let top = tops.get(key)
    if (top === undefined) {
      // the column's highest block a body can't pass (trees left out): the ground, or a roof over it
      top = null
      for (let y = refY + range; y >= refY - range; y--) {
        const b = lookup(new Vec3(pos.x, y, pos.z))
        if (b == null) continue
        if (!TREE.test(b.name) && (b.boundingBox === 'block' || LIQUIDS.has(b.name))) { top = y; break }
      }
      tops.set(key, top)
    }
    // a cell well below where the trip set out from is down in a ravine (open to the sky, as dark at its bottom as a
    // cave): as dear (seed 4's legs went down one to y 20 and the bot died there)
    if (pos.y < refY - SURFACE_DIP) return UNDER_ROOF_STEP_COST
    return top != null && pos.y < top ? UNDER_ROOF_STEP_COST : 0
  }
}

/**
 * surfaceStepCost for a grid walk (GridCellView.cellCost): a cell under a roof or down a ravine is never walked, and
 * with no way over the surface the grid walk fails and the pathfinder's walk goes on, with the surface's step costs
 * (onTheSurface). The grid walk had no rule of the sort: a respawned 26.3 bot's walk to its trip kit, an 89-cell grid
 * walk from its base's way out at (-44, 63, -19), ended down in its old mine at y 5, where a zombie and a creeper
 * killed it bare (full-26.3-fresh-u, t234260)
 */
export function surfaceGridCost (lookup: Lookup, refY: number): (c: Vec3) => number {
  const step = surfaceStepCost(lookup, refY)
  return c => step({ position: c }) > 0 ? Infinity : 0
}

/** surfaceGridCost for the bot's world, from where its feet are */
export function botSurfaceGridCost (bot: Bot): (c: Vec3) => number {
  return surfaceGridCost(lookupOf(bot), Math.floor(bot.entity.position.y))
}

/** the open drop under a block put down that makes it a bridge's (bridgePlaceCost) */
export const BRIDGE_DROP = 4
/** what a block put down over such a drop costs a surface trip more (ticks): a way round is walked first */
export const BRIDGE_PLACE_COST = 200

/**
 * A block put down with BRIDGE_DROP or more of open air under it, a bridge's over a valley, costs BRIDGE_PLACE_COST
 * more: the surface legs bridged straight across valleys 25 to 35 blocks up, and a step off the bridge's edge was a
 * death, four of them on 26.3 (full-26.3-fresh-o at y 101, fresh-r at y 108 and y 98, a bridge at y 144 on seed 31337).
 * A block put with ground under it (a pillar's, a step's) costs nothing more.
 */
export function bridgePlaceCost (lookup: Lookup): (block: { position: Vec3 }) => number {
  return (block) => {
    const pos = block.position
    for (let dy = 1; dy <= BRIDGE_DROP; dy++) {
      const b = lookup(new Vec3(pos.x, pos.y - dy, pos.z))
      if (b == null || b.boundingBox === 'block') return 0
    }
    return BRIDGE_PLACE_COST
  }
}

/** how far below the level a surface trip sets out from a step counts as down a ravine (surfaceStepCost) */
export const SURFACE_DIP = 10

/**
 * runs `fn` with surfaceStepCost added to the pathfinder's step costs and no drop into water deeper than maxDropDown
 * (a surface leg on seed 4 dropped 48 blocks into a ravine's water and went on through the caves), and puts the old
 * settings back
 */
export async function onTheSurface<T> (bot: Bot, fn: () => Promise<T>): Promise<T> {
  const pf = bot.pathfinder as any
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null) return await fn()
  const before = { ...pf.defaultMoveSettings }
  pf.setMoveOptions({
    ...before,
    exclusionAreasStep: [...(before.exclusionAreasStep ?? []), surfaceStepCost(lookupOf(bot), Math.floor(bot.entity.position.y))],
    // no bridge across a valley high over its floor when there's a way round
    exclusionAreasPlace: [...(before.exclusionAreasPlace ?? []), bridgePlaceCost(lookupOf(bot))],
    // no jump into the water at a ravine's bottom, whatever the height: the way out of one is through its caves
    infiniteLiquidDropdownDistance: false
  })
  try {
    return await fn()
  } finally {
    pf.setMoveOptions(before)
  }
}

/** the index of the first waypoint farther than `skip` from the center (a square's), past the end when none is */
export function firstLegBeyond (waypoints: ReadonlyArray<{ x: number, z: number }>, center: { x: number, z: number }, skip?: number): number {
  if (skip == null) return 0
  const i = waypoints.findIndex(w => Math.max(Math.abs(w.x - center.x), Math.abs(w.z - center.z)) > skip)
  return i < 0 ? waypoints.length : i
}

/** the point of interest where a surface leg ended short of its end (its note: the times it did there) */
export const STUCK_LEG_POI = 'explore_stuck'
/** how long a spot a leg got stuck at is remembered (two days) */
export const STUCK_LEG_TTL = 48000
/** how near a spot counts as the same one, and how near a leg's way passes it */
export const STUCK_SPOT_RADIUS = 6
/** the times a leg got stuck at a spot before the legs that go by it are passed over */
export const STUCK_LEG_TIMES = 2
/** a leg that moved the bot less than this before it ended short got stuck */
export const STUCK_LEG_MOVED = 3

type StuckMemory = Pick<WorldMemory, 'now' | 'addPoi' | 'removePoi' | 'getPois'>

/** the spots legs got stuck at STUCK_LEG_TIMES times or more, lately (within STUCK_LEG_TTL) */
export function stuckSpots (memory: StuckMemory, dimension = 'overworld'): Vec3[] {
  return memory.getPois(STUCK_LEG_POI, { dimension })
    .filter(p => memory.now - p.seen < STUCK_LEG_TTL && Number(p.note ?? '0') >= STUCK_LEG_TIMES)
    .map(p => new Vec3(p.x, p.y, p.z))
}

/** notes a leg ended short of its end at `pos`: the spot's count goes up (a lapsed one starts again), returned */
export function noteStuckLeg (memory: StuckMemory, pos: Vec3, dimension = 'overworld'): number {
  const spot = memory.getPois(STUCK_LEG_POI, { dimension, near: pos })
    .find(p => Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) <= STUCK_SPOT_RADIUS)
  const times = spot != null && memory.now - spot.seen < STUCK_LEG_TTL ? Number(spot.note ?? '0') + 1 : 1
  if (spot != null) memory.removePoi(STUCK_LEG_POI, spot, dimension)
  const at = spot ?? pos.floored()
  memory.addPoi(STUCK_LEG_POI, at, dimension, String(times))
  return times
}

/**
 * whether the way from `from` to a leg's end (straight, over the ground) goes within STUCK_SPOT_RADIUS of a spot; a
 * spot the bot is at already isn't one its way goes by (every leg starts there: all 24 of a hunt's were passed over
 * from one, seed 31337)
 */
export function legPassesSpot (from: Vec3, to: { x: number, z: number }, spots: readonly Vec3[]): boolean {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const len2 = dx * dx + dz * dz
  return spots.some(s => {
    if (Math.hypot(s.x - from.x, s.z - from.z) <= STUCK_SPOT_RADIUS) return false
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((s.x - from.x) * dx + (s.z - from.z) * dz) / len2))
    return Math.hypot(from.x + t * dx - s.x, from.z + t * dz - s.z) <= STUCK_SPOT_RADIUS
  })
}

/**
 * A square spiral over the surface around `center`, the pathfinder walking each leg (kept out from under a roof:
 * onTheSurface), until `found` holds. Resolves true when found; false when the spiral ran out.
 */
export async function exploreSurface (bot: Bot, args: ExploreArgs, signal?: AbortSignal): Promise<boolean> {
  if (args.found()) return true
  // the surface's things (animals, trees, sand, cane) explored for from under the open sky only: a bot under the cave
  // rule with no way up but through a cave doesn't explore from down there (a 26.3 bot's hunt for a meal began at
  // y 33 by a cave and went down it to y 27, where cave spiders killed it, f5-26.3 t58998 to t59474)
  if (!(await ensureSurface(bot, signal)) && caveRuleOn(bot)) {
    throw new SkillError('NO_PATH', `underground at ${feetOf(bot).toString()} with no way up out of the rock but through a cave: no exploring from here`)
  }
  if (args.found()) return true
  const center = args.center ?? bot.entity.position.clone()
  const waypoints = spiralWaypoints(center, args.step ?? 16, args.maxRadius ?? 192)
  const lookup = lookupOf(bot)
  // (the legs within skipWithin walked before: on from the first beyond it)
  const skip = args.skipWithin
  const first = firstLegBeyond(waypoints, center, skip)
  for (let i = Math.max(first, args.progress?.leg ?? 0); i < waypoints.length; i++) {
    const wp = waypoints[i]
    throwIfAborted(signal)
    if (args.progress != null) args.progress.leg = i
    // a leg out over the sea or a lake is passed over (no animal or tree out there): on seed 7 the hunt's legs went out
    // over the ocean, the bot sank where a leg ended short, and it drowned
    // in the water (the sea a leg ended in, a respawn by it): to the nearest shore first, not on through it under
    // the waves (seed 7: a leg's path swam on at y 56, the drowning reflex cut it off every 300 ticks, and a drowned
    // killed the bot)
    if (inWater(bot)) await toShore(bot, signal)
    if (columnSurface(lookup, wp.x, wp.z, Math.floor(bot.entity.position.y)) === 'water') {
      trace('explore: leg to', wp.x, wp.z, 'is over water: passed over')
      if (args.progress != null) args.progress.leg = i + 1
      continue
    }
    // a leg whose way goes by a spot legs got stuck at twice lately goes elsewhere (the next): the hunt's leg for a
    // spider walked into the same pond at (-131, 61, 47) and was cut off there twice, 160000 ticks apart (26.3 seed 2)
    const dimension = normalizeDimension(bot.game?.dimension)
    if (args.memory != null && legPassesSpot(bot.entity.position, wp, stuckSpots(args.memory, dimension))) {
      trace('explore: leg to', wp.x, wp.z, 'goes by a spot legs got stuck at: passed over')
      if (args.progress != null) args.progress.leg = i + 1
      continue
    }
    trace('explore: surface leg to', wp.x, wp.z)
    // a leg that ends short of its end (failed, or cut off by a reflex) where it started, getting nowhere, is noted
    // where it did (one cut off by a fight on its way, 8 blocks on, isn't stuck)
    const legStart = bot.entity.position.clone()
    const short = (): void => {
      if (args.memory == null || Math.hypot(bot.entity.position.x - wp.x, bot.entity.position.z - wp.z) <= 8) return
      if (bot.entity.position.distanceTo(legStart) >= STUCK_LEG_MOVED) return
      const times = noteStuckLeg(args.memory, bot.entity.position, dimension)
      trace('explore: leg to', wp.x, wp.z, 'ended short at', bot.entity.position.floored().toString(), `(${times} times there)`)
    }
    try {
      await onTheSurface(bot, async () => await navigate(bot, { goal: new goals.GoalNearXZ(wp.x, wp.z, 4) }, signal))
    } catch (err) {
      short()
      if (isAbort(err)) throw err
      trace('explore: leg failed', (err as Error).message)
    }
    if (args.progress != null) args.progress.leg = i + 1
    // a leg that ended in the water: up to the air before the next (a body still in water sinks)
    if (headInWater(bot)) await surface(bot, { signal, maxTicks: 200 }).catch(err => { if (isAbort(err)) throw err })
    if (args.memory != null && args.remember != null) rememberAround(bot, args.memory, args.remember)
    if (args.found()) return true
  }
  return false
}

/**
 * How a dug route's cells are broken: with any tool (the way through, not the drop), and their drops not walked
 * after: the route's next step goes into the cell they fell in, which picks them up. Each pickup was a walk of 20 to
 * 100 ticks, and a staircase up from y 18 on seed 7 took some 10000 ticks
 */
export const ROUTE_DIG = { anyTool: true, pickup: false } as const

/** the cells left to break (air and the plants a body walks through stay), in order */
async function open (bot: Bot, cells: Vec3[], signal?: AbortSignal): Promise<void> {
  for (const cell of cells) {
    // gravel and sand fall into the hole again: dig until it stays open
    for (let tries = 0; tries < 6 && !isOpen(bot, cell); tries++) {
      const block = bot.blockAt(cell)
      if (block == null) throw new SkillError('NOT_FOUND', `the chunk at ${cell.toString()} isn't loaded`)
      if (block.boundingBox === 'empty' && !LIQUIDS.has(block.name)) break
      // the way out matters more than the drop: a block the bag's tools don't harvest is broken by hand
      await collectBlock(bot, { positions: [cell], ...ROUTE_DIG }, signal)
    }
    if (!isOpen(bot, cell)) throw new SkillError('VERIFY_FAILED', `${bot.blockAt(cell)?.name ?? 'nothing'} still at ${cell.toString()}`)
  }
}

const PLUG_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate']

/** whether a block to put under a step is carried (ensureFloor's) */
const hasPlug = (bot: Bot): boolean => PLUG_BLOCKS.some(n => countItems(bot, n) > 0)

/** puts a block under `floor`'s cell when it's open (a cave below), from whatever building block the bot has */
async function ensureFloor (bot: Bot, floor: Vec3, signal?: AbortSignal): Promise<boolean> {
  const b = bot.blockAt(floor)
  if (b != null && b.boundingBox === 'block') return true
  const item = PLUG_BLOCKS.find(n => countItems(bot, n) > 0)
  if (item == null) return false
  try {
    await placeBlock(bot, { pos: floor, item }, signal)
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    return false
  }
}

/**
 * Into the open cell of a dug route's next step beside the bot: walked straight at by hand, as a player holds forward
 * (off the edge into a step down, jumping into a step up), the pathfinder's way only when that doesn't get there. The
 * pathfinder's way into a staircase's next step, a block forward and a block down, broke the floor under the bot and
 * walked in level: a block more to dig each step (a 26.3 staircase dug by hand took 220 ticks a step for it, 70
 * without), and the bot a block lower beside the pit it had thrown into, the stack picked up again.
 */
async function walkInto (bot: Bot, cell: Vec3, signal?: AbortSignal): Promise<void> {
  const there = (): boolean => feetOf(bot).equals(cell) && bot.entity.onGround
  await walkTo(bot, cell.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 40, until: there }, signal)
  // (still dropping into it)
  await waitUntil(bot, () => bot.entity.onGround, 20, signal)
  if (!there()) await navigate(bot, { goal: new goals.GoalBlock(cell.x, cell.y, cell.z) }, signal)
  // the drops of the step's blocks lying in its reach picked up now (ItemEntity's 10 ticks of pickup delay), not in the
  // middle of what comes next: a craft there failed 'the server's menu kept changing' as they came in
  await settlePickups(bot, signal)
}

/** the bot's feet cell */
function feetOf (bot: Bot): Vec3 {
  const p = bot.entity.position
  return new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z))
}

/**
 * A torch on the floor of the cell a dug route just left, when one is carried: the staircase and tunnels lit every
 * TORCH_SPACING blocks, so nothing spawns along the way back (any block light stops monster spawning since 1.18,
 * Monster.isDarkEnoughToSpawn) and the way is seen
 */
export async function lightBehind (bot: Bot, cell: Vec3, signal?: AbortSignal): Promise<boolean> {
  if (countItems(bot, 'torch') === 0) return false
  const here = bot.blockAt(cell)
  const floor = bot.blockAt(cell.offset(0, -1, 0))
  if (here == null || !AIR_BLOCKS.has(here.name) || floor == null || floor.boundingBox !== 'block') return false
  try {
    await placeBlock(bot, { pos: cell, item: 'torch', against: cell.offset(0, -1, 0) }, signal)
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no torch at', cell.toString(), (err as Error).message)
    return false
  }
}

export interface DigRouteArgs {
  /** stop early once this holds (checked every step) */
  found?: () => boolean
  /**
   * Makes room in the bag when it's short, every step (the executor's: the route's stone over the stock thrown into a
   * pit beside the way, the rest put in a depot), `toward` the step's next cell: the route's cells' drops come in as
   * the bot walks into them (default: the bag's keeper's, skills/bag.ts keepRoom)
   */
  room?: (toward?: Vec3) => Promise<void>
  /** most steps (default 160) */
  maxSteps?: number
  /** a staircase up turns from the caves' cells under the cave rule (default true); false: the rock's way only */
  caves?: boolean
}

/**
 * Room in the bag before a step of a dug route: the route's own room maker, else the bag's keeper's, `next` the cell
 * the step walks into (what's thrown goes into a pit beside the route, under that step's reach: dumpPitFor)
 */
async function routeRoom (bot: Bot, args: DigRouteArgs, signal?: AbortSignal, next?: Vec3): Promise<void> {
  const toward = next?.offset(0.5, 0, 0.5)
  if (args.room != null) await args.room(toward)
  else await keepRoom(bot, signal, toward)
}

/**
 * A staircase down to feet level `y`: a block forward and a block down each step, along the bot's facing, turning to
 * another side where a step would open next to lava or water. Resolves once the bot's feet are at `y` (or `found`).
 */
export async function descendTo (bot: Bot, y: number, args: DigRouteArgs = {}, signal?: AbortSignal): Promise<boolean> {
  await outOfTheWater(bot, signal)
  let dir = facingDir(bot.entity.yaw)
  const lookup = lookupOf(bot)
  const maxSteps = args.maxSteps ?? 400
  let moves = 0
  let dug = 0
  let level = 0
  const pickaxe = pickaxeKeeper(bot)
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    if (args.found?.() === true) return true
    const feet = feetOf(bot)
    if (feet.y <= y) return true
    await pickaxe(signal)
    await routeRoom(bot, args, signal, staircaseStep(feet, dir).next)
    const turns = [dir, new Vec3(-dir.z, 0, dir.x), new Vec3(dir.z, 0, -dir.x), dir.scaled(-1)]
    let stepped = false
    for (const d of turns) {
      const step = staircaseStep(feet, d)
      // (and a step into a cave, or opening the way into one, for a bot not fit for the caves: round it in the rock)
      const why = unsafeStep(lookup, step) ?? caveStep(bot, step)
      if (why != null) { trace('explore: staircase turns from', d.toString(), why); continue }
      if (!floorHeld(lookup, step, hasPlug(bot))) { trace('explore: staircase turns from', d.toString(), 'no floor at', step.floor.toString()); continue }
      try {
        await open(bot, step.open, signal)
        if (!(await ensureFloor(bot, step.floor, signal))) continue
        await walkInto(bot, step.next, signal)
        // a hole into a cave the step opened all the same (gravel that fell, a cave the step's cells hid) sealed
        await sealCaveOpenings(bot, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('explore: staircase step failed', (err as Error).message)
        continue
      }
      if (++dug % TORCH_SPACING === 0) await lightBehind(bot, feet, signal)
      dir = d
      stepped = true
      break
    }
    if (stepped) continue
    // no safe step down on any side (a dripstone cave's stalagmites under them, a lake): a level step on through the
    // rock, over the cave's roof, and down again past it
    if (level < LEVEL_STEPS && await levelStep(bot, lookup, feet, [dir, new Vec3(-dir.z, 0, dir.x), new Vec3(dir.z, 0, -dir.x)], signal)) {
      level++
      continue
    }
    // water or lava on every side (a beach, a lake's floor): somewhere drier a few blocks off, and down from there
    const spot = moves < 3 ? dryStart(lookup, feet) : null
    if (spot == null) throw new SkillError('NO_PATH', `no safe way down from ${feet.toString()}`)
    moves++
    trace('explore: no safe way down from', feet.toString(), ': down from', spot.toString(), 'instead')
    try {
      await navigate(bot, { goal: new goals.GoalBlock(spot.x, spot.y, spot.z) }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: no way to', spot.toString(), (err as Error).message)
    }
  }
  return feetOf(bot).y <= y
}

/**
 * A dug route starts from dry ground: a bot in the water (a pond's, a lake's floor) goes to the shore first
 * (toShore), and throws NO_PATH when it can't: a staircase or a tunnel from under the water lets it in on the bot (a
 * 1.21.11 bot's stone step went under a pond's water at y 56 and surfaced 35 times, ls3-1.21.11)
 */
export async function outOfTheWater (bot: Bot, signal?: AbortSignal): Promise<void> {
  if (!inWater(bot)) return
  if (!(await toShore(bot, signal))) throw new SkillError('NO_PATH', `in the water at ${feetOf(bot).toString()}: no staircase or tunnel from under it`)
}

/** level steps a staircase down takes at most where no step down is safe (descendTo) */
const LEVEL_STEPS = 32

/**
 * A level step (tunnelStep) along the first of `dirs` it's safe to take (unsafeStep), dug and walked into; whether one
 * was. A staircase over a dripstone cave (every step down over its stalagmites) went no further, 'no safe way down'.
 */
async function levelStep (bot: Bot, lookup: Lookup, feet: Vec3, dirs: Vec3[], signal?: AbortSignal): Promise<boolean> {
  for (const d of dirs) {
    const step = tunnelStep(feet, d)
    const why = unsafeStep(lookup, step) ?? caveStep(bot, step)
    if (why != null || !floorHeld(lookup, step, hasPlug(bot))) continue
    try {
      await open(bot, step.open, signal)
      if (!(await ensureFloor(bot, step.floor, signal))) continue
      await walkInto(bot, step.next, signal)
      await sealCaveOpenings(bot, signal)
      trace('explore: no safe step down from', feet.toString(), ': a level step to', step.next.toString())
      return true
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: level step failed', (err as Error).message)
    }
  }
  return false
}

/**
 * A place to stand a few blocks off (4 to 24, in the eight directions) with no liquid within a block of the column
 * under it, down a staircase's first few steps: where a way down from the bot's feet opens to water or lava on every
 * side. Null when there's none.
 */
export function dryStart (lookup: Lookup, feet: Vec3): Vec3 | null {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  for (const r of [4, 6, 8, 10, 12, 16, 20, 24]) {
    for (const [dx, dz] of dirs) {
      const base = feet.offset(dx * r, 0, dz * r)
      for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const cell = base.offset(0, dy, 0)
        const free = (p: Vec3): boolean => { const b = lookup(p); return b != null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name) }
        if (!free(cell) || !free(cell.offset(0, 1, 0)) || lookup(cell.offset(0, -1, 0))?.boundingBox !== 'block') continue
        let wet = false
        for (let down = 0; down >= -4 && !wet; down--) {
          for (let ox = -1; ox <= 1 && !wet; ox++) {
            for (let oz = -1; oz <= 1 && !wet; oz++) {
              const name = lookup(cell.offset(ox, down, oz))?.name
              if (name != null && LIQUIDS.has(name)) wet = true
            }
          }
        }
        if (!wet) return cell
        break
      }
    }
  }
  return null
}

/**
 * A two-high tunnel at the bot's level, `length` blocks along the facing, then a turn to the right for the next leg,
 * until `found` holds. Lava or water ahead turns it early. Resolves whether `found` held.
 */
export async function tunnel (bot: Bot, args: DigRouteArgs & { length?: number, legs?: number }, signal?: AbortSignal): Promise<boolean> {
  await outOfTheWater(bot, signal)
  let dir = facingDir(bot.entity.yaw)
  const lookup = lookupOf(bot)
  const length = args.length ?? 24
  const legs = args.legs ?? 8
  let dug = 0
  const pickaxe = pickaxeKeeper(bot)
  for (let leg = 0; leg < legs; leg++) {
    let blocked = 0
    for (let i = 0; i < length; i++) {
      throwIfAborted(signal)
      if (args.found?.() === true) return true
      await pickaxe(signal)
      await routeRoom(bot, args, signal, tunnelStep(feetOf(bot), dir).next)
      const feet = feetOf(bot)
      const step = tunnelStep(feet, dir)
      // (a cave ahead, or against the next cells, for a bot not fit for the caves: the tunnel turns, the rock kept between)
      const why = unsafeStep(lookup, step) ?? caveStep(bot, step)
      if (why != null) { trace('explore: tunnel stops,', why); blocked++; break }
      if (!floorHeld(lookup, step, hasPlug(bot))) { trace('explore: tunnel stops, no floor at', step.floor.toString()); blocked++; break }
      try {
        await open(bot, step.open, signal)
        if (!(await ensureFloor(bot, step.floor, signal))) break
        await walkInto(bot, step.next, signal)
        await sealCaveOpenings(bot, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('explore: tunnel step failed', (err as Error).message)
        blocked++
        break
      }
      if (++dug % TORCH_SPACING === 0) await lightBehind(bot, feet, signal)
    }
    if (args.found?.() === true) return true
    // turn right (clockwise from above): -z → +x → +z → -x
    dir = new Vec3(-dir.z, 0, dir.x)
    if (blocked > 3) break
  }
  return args.found?.() === true
}

export interface ExploreForBlocksArgs {
  names: string[]
  /** how far a block may be to count as found (default 48) */
  radius?: number
  memory?: WorldMemory
  center?: Vec3
  /** blocks that don't count as found (the base's walls, an ore too deep) */
  exclude?: (pos: Vec3) => boolean
  /** how far out the surface spiral goes (default exploreSurface's) */
  maxRadius?: number
  /** the surface spiral's legs walked so far (ExploreArgs.progress) */
  progress?: { leg: number }
  /** room made in the bag down the staircase and the tunnels (DigRouteArgs.room) */
  room?: (toward?: Vec3) => Promise<void>
  /** more blocks to note in the memory on the surface spiral's way, beyond `names` */
  remember?: string[]
}

/** the nearest block of the names in the loaded chunks, within `radius` */
export function findNear (bot: Bot, names: readonly string[], radius: number, exclude?: (pos: Vec3) => boolean): Vec3 | null {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  if (ids.length === 0) return null
  const found = findBlocks(bot, { matching: ids, maxDistance: radius, count: 64 }).filter(p => exclude == null || !exclude(p))
  return found[0] ?? null
}

/**
 * Goes looking for one of the blocks: an ore by a staircase down to its level and tunnels there; anything else by the
 * surface spiral. Resolves true once one is within `radius` of the bot.
 */
export async function exploreForBlocks (bot: Bot, args: ExploreForBlocksArgs, signal?: AbortSignal): Promise<boolean> {
  const radius = args.radius ?? 48
  const found = (): boolean => findNear(bot, args.names, radius, args.exclude) != null
  if (found()) return true
  const level = oreLevel(args.names)
  if (level == null) return await exploreSurface(bot, { found, center: args.center, memory: args.memory, remember: [...new Set([...args.names, ...(args.remember ?? [])])], maxRadius: args.maxRadius, progress: args.progress }, signal)
  const feet = feetOf(bot)
  // the bot may stand in a hole above or below the level: get to within a few blocks of it
  if (feet.y > level + 2) await descendTo(bot, level, { found, room: args.room }, signal)
  if (found()) return true
  return await tunnel(bot, { found, room: args.room }, signal)
}
