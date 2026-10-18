// buildPortal: a nether portal frame, cast from a lava pool (planLavaCast's steps through the bucket skills) or built
// from 10 obsidian, lit with flint and steel (crafted when the bot has none, the flint from gravel), and checked for
// its portal blocks.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Pos } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { SkillError, isAbort, isSkillError, throwIfAborted } from '../skills/errors'
import { emptyBucket, fillBucket, isSource } from '../skills/bucket'
import { collectBlock } from '../skills/collectBlock'
import { craft } from '../skills/craft'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { navigate, navigateToReach } from '../skills/navigate'
import { placeBlock } from '../skills/placeBlock'
import { findPlacement } from '../skills/placement'
import { countItems, findInventoryItem, settleInventory, trace, waitTicks, waitUntil, withinReach } from '../skills/util'
import {
  type Axis, type BlockGetter, type CastStep, type LavaCastOptions, type LavaCastPlan, type PortalFrame,
  checkPortalFrame, findLavaSources, frameCell, isAir, isSolid, planLavaCast, portalFrame
} from './portal'

const v3 = (p: Pos): Vec3 => new Vec3(p.x, p.y, p.z)

/** the world as the portal plans read it: mineflayer's blocks, with their state as properties */
/**
 * A findBlock matcher for a lava source outside the frame's cells (`x,y,z` keys). findBlocks first asks it about each
 * section's palette with blocks that have no position: those match on the block alone.
 */
export function otherLavaSource (frameCells: ReadonlySet<string>): (b: any) => boolean {
  return b => isSource(b, 'lava') && (b.position == null || !frameCells.has(`${String(b.position.x)},${String(b.position.y)},${String(b.position.z)}`))
}

export function blockGetter (bot: Bot): BlockGetter {
  return (pos: Pos) => {
    const block = bot.blockAt(v3(pos))
    if (block == null) return null
    return { name: block.name, properties: (block as any).getProperties?.() ?? {} }
  }
}

/** blocks a frame's corners can be made of when the bot builds one (any full block: PortalShape ignores the corners) */
export const FILLER_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'netherrack', 'dirt', 'stone', 'deepslate', 'blackstone', 'andesite', 'diorite', 'granite', 'tuff', 'oak_planks', 'spruce_planks', 'birch_planks']

export interface FramePlacement {
  pos: Pos
  /** 'obsidian', or 'filler' for a corner (anything solid) */
  item: 'obsidian' | 'filler'
}

/**
 * The order to place a frame's blocks in so each has a solid neighbour when it goes down: the bottom row (on the
 * ground), the bottom corners, each side upwards from its corner, a top corner, then the top row from that corner.
 * The three corners are filler: PortalShape doesn't look at them, they're only there to place the sides against.
 */
export function frameBuildOrder (frame: PortalFrame): FramePlacement[] {
  const { origin, axis, width, height } = frame
  const at = (u: number, v: number): Pos => frameCell(origin, axis, u, v)
  const out: FramePlacement[] = []
  for (let u = 1; u < width - 1; u++) out.push({ pos: at(u, 0), item: 'obsidian' })
  out.push({ pos: at(0, 0), item: 'filler' }, { pos: at(width - 1, 0), item: 'filler' })
  for (let v = 1; v < height - 1; v++) out.push({ pos: at(0, v), item: 'obsidian' }, { pos: at(width - 1, v), item: 'obsidian' })
  out.push({ pos: at(0, height - 1), item: 'filler' })
  for (let u = 1; u < width - 1; u++) out.push({ pos: at(u, height - 1), item: 'obsidian' })
  return out
}

const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'crimson_roots', 'warped_roots', 'nether_sprouts'])

export interface PortalSiteOptions {
  /** how far from `near` to look (default 8) */
  radius?: number
  axis?: Axis
}

/**
 * A place to build a 4 × 5 frame near `near`: solid ground under its four columns, the frame and a row on each side of
 * it clear (to walk up to it and out of it), the ground at most 3 above or below `near`. Nearest first.
 */
