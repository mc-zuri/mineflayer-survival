// A pen for the herd: a ring of fences with one gate, built with placeBlock, the fences and the gate got through the
// planner. The pathfinder goes in and out by the gate (it opens it and shuts it behind the bot: closeGatesBehind) and
// never digs the ring (protectPen); the herd is led in with its food (TemptGoal) and the gate shut on it (leadIntoPen).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals, useInSight } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isSkillError, throwIfAborted } from './errors'
import { navigate, navigateNear, walkTo } from './navigate'
import { placeBlock } from './placeBlock'
import { isFree, isSolid } from './placement'
import { countItems, findInventoryItem, trace, waitTicks, waitUntil, type Block } from './util'
import { BREEDING_FOOD } from './husbandry'
import { dig } from '../core/actions'
import { itemTags } from '../core/tags'
import type { WorldMemory } from '../core/memory'

export type Side = 'north' | 'south' | 'east' | 'west'

/** the way out of the pen by each side */
export const SIDE_DIRS: Readonly<Record<Side, Vec3>> = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
  east: new Vec3(1, 0, 0)
}

/** blocks put under a fence over a hole, any of them held */
export const PEN_FILLERS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'coarse_dirt']

/** blocks the bot leads an animal before it waits for it to catch up (leadIntoPen) */
export const LEAD_LEG = 5

/** the smallest pen: a 3 × 3 inside */
export const MIN_PEN_SIZE = 5

type Lookup = (pos: Vec3) => { name: string, boundingBox: string } | null

export interface PenPlan {
  /** the middle of the inside, at the feet's level (the level of the ring's fences) */
  center: Vec3
  /** cells across, the ring included (odd: 2 × radius + 1) */
  size: number
  /** the side the gate is in */
  side: Side
  /** the gate's cell, and the cells just inside and outside it (walked through) */
  gate: Vec3
  inside: Vec3
  outside: Vec3
  /** the cells a fence goes in (over a block a step up: on it) */
  fences: Vec3[]
  /** the cells a filler block goes in first, the lowest first (a hole under a fence, the gate or its walkway) */
  fillers: Vec3[]
  /** the cells to clear first: a plant in a fence's cell, a block in the gate's or its walkway's */
  clear: Vec3[]
}

/**
 * The pen's blocks as the ground is: a square ring of `size` cells across about `center` (its feet's level), the gate
 * in the middle of `side`. A fence goes in each ring cell at that level, or on the block there when the ground steps
 * up (a cow jumps a block, not a block and a fence, MobJumpControl); a hole under one is filled (two deep at most:
 * deeper, the ring goes round nothing a cow would climb out of anyway). The gate's cell and the cells either side of it
 * are cleared and floored.
 */
export function planPen (lookup: Lookup, center: Vec3, size: number, side: Side): PenPlan {
  const r = Math.floor(Math.max(MIN_PEN_SIZE, size) / 2)
  const c = center.floored()
  const out = SIDE_DIRS[side]
  const gate = c.plus(out.scaled(r))
  const plan: PenPlan = { center: c, size: 2 * r + 1, side, gate, inside: gate.minus(out), outside: gate.plus(out), fences: [], fillers: [], clear: [] }
  const solid = (p: Vec3): boolean => isSolid(lookup(p) as any)
  const free = (p: Vec3): boolean => isFree(lookup(p) as any)
  const floor = (p: Vec3): void => {
    if (solid(p.offset(0, -1, 0))) return
    if (!solid(p.offset(0, -2, 0))) plan.fillers.push(p.offset(0, -2, 0))
    plan.fillers.push(p.offset(0, -1, 0))
  }
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const cell = c.offset(dx, 0, dz)
      if (cell.equals(gate)) continue
      if (solid(cell)) {
        const above = cell.offset(0, 1, 0)
        if (solid(above)) continue
        if (!free(above)) plan.clear.push(above)
        plan.fences.push(above)
        continue
      }
      floor(cell)
      if (!free(cell)) plan.clear.push(cell)
      plan.fences.push(cell)
    }
  }
  for (const cell of [plan.outside, gate, plan.inside]) {
    floor(cell)
    for (const p of [cell, cell.offset(0, 1, 0)]) if (!free(p)) plan.clear.push(p)
  }
  return plan
}

