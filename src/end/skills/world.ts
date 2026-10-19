import type { Bot } from 'mineflayer'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Pos } from '../../core/memory'
import type { ExitPortal } from '../spikes'
import { TaskError, throwIfAborted, type SkillOptions } from '../../skills/combatUtil'

// The End skills' view of the world around the bot: where the ground is, where the void starts, and getting
// somewhere with the pathfinder (towering up and digging down included).

/**
 * the blocks the End's pillars and the shelter's towers are built of: any full block a mine leaves the bot with (the
 * pathfinder's own bridging takes cobblestone and dirt, BlockInfo.scaffoldingBlockItems), the island's end stone too:
 * with cobblestone and dirt alone a 1.21.11 run stood under a crystal with 12 of them, 'short of 18', and 42 of
 * deepslate, andesite, diorite and granite in its bag
 */
export const SCAFFOLD_ITEMS = ['cobblestone', 'dirt', 'cobbled_deepslate', 'end_stone', 'netherrack', 'andesite', 'diorite', 'granite', 'stone', 'tuff', 'blackstone', 'deepslate', 'stone_bricks']

/** what the End skills read the world through: mineflayer's bot.blockAt, or a test's */
export type BlockGetter = (pos: Vec3) => { name: string, boundingBox: string } | null

export function blockGetter (bot: Bot): BlockGetter {
  return (pos) => bot.blockAt(pos) as any
}

/** a block a player can stand on (a full collision box) */
export function isSolidAt (get: BlockGetter, pos: Vec3): boolean {
  const b = get(pos)
  return b != null && b.boundingBox === 'block'
}

/** a cell the body fits in: no collision, and not something that hurts */
export function isOpenAt (get: BlockGetter, pos: Vec3): boolean {
  const b = get(pos)
  if (b == null) return false
  if (b.boundingBox !== 'empty') return false
  return !['lava', 'fire', 'soul_fire', 'end_portal'].includes(b.name)
}

/** feet height to stand at on top of the column, scanning down from `fromY`; null over the void (or unloaded) */
export function groundY (get: BlockGetter, x: number, z: number, fromY = 120, toY = 0): number | null {
  const fx = Math.floor(x)
  const fz = Math.floor(z)
  let open = 0
  for (let y = Math.floor(fromY); y >= toY; y--) {
    const p = new Vec3(fx, y, fz)
    if (isSolidAt(get, p)) {
      if (open >= 2) return y + 1
      open = 0
    } else if (get(p) == null) {
      return null
    } else {
      open++
    }
  }
  return null
}

/** the column has nothing to land on down to `toY`: a fall there is a fall into the void */
export function isVoidColumn (get: BlockGetter, x: number, z: number, fromY: number, toY = 0): boolean {
  const fx = Math.floor(x)
  const fz = Math.floor(z)
  // at or under the bottom of the world: nothing to scan, no void to speak of
  if (Math.floor(fromY) < toY) return false
  for (let y = Math.floor(fromY); y >= toY; y--) {
    const b = get(new Vec3(fx, y, fz))
    if (b == null) return false // unloaded: unknown, not void
    if (b.boundingBox === 'block' || b.name === 'water') return false
  }
  return true
}

/**
 * The horizontal distance from `pos` to the nearest column with nothing under it (the island's edge, a hole down
 * to the void), searched in rings out to `radius`; Infinity when there is none that close.
 */
export function voidDistance (get: BlockGetter, pos: Pos, radius = 6, toY = 0): number {
  const cx = Math.floor(pos.x)
  const cz = Math.floor(pos.z)
  let best = Infinity
  for (let r = 0; r <= radius; r++) {
    if (r > best) break
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const d = Math.hypot(dx, dz)
        if (d >= best) continue
        if (isVoidColumn(get, cx + dx, cz + dz, pos.y, toY)) best = d
      }
    }
  }
  return best
}

/**
 * Where the bot last stood safely: on solid ground with no void within `margin` blocks. A knock (the dragon's wings,
 * an explosion) that sends it over the edge is answered by heading back here.
 */
export class VoidGuard {
  lastSafe: Vec3 | null = null
  /** the bot is airborne with only the void under it */
  overVoid = false

  constructor (readonly get: BlockGetter, readonly margin = 3, readonly minY = 0) {}

  update (position: Vec3, onGround: boolean): void {
    this.overVoid = !onGround && isVoidColumn(this.get, position.x, position.z, position.y, this.minY)
    if (onGround && isSolidAt(this.get, position.offset(0, -0.5, 0)) && voidDistance(this.get, position, this.margin, this.minY) > this.margin) {
      this.lastSafe = position.clone()
    }
  }