export function choosePortalSite (getBlock: BlockGetter, near: Pos, opts: PortalSiteOptions = {}): { origin: Pos, axis: Axis } | null {
  const radius = opts.radius ?? 8
  const c = { x: Math.floor(near.x), y: Math.floor(near.y), z: Math.floor(near.z) }
  const clear = (p: Pos): boolean => { const b = getBlock(p); return b != null && PASSABLE.has(b.name) }
  let best: { origin: Pos, axis: Axis, d: number } | null = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const origin = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
        for (const axis of opts.axis != null ? [opts.axis] : ['x', 'z'] as Axis[]) {
          let ok = true
          for (let u = 0; u < 4 && ok; u++) {
            for (const depth of [-1, 0, 1]) {
              if (!isSolid(getBlock(frameCell(origin, axis, u, -1, depth)))) { ok = false; break }
              for (let v = 0; v < 5; v++) if (!clear(frameCell(origin, axis, u, v, depth))) { ok = false; break }
              if (!ok) break
            }
          }
          if (!ok) continue
          const mid = frameCell(origin, axis, 1.5, 0)
          const d = Math.hypot(mid.x + 0.5 - near.x, mid.y - near.y, mid.z + 0.5 - near.z)
          // the bot's own cells are fine: it steps out of the way to place
          if (best == null || d < best.d) best = { origin, axis, d }
        }
      }
    }
  }
  return best == null ? null : { origin: best.origin, axis: best.axis }
}

export interface BuildPortalArgs {
  /** where to put the frame (its bottom corner) and along which axis; default: a site near the bot or the lava */
  origin?: Vec3
  axis?: Axis
  /** 'obsidian' to place 10 obsidian, 'cast' to cast it from lava; default: obsidian when the bot has 10, else cast */
  method?: 'obsidian' | 'cast'
  /** the lava sources to cast with (default: the ones within `lavaRadius` of the bot) */
  lava?: Vec3[]
  lavaRadius?: number
  /** the mould's block for the cast (default: the filler the bot has most of) */
  scaffoldItem?: string
  /** light it (default true) */
  light?: boolean
  /** remember the portal in bot.survival.memory (default true) */
  remember?: boolean
}

export interface BuildPortalResult {
  frame: PortalFrame
  method: 'obsidian' | 'cast'
  /** the nether_portal blocks inside the frame (empty when not lit) */
  portal: Vec3[]
  /** the bottom middle of the inside: where to walk to go through */
  entrance: Vec3
  ticks: number
}

function fillerItem (bot: Bot, need: number, exclude: string[] = []): string | null {
  let best: string | null = null
  let most = 0
  for (const name of FILLER_BLOCKS) {
    if (exclude.includes(name)) continue
    const n = countItems(bot, name)
    if (n > most) { most = n; best = name }
  }
  return most >= need ? best : null
}

/** the bottom middle of the inside, where a player walking in stands in the portal */
export function portalEntrance (frame: PortalFrame): Vec3 {
  const cell = frameCell(frame.origin, frame.axis, 1, 1)
  return frame.axis === 'x' ? new Vec3(cell.x + 1, cell.y, cell.z + 0.5) : new Vec3(cell.x + 0.5, cell.y, cell.z + 1)
}

