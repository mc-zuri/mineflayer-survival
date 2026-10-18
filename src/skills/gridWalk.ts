// gridWalk: a short walk planned on the block grid and walked from block middle to block middle, for the places the
// pathfinder's executor catches on corners (fortress bridges, stronghold corridors): no digging, no placing, no jumps
// but a step up; cells next to lava, and fire, left out.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isSkillError, throwIfAborted } from './errors'
import { navigate, walkTo } from './navigate'
import { trace } from './util'

export interface GridCellView {
  /** the cell holds nothing to collide with (air, plants, a portal), and no lava or fire */
  free: (p: Vec3) => boolean
  /** the cell can be stood on: a full collision box (not magma) */
  floor: (p: Vec3) => boolean
  /** lava in the cell */
  lava?: (p: Vec3) => boolean
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
 * A* on the grid from `start` to the nearest cell where `isGoal` holds, within `maxNodes` cells looked at; the cells
 * to walk (start left out), or null.
 */
export function gridPath (view: GridCellView, start: Vec3, isGoal: (c: Vec3) => boolean, heuristic: (c: Vec3) => number, maxNodes = 20000): Vec3[] | null {
  const open = new MinHeap<{ c: Vec3, g: number, f: number }>(n => n.f)
  open.push({ c: start, g: 0, f: heuristic(start) })
  const came = new Map<string, Vec3 | null>([[key(start), null]])
  const best = new Map<string, number>([[key(start), 0]])
  let seen = 0
  while (open.size > 0 && seen++ < maxNodes) {
    const { c, g } = open.pop()
    if (g > (best.get(key(c)) ?? Infinity)) continue
    if (isGoal(c)) {
      const path: Vec3[] = []
      let at: Vec3 | null = c
      while (at != null && !at.equals(start)) { path.unshift(at); at = came.get(key(at)) ?? null }
      return path
    }
    for (const n of gridNeighbours(view, c)) {
      const cost = g + 1 + (n.y !== c.y ? 0.5 : 0)
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

/** the bot's world as gridWalk sees it */
export function botGridView (bot: Bot): GridCellView {
  const isLava = (p: Vec3): boolean => bot.blockAt(p)?.name === 'lava'
  return {
    free: p => { const b = bot.blockAt(p); return b != null && b.boundingBox === 'empty' && !HARMFUL.has(b.name) },
    floor: p => { const b = bot.blockAt(p); return b != null && b.boundingBox === 'block' && b.name !== 'magma_block' },
    lava: isLava
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
  const path = gridPath(view, start, c => dist(c) <= range, dist, args.maxNodes)
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
