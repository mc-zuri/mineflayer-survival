// caves: a bot not equipped for the caves mines only in its own tunnels and staircases. The caves, the mineshafts and
// the ravines are where the dark's monsters spawn at any hour (Monster.isDarkEnoughToSpawn: block light 0 since 1.18)
// and the cave spiders' spawners are: a 26.3 bot sent down a mineshaft for cobwebs fought cave spiders with a stone
// sword and was killed (ls-26.3 t34384, at y 20), and one going down for diamonds in iron was killed at y 20 by a
// zombie and cave spiders (t100061). The gate (caveReady) is the bot's state, not a flat ban: in enchanted iron or
// better, with a full bar and cooked food carried, the caves are walked as any ground.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { foodInfo } from '../core/items'
import { wornArmor } from './armor'

/** the weakest armor and sword the caves are let into in (iron, diamond, netherite) */
export const CAVE_TIERS = ['iron', 'diamond', 'netherite']
/** the worn armor pieces (of the four) with an enchantment, at least */
export const CAVE_ENCHANTED_ARMOR = 2
/** the food bar (FoodData.tick heals from 18 up) */
export const CAVE_FOOD = 18
/** the cooked food carried, in nutrition points (five steaks) */
export const CAVE_FOOD_POINTS = 40
/** the health */
export const CAVE_HEALTH = 12
/** the food that isn't cooked (or is no meal): not counted toward CAVE_FOOD_POINTS */
const UNCOOKED = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato', 'poisonous_potato', 'rotten_flesh', 'spider_eye', 'pufferfish', 'tropical_fish', 'chorus_fruit'])

const tierOf = (name: string): string | null => /^([a-z]+)_(sword|helmet|chestplate|leggings|boots)$/.exec(name)?.[1] ?? null
const enchanted = (item: Item | null | undefined): boolean => {
  try {
    return ((item as { enchants?: unknown[] } | null)?.enchants?.length ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Why the bot isn't fit for the caves, or null when it is (caveReady): four armor pieces of CAVE_TIERS worn, at least
 * CAVE_ENCHANTED_ARMOR of them enchanted; an enchanted sword of CAVE_TIERS carried; the bar at CAVE_FOOD and
 * CAVE_FOOD_POINTS of cooked food carried; CAVE_HEALTH.
 */
export function caveUnreadiness (bot: Bot): string | null {
  let worn: Array<Item | null>
  try {
    worn = Object.values(wornArmor(bot))
  } catch {
    return 'no armor'
  }
  if (worn.some(i => i == null || !CAVE_TIERS.includes(tierOf(i.name) ?? ''))) return 'no full iron armor worn'
  if (worn.filter(enchanted).length < CAVE_ENCHANTED_ARMOR) return 'the armor not enchanted'
  const items = [...bot.inventory.items(), ...(bot.heldItem != null ? [bot.heldItem] : [])]
  if (!items.some(i => i.name.endsWith('_sword') && CAVE_TIERS.includes(tierOf(i.name) ?? '') && enchanted(i))) return 'no enchanted iron sword'
  if (bot.food < CAVE_FOOD) return `food ${bot.food}`
  let points = 0
  for (const i of bot.inventory.items()) {
    if (UNCOOKED.has(i.name)) continue
    const food = foodInfo(bot.registry as any, i.name)
    if (food != null && food.harmful !== true) points += food.nutrition * i.count
  }
  if (points < CAVE_FOOD_POINTS) return `${points} points of cooked food`
  if (bot.health < CAVE_HEALTH) return `health ${Math.round(bot.health)}`
  return null
}

/**
 * Whether the bot may go into the caves (caveUnreadiness): the one gate of the cave rule, for the mining targets, the
 * pathfinder's costs, the cobweb's string and the fight or the wall in. Until it is (all the early game, before the
 * enchanting) the bot mines in its own sealed tunnels only.
 */
export function caveReady (bot: Bot): boolean {
  return caveUnreadiness(bot) == null
}

/** a cell's block as the classifier sees it */
export type CaveBlock = { name: string, boundingBox: string } | null

export interface CaveView {
  /** the block in a cell, null where the chunk isn't loaded */
  block: (p: Vec3) => CaveBlock
  /** its block light (default 0) */
  light?: (p: Vec3) => number
  /** whether the bot dug the cell itself (default none) */
  dug?: (p: Vec3) => boolean
}

/** the flood's reach round a cell, across (Chebyshev) */
export const CAVE_RADIUS = 4
/**
 * the open cells joined to a cell within CAVE_RADIUS that make it a cave's: a tunnel the bot dug (1 wide, 2 high) has
 * 18 within the 9 blocks across, a crossing of two 34, a staircase about 21; a cave's tube 3 across 81, a mineshaft's
 * corridor as many (inNarrowPassage's 48 the same idea)
 */
export const CAVE_CELLS = 40
/** the blocks over a cell (its column's highest solid one this far up or more) that make it under rock, not a roof */
export const CAVE_ROOF = 3

const LIQUIDS = new Set(['water', 'lava', 'bubble_column'])
const TREE = /_(leaves|log|wood)$|^mangrove_roots$/
const FACES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0), new Vec3(0, -1, 0)]
const WORLD_TOP = 320
const WORLD_BOTTOM = -64

/** a cell a mob walks through: no collision box, no liquid (a cobweb, a rail, a torch, the air) */
export function openBlock (b: CaveBlock): boolean {
  return b != null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name)
}

