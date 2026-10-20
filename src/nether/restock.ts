// The nether's building blocks run short on the way: a trip whose hop has no path, with fewer blocks than the crossing
// ahead takes, turns back along the trail it came by (its own bridge over the lava sea) to firm ground, mines
// netherrack there up to the bag's nether working set, and plans again. The pathfinder plans no place past its budget
// (the blocks held less scaffoldReserve): a 26.3 bot at the end of its own 60-block bridge over the lava sea with 4
// cobblestone had every hop on toward the fortress fail ('no path to the goal', 'the IdleMovement executor isn't
// driving the bot'), from t215000 to past t250000, with nothing to mine in reach (full-26.3-fresh-t).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { collectBlock } from '../skills/collectBlock'
import { countItems, trace } from '../skills/util'
import { SCAFFOLD_ITEMS } from '../executor/steps'
import { NETHER_SCAFFOLD_KEEP } from '../executor/keep'
import { findBlocks } from '../core/findBlocks'
import { trailPoints } from './trail'
import { SAFE_DROP } from './safety'

type Lookup = (pos: Vec3) => { name: string, boundingBox: string } | null

/** the farthest along the way ahead the crossing's blocks are counted (a hop and a half) */
export const CROSSING_LOOKAHEAD = 64
/** floor cells of the 5 x 5 under the feet that make a spot firm ground, not a bridge or a ledge's lip */
export const LAND_CELLS = 13
/** netherrack blocks within RESTOCK_RADIUS of a spot to mine there */
export const RESTOCK_MIN_NETHERRACK = 16
/** how far round the firm spot the netherrack is mined */
export const RESTOCK_RADIUS = 12
/** the farthest back along the trail the firm ground is looked for */
export const TURN_BACK_RANGE = 160
/** turn-backs a trip makes at most */
export const MAX_TURN_BACKS = 2
/** a turn-back that got fewer blocks than this is the last of its trip (no netherrack to be had) */
export const TURN_BACK_MIN_GAIN = 16

/** a cell a player stands on: a full block's box, not lava */
function solid (lookup: Lookup, pos: Vec3): boolean {
  const b = lookup(pos)
  return b != null && b.boundingBox === 'block' && b.name !== 'lava'
}

/**
 * The blocks to put down to walk the straight way from `from` toward `to` at the feet's level, as far as
 * CROSSING_LOOKAHEAD (or `max`): the columns of it, in the loaded chunks, with no floor under the feet's level within
 * SAFE_DROP and no wall at the feet (a wall is dug through), the lava sea's and a chasm's
 */
export function crossingBlocks (lookup: Lookup, from: Vec3, to: Vec3, max = CROSSING_LOOKAHEAD): number {
  const feetY = Math.floor(from.y)
  const dx = to.x - from.x
  const dz = to.z - from.z
  const d = Math.min(Math.hypot(dx, dz), max)
  if (d < 1) return 0
  const ux = dx / Math.hypot(dx, dz)
  const uz = dz / Math.hypot(dx, dz)
  const seen = new Set<string>()
  const start = `${Math.floor(from.x)},${Math.floor(from.z)}`
  let blocks = 0
  for (let s = 0.5; s <= d; s += 0.5) {
    const x = Math.floor(from.x + ux * s)
    const z = Math.floor(from.z + uz * s)
    const key = `${x},${z}`
    if (key === start || seen.has(key)) continue
    seen.add(key)
    // the chunks not loaded yet: no more known
    if (lookup(new Vec3(x, feetY, z)) == null) break
    if (solid(lookup, new Vec3(x, feetY, z))) continue
    let floor = false
    for (let dy = 1; dy <= SAFE_DROP && !floor; dy++) floor = solid(lookup, new Vec3(x, feetY - dy, z))
    if (!floor) blocks++
  }
  return blocks
}

/** the building blocks the pathfinder places (its scaffoldingBlocks: SCAFFOLD_ITEMS) and the reserve it keeps back */
export function scaffoldSettings (bot: Bot): { items: string[], reserve: number } {
  const settings = (bot.pathfinder as any)?.defaultMoveSettings ?? {}
  return { items: [...(settings.scaffoldingBlocks ?? SCAFFOLD_ITEMS)], reserve: settings.scaffoldReserve ?? 4 }
}