/** whether a position is inside the pen's ring (its inside cells, any height) */
export function inPen (pen: Pick<PenPlan, 'center' | 'size'>, pos: Vec3): boolean {
  const r = Math.floor(pen.size / 2)
  return Math.abs(Math.floor(pos.x) - pen.center.x) < r && Math.abs(Math.floor(pos.z) - pen.center.z) < r
}

/** the pen's fence and gate cells (and what's under them), which the pathfinder may not break (protectPen) */
export function penCells (pen: PenPlan): Vec3[] {
  return [...pen.fences, pen.gate, ...pen.fillers]
}

/**
 * Keeps the pathfinder from breaking the pen's ring (an exclusion area for its breaks: a fence costs less to dig than
 * the walk round to the gate, and the herd would be out through the hole): the pathfinder opens the gate instead. A
 * pen protected again replaces the one before.
 */
export function protectPen (bot: Bot, pen: PenPlan): void {
  const pathfinder: any = bot.pathfinder
  const settings = pathfinder?.defaultMoveSettings
  if (settings == null) return
  const cells = new Set(penCells(pen).map(p => `${p.x},${p.y},${p.z}`))
  const keep = (block: any): number => cells.has(`${block.position.x},${block.position.y},${block.position.z}`) ? 1e9 : 0
  ;(keep as any).survivalPen = true
  pathfinder.setMoveOptions({
    ...settings,
    exclusionAreasBreak: [...(settings.exclusionAreasBreak ?? []).filter((f: any) => f.survivalPen !== true), keep]
  })
}

export interface BuildPenArgs {
  /** the middle of the inside, at the feet's level */
  center: Vec3
  /** cells across, the ring included (default 9: a 7 × 7 inside, room for a herd of 10 or so) */
  size?: number
  /** the side the gate is in (default the one nearest the bot) */
  side?: Side
  /**
   * Gets items the bot hasn't got (the executor's obtain, the planner's crafting: fences from planks and sticks, the
   * gate the same). Without it the pen is built from what's held.
   */
  obtain?: (requests: Array<{ item: string, count: number }>, signal?: AbortSignal) => Promise<unknown>
}

export interface Pen extends PenPlan {
  /** fences placed, and the fence cells already a fence */
  placed: number
}