const keyOf = (p: { x: number, y: number, z: number }): string => `${p.x},${p.y},${p.z}`

/**
 * Tells the cave's cells from the rest: an open cell (openBlock) the bot didn't dig, unlit, under rock (its column's
 * highest solid block, trees left out, CAVE_ROOF or more over it), and a carved one (cave_air: WorldCarver's caves and
 * ravines, the mineshafts' corridors, the dungeons) or joined to CAVE_CELLS such cells within CAVE_RADIUS (the noise
 * caves are plain air). The verdicts are kept till forget(); a flood's cells share the verdict it came to.
 */
export class CaveCells {
  private readonly cells = new Map<string, boolean>()
  private readonly tops = new Map<string, number>()

  constructor (readonly view: CaveView) {}

  /** the column's highest solid block (trees left out), -Infinity for none */
  top (x: number, z: number): number {
    const k = `${x},${z}`
    const known = this.tops.get(k)
    if (known != null) return known
    let top = -Infinity
    for (let y = WORLD_TOP; y >= WORLD_BOTTOM; y--) {
      const b = this.view.block(new Vec3(x, y, z))
      if (b != null && b.boundingBox === 'block' && !TREE.test(b.name)) { top = y; break }
    }
    this.tops.set(k, top)
    return top
  }

  /** CAVE_ROOF or more of rock over the cell */
  roofed (p: Vec3): boolean {
    return this.top(p.x, p.z) >= p.y + CAVE_ROOF
  }

  /** an open, undug, unlit cell under rock: one a cave's could be */
  candidate (p: Vec3): boolean {
    if (!openBlock(this.view.block(p))) return false
    if (this.view.dug?.(p) === true) return false
    if ((this.view.light?.(p) ?? 0) > 0) return false
    return this.roofed(p)
  }