  /** a spot is risky to stand at: void within the margin */
  risky (pos: Pos): boolean {
    return voidDistance(this.get, pos, this.margin, this.minY) <= this.margin
  }
}

/** the dimension's lowest y (DimensionType.minY: 0 in the End, -64 in the overworld) */
export function worldMinY (bot: Bot): number {
  return (bot.game as any)?.minY ?? 0
}

export function countItems (bot: Bot, names: string[]): number {
  return bot.inventory.items().filter(i => names.includes(i.name)).reduce((n, i) => n + i.count, 0)
}

export interface GotoOptions extends SkillOptions {
  /** the goal's point: the walk is called off when the bot strays this far further from it than it started (default 10) */
  target?: Vec3
  strayLimit?: number
  /** goes a second time when the first walk fails or strays (default 1) */
  retries?: number
  /** ticks a walk may take (default 300 plus 30 a block to the target; 1200 without one) */
  maxTicks?: number
  /** cells to keep off (the dragon's clouds): a pathfinder exclusion area for the walk */
  avoid?: (pos: Vec3) => boolean
}

/**
 * The pathfinder to a goal; throws NO_PATH when it doesn't get there (checked with `arrived`). With a target point a
 * watchdog cancels a walk that takes the bot away from it, or more than 4 blocks below both ends (off an edge).
 */
export async function goto (bot: Bot, goal: any, arrived: () => boolean, opts: GotoOptions = {}): Promise<void> {
  if (arrived()) return
  if (bot.pathfinder == null) throw new TaskError('NO_PATH', 'no pathfinder loaded')
  let lastError: TaskError | null = null
  // the pathfinder gives a walk up when its tick step runs past 40 ms of wall time (PathExecutor.waitForPromiseSync):
  // on a loaded machine that comes and goes, and those tries don't count
  let slowTries = 0
  for (let attempt = 0; attempt <= (opts.retries ?? 1); attempt++) {
    if (arrived()) return
    const target = opts.target
    const startDistance = target != null ? bot.entity.position.distanceTo(target) : 0
    const floorY = target != null ? Math.min(bot.entity.position.y, target.y) - 4 : -Infinity
    let strayed: string | null = null
    let giveUp: () => void = () => {}
    const gaveUp = new Promise<void>(resolve => { giveUp = resolve })
    let graceTicks = 0
    let ticks = 0
    const maxTicks = opts.maxTicks ?? (target != null ? 300 + 30 * startDistance : 1200)
    const watchdog = (): void => {
      // cancelled, but the pathfinder's goto hasn't settled: stop waiting for it
      if (strayed != null || opts.signal?.aborted === true) {
        if (++graceTicks > 40) giveUp()
        return
      }
      if (++ticks > maxTicks) {
        strayed = `took over ${Math.round(maxTicks)} ticks`
        void bot.pathfinder.cancel()
        return
      }
      if (target == null) return
      const p = bot.entity.position
      if (p.distanceTo(target) > startDistance + (opts.strayLimit ?? 10)) strayed = `strayed to ${p.toString()}`
      else if (p.y < floorY) strayed = `fell to ${p.toString()}`
      if (strayed != null) void bot.pathfinder.cancel()
    }
    const onAbort = (): void => { void bot.pathfinder.cancel() }
    opts.signal?.addEventListener('abort', onAbort)
    bot.on('physicsTick', watchdog)
    try {
      await Promise.race([bot.pathfinder.goto(goal), gaveUp])
      if (strayed != null) lastError = new TaskError('NO_PATH', `the walk ${String(strayed)}`)
    } catch (err) {
      throwIfAborted(opts.signal)
      const message = String((err as Error)?.message ?? err)
      if (strayed == null && /exceeded \d+ms/.test(message) && slowTries++ < 8) attempt--
      lastError = new TaskError('NO_PATH', strayed != null ? `the walk ${String(strayed)}` : `the pathfinder failed: ${message}`)
    } finally {
      bot.off('physicsTick', watchdog)
      opts.signal?.removeEventListener('abort', onAbort)
      bot.clearControlStates()
    }
    throwIfAborted(opts.signal)
    if (arrived()) return
    lastError = lastError ?? new TaskError('NO_PATH', `the pathfinder stopped short of the goal, at ${bot.entity.position.toString()}`)
  }
  throw lastError ?? new TaskError('NO_PATH', 'the pathfinder stopped short of the goal')
}

export function feetBlock (bot: Bot): Vec3 {
  return bot.entity.position.floored()
}

