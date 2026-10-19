// gridWalk: a short walk planned on the block grid and walked from block middle to block middle, for the places the
// pathfinder's executor catches on corners (fortress bridges, stronghold corridors): no digging, no placing, no jumps
// but a step up; cells next to lava, and fire, left out; ledges over deadly falls walked only when there's no way round.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isSkillError, throwIfAborted } from './errors'
import { navigate, walkTo } from './navigate'
import { trace } from './util'
import { normalizeDimension } from '../core/memory'
import { nearDeath } from '../nether/deaths'
import { hazardLeft } from './hazardCells'
import { runSliced, runToEnd, type SliceOptions } from '../core/slice'

export interface GridCellView {
  /** the cell holds nothing to collide with (air, plants, a portal), and no lava or fire */
  free: (p: Vec3) => boolean
  /** the cell can be stood on: a full collision box (not magma) */
  floor: (p: Vec3) => boolean
  /** lava in the cell */
  lava?: (p: Vec3) => boolean
  /**
   * cells' worth of walk charged on top for each side of a cell with a deadly fall beside it (deadlySides): a ledge
   * over the nether's lava sea is walked only when there's no way round (default 0)
   */
  edgeCost?: number
  /** cells' worth charged on top for standing in the cell (the nether's death spots) */
  cellCost?: (c: Vec3) => number
}

/** blocks without a collision box that hurt or hold the bot: kept out of */
export const HARMFUL = new Set(['lava', 'fire', 'soul_fire', 'cobweb', 'powder_snow', 'sweet_berry_bush', 'wither_rose', 'water', 'bubble_column'])

const STEPS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function key (p: Vec3): string {
  return `${p.x},${p.y},${p.z}`
}

/** the cells the bot can stand in from `from`: on the level, a step up (headroom for the jump), or 1-3 down */
export function gridNeighbours (view: GridCellView, from: Vec3): Vec3[] {
  const standable = (c: Vec3): boolean => view.free(c) && view.free(c.offset(0, 1, 0)) && view.floor(c.offset(0, -1, 0)) && !nearLava(view, c)
  const out: Vec3[] = []
  for (const s of STEPS) {
    const c = from.plus(s)
    if (standable(c)) { out.push(c); continue }
    // a step up: the jump needs the cell over the bot's head free too
    const up = c.offset(0, 1, 0)
    if (view.floor(c) && standable(up) && view.free(from.offset(0, 2, 0))) { out.push(up); continue }
    // a drop of up to 3 into the cell's column
    if (view.free(c) && view.free(c.offset(0, 1, 0))) {
      for (let d = 1; d <= 3; d++) {
        const down = c.offset(0, -d, 0)
        if (!view.free(down)) break
        if (standable(down)) { out.push(down); break }
      }
    }
  }
  return out
}

function nearLava (view: GridCellView, c: Vec3): boolean {
  if (view.lava == null) return false
  for (const s of STEPS) if (view.lava(c.plus(s)) || view.lava(c.plus(s).offset(0, 1, 0))) return true
  return view.lava(c.offset(0, -1, 0))
}

/**
 * The sides of the cell with a deadly fall beside it: a free column there (the feet's level and down) with lava in
 * the first 4 blocks under, or neither ground nor anything else in them (a fall of more than 3 blocks hurts:
 * LivingEntity.causeFallDamage). A knockback or a step off the line goes over those.
 */
export function deadlySides (view: GridCellView, c: Vec3): number {
  let n = 0
  for (const s of STEPS) {
    const q = c.plus(s)
    if (!view.free(q)) continue
    let deadly = true
    for (let d = 1; d <= 4; d++) {
      const below = q.offset(0, -d, 0)
      if (view.lava?.(below) === true) break
      if (!view.free(below)) { deadly = false; break }
    }
    if (deadly) n++
  }
  return n
}

/**
 * A* on the grid from `start` to the nearest cell where `isGoal` holds, within `maxNodes` cells looked at; the cells
 * to walk (start left out), or null.
 */
export function gridPath (view: GridCellView, start: Vec3, isGoal: (c: Vec3) => boolean, heuristic: (c: Vec3) => number, maxNodes = 20000): Vec3[] | null {
  return runToEnd(gridSearch(view, start, isGoal, heuristic, maxNodes))
}