  /** whether the cell is a cave's (see the class) */
  isCave (pos: { x: number, y: number, z: number }): boolean {
    const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    const k = keyOf(p)
    const known = this.cells.get(k)
    if (known != null) return known
    if (!this.candidate(p)) return false
    const seen = new Map<string, Vec3>([[k, p]])
    const queue = [p]
    let clipped = false
    let cave = this.view.block(p)?.name === 'cave_air'
    while (!cave && queue.length > 0) {
      const c = queue.pop() as Vec3
      for (const d of FACES) {
        const q = c.plus(d)
        const qk = keyOf(q)
        if (seen.has(qk)) continue
        if (Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y), Math.abs(q.z - p.z)) > CAVE_RADIUS) {
          if (this.candidate(q)) clipped = true
          continue
        }
        const known = this.cells.get(qk)
        if (known === false || !this.candidate(q)) continue
        seen.set(qk, q)
        if (known === true || this.view.block(q)?.name === 'cave_air' || seen.size >= CAVE_CELLS) { cave = true; break }
        queue.push(q)
      }
    }
    // (a flood cut at its reach is no verdict on the cells it went through, but the one it started from)
    if (cave || !clipped) for (const sk of seen.keys()) this.cells.set(sk, cave)
    else this.cells.set(k, false)
    return cave
  }

  /** the cave's cells against the faces of `cells` (not among them) */
  beside (cells: readonly Vec3[]): Vec3[] {
    const out: Vec3[] = []
    for (const c of cells) {
      for (const d of FACES) {
        const q = c.plus(d)
        if (cells.some(o => o.equals(q)) || out.some(o => o.equals(q))) continue
        if (this.isCave(q)) out.push(q)
      }
    }
    return out
  }

  /** every verdict forgotten (a block changed) */
  forget (): void {
    this.cells.clear()
  }

  /** a column's top forgotten (a block in it changed), and every verdict */
  forgetColumn (x: number, z: number): void {
    this.tops.delete(`${x},${z}`)
    this.cells.clear()
  }

  /** a column's top forgotten alone */
  forgetTop (x: number, z: number): void {
    this.tops.delete(`${x},${z}`)
  }

  /** everything forgotten (chunks loaded or gone) */
  reset (): void {
    this.cells.clear()
    this.tops.clear()
  }
}

/** the cells the bot dug (its tunnels and staircases), by dimension, the oldest dropped past DUG_MAX */
export const DUG_MAX = 200000

interface BotCaves {
  cells: CaveCells
  dug: Set<string>
}
const botCaves = new WeakMap<Bot, BotCaves>()

const dimensionOf = (bot: Bot): string => String(bot.game?.dimension ?? 'overworld')

/** the bot's world for the classifier: its block states (a chunk not loaded: null), block light and dug cells */
function botView (bot: Bot, dug: Set<string>): CaveView {
  const world = (bot as any).world
  const byState = (bot.registry as any)?.blocksByStateId
  const fast = typeof world?.getBlockStateId === 'function' && typeof world?.getColumnAt === 'function' && byState != null
  const block = fast
    ? (p: Vec3): CaveBlock => world.getColumnAt(p) == null ? null : (byState[world.getBlockStateId(p)] ?? null)
    : (p: Vec3): CaveBlock => (bot.blockAt(p) as any) ?? null
  const light = typeof world?.getBlockLight === 'function'
    ? (p: Vec3): number => world.getColumnAt(p) == null ? 0 : (world.getBlockLight(p) ?? 0)
    : (p: Vec3): number => (bot.blockAt(p) as any)?.light ?? 0
  return { block, light, dug: p => dug.has(`${dimensionOf(bot)}:${keyOf(p)}`) }
}

/** how far off a block's change (across) makes the bot's classifier forget its verdicts */
export const FORGET_RANGE = 48

/** the light sources a block update brings or takes (the light update comes after, not as a block update) */
const LIGHTS = /(torch|lantern|campfire|glowstone|shroomlight|sea_lantern|jack_o_lantern|lava|fire|froglight|redstone_lamp|glow_lichen|end_rod|beacon|conduit)$/

/**
 * The bot's cave classifier (CaveCells over its world), kept in step with it: the cells it digs noted as its own, a
 * verdict forgotten when a block's openness or a light changes, all of them when chunks load
 */