/** the side of the pen nearest a position */
export function nearestSide (center: Vec3, pos: Vec3): Side {
  const dx = pos.x - (center.x + 0.5)
  const dz = pos.z - (center.z + 0.5)
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

async function clearCell (bot: Bot, pos: Vec3, signal?: AbortSignal): Promise<void> {
  const block = bot.blockAt(pos)
  if (block == null || isFree(block)) return
  await navigateNear(bot, pos, 3, signal)
  await dig(bot, block as Block, { signal })
  await waitUntil(bot, () => isFree(bot.blockAt(pos)), 20, signal)
}

/**
 * Builds a pen of fences with one gate (planPen): the fences and the gate got first (`obtain`), the plants and blocks
 * in the way cleared, the holes under it filled, each fence and the gate placed with placeBlock (the gate facing
 * along the way through it: FenceGateBlock.getStateForPlacement takes the player's facing), and the ring kept from the
 * pathfinder's digs (protectPen). Resolves the pen as built; a ring with a gap left throws.
 */
export async function buildPen (bot: Bot, args: BuildPenArgs, signal?: AbortSignal): Promise<Pen> {
  throwIfAborted(signal)
  const center = args.center.floored()
  const side = args.side ?? nearestSide(center, bot.entity.position)
  const lookup: Lookup = p => bot.blockAt(p) as any
  const plan = planPen(lookup, center, args.size ?? 9, side)
  const tags = itemTags(bot.registry as any)
  const fenceNames = tags.members('#wooden_fences')
  const gateNames = tags.members('#fence_gates')
  const isFence = (name: string | undefined): boolean => name != null && fenceNames.includes(name)
  const toPlace = plan.fences.filter(p => !isFence(bot.blockAt(p)?.name))
  const gateThere = gateNames.includes(bot.blockAt(plan.gate)?.name ?? '')

  // the materials: the fences and the gate (the planner crafts them), the fillers from what's held
  const fencesHeld = countItems(bot, [...fenceNames])
  const want: Array<{ item: string, count: number }> = []
  if (fencesHeld < toPlace.length) want.push({ item: '#wooden_fences', count: toPlace.length })
  if (!gateThere && countItems(bot, [...gateNames]) === 0) want.push({ item: '#fence_gates', count: 1 })
  if (want.length > 0) {
    if (args.obtain == null) throw new SkillError('MISSING_ITEMS', `a pen of ${plan.size} takes ${toPlace.length} fences and a gate`)
    await args.obtain(want, signal)
  }
  const fillersNeeded = plan.fillers.filter(p => !isSolid(bot.blockAt(p))).length
  if (fillersNeeded > countItems(bot, PEN_FILLERS)) throw new SkillError('MISSING_ITEMS', `the pen's ground takes ${fillersNeeded} blocks to fill its holes`)

  for (const pos of plan.clear) await clearCell(bot, pos, signal)
  for (const pos of plan.fillers) {
    if (isSolid(bot.blockAt(pos))) continue
    const filler = PEN_FILLERS.find(n => countItems(bot, n) > 0)
    if (filler == null) throw new SkillError('MISSING_ITEMS', 'no block to fill the hole under the pen')
    await placeBlock(bot, { pos, item: filler }, signal)
  }

  let placed = plan.fences.length - toPlace.length
  // round the ring from the gate, so the bot isn't walled off from the cells still to do
  const order = [...toPlace].sort((a, b) => ringAngle(plan, a) - ringAngle(plan, b))
  for (const pos of order) {
    throwIfAborted(signal)
    const item = fenceNames.find(n => countItems(bot, n) > 0)
    if (item == null) throw new SkillError('MISSING_ITEMS', 'no fence left for the pen')
    const res = await placeWithRetry(bot, pos, item, signal)
    if (!isFence(res.block)) throw new SkillError('VERIFY_FAILED', `${res.block} is at ${pos.toString()}, not a fence`)
    placed++
  }
  if (!gateThere) {
    const item = gateNames.find(n => countItems(bot, n) > 0)
    if (item == null) throw new SkillError('MISSING_ITEMS', 'no fence gate for the pen')
    // the gate's bar lies across the way through it: placed facing out (or in) of the pen
    await placeWithRetry(bot, plan.gate, item, signal, SIDE_DIRS[side])
    const gate = bot.blockAt(plan.gate)
    if (gate == null || !gateNames.includes(gate.name)) throw new SkillError('VERIFY_FAILED', `no gate at ${plan.gate.toString()}`)
    if ((gate.getProperties() as any).open === true) await useGate(bot, plan.gate, false, signal)
  }
  protectPen(bot, plan)
  trace('buildPen:', placed, 'fences and a gate at', plan.gate.toString())
  return { ...plan, placed }
}

/** whether a mob (any entity but items, orbs and arrows) has its box in the cell: a block isn't placed there */
function mobIn (bot: Bot, pos: Vec3): boolean {
  return Object.values(bot.entities).some((e: any) => {
    if (e === bot.entity || e.position == null || /^(item|experience_orb|arrow|spectral_arrow)$/.test(e.name ?? '')) return false
    const hw = (e.width ?? 0.6) / 2
    return e.position.x + hw > pos.x && e.position.x - hw < pos.x + 1 && e.position.z + hw > pos.z && e.position.z - hw < pos.z + 1 &&
      e.position.y < pos.y + 1 && e.position.y + (e.height ?? 1.8) > pos.y
  })
}

/**
 * placeBlock, out of the cell first (outOfCell) and with no mob in it (the server refuses a block whose collision
 * shape an entity is in: BlockItem.canPlace, Level.isUnobstructed; a sheep wandered into the ring), and again from
 * nearer when the server didn't place it (twice more)
 */
async function placeWithRetry (bot: Bot, pos: Vec3, item: string, signal?: AbortSignal, facing?: Vec3): Promise<{ block: string }> {
  for (let attempt = 0; ; attempt++) {
    await outOfCell(bot, pos, signal)
    if (mobIn(bot, pos)) await waitUntil(bot, () => !mobIn(bot, pos), 200, signal)
    try {
      return await placeBlock(bot, { pos, item, facing }, signal)
    } catch (err) {
      if (attempt >= 2 || !isSkillError(err, 'CANNOT_PLACE')) throw err
      trace('buildPen: again at', pos.toString(), 'from', bot.entity.position.toString(), (err as Error).message)
      await navigateNear(bot, pos, 2, signal).catch(() => {})
    }
  }
}

/**
 * The bot's box out of the cell a fence goes in (to the middle of the block it stands in): the server refuses a
 * block whose collision shape the player is in (BlockItem.canPlace: Level.isUnobstructed), and a fence joined to its
 * neighbours reaches the cell's edges
 */
async function outOfCell (bot: Bot, pos: Vec3, signal?: AbortSignal): Promise<void> {
  const p = bot.entity.position
  const overlaps = p.x + 0.3 > pos.x && p.x - 0.3 < pos.x + 1 && p.z + 0.3 > pos.z && p.z - 0.3 < pos.z + 1 && p.y < pos.y + 1 && p.y + 1.8 > pos.y
  if (!overlaps) return
  const feet = p.floored()
  if (feet.x === pos.x && feet.z === pos.z) return // (placeBlock goes off the cell itself)
  await walkTo(bot, feet.offset(0.5, 0, 0.5), { within: 0.1, maxTicks: 20 }, signal)
}

/** the angle of a ring cell about the pen's middle, from the gate round */
function ringAngle (pen: PenPlan, pos: Vec3): number {
  const a = Math.atan2(pos.z - pen.center.z, pos.x - pen.center.x)
  const g = Math.atan2(pen.gate.z - pen.center.z, pen.gate.x - pen.center.x)
  return ((a - g) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
}

/** the gate opened or shut (a right click through the crosshair, the pathfinder's useInSight), from where the bot stands */
export async function useGate (bot: Bot, gate: Vec3, open: boolean, signal?: AbortSignal): Promise<boolean> {
  const isOpen = (): boolean => (bot.blockAt(gate)?.getProperties() as any)?.open === true
  if (isOpen() === open) return true
  for (let attempt = 0; attempt < 3 && isOpen() !== open; attempt++) {
    const block = bot.blockAt(gate)
    if (block == null) return false
    if (!(await useInSight(bot, block as any))) {
      await navigateNear(bot, gate, 2, signal)
      continue
    }
    await waitUntil(bot, () => isOpen() === open, 20, signal)
  }
  return isOpen() === open
}

export interface LeadIntoPenArgs {
  /** the animal (default cow) */
  mob?: string
  /** trips out for strays at most (default 6) */
  trips?: number
  /** how far from the pen strays are looked for (default 48) */
  radius?: number
}

/**
 * Leads the herd into the pen with its food in hand (TemptGoal: an animal follows a player holding its food within
 * 10 blocks, at 1.25 its speed): to the nearest ones outside, then back into the pen at a walk, through the gate left
 * open behind; once those that followed are in, the food is put away (they stop following), the bot goes out and the
 * gate is shut behind it (the pathfinder's closeGatesBehind). Resolves how many of the kind are in the pen.
 */
export async function leadIntoPen (bot: Bot, pen: PenPlan, args: LeadIntoPenArgs = {}, signal?: AbortSignal): Promise<number> {
  const mob = args.mob ?? 'cow'
  const food = (BREEDING_FOOD[mob] ?? []).find(f => countItems(bot, f) > 0)
  const herd = (): any[] => Object.values(bot.entities).filter(e => e.name === mob)
  const inside = (): number => herd().filter(e => inPen(pen, e.position)).length
  if (food == null) throw new SkillError('MISSING_ITEMS', `no food for the ${mob}s`)
  // the food away so that none follows, then out by the gate, which is shut behind the bot (none standing in it as
  // it shuts: a mob in a closing gate is pushed out of its box, either side)
  const shutIn = async (): Promise<void> => {
    await bot.unequip('hand').catch(() => {})
    // the gate shut from inside first (none wanders out while the bot goes), then out by it: the pathfinder opens it
    // and shuts it behind the bot
    await waitUntil(bot, () => !herd().some(e => e.position.floored().x === pen.gate.x && e.position.floored().z === pen.gate.z), 200, signal)
    const by = pen.inside.minus(SIDE_DIRS[pen.side])
    await navigate(bot, { goal: new goals.GoalBlock(by.x, by.y, by.z) }, signal).catch(err => trace('leadIntoPen: not by the gate:', (err as Error).message))
    if (!(await useGate(bot, pen.gate, false, signal))) trace('leadIntoPen: the gate would not shut')
    await waitTicks(bot, 20, signal)
    await leavePen(bot, pen, signal)
  }
  const pathfinder: any = bot.pathfinder
  for (let trip = 0; trip < (args.trips ?? 6); trip++) {
    throwIfAborted(signal)
    // (out with the gate shut and the food away first: those in would follow the bot out)
    if (inPen(pen, bot.entity.position)) await shutIn()
    const strays = herd().filter(e => !inPen(pen, e.position) && e.position.distanceTo(pen.center) <= (args.radius ?? 48))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (strays.length === 0) break
    try {
      await navigateNear(bot, strays[0].position, 3, signal)
    } catch (err) {
      trace('leadIntoPen: no way to the', mob, (err as Error).message)
      continue
    }
    const item = findInventoryItem(bot, food)
    if (item == null) break
    await bot.equip(item, 'hand')
    // till the stray follows (an animal let go of lately waits out its calm down first, TemptGoal.calmDown)
    const stray = strays[0]
    await waitUntil(bot, () => stray.position.distanceTo(bot.entity.position) <= 4, 100, signal)
    // to the gate in legs of LEAD_LEG blocks, each waited at till the stray is near again (it follows at its own
    // pace, and one left 10 blocks behind is let go: TemptGoal.canUse)
    for (let leg = 0; leg < 12 && Math.hypot(bot.entity.position.x - pen.outside.x - 0.5, bot.entity.position.z - pen.outside.z - 0.5) > LEAD_LEG; leg++) {
      throwIfAborted(signal)
      const p = bot.entity.position
      const d = new Vec3(pen.outside.x + 0.5 - p.x, 0, pen.outside.z + 0.5 - p.z)
      const to = p.plus(d.scaled(LEAD_LEG / d.norm())).floored()
      await navigate(bot, { goal: new goals.GoalNear(to.x, pen.outside.y, to.z, 2) }, signal).catch(err => trace('leadIntoPen: a leg:', (err as Error).message))
      if (!(await waitUntil(bot, () => stray.position.distanceTo(bot.entity.position) <= 4, 100, signal))) break
    }
    // in at a walk, by the gate left open behind, to the far side of the inside (a tempted animal stops 2.5 blocks
    // off the player, TemptGoal.tick: by the gate it would stop in it); then a wait for those that followed to come in
    const before = pathfinder?.defaultMoveSettings
    if (before != null) pathfinder.setMoveOptions({ ...before, closeGatesBehind: false, allowSprinting: false })
    try {
      const far = pen.center.minus(SIDE_DIRS[pen.side].scaled(Math.max(0, Math.floor(pen.size / 2) - 2)))
      await navigate(bot, { goal: new goals.GoalBlock(far.x, far.y, far.z) }, signal).catch(err => trace('leadIntoPen: not in:', (err as Error).message))
    } finally {
      if (before != null) pathfinder.setMoveOptions(before)
    }
    const near = (): number => herd().filter(e => !inPen(pen, e.position) && e.position.distanceTo(bot.entity.position) <= 10).length
    await waitUntil(bot, () => near() === 0, 300, signal)
    trace('leadIntoPen: trip', trip, 'bot', bot.entity.position.floored().toString(), 'gate', (bot.blockAt(pen.gate)?.getProperties() as any)?.open, bot.heldItem?.name, 'herd', herd().map(e => e.position.floored().toString()).join(' '))
  }
  if (inPen(pen, bot.entity.position) || (bot.blockAt(pen.gate)?.getProperties() as any)?.open === true) await shutIn()
  trace('leadIntoPen:', inside(), mob + 's in the pen')
  return inside()
}

/** out of the pen to the cell before its gate, the gate shut behind (shut by hand if the pathfinder left it open) */
export async function leavePen (bot: Bot, pen: PenPlan, signal?: AbortSignal): Promise<void> {
  if (inPen(pen, bot.entity.position)) {
    await navigate(bot, { goal: new goals.GoalBlock(pen.outside.x, pen.outside.y, pen.outside.z) }, signal)
  }
  if ((bot.blockAt(pen.gate)?.getProperties() as any)?.open === true) await useGate(bot, pen.gate, false, signal)
}

/** the point of interest a pen is remembered by (its middle; its note the plan's size, side, ring and fillers) */
export const PEN = 'pen'

/** a pen as remembered (memory's PEN point of interest), null for none near `near` within `range` */
export function penFromMemory (memory: WorldMemory, near: Vec3, range = 64): PenPlan | null {
  for (const poi of memory.getPois(PEN, { dimension: 'overworld', near })) {
    if (Math.hypot(poi.x - near.x, poi.z - near.z) > range) break
    try {
      const n = JSON.parse(poi.note ?? '') as { size: number, side: Side, fences: number[][], fillers: number[][] }
      const center = new Vec3(poi.x, poi.y, poi.z)
      const out = SIDE_DIRS[n.side]
      const gate = center.plus(out.scaled(Math.floor(n.size / 2)))
      const v = (a: number[]): Vec3 => new Vec3(a[0], a[1], a[2])
      return { center, size: n.size, side: n.side, gate, inside: gate.minus(out), outside: gate.plus(out), fences: n.fences.map(v), fillers: n.fillers.map(v), clear: [] }
    } catch {}
  }
  return null
}

/** remembers the pen (penFromMemory) */
export function rememberPen (memory: WorldMemory, pen: PenPlan): void {
  const note = JSON.stringify({ size: pen.size, side: pen.side, fences: pen.fences.map(p => p.toArray()), fillers: pen.fillers.map(p => p.toArray()) })
  memory.addPoi(PEN, pen.center, 'overworld', note)
}

/**
 * Where a pen of `size` goes near `home`: the middle of the flattest ground 6 to 16 blocks off it (the fewest holes to
 * fill, blocks to clear and steps to fence on top), with a floor and room for the herd over every inside cell and no
 * water or lava in it; null when there's none
 */
export function choosePenSite (lookup: Lookup, home: Vec3, size: number): { center: Vec3, side: Side } | null {
  const r = Math.floor(Math.max(MIN_PEN_SIZE, size) / 2)
  let best: { center: Vec3, side: Side, score: number } | null = null
  const h = home.floored()
  for (let dx = -16; dx <= 16; dx += 2) {
    for (let dz = -16; dz <= 16; dz += 2) {
      const d = Math.max(Math.abs(dx), Math.abs(dz))
      if (d < 6 + r - 2) continue
      for (const dy of [0, 1, -1, 2, -2]) {
        const center = h.offset(dx, dy, dz)
        // the inside: a floor, the herd's room over it
        let ok = true
        for (let ix = -r + 1; ix < r && ok; ix++) {
          for (let iz = -r + 1; iz < r && ok; iz++) {
            const cell = center.offset(ix, 0, iz)
            ok = isSolid(lookup(cell.offset(0, -1, 0)) as any) && isFree(lookup(cell) as any) && isFree(lookup(cell.offset(0, 1, 0)) as any)
          }
        }
        if (!ok) continue
        const side = nearestSide(center, h)
        const plan = planPen(lookup, center, size, side)
        const steps = plan.fences.filter(p => p.y !== center.y).length
        const score = plan.fillers.length * 3 + plan.clear.length * 2 + steps + d * 0.1
        if (best == null || score < best.score) best = { center, side, score }
        break
      }
    }
  }
  return best == null ? null : { center: best.center, side: best.side }
}

export interface HerdPenArgs {
  /** where the herd lives (the HERD point of interest): the pen is built near it */
  home: Vec3
  memory: WorldMemory
  /** the executor's obtain, for the fences and the gate (BuildPenArgs.obtain) */
  obtain?: BuildPenArgs['obtain']
  /** the animal (default cow) */
  mob?: string
  /** the pen's size (default 9) */
  size?: number
}

/**
 * The herd's pen, the hook for the enchanting milestone's herd: the pen remembered near home (kept from the
 * pathfinder's digs again), else one built near home (choosePenSite, buildPen) and remembered; then the herd led in
 * with its food and shut in (leadIntoPen), when the bot holds the food. Resolves the pen and the animals in it.
 */
export async function herdPen (bot: Bot, args: HerdPenArgs, signal?: AbortSignal): Promise<{ pen: PenPlan, inside: number, built: boolean }> {
  let pen = penFromMemory(args.memory, args.home)
  let built = false
  if (pen != null) {
    protectPen(bot, pen)
  } else {
    const size = args.size ?? 9
    const site = choosePenSite(p => bot.blockAt(p) as any, args.home, size)
    if (site == null) throw new SkillError('NOT_FOUND', `no ground for a pen of ${size} near ${args.home.toString()}`)
    pen = await buildPen(bot, { center: site.center, size, side: site.side, obtain: args.obtain }, signal)
    rememberPen(args.memory, pen)
    built = true
  }
  const mob = args.mob ?? 'cow'
  const hasFood = (BREEDING_FOOD[mob] ?? []).some(f => countItems(bot, f) > 0)
  const inside = hasFood
    ? await leadIntoPen(bot, pen, { mob }, signal)
    : Object.values(bot.entities).filter(e => e.name === mob && inPen(pen as PenPlan, e.position)).length
  return { pen, inside, built }
}
