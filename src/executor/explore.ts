// Looking for what the plan needs when neither the loaded chunks nor the memory show one: a square spiral out over
// the surface (trees, animals, water, sand), and for ores a staircase down to the ore's best level and a tunnel
// along it. Every block opened is checked for lava (and water) around it first, so the bot stays out of both.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { navigate } from '../skills/navigate'
import { placeBlock } from '../skills/placeBlock'
import { AIR_BLOCKS, CARDINALS, countItems, trace } from '../skills/util'

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
}

/** notes the blocks of the given names within `radius` in the memory */
export function rememberAround (bot: Bot, memory: WorldMemory, names: readonly string[], radius = 48, perName = 32): number {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  if (ids.length === 0) return 0
  const dimension = normalizeDimension(bot.game?.dimension)
  let n = 0
  const counts = new Map<number, number>()
  for (const pos of bot.findBlocks({ matching: ids, maxDistance: radius, count: perName * ids.length })) {
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
export class GoalSurface extends goals.Goal {
  private readonly tops = new Map<string, number>()
  constructor (private readonly lookup: Lookup) {
    super()
  }

  isEnd (node: { x: number, y: number, z: number }): boolean {
    return openSky(this.lookup, new Vec3(node.x, node.y, node.z))
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

/** climbs out to the open sky first when the bot is underground; resolves whether it's out */
export async function ensureSurface (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const lookup = lookupOf(bot)
  if (openSky(lookup, feetOf(bot))) return true
  trace('explore: underground at', feetOf(bot).toString(), ': up to the surface first')
  try {
    await navigate(bot, { goal: new GoalSurface(lookup) }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('explore: no way up', (err as Error).message)
  }
  return openSky(lookup, feetOf(bot))
}

/**
 * A square spiral over the surface around `center`, the pathfinder walking each leg, until `found` holds. Resolves
 * true when found; false when the spiral ran out.
 */
export async function exploreSurface (bot: Bot, args: ExploreArgs, signal?: AbortSignal): Promise<boolean> {
  if (args.found()) return true
  await ensureSurface(bot, signal)
  if (args.found()) return true
  const center = args.center ?? bot.entity.position.clone()
  for (const wp of spiralWaypoints(center, args.step ?? 16, args.maxRadius ?? 192)) {
    throwIfAborted(signal)
    trace('explore: surface leg to', wp.x, wp.z)
    try {
      await navigate(bot, { goal: new goals.GoalNearXZ(wp.x, wp.z, 4) }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('explore: leg failed', (err as Error).message)
    }
    if (args.memory != null && args.remember != null) rememberAround(bot, args.memory, args.remember)
    if (args.found()) return true
  }
  return false
}

/** the cells left to break (air and the plants a body walks through stay), in order */
async function open (bot: Bot, cells: Vec3[], signal?: AbortSignal): Promise<void> {
  for (const cell of cells) {
    // gravel and sand fall into the hole again: dig until it stays open
    for (let tries = 0; tries < 6 && !isOpen(bot, cell); tries++) {
      const block = bot.blockAt(cell)
      if (block == null) throw new SkillError('NOT_FOUND', `the chunk at ${cell.toString()} isn't loaded`)
      if (block.boundingBox === 'empty' && !LIQUIDS.has(block.name)) break
      await collectBlock(bot, { positions: [cell] }, signal)
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

async function walkInto (bot: Bot, cell: Vec3, signal?: AbortSignal): Promise<void> {
  await navigate(bot, { goal: new goals.GoalBlock(cell.x, cell.y, cell.z) }, signal)
}

/** the bot's feet cell */
function feetOf (bot: Bot): Vec3 {
  const p = bot.entity.position
  return new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z))
}

export interface DigRouteArgs {
  /** stop early once this holds (checked every step) */
  found?: () => boolean
  /** most steps (default 160) */
  maxSteps?: number
}

/**
 * A staircase down to feet level `y`: a block forward and a block down each step, along the bot's facing, turning to
 * another side where a step would open next to lava or water. Resolves once the bot's feet are at `y` (or `found`).
 */
export async function descendTo (bot: Bot, y: number, args: DigRouteArgs = {}, signal?: AbortSignal): Promise<boolean> {
  let dir = facingDir(bot.entity.yaw)
  const lookup = lookupOf(bot)
  const maxSteps = args.maxSteps ?? 400
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    if (args.found?.() === true) return true
    const feet = feetOf(bot)
    if (feet.y <= y) return true
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
      dir = d
      stepped = true
      break
    }
    if (!stepped) throw new SkillError('NO_PATH', `no safe way down from ${feet.toString()}`)
  }
  return feetOf(bot).y <= y
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
  for (let leg = 0; leg < legs; leg++) {
    let blocked = 0
    for (let i = 0; i < length; i++) {
      throwIfAborted(signal)
      if (args.found?.() === true) return true
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
}

/** the nearest block of the names in the loaded chunks, within `radius` */
export function findNear (bot: Bot, names: readonly string[], radius: number, exclude?: (pos: Vec3) => boolean): Vec3 | null {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  if (ids.length === 0) return null
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }).filter(p => exclude == null || !exclude(p))
  return found[0] ?? null
}

/**
 * Goes looking for one of the blocks: an ore by a staircase down to its level and tunnels there; anything else by the
 * surface spiral. Resolves true once one is within `radius` of the bot.
 */
export async function exploreForBlocks (bot: Bot, args: ExploreForBlocksArgs, signal?: AbortSignal): Promise<boolean> {
  const radius = args.radius ?? 48
  const found = (): boolean => findNear(bot, args.names, radius) != null
  if (found()) return true
  const level = oreLevel(args.names)
  if (level == null) return await exploreSurface(bot, { found, center: args.center, memory: args.memory, remember: args.names }, signal)
  const feet = feetOf(bot)
  // the bot may stand in a hole above or below the level: get to within a few blocks of it
  if (feet.y > level + 2) await descendTo(bot, level, { found }, signal)
  if (found()) return true
  return await tunnel(bot, { found }, signal)
}