export function caveCells (bot: Bot): CaveCells {
  let c = botCaves.get(bot)
  if (c != null) return c.cells
  const dug = new Set<string>()
  c = { cells: new CaveCells(botView(bot, dug)), dug }
  botCaves.set(bot, c)
  const cells = c.cells
  bot.on?.('diggingCompleted' as any, (block: any) => {
    const p = block?.position
    if (p == null) return
    if (dug.size >= DUG_MAX) dug.delete(dug.values().next().value as string)
    dug.add(`${dimensionOf(bot)}:${keyOf(p)}`)
    cells.forgetColumn(p.x, p.z)
  })
  bot.on?.('blockUpdate' as any, (old: any, now: any) => {
    const p = now?.position ?? old?.position
    if (p == null) return
    const changed = openBlock(old) !== openBlock(now) || (old?.boundingBox ?? '') !== (now?.boundingBox ?? '') || LIGHTS.test(old?.name ?? '') || LIGHTS.test(now?.name ?? '')
    if (!changed) return
    // (the verdicts only for a change near the bot: the sea's flows far off would clear them every tick)
    const at = bot.entity?.position
    if (at == null || Math.abs(p.x - at.x) <= FORGET_RANGE && Math.abs(p.z - at.z) <= FORGET_RANGE) cells.forgetColumn(p.x, p.z)
    else cells.forgetTop(p.x, p.z)
  })
  bot.on?.('chunkColumnLoad' as any, () => cells.reset())
  bot.on?.('chunkColumnUnload' as any, () => cells.reset())
  bot.on?.('respawn' as any, () => cells.reset())
  return cells
}

/** whether the bot dug the cell itself (caveCells' record) */
export function dugByBot (bot: Bot, p: { x: number, y: number, z: number }): boolean {
  caveCells(bot)
  return botCaves.get(bot)?.dug.has(`${dimensionOf(bot)}:${keyOf(p)}`) === true
}

const readyCache = new WeakMap<Bot, { tick: number, ready: boolean }>()
const ticks = new WeakMap<Bot, { n: number }>()

/** caveReady as of this physics tick (the pathfinder asks it for every cell of a search) */
export function caveReadyNow (bot: Bot): boolean {
  let t = ticks.get(bot)
  if (t == null) {
    const counter = { n: 0 }
    ticks.set(bot, t = counter)
    bot.on?.('physicsTick' as any, () => { counter.n++ })
  }
  const cached = readyCache.get(bot)
  if (cached != null && cached.tick === t.n) return cached.ready
  const ready = caveReady(bot)
  readyCache.set(bot, { tick: t.n, ready })
  return ready
}

/** whether the cave rule holds for the bot now: in the overworld (the nether's and the End's ground have their own), not caveReady */
export function caveRuleOn (bot: Bot): boolean {
  const dim = String(bot.game?.dimension ?? 'overworld')
  if (!/overworld/.test(dim)) return false
  return !caveReadyNow(bot)
}

/**
 * the extra cost (ticks) of a move ending in a cave's cell for a bot under the cave rule: far over a tunnel's step dug
 * through the rock (stone with a stone pickaxe some 12 ticks a block, deepslate 23; a step is two), so a way stays in
 * the rock unless a cave's saves a long way round; never forbidden (a bot in a cave walks out of it)
 */
export const CAVE_STEP_COST = 100
/** the extra cost of breaking a block with a cave's cell against a face: the dig opens the way into the cave */
export const CAVE_BREAK_COST = 100

/** the pathfinder's step rule of the cave rule: CAVE_STEP_COST into a cave's cell */
export function caveStepCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  const cells = caveCells(bot)
  return (block) => caveRuleOn(bot) && cells.isCave(block.position) ? CAVE_STEP_COST : 0
}

/** the pathfinder's break rule of the cave rule: CAVE_BREAK_COST for a block with a cave's cell against a face */
export function caveBreakCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  const cells = caveCells(bot)
  return (block) => {
    if (!caveRuleOn(bot)) return 0
    const p = block.position
    for (const d of FACES) if (cells.isCave({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z })) return CAVE_BREAK_COST
    return 0
  }
}

/**
 * caveStepCost and caveBreakCost added to the pathfinder's rules for good (once, createPlugin): every way the bot is
 * walked (a mine step's, a pickup's, a trip's) keeps to the rock and out of the caves while the rule holds
 */