/**
 * A pathfinder exclusion area (exclusionAreasStep) that keeps the bot off columns with only the void under them:
 * the island's edge and the holes the crystals' blasts leave. Columns are cached for the walk.
 */
export function voidExclusion (get: BlockGetter, minY = 0): (block: { position: Vec3 }) => number {
  const cache = new Map<string, boolean>()
  return (block) => {
    const p = block.position
    const k = `${p.x},${p.z}`
    let v = cache.get(k)
    if (v == null) {
      v = isVoidColumn(get, p.x, p.z, p.y, minY)
      cache.set(k, v)
    }
    return v ? 1e6 : 0
  }
}

/**
 * runs fn with the void exclusion (and the cells to avoid) added to the pathfinder's move options, and puts the old
 * ones back after
 */
export async function withVoidExclusion<T> (bot: Bot, fn: () => Promise<T>, avoid?: (pos: Vec3) => boolean): Promise<T> {
  const pf: any = bot.pathfinder
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null) return await fn()
  const before = pf.defaultMoveSettings
  const areas = [...before.exclusionAreasStep, voidExclusion(blockGetter(bot), worldMinY(bot))]
  // a soft cost (20 ticks a block), so a walk that starts in a cloud still gets out of it, and the search stays small
  if (avoid != null) areas.push((block: { position: Vec3 }) => avoid(block.position) ? 20 : 0)
  pf.setMoveOptions({ ...before, exclusionAreasStep: areas })
  try {
    return await fn()
  } finally {
    pf.setMoveOptions(before)
  }
}

/** to stand in the block cell (feet in it); the pathfinder stops near, the last steps are walked */
export async function gotoBlock (bot: Bot, pos: Pos, opts: GotoOptions = {}): Promise<void> {
  const target = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  const center = target.offset(0.5, 0, 0.5)
  const near = (): boolean => Math.abs(bot.entity.position.y - target.y) < 0.6 && Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z) < 1.5
  await withVoidExclusion(bot, async () => await goto(bot, new goals.GoalBlock(target.x, target.y, target.z), near, { ...opts, target: center }), opts.avoid).catch(err => {
    if (TaskError.is(err) && err.code === 'NO_PATH') throw new TaskError('NO_PATH', `${err.message} (to ${target.toString()})`)
    throw err
  })
  await stepTo(bot, center, opts)
}

/** walks the last bit onto the middle of a cell, slowly, tick by tick (to within `within`) */
export async function stepTo (bot: Bot, center: Vec3, opts: SkillOptions & { within?: number, maxTicks?: number } = {}): Promise<void> {
  const within = opts.within ?? 0.25
  try {
    for (let t = 0; t < (opts.maxTicks ?? 60); t++) {
      throwIfAborted(opts.signal)
      const p = bot.entity.position
      const d = Math.hypot(p.x - center.x, p.z - center.z)
      const v = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z)
      if (d < within && v < 0.05) return
      if (d < within) {
        bot.clearControlStates()
      } else {
        const yaw = Math.atan2(-(center.x - p.x), -(center.z - p.z))
        await bot.look(yaw, bot.entity.pitch, true)
        bot.setControlState('forward', true)
        // sneaking near the spot: slow enough to stop on it (and never off an edge)
        bot.setControlState('sneak', d < 1)
      }
      await bot.waitForTicks(1)
    }
  } finally {
    bot.clearControlStates()
  }
}

/** within `distance` of a point */
export async function gotoNear (bot: Bot, pos: Pos, distance: number, opts: GotoOptions = {}): Promise<void> {
  const p = new Vec3(pos.x, pos.y, pos.z)
  await withVoidExclusion(bot, async () => await goto(bot, new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), distance), () => bot.entity.position.distanceTo(p) <= distance + 1, { ...opts, target: p }), opts.avoid)
}

export async function holdOneOf (bot: Bot, names: string[]): Promise<boolean> {
  if (bot.heldItem != null && names.includes(bot.heldItem.name)) return true
  const item = bot.inventory.items().find(i => names.includes(i.name))
  if (item == null) return false
  await bot.equip(item, 'hand')
  return true
}

export const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']

/**
 * Towers straight up where the bot stands to feet height `topY`: a jump, and at the top of it a block put under the
 * feet on the block below (the player pillar-jump; the server lets it in once the body has cleared the cell,
 * BlockItem.place's collision check). Blocks over the head are dug out first.
 */