export async function buildPortal (bot: Bot, args: BuildPortalArgs = {}, signal?: AbortSignal): Promise<BuildPortalResult> {
  throwIfAborted(signal)
  const startTick = tickCounter(bot)
  const getBlock = blockGetter(bot)
  const method = args.method ?? (countItems(bot, 'obsidian') >= 10 ? 'obsidian' : 'cast')
  let frame: PortalFrame
  if (method === 'obsidian') {
    if (countItems(bot, 'obsidian') < 10) throw new SkillError('MISSING_ITEMS', `${countItems(bot, 'obsidian')} obsidian of the 10 a frame takes`)
    const site = args.origin != null ? { origin: args.origin.floored(), axis: args.axis ?? 'x' } : choosePortalSite(getBlock, bot.entity.position, { axis: args.axis })
    if (site == null) throw new SkillError('CANNOT_PLACE', 'no flat clear ground for a portal frame near the bot')
    frame = portalFrame(site.origin, site.axis)
    await placeFrame(bot, frame, signal)
  } else {
    const lava = args.lava?.map(p => p.floored()) ?? findLavaSources(getBlock, bot.entity.position, args.lavaRadius ?? 16).map(v3)
    if (lava.length < 10) throw new SkillError('NOT_FOUND', `${lava.length} lava sources found; a cast frame takes 10`)
    const scaffoldItem = args.scaffoldItem ?? fillerItem(bot, 1) ?? 'cobblestone'
    const opts: LavaCastOptions = { scaffoldItem, ...(args.origin != null ? { origin: args.origin.floored() } : {}), ...(args.axis != null ? { axis: args.axis } : {}) }
    const plan = planLavaCast(getBlock, lava, opts)
    if (plan == null) throw new SkillError('CANNOT_PLACE', 'no site to cast a portal frame by the lava')
    frame = plan.frame
    await castFrame(bot, plan, signal)
  }
  let portal: Vec3[] = []
  if (args.light !== false) portal = await lightPortal(bot, frame, signal)
  const entrance = portalEntrance(frame)
  if (args.remember !== false && portal.length > 0) {
    bot.survival?.memory.addPoi('nether_portal', entrance, normalizeDimension(bot.game.dimension), 'built')
  }
  return { frame, method, portal, entrance, ticks: tickCounter(bot) - startTick }
}

/** a tick count to time skills by: the lockstep client's, else the world's age */
function tickCounter (bot: Bot): number {
  return (bot as any).lockstep?.ticks ?? Number(bot.time?.age ?? 0)
}

/** places the frame's 10 obsidian (and three filler corners) in frameBuildOrder */
export async function placeFrame (bot: Bot, frame: PortalFrame, signal?: AbortSignal): Promise<void> {
  const getBlock = blockGetter(bot)
  const order = frameBuildOrder(frame)
  const fillers = order.filter(p => p.item === 'filler' && !isSolid(getBlock(p.pos))).length
  const filler = fillerItem(bot, fillers) ?? (countItems(bot, 'obsidian') >= 10 + fillers ? 'obsidian' : null)
  if (filler == null && fillers > 0) throw new SkillError('MISSING_ITEMS', `no ${fillers} blocks for the frame's corners`)
  for (const step of order) {
    throwIfAborted(signal)
    const pos = v3(step.pos)
    const b = getBlock(step.pos)
    if (step.item === 'filler' && isSolid(b)) continue
    if (step.item === 'obsidian' && b?.name === 'obsidian') continue
    await placeBlock(bot, { pos, item: step.item === 'filler' ? filler as string : 'obsidian' }, signal)
  }
  const check = checkPortalFrame(getBlock, frame)
  if (check.missing.length > 0) throw new SkillError('VERIFY_FAILED', `the frame lacks obsidian at ${check.missing.map(p => `${p.x},${p.y},${p.z}`).join(' ')}`)
}

/** pours a bucket into a cell; true once the cell holds the fluid's source, or what water makes of it (obsidian) */
async function pour (bot: Bot, pos: Vec3, fluid: 'water' | 'lava', signal?: AbortSignal): Promise<void> {
  try {
    await emptyBucket(bot, { pos, fluid }, signal)
  } catch (err) {
    // lava next to water turns to obsidian the tick it's placed (LiquidBlock.onPlace: shouldSpreadLiquid), so the
    // client may never see the source
    if (fluid === 'lava' && isSkillError(err, 'VERIFY_FAILED') && bot.blockAt(pos)?.name === 'obsidian') return
    throw err
  }
}

/**
 * Runs a lava cast plan step by step: the mould, then per frame cell a bucket of lava from the pool, poured into the
 * cell, water poured over it within the lava's 30 tick delay so it sets as obsidian, the water scooped back up.
 */