export function keepOutOfCaves (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalCaves === true)) return
  const step = caveStepCost(bot)
  const brk = caveBreakCost(bot)
  ;(step as any).survivalCaves = true
  ;(brk as any).survivalCaves = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), step], exclusionAreasBreak: [...(settings.exclusionAreasBreak ?? []), brk] })
}

/**
 * Whether a block to mine is a cave's for a bot under the rule (caveRuleOn): open to a cave (a cave's cell against a
 * face: an ore in a cave's wall, a mineshaft's) or in one itself (a cobweb in a mineshaft's corridor). Mined, the bot
 * stands in the cave or opens its tunnel to it: such a block is passed over, and the tunnels go on to one in the rock.
 */
export function inCaveWall (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  if (!caveRuleOn(bot)) return false
  const cells = caveCells(bot)
  const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  return cells.isCave(p) || cells.beside([p]).length > 0
}

/**
 * Why a dug step (a staircase's or a tunnel's: the cells it opens and its floor) is a cave's, or null: a cell it opens
 * is a cave's, a cave's cell is against one (opened, the tunnel is the cave's), or its floor is one (the step over a
 * cave's air). Such a step isn't taken: the staircase or the tunnel turns and goes round, the rock kept between.
 */
export function caveStepHazard (cells: CaveCells, step: { open: readonly Vec3[], floor: Vec3 }, body: readonly Vec3[] = []): string | null {
  for (const c of step.open) if (cells.isCave(c)) return `a cave at ${c.toString()}`
  if (cells.isCave(step.floor)) return `a cave under ${step.floor.toString()}`
  const beside = cells.beside(step.open).filter(c => !body.some(b => b.equals(c)))
  return beside.length > 0 ? `a cave at ${beside[0].toString()}` : null
}

/** caveStepHazard for the bot under the cave rule (caveRuleOn), its body's cells left out; null off the rule */
export function caveStep (bot: Bot, step: { open: readonly Vec3[], floor: Vec3 }): string | null {
  if (!caveRuleOn(bot)) return null
  const p = bot.entity.position
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z))
  return caveStepHazard(caveCells(bot), step, [feet, feet.offset(0, 1, 0)])
}

/**
 * The cave's cells against the bot's body (its feet's sides, its head's sides and the cell over it) while it stands
 * in the rock (its feet's and head's cells no cave's), under the cave rule: the holes its tunnel broke into a cave
 */
export function caveOpenings (bot: Bot): Vec3[] {
  if (!caveRuleOn(bot) || bot.entity == null) return []
  const cells = caveCells(bot)
  const p = bot.entity.position
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z))
  const head = feet.offset(0, 1, 0)
  if (cells.isCave(feet) || cells.isCave(head)) return []
  // (not under the feet: the floor's no hole, and a block put there is under the bot)
  return cells.beside([feet, head]).filter(c => !(c.x === feet.x && c.z === feet.z && c.y < feet.y))
}

/**
 * The water and lava against the bot's body (its feet's sides, its head's sides and the cell over it) while it stands
 * dry in a cell it dug itself under the rock (its tunnel, its staircase), under the cave rule: what a dig let in or
 * opened onto (a pond's shore, a bucket filled under the sky, are no tunnel's; a bucket in hand is a pour meant: the
 * obsidian's cast, a cane farm's water)
 */
export function liquidOpenings (bot: Bot): Vec3[] {
  if (bot.entity == null || !caveRuleOn(bot)) return []
  if (/bucket$/.test(bot.heldItem?.name ?? '')) return []
  const cells = caveCells(bot)
  const view = cells.view
  const p = bot.entity.position
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z))
  const head = feet.offset(0, 1, 0)
  if (!dugByBot(bot, feet) || !cells.roofed(feet)) return []
  if ([feet, head].some(c => LIQUIDS.has(view.block(c)?.name ?? ''))) return []
  const out: Vec3[] = []
  for (const c of [feet, head]) {
    for (const d of FACES) {
      const q = c.plus(d)
      if (d.y < 0 || q.equals(feet) || q.equals(head)) continue
      if (LIQUIDS.has(view.block(q)?.name ?? '') && !out.some(o => o.equals(q))) out.push(q)
    }
  }
  return out
}