export async function towerUp (bot: Bot, topY: number, opts: SkillOptions = {}): Promise<void> {
  const signal = opts.signal
  const needed = Math.max(0, topY - Math.floor(bot.entity.position.y))
  const have = countItems(bot, SCAFFOLD_ITEMS)
  if (have < needed) throw new TaskError('MISSING_ITEMS', `${needed} blocks to pillar up, ${have} in the inventory`)
  const get = blockGetter(bot)
  try {
    while (Math.floor(bot.entity.position.y + 1e-6) < topY) {
      throwIfAborted(signal)
      const feet = bot.entity.position.floored()
      const overhead = feet.offset(0, 2, 0)
      if (bot.blockAt(overhead)?.boundingBox === 'block') {
        await holdOneOf(bot, PICKAXES)
        await bot.dig(bot.blockAt(overhead) as any, true)
      }
      if (!await holdOneOf(bot, SCAFFOLD_ITEMS)) throw new TaskError('MISSING_ITEMS', 'out of blocks to pillar with')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.setControlState('jump', true)
      let cleared = false
      for (let t = 0; t < 12; t++) {
        await bot.waitForTicks(1)
        throwIfAborted(signal)
        if (bot.entity.position.y >= feet.y + 1.0) { cleared = true; break }
      }
      bot.setControlState('jump', false)
      if (!cleared) throw new TaskError('NO_PATH', `couldn't jump clear of ${feet.toString()}`)
      const below = bot.blockAt(feet.offset(0, -1, 0))
      if (below == null || below.boundingBox !== 'block') throw new TaskError('NO_PATH', `nothing to build on under ${feet.toString()}`)
      if (isOpenAt(get, feet)) await bot.placeBlock(below, new Vec3(0, 1, 0))
      for (let t = 0; t < 20 && !bot.entity.onGround; t++) await bot.waitForTicks(1)
    }
  } finally {
    bot.clearControlStates()
  }
}

/** Digs straight down through the blocks under the feet to feet height `toY` (a pillar taken back down). */
export async function digDown (bot: Bot, toY: number, opts: SkillOptions = {}): Promise<void> {
  const signal = opts.signal
  try {
    for (let guard = 0; guard < 256 && Math.floor(bot.entity.position.y + 1e-6) > toY; guard++) {
      throwIfAborted(signal)
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      if (below == null) throw new TaskError('NO_PATH', 'the block below is unloaded')
      if (below.boundingBox === 'block') {
        if (below.name === 'bedrock' || below.name === 'obsidian' || below.name === 'end_stone') throw new TaskError('NO_PATH', `the ground (${below.name}) is under the feet`)
        await holdOneOf(bot, PICKAXES)
        await bot.dig(below, true)
      }
      // down onto the next block of the pillar
      for (let t = 0; t < 20; t++) {
        await bot.waitForTicks(1)
        if (bot.entity.onGround && Math.floor(bot.entity.position.y + 1e-6) < feet.y) break
      }
    }
  } finally {
    bot.clearControlStates()
  }
}

/**
 * Walks to the column and towers up a 1×1 pillar there to feet height `topY`. Needs a scaffolding block (cobblestone
 * or dirt, what the pathfinder bridges with too) for every block up.
 */
export async function pillarUp (bot: Bot, column: { x: number, z: number }, topY: number, opts: GotoOptions = {}): Promise<void> {
  const get = blockGetter(bot)
  const base = groundY(get, column.x, column.z, topY + 2) ?? Math.floor(bot.entity.position.y)
  const needed = Math.max(0, topY - base)
  const have = countItems(bot, SCAFFOLD_ITEMS)
  if (have < needed) throw new TaskError('MISSING_ITEMS', `${needed} blocks to pillar up, ${have} in the inventory`)
  const feet = bot.entity.position.floored()
  // on the column already (a pillar begun and left): on up from there
  if (feet.x !== column.x || feet.z !== column.z) await gotoBlock(bot, { x: column.x, y: base, z: column.z }, opts)
  await towerUp(bot, topY, opts)
}

/** the exit portal's y from the bedrock pillar at 0,0 (EndPodiumFeature: the pillar's top is portalY + 3) */
export function findPortalY (get: BlockGetter, fromY = 128, toY = 0): number | null {
  for (let y = fromY; y >= toY; y--) {
    const b = get(new Vec3(0, y, 0))
    if (b == null) return null
    if (b.name === 'bedrock') return y - 3
  }
  return null
}

/** the exit portal is open: end_portal blocks round the pillar (EndDragonFight.spawnExitPortal(true)) */
export function exitPortalOpen (get: BlockGetter, portal: ExitPortal): boolean {
  return portal.portal.some(p => get(new Vec3(p.x, p.y, p.z))?.name === 'end_portal')
}