export async function castFrame (bot: Bot, plan: LavaCastPlan, signal?: AbortSignal): Promise<void> {
  if (findInventoryItem(bot, 'water_bucket') == null) throw new SkillError('MISSING_ITEMS', 'no water bucket to cast the frame with')
  if (findInventoryItem(bot, ['bucket', 'lava_bucket']) == null) throw new SkillError('MISSING_ITEMS', 'no empty bucket to carry the lava in')
  const scaffold = plan.steps.filter(s => s.kind === 'place_block').length
  if (countItems(bot, plan.scaffoldItem) < scaffold) throw new SkillError('MISSING_ITEMS', `${countItems(bot, plan.scaffoldItem)} ${plan.scaffoldItem} of the ${scaffold} the mould takes`)
  const frameCells = new Set(plan.frame.obsidian.map(p => `${p.x},${p.y},${p.z}`))
  const getBlock = blockGetter(bot)
  // in front of the frame first: the mould goes up behind it, and the bot shouldn't be walled in on that side
  const stand = v3(plan.stand[0])
  if (bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) > 1.5) await navigate(bot, { goal: new goals.GoalNear(stand.x, stand.y, stand.z, 1) }, signal)
  for (const step of plan.steps) {
    throwIfAborted(signal)
    trace('castFrame:', step.kind, 'pos' in step ? `${step.pos.x},${step.pos.y},${step.pos.z}` : '')
    await retryMoves(bot, async () => await castStep(bot, step, frameCells, getBlock, signal), signal)
  }
  const check = checkPortalFrame(getBlock, plan.frame)
  if (check.missing.length > 0) throw new SkillError('VERIFY_FAILED', `the cast frame lacks obsidian at ${check.missing.map(p => `${p.x},${p.y},${p.z}`).join(' ')}`)
}

async function castStep (bot: Bot, step: CastStep, frameCells: Set<string>, getBlock: BlockGetter, signal?: AbortSignal): Promise<void> {
  switch (step.kind) {
    case 'place_block':
      if (isSolid(getBlock(step.pos))) return
      await placeBlock(bot, { pos: v3(step.pos), item: step.item }, signal)
      return
    case 'fill_lava': {
      if (countItems(bot, 'lava_bucket') > 0) return
      let pos = v3(step.pos)
      // the planned source can be gone (taken, or turned by water); any other source of the pool does
      if (!isSource(bot.blockAt(pos), 'lava')) {
        const other = bot.findBlock({ matching: otherLavaSource(frameCells), maxDistance: 24 })
        if (other == null) throw new SkillError('NOT_FOUND', 'no lava source left to fill the bucket from')
        pos = other.position
      }
      await fillBucket(bot, { fluid: 'lava', pos }, signal)
      return
    }
    case 'place_lava':
      if (getBlock(step.pos)?.name === 'obsidian') return
      await pour(bot, v3(step.pos), 'lava', signal)
      return
    case 'place_water': {
      const makes = v3(step.makes)
      if (bot.blockAt(makes)?.name !== 'obsidian') await pour(bot, v3(step.pos), 'water', signal)
      if (!await waitUntil(bot, () => bot.blockAt(makes)?.name === 'obsidian', 20, signal)) {
        throw new SkillError('VERIFY_FAILED', `${bot.blockAt(makes)?.name ?? 'nothing'} at ${makes.toString()} after pouring water over it`)
      }
      return
    }
    case 'pickup_water': {
      const pos = v3(step.pos)
      if (!isSource(bot.blockAt(pos), 'water')) return
      if (findInventoryItem(bot, 'bucket') == null) return
      await fillBucket(bot, { fluid: 'water', pos }, signal)
      return
    }
    case 'wait':
      await waitTicks(bot, step.ticks, signal)
      break
    case 'light':
      // lightPortal does it, after the cast is checked
      break
  }
}

/**
 * Flint and steel: in the inventory, or crafted from an iron ingot and flint. Flint comes from gravel (10% of breaks,
 * GravelBlock's loot table without fortune): gravel the bot carries is put down and broken until one drops.
 */
export async function ensureFlintAndSteel (bot: Bot, signal?: AbortSignal, opts: { maxBreaks?: number } = {}): Promise<void> {
  if (countItems(bot, 'flint_and_steel') > 0) return
  if (countItems(bot, 'iron_ingot') === 0) throw new SkillError('MISSING_ITEMS', 'no iron ingot for flint and steel')
  if (countItems(bot, 'flint') === 0) await flintFromGravel(bot, signal, opts.maxBreaks ?? 60)
  await craft(bot, { item: 'flint_and_steel' }, signal)
}