/**
 * Seals the holes into a cave by the bot (caveOpenings) and the water and lava against it in its tunnel
 * (liquidOpenings) with a block each (sealItem: cobblestone first); resolves the blocks put. A hole that won't take one
 * (a mob in it) is left.
 */
export async function sealCaveOpenings (bot: Bot, signal?: AbortSignal, opts: { skip?: (hole: Vec3) => boolean, sealed?: (hole: Vec3) => void, failed?: (hole: Vec3) => void } = {}): Promise<number> {
  const wet = liquidOpenings(bot)
  const holes = [...caveOpenings(bot), ...wet].filter(h => opts.skip?.(h) !== true)
  if (holes.length === 0) return 0
  const { sealItem } = await import('./shelter')
  const { placeBlock } = await import('./placeBlock')
  let placed = 0
  for (const hole of holes) {
    const item = sealItem(bot)
    if (item == null) break
    try {
      await placeBlock(bot, { pos: hole, item, intoFluid: wet.some(w => w.equals(hole)) }, signal)
      placed++
      opts.sealed?.(hole)
    } catch (err) {
      if (signal?.aborted === true) throw err
      opts.failed?.(hole)
    }
  }
  return placed
}

/** the most blocks a pocket for the night's wait may take (sealPocket): a tunnel's two ends 4, a staircase's step some 6 */
export const POCKET_MAX_BLOCKS = 10

/**
 * The cells to fill to shut the bot in where it stands (sealIn's box: the back, the sides at the feet and the head,
 * the roof, the front), or null where no box can be put up or it takes more than `maxBlocks`
 */
export async function pocketCells (bot: Bot, maxBlocks = POCKET_MAX_BLOCKS): Promise<Vec3[] | null> {
  const { sealBox, openCells } = await import('./sealIn')
  const box = sealBox(bot, [])
  if (box == null) return null
  const open = openCells(bot, box)
  return open.length <= maxBlocks ? open : null
}

/**
 * Shuts the bot in where it stands for a wait below the surface (the rest of the night down the mine): a sealed pocket,
 * both ends of its tunnel blocked and no way in from a cave, so nothing the dark spawns comes at it (a spawner near
 * behind the rock too). Resolves the blocks put, or throws CANNOT_PLACE (no pocket of POCKET_MAX_BLOCKS there) or
 * MISSING_ITEMS. A 1.21.11 bot waited out the night down an open mine by a spider spawner, and at dawn a zombie and the
 * spiders killed it at y 9 (ls3-1.21.11, t41183 to t48133).
 */
export async function sealPocket (bot: Bot, signal?: AbortSignal): Promise<number> {
  const cells = await pocketCells(bot)
  const { SkillError } = await import('./errors')
  if (cells == null) throw new SkillError('CANNOT_PLACE', `no pocket of ${POCKET_MAX_BLOCKS} blocks at most at ${bot.entity.position.floored().toString()}`)
  if (cells.length === 0) return 0
  const { sealIn } = await import('./sealIn')
  const res = await sealIn(bot, { signal, healTo: 0, maxTicks: 0 })
  return res.placed
}

/** ticks between the cave-entry lines (watchCaveEntries) */
export const CAVE_ENTRY_LOG_TICKS = 200
/** ticks out of the caves before a way back in counts as another entry (a body at a cave's edge steps in and out) */
export const CAVE_ENTRY_GAP = 40

const entries = new WeakMap<Bot, { count: number }>()

/** the times the bot's feet went into a cave's cell under the cave rule (watchCaveEntries) */
export function caveEntries (bot: Bot): number {
  return entries.get(bot)?.count ?? 0
}

