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
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { navigate, walkTo } from '../skills/navigate'
import { isItemEntity, touches } from '../skills/pickupDrops'
import { keepRoom } from '../skills/bag'
import { headInWater, surface } from '../skills/escape'
import { placeBlock } from '../skills/placeBlock'
import { AIR_BLOCKS, CARDINALS, countItems, trace, waitUntil } from '../skills/util'

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

/** why a step is unsafe (lava or water next to a cell it opens, nothing to stand on over a drop into lava), or null */
export function unsafeStep (lookup: Lookup, step: { open: Vec3[], floor: Vec3 }): string | null {
  for (const cell of step.open) {
    const liquid = liquidAround(lookup, cell)
    if (liquid != null) return liquid
  }
  // the floor and what's under it: a bot doesn't stand over lava (a block broken under it drops it in)
  for (let dy = 0; dy >= -2; dy--) {
    const name = lookup(step.floor.offset(0, dy, 0))?.name
    if (name === 'lava') return `lava under ${step.floor.toString()}`
    if (name != null && !AIR_BLOCKS.has(name) && name !== 'water') break
  }
  return null
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
  if (b == null || b.boundingBox !== 'block' || UNBREAKABLE.has(b.name) || /(chest|furnace|table|barrel|bed|door)/.test(b.name)) return false
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
 * Where a pit goes for a bot at `feet` (its look `yaw`) that goes to `toward` next: by a dug route's next step or the
 * block it breaks next (a cell within ROUTE_STEP_RANGE), to its sides, 2 under the floor (a step a block down and one
 * more); behind a trip's way (farther off); else (`toward` over or under the feet, or none) by the facing
 * (dumpPitCells)
 */
export function dumpPitFor (lookup: Lookup, feet: Vec3, yaw: number, toward?: Vec3): ReturnType<typeof dumpPitCells> {
  // from the feet's cell to the cell of `toward` (a goal's block, a block, a point): a GoalBlock's corner seen from the
  // bot off its cell's middle pointed along the route, the pit dug in the next step's floor
  const dx = toward != null ? Math.floor(toward.x) - feet.x : 0
  const dz = toward != null ? Math.floor(toward.z) - feet.z : 0
  const dist = Math.hypot(dx, dz)
  if (toward != null && dist >= 1) {
    const way = facingDir(Math.atan2(-dx, -dz))
    if (dist <= ROUTE_STEP_RANGE) return dumpPitCells(lookup, feet, way, 'sides', 2 + Math.min(1, Math.max(0, feet.y - Math.floor(toward.y) - 1)))
    const behind = dumpPitCells(lookup, feet, way, 'behind')
    if (behind != null) return behind
  }
  return dumpPitCells(lookup, feet, facingDir(yaw))
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

/** out of the water to the nearest shore (nearestShore), swimming up first; resolves whether the bot is out */
export async function toShore (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  if (headInWater(bot)) await surface(bot, { signal, maxTicks: 200 }).catch(err => { if (isAbort(err)) throw err })
  const shore = nearestShore(lookupOf(bot), bot.entity.position)
  if (shore == null) return !inWater(bot)
  trace('explore: in the water: to the shore at', shore.x, shore.z)
  try {
    await navigate(bot, { goal: new goals.GoalNearXZ(shore.x, shore.z, 2), maxTicks: 1200 }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no way to the shore', (err as Error).message)
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
 * wants one): stone, else wood. Resolves the one there is, or null.
 */
export async function ensurePickaxe (bot: Bot, signal?: AbortSignal, craftFn?: Crafter): Promise<string | null> {
  const held = (): string | null => bot.inventory.items().find(i => i.name.endsWith('_pickaxe'))?.name ?? null
  if (held() != null) return held()
  const make = craftFn ?? (await import('../skills/craft')).craft
  for (const pickaxe of ['stone_pickaxe', 'wooden_pickaxe']) {
    try {
      await make(bot, { item: pickaxe, pickUpTable: true }, signal)
      if (held() != null) return held()
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: no', pickaxe, ':', (err as Error).message)
    }
  }
  return null
}

/**
 * A staircase up and out, dug by hand where the pathfinder plans no way up: a block forward and a block up each
 * step, turning from lava and water, until the bot is under the open sky.
 */
export async function climbOut (bot: Bot, args: DigRouteArgs = {}, signal?: AbortSignal): Promise<boolean> {
  const lookup = lookupOf(bot)
  let dir = facingDir(bot.entity.yaw)
  const maxSteps = args.maxSteps ?? 128
  await ensurePickaxe(bot, signal)
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    const feet = feetOf(bot)
    if (onSurface(lookup, feet, inOverworld(bot))) return true
    await routeRoom(bot, args, signal, staircaseUpStep(feet, dir).next)
    const turns = [dir, new Vec3(-dir.z, 0, dir.x), new Vec3(dir.z, 0, -dir.x), dir.scaled(-1)]
    let stepped = false
    for (const d of turns) {
      const step = staircaseUpStep(feet, d)
      // the step stands on the block ahead: it has to be there (or be put there)
      const why = unsafeStep(lookup, { open: step.open, floor: step.floor })
      if (why != null) { trace('explore: climb turns from', d.toString(), why); continue }
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

/** climbs out to the open sky first when the bot is underground; resolves whether it's out */
export async function ensureSurface (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const lookup = lookupOf(bot)
  const overworld = inOverworld(bot)
  if (onSurface(lookup, feetOf(bot), overworld)) return true
  trace('explore: underground at', feetOf(bot).toString(), ': up to the surface first')
  try {
    await navigate(bot, { goal: new GoalSurface(lookup, overworld) }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no way up', (err as Error).message)
  }
  if (onSurface(lookup, feetOf(bot), overworld)) return true
  // the pathfinder planned no way up (or none it could walk): a staircase dug by hand
  trace('explore: digging a staircase up from', feetOf(bot).toString())
  return await climbOut(bot, {}, signal)
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
    // no jump into the water at a ravine's bottom, whatever the height: the way out of one is through its caves
    infiniteLiquidDropdownDistance: false
  })
  try {
    return await fn()
  } finally {
    pf.setMoveOptions(before)
  }
}

/**
 * A square spiral over the surface around `center`, the pathfinder walking each leg (kept out from under a roof:
 * onTheSurface), until `found` holds. Resolves true when found; false when the spiral ran out.
 */
export async function exploreSurface (bot: Bot, args: ExploreArgs, signal?: AbortSignal): Promise<boolean> {
  if (args.found()) return true
  await ensureSurface(bot, signal)
  if (args.found()) return true
  const center = args.center ?? bot.entity.position.clone()
  const waypoints = spiralWaypoints(center, args.step ?? 16, args.maxRadius ?? 192)
  const lookup = lookupOf(bot)
  for (let i = args.progress?.leg ?? 0; i < waypoints.length; i++) {
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
    trace('explore: surface leg to', wp.x, wp.z)
    try {
      await onTheSurface(bot, async () => await navigate(bot, { goal: new goals.GoalNearXZ(wp.x, wp.z, 4) }, signal))
    } catch (err) {
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
/** ticks a step waits for the drops in its reach to come in (ItemEntity's pickup delay of 10 and a tick or two) */
const DROP_PICKUP_TICKS = 12

async function walkInto (bot: Bot, cell: Vec3, signal?: AbortSignal): Promise<void> {
  const there = (): boolean => feetOf(bot).equals(cell) && bot.entity.onGround
  await walkTo(bot, cell.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 40, until: there }, signal)
  // (still dropping into it)
  await waitUntil(bot, () => bot.entity.onGround, 20, signal)
  if (!there()) await navigate(bot, { goal: new goals.GoalBlock(cell.x, cell.y, cell.z) }, signal)
  // the drops of the step's blocks lying in its reach picked up now (ItemEntity's 10 ticks of pickup delay), not in the
  // middle of what comes next: a craft there failed 'the server's menu kept changing' as they came in
  await waitUntil(bot, () => !Object.values(bot.entities).some(e => e !== bot.entity && isItemEntity(e) && touches(bot.entity.position, e.position)), DROP_PICKUP_TICKS, signal)
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
  let dir = facingDir(bot.entity.yaw)
  const lookup = lookupOf(bot)
  const maxSteps = args.maxSteps ?? 400
  let moves = 0
  let dug = 0
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    if (args.found?.() === true) return true
    const feet = feetOf(bot)
    if (feet.y <= y) return true
    await routeRoom(bot, args, signal, staircaseStep(feet, dir).next)
    const turns = [dir, new Vec3(-dir.z, 0, dir.x), new Vec3(dir.z, 0, -dir.x), dir.scaled(-1)]
    let stepped = false
    for (const d of turns) {
      const step = staircaseStep(feet, d)
      const why = unsafeStep(lookup, step)
      if (why != null) { trace('explore: staircase turns from', d.toString(), why); continue }
      try {
        await open(bot, step.open, signal)
        if (!(await ensureFloor(bot, step.floor, signal))) continue
        await walkInto(bot, step.next, signal)
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
  let dir = facingDir(bot.entity.yaw)
  const lookup = lookupOf(bot)
  const length = args.length ?? 24
  const legs = args.legs ?? 8
  let dug = 0
  for (let leg = 0; leg < legs; leg++) {
    let blocked = 0
    for (let i = 0; i < length; i++) {
      throwIfAborted(signal)
      if (args.found?.() === true) return true
      await routeRoom(bot, args, signal, tunnelStep(feetOf(bot), dir).next)
      const feet = feetOf(bot)
      const step = tunnelStep(feet, dir)
      const why = unsafeStep(lookup, step)
      if (why != null) { trace('explore: tunnel stops,', why); blocked++; break }
      try {
        await open(bot, step.open, signal)
        if (!(await ensureFloor(bot, step.floor, signal))) break
        await walkInto(bot, step.next, signal)
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
  if (level == null) return await exploreSurface(bot, { found, center: args.center, memory: args.memory, remember: args.names, maxRadius: args.maxRadius, progress: args.progress }, signal)
  const feet = feetOf(bot)
  // the bot may stand in a hole above or below the level: get to within a few blocks of it
  if (feet.y > level + 2) await descendTo(bot, level, { found, room: args.room }, signal)
  if (found()) return true
  return await tunnel(bot, { found, room: args.room }, signal)
}