/**
 * gridPath with the event loop let through every SLICE_MS of searching (runSliced): its 20000 cells of a nether walk
 * held the process 1.5 to 4.6 s at a time (the bot's block lookups), and on a loaded machine past the server's
 * keep-alive. `opts.between` runs after each pause (an abort's check).
 */
export async function gridPathSliced (view: GridCellView, start: Vec3, isGoal: (c: Vec3) => boolean, heuristic: (c: Vec3) => number, maxNodes = 20000, opts: SliceOptions = {}): Promise<Vec3[] | null> {
  return await runSliced(gridSearch(view, start, isGoal, heuristic, maxNodes), opts)
}

/** gridPath's search, yielding after each cell it looks at (where a slice may end) */
function * gridSearch (view: GridCellView, start: Vec3, isGoal: (c: Vec3) => boolean, heuristic: (c: Vec3) => number, maxNodes: number): Generator<void, Vec3[] | null> {
  const open = new MinHeap<{ c: Vec3, g: number, f: number }>(n => n.f)
  open.push({ c: start, g: 0, f: heuristic(start) })
  const came = new Map<string, Vec3 | null>([[key(start), null]])
  const best = new Map<string, number>([[key(start), 0]])
  let seen = 0
  const edgeCost = view.edgeCost ?? 0
  while (open.size > 0 && seen++ < maxNodes) {
    const { c, g } = open.pop()
    if (g > (best.get(key(c)) ?? Infinity)) continue
    yield
    if (isGoal(c)) {
      const path: Vec3[] = []
      let at: Vec3 | null = c
      while (at != null && !at.equals(start)) { path.unshift(at); at = came.get(key(at)) ?? null }
      return path
    }
    for (const n of gridNeighbours(view, c)) {
      const cost = g + 1 + (n.y !== c.y ? 0.5 : 0) + (edgeCost > 0 ? edgeCost * deadlySides(view, n) : 0) + (view.cellCost?.(n) ?? 0)
      const k = key(n)
      if ((best.get(k) ?? Infinity) <= cost) continue
      best.set(k, cost)
      came.set(k, c)
      open.push({ c: n, g: cost, f: cost + heuristic(n) })
    }
  }
  return null
}

/** a binary heap, least first */
class MinHeap<T> {
  private readonly items: T[] = []
  constructor (private readonly score: (t: T) => number) {}
  get size (): number { return this.items.length }
  push (t: T): void {
    const a = this.items
    a.push(t)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.score(a[p]) <= this.score(a[i])) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }

  pop (): T {
    const a = this.items
    const top = a[0]
    const last = a.pop() as T
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.score(a[l]) < this.score(a[m])) m = l
        if (r < a.length && this.score(a[r]) < this.score(a[m])) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

/** cells' worth charged for each deadly side of a cell the grid walk goes by: in the nether, and elsewhere */
export const GRID_EDGE_COST = { the_nether: 3, other: 1 }
/** cells' worth charged for a cell near where the bot died in the nether (nearDeath) */
export const GRID_DEATH_COST = 5

interface GridBlock { name: string, boundingBox: string }

/** a cell's key: x and z to 20 bits (wrapped), y to 12 */
function cellKey (p: Vec3): number {
  return ((p.x & 0xfffff) * 0x100000 + (p.z & 0xfffff)) * 0x1000 + ((p.y + 2048) & 0xfff)
}

/**
 * The block of a cell for one grid search: its registry entry by the world's state id (the name and the collision
 * box a prismarine Block takes from it, Block.fromStateId), each cell read once; null where the world has no column.
 * bot.blockAt made a Block for each of a search's lookups, its block entity, biome and light read too: 90% of a
 * nether grid search.
 */