/**
 * Counts and logs the bot's ways into the caves while the rule holds (its feet into a cave's cell from one that isn't),
 * and the gate as it opens and shuts (caveReady): what a game's log shows of the rule. Once per bot.
 */
export function watchCaveEntries (bot: Bot, log: (line: string) => void): void {
  if (entries.has(bot) || typeof bot.on !== 'function') return
  const e = { count: 0 }
  entries.set(bot, e)
  let lastFeet = ''
  let wasCave = false
  let ready: boolean | null = bot.entity != null && bot.inventory != null ? caveReadyNow(bot) : null
  let lastLog = -Infinity
  let lastInCave = -Infinity
  let ticks = 0
  bot.on('physicsTick', () => {
    ticks++
    if (bot.entity == null || typeof bot.blockAt !== 'function') return
    if (ticks % 20 === 0) {
      const now = caveReadyNow(bot)
      if (ready != null && now !== ready) log(now ? 'caves: cave-ready now (enchanted iron, a full bar, cooked food): the caves are walked as any ground' : `caves: not cave-ready (${caveUnreadiness(bot) ?? ''}): mining in its own tunnels only`)
      ready = now
    }
    const p = bot.entity.position
    const feet = `${Math.floor(p.x)},${Math.floor(p.y + 1e-6)},${Math.floor(p.z)}`
    if (wasCave) lastInCave = ticks
    if (feet === lastFeet) return
    lastFeet = feet
    if (!caveRuleOn(bot)) { wasCave = false; return }
    const cave = caveCells(bot).isCave(new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z)))
    if (cave && !wasCave && ticks - lastInCave >= CAVE_ENTRY_GAP) {
      e.count++
      if (ticks - lastLog >= CAVE_ENTRY_LOG_TICKS) {
        lastLog = ticks
        log(`caves: into a cave at ${feet.replace(/,/g, ' ')} (${e.count} so far, not cave-ready: ${caveUnreadiness(bot) ?? ''})`)
      }
    }
    wasCave = cave
  })
}

/** how far round (across, and up or down) the way out of a cave looks for the rock's cells (caveExit) */
export const CAVE_EXIT_RADIUS = 8

/**
 * The nearest cell out of the cave by the bot (within CAVE_EXIT_RADIUS) to stand in: its feet and head cells open,
 * dry and no cave's, a full block under them; one the bot dug first (its tunnel), then the rest by distance. Null
 * when there's none.
 */
export function caveExit (cells: CaveCells, feet: Vec3, dug: (p: Vec3) => boolean = () => false): Vec3 | null {
  const r = CAVE_EXIT_RADIUS
  let best: Vec3 | null = null
  let bestScore = Infinity
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = feet.offset(dx, dy, dz)
        const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
        const score = d + (dug(c) ? 0 : 2 * r)
        if (score >= bestScore) continue
        if (!openBlock(cells.view.block(c)) || !openBlock(cells.view.block(c.offset(0, 1, 0)))) continue
        if (cells.view.block(c.offset(0, -1, 0))?.boundingBox !== 'block') continue
        if (cells.isCave(c) || cells.isCave(c.offset(0, 1, 0))) continue
        best = c
        bestScore = score
      }
    }
  }
  return best
}

/**
 * Out of the cave the bot lingers in (a fight that took it there, a fall, a station put up by its edge) to the
 * nearest of the rock's cells (caveExit), the pathfinder's way (the cave rule's costs on); resolves whether it got
 * out. The caves reflex then seals the holes by it.
 */
export async function leaveCave (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const cells = caveCells(bot)
  const feet = bot.entity.position.floored()
  const exit = caveExit(cells, feet, p => dugByBot(bot, p))
  if (exit == null) return false
  const { navigate } = await import('./navigate')
  const { goals } = await import('@nxg-org/mineflayer-pathfinder')
  try {
    await navigate(bot, { goal: new goals.GoalBlock(exit.x, exit.y, exit.z) }, signal)
  } catch (err) {
    if (signal?.aborted === true) throw err
  }
  return !cells.isCave(bot.entity.position.floored())
}