export async function flintFromGravel (bot: Bot, signal?: AbortSignal, maxBreaks = 60): Promise<number> {
  for (let i = 0; i < maxBreaks && countItems(bot, 'flint') === 0; i++) {
    throwIfAborted(signal)
    if (countItems(bot, 'gravel') === 0) {
      // gravel in the world nearby
      const found = bot.findBlock({ matching: bot.registry.blocksByName.gravel.id, maxDistance: 32 })
      if (found == null) throw new SkillError('MISSING_ITEMS', 'no gravel for flint')
      await collectBlock(bot, { positions: [found.position] }, signal)
      continue
    }
    const pos = findPlacement(p => bot.blockAt(p), bot.entity.position)
    if (pos == null) throw new SkillError('CANNOT_PLACE', 'no room to put gravel down')
    await placeBlock(bot, { pos, item: 'gravel' }, signal)
    await collectBlock(bot, { positions: [pos] }, signal)
  }
  if (countItems(bot, 'flint') === 0) throw new SkillError('MISSING_ITEMS', `no flint after ${maxBreaks} gravel breaks`)
  return countItems(bot, 'flint')
}

/** the nether_portal blocks in a frame's inside */
export function portalBlocks (bot: Bot, frame: PortalFrame): Vec3[] {
  return frame.interior.map(v3).filter(p => bot.blockAt(p)?.name === 'nether_portal')
}

/**
 * Lights the frame: flint and steel on the top face of a bottom obsidian (FlintAndSteelItem.useOn puts fire in the
 * cell above, and BaseFireBlock.onPlace opens the portal there when PortalShape finds the frame). Returns the portal
 * blocks once the whole inside holds them.
 */
export async function lightPortal (bot: Bot, frame: PortalFrame, signal?: AbortSignal): Promise<Vec3[]> {
  const getBlock = blockGetter(bot)
  if (portalBlocks(bot, frame).length === frame.interior.length) return portalBlocks(bot, frame)
  // water from the cast drains a level every 5 ticks
  await waitUntil(bot, () => frame.interior.every(p => isAir(getBlock(p)) || getBlock(p)?.name === 'fire'), 80, signal)
  const check = checkPortalFrame(getBlock, frame)
  if (!check.valid) {
    throw new SkillError('VERIFY_FAILED', `the frame isn't ready: missing ${check.missing.length} obsidian, ${check.blocked.map(p => getBlock(p)?.name ?? '?').join(', ')} inside`)
  }
  await ensureFlintAndSteel(bot, signal)
  for (let attempt = 0; attempt < 3; attempt++) {
    // either bottom obsidian; the second when the first's top isn't in view
    const against = v3(frame.obsidian[attempt % 2])
    if (!withinReach(bot, against)) await navigateToReach(bot, against, signal, { reach: 3.5 })
    await settleInventory(bot, signal)
    const tool = findInventoryItem(bot, 'flint_and_steel')
    if (tool == null) throw new SkillError('MISSING_ITEMS', 'the flint and steel is gone')
    await bot.equip(tool, 'hand')
    const block = bot.blockAt(against)
    if (block == null) throw new SkillError('NOT_FOUND', `the frame at ${against.toString()} isn't loaded`)
    await bot.activateBlock(block, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5))
    if (await waitUntil(bot, () => portalBlocks(bot, frame).length === frame.interior.length, 20, signal)) return portalBlocks(bot, frame)
    trace('lightPortal: no portal after lighting, attempt', attempt + 1, frame.interior.map(p => getBlock(p)?.name))
  }
  throw new SkillError('VERIFY_FAILED', `${portalBlocks(bot, frame).length} of ${frame.interior.length} portal blocks after lighting the frame`)
}

/**
 * Runs a step again when the walk to it failed (no path, stuck): the pathfinder plans afresh from where the bot ended
 * up, after the water about it has settled a little.
 */
export async function retryMoves<T> (bot: Bot, fn: () => Promise<T>, signal?: AbortSignal, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (isAbort(err) || i >= attempts || !(isSkillError(err, 'NO_PATH') || isSkillError(err, 'STUCK'))) throw err
      trace('retryMoves: attempt', i, 'failed:', (err as Error).message)
      await waitTicks(bot, 10, signal)
    }
  }
}