export function gridBlockLookup (bot: Bot): (p: Vec3) => GridBlock | null {
  const world = bot.world as any
  if (typeof world?.getColumnAt !== 'function') return p => bot.blockAt(p)
  const byState = bot.registry.blocksByStateId as Record<number, GridBlock | undefined>
  const seen = new Map<number, GridBlock | null>()
  const local = new Vec3(0, 0, 0)
  return p => {
    const k = cellKey(p)
    let b = seen.get(k)
    if (b === undefined) {
      // (the world's getBlockStateId is air where no column is loaded: blockAt's null is kept)
      const column = world.getColumnAt(p)
      b = column == null ? null : byState[column.getBlockStateId(local.set(p.x & 15, p.y, p.z & 15))] ?? null
      seen.set(k, b)
    }
    return b
  }
}

/** the bot's world as gridWalk sees it */
export function botGridView (bot: Bot): GridCellView {
  const blockOf = gridBlockLookup(bot)
  const isLava = (p: Vec3): boolean => blockOf(p)?.name === 'lava'
  const nether = normalizeDimension(bot.game?.dimension) === 'the_nether'
  // where the bot died in the nether: kept away from, as the pathfinder's nether settings do
  const deaths = nether ? (bot.survival?.memory?.getPois('nether_death', { dimension: 'the_nether' }) ?? []) : []
  return {
    free: p => { const b = blockOf(p); return b != null && b.boundingBox === 'empty' && !HARMFUL.has(b.name) },
    // (and no cell the hazard reflex took the bot out of lately: hazardLeft)
    floor: p => { const b = blockOf(p); return b != null && b.boundingBox === 'block' && b.name !== 'magma_block' && !hazardLeft(bot, p.offset(0, 1, 0)) },
    lava: isLava,
    edgeCost: nether ? GRID_EDGE_COST.the_nether : GRID_EDGE_COST.other,
    cellCost: deaths.length > 0 ? c => nearDeath(deaths, c) ? GRID_DEATH_COST : 0 : undefined
  }
}

export interface GridWalkArgs {
  target: Vec3
  /** done within this many blocks (default 1) */
  range?: number
  /** the range counts x and z only (a hop over unknown heights) */
  horizontal?: boolean
  maxNodes?: number
}

/** walks a grid path to within `range` of the target, block middle to block middle (a jump for each step up) */
export async function gridWalk (bot: Bot, args: GridWalkArgs, signal?: AbortSignal): Promise<{ cells: number }> {
  throwIfAborted(signal)
  const view = botGridView(bot)
  const t = args.target.floored()
  const range = args.range ?? 1
  const start = bot.entity.position.floored()
  const dist = (c: Vec3): number => args.horizontal === true ? Math.hypot(c.x - t.x, c.z - t.z) : c.distanceTo(t)
  const path = await gridPathSliced(view, start, c => dist(c) <= range, dist, args.maxNodes, { between: () => throwIfAborted(signal) })
  if (path == null) throw new SkillError('NO_PATH', `no grid path from ${start.toString()} to ${t.toString()}`)
  trace('gridWalk:', path.length, 'cells to', t.toString())
  let prev = start
  for (const cell of path) {
    throwIfAborted(signal)
    const ok = await walkTo(bot, cell.offset(0.5, 0, 0.5), { within: 0.2, maxTicks: cell.y > prev.y ? 30 : 25 }, signal)
    if (!ok && bot.entity.position.floored().distanceTo(cell) > 1.5) throw new SkillError('STUCK', `the grid walk stopped at ${bot.entity.position.toString()} short of ${cell.toString()}`)
    prev = cell
  }
  return { cells: path.length }
}

/**
 * To within `range` of a point: the pathfinder first, then a grid walk when it finds no path in time or gets stuck
 * (the grid walk neither digs nor builds, so it's for ground the bot can walk).
 */
export async function moveNear (bot: Bot, target: Vec3, range: number, signal?: AbortSignal): Promise<'pathfinder' | 'grid'> {
  const t = target.floored()
  try {
    await navigate(bot, { goal: new goals.GoalNear(t.x, t.y, t.z, range), planTicks: 300, unstick: 1 }, signal)
    return 'pathfinder'
  } catch (err) {
    if (!isSkillError(err, 'NO_PATH') && !isSkillError(err, 'STUCK')) throw err
    trace('moveNear: the pathfinder failed (', (err as Error).message, '): walking the grid')
  }
  await gridWalk(bot, { target: t, range }, signal)
  return 'grid'
}