/**
 * Whether the bot holds fewer building blocks than the straight way toward `to` takes to cross (crossingBlocks, as
 * many as the nether's working set at most) past what the pathfinder keeps back: the blocks it needs and what it holds
 */
export function scaffoldShort (bot: Bot, to: Vec3): { short: boolean, need: number, held: number } {
  const { items, reserve } = scaffoldSettings(bot)
  const held = countItems(bot, items)
  const need = Math.min(crossingBlocks(p => bot.blockAt(p) as any, bot.entity.position, to), NETHER_SCAFFOLD_KEEP)
  return { short: need > 0 && held - reserve < need, need, held }
}

/** whether the spot is firm ground: LAND_CELLS of the 5 x 5 cells under its feet are floor (no bridge, no ledge's lip) */
export function landAt (lookup: Lookup, feet: Vec3): boolean {
  const f = feet.floored()
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (solid(lookup, new Vec3(f.x + dx, f.y - 1, f.z + dz))) n++
  return n >= LAND_CELLS
}

/**
 * Where to turn back to for netherrack: the trail's points from the newest back (the way the bot came, its bridge
 * over the lava sea first), within TURN_BACK_RANGE, the first on firm ground (landAt) with RESTOCK_MIN_NETHERRACK
 * netherrack round it; else `fallback` (the trip's start) when it is; null with none
 */
export function turnBackPoint (bot: Bot, fallback?: Vec3): Vec3 | null {
  const lookup: Lookup = p => bot.blockAt(p) as any
  const id = bot.registry.blocksByName.netherrack?.id
  const good = (p: Vec3): boolean => landAt(lookup, p) &&
    (id == null || findBlocks(bot, { matching: id, point: p, maxDistance: RESTOCK_RADIUS, count: RESTOCK_MIN_NETHERRACK }).length >= RESTOCK_MIN_NETHERRACK)
  const here = bot.entity.position
  if (good(here)) return here.floored()
  const memory = bot.survival?.memory
  const points = memory == null ? [] : trailPoints(memory).reverse()
  for (const p of points) {
    const at = new Vec3(p.x, p.y, p.z)
    if (at.distanceTo(here) > TURN_BACK_RANGE) continue
    if (good(at)) return at
  }
  return fallback != null && good(fallback) ? fallback.floored() : null
}

/**
 * Netherrack mined about the bot up to the nether's working set (NETHER_SCAFFOLD_KEEP of the building blocks), the
 * walls and mounds first: none under the feet's level but a floor block with ground under it (a pit one deep, no hole
 * to the lava sea); the blocks got
 */
export async function mineNetherrack (bot: Bot, signal?: AbortSignal): Promise<number> {
  const { items } = scaffoldSettings(bot)
  const want = NETHER_SCAFFOLD_KEEP - countItems(bot, items)
  if (want <= 0) return 0
  const feetY = Math.floor(bot.entity.position.y)
  const lookup: Lookup = p => bot.blockAt(p) as any
  const before = countItems(bot, items)
  await collectBlock(bot, {
    names: ['netherrack'],
    count: want,
    maxDistance: RESTOCK_RADIUS,
    exclude: pos => pos.y < feetY - 1 || (pos.y === feetY - 1 && !solid(lookup, pos.offset(0, -1, 0)))
  }, signal)
  return countItems(bot, items) - before
}

/** a pickaxe in the bag: netherrack drops nothing without one (requiresCorrectToolForDrops) */
export function hasPickaxe (bot: Bot): boolean {
  return bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
}

/**
 * Back to firm ground (turnBackPoint) by `walk`, and netherrack mined there (mineNetherrack); the blocks got (0 with
 * no firm ground to go back to, or no pickaxe)
 */
export async function turnBackForBlocks (bot: Bot, walk: (to: Vec3) => Promise<unknown>, opts: { fallback?: Vec3, signal?: AbortSignal } = {}): Promise<number> {
  if (!hasPickaxe(bot)) return 0
  const to = turnBackPoint(bot, opts.fallback)
  if (to == null) {
    trace('restock: no firm ground with netherrack to turn back to')
    return 0
  }
  if (to.distanceTo(bot.entity.position) > 3) await walk(to)
  return await mineNetherrack(bot, opts.signal)
}
