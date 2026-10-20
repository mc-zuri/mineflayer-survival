// One runner per kind of plan step, each over the skills: mine → collectBlock (finding or exploring for the block
// first), craft, smelt, kill → hunt, loot → retrieveItems, fill → fillBucket; barter waits for the nether skills.
// A runner keeps its starting count in the task's state, so a step a reflex preempted picks up where it was.
import { baseWayIn } from '../base/pois'
import { travel } from '../skills/travel'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from '../core/errors'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import type { CraftStep, FarmStep, FillStep, FishStep, KillStep, LootStep, MineStep, PlanStep, SmeltStep } from '../planner/steps'
import { fish, fishingSpotFor, iceHoleFor } from '../skills/fish'
import { FISHING } from '../planner/sources'
import { farmCells, grownPlots, harvestFarm, knownFarms, nearlyGrownPlots, plantFarm, rememberFarm, SEED_OF, sow } from '../skills/farm'
import { SkillError, isAbort, isSkillError, throwIfAborted } from '../skills/errors'
import { collectBlock, waterBeside } from '../skills/collectBlock'
import { craft } from '../skills/craft'
import { PARALLEL_MIN_ITEMS, smelt, smeltParallel } from '../skills/smelt'
import { retrieveItems } from '../skills/chest'
import { fillBucket, isSource } from '../skills/bucket'
import { hunt, nearestOfType } from '../skills/hunt'
import type { Entity } from '../skills/combatUtil'
import { navigate, navigateNear, pickaxeForTheWay } from '../skills/navigate'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { countItems, trace, waitUntil } from '../skills/util'
import { findPlacementNear } from '../skills/placement'
import { digNook, ensureSurface, exploreForBlocks, exploreSurface, findNear, onTheSurface, openSky, oreLevel, unstick } from './explore'
import { toolKindFor, watchToolWear, wornOutTools, type WornTool } from './durability'
import { growsAny, isGrown } from '../core/crops'
import { SIGHTED_BLOCKS } from './sight'
import { herdCensus, herdFromMemory, herdPenOf, herdSpares, herdSupply, herdSurplus, noteHerd } from '../skills/herd'
import { protectPen } from '../skills/pen'

/** a mine step hands back to the executor when its tool has this many uses left (the executor's default too) */
export const MIN_TOOL_USES = 24

export interface StepContext {
  bot: Bot
  memory: WorldMemory
  signal: AbortSignal
  /** the task's state: kept when a reflex preempts the step and it runs again */
  state: Record<string, any>
  log: (line: string) => void
  /** a crafting table and a furnace to use when they are near (the base's) */
  table?: Vec3 | null
  furnace?: Vec3 | null
  /** where exploring turns around (the spawn, the base) */
  home?: Vec3 | null
  /** blocks never mined (the base's shell): their positions */
  protect?: (pos: Vec3) => boolean
  /**
   * the step is part of making a new tool for one about to break (Executor.replaceWornTools): it works on with the
   * worn one instead of handing back for a new one, which is what it is getting
   */
  replacingTools?: boolean
  /** drops not gone for (the route's stone the stock has enough of, once the bag carries what's kept of it) */
  unwanted?: (name: string) => boolean
  /**
   * Makes room in the bag when it's short, on the way (Executor.makeRoomDuringStep): before each block a mine step
   * breaks and each step of a staircase or tunnel it digs, `toward` where the bot goes next
   */
  room?: (toward?: Vec3) => Promise<void>
  /** the explorations for a name lately that found none, in a row (Executor.sightings) */
  misses?: (name: string) => number
  /** notes names a step found none of near it, without exploring (Sightings.notNear): dear to the next plans a while */
  notNear?: (names: readonly string[]) => void
  /** whether a name was noted not near lately (Sightings.isNotNear) */
  isNotNear?: (name: string) => boolean
  /**
   * an exploration's progress kept across steps (the executor's, by `key`): a hunt's plan made again (a stock top-up
   * between, a death) started its spiral over, and it never came to its end to go further out
   */
  progress?: (key: string) => { leg: number }
  /** forgets an exploration's progress (its spiral ran out) */
  forgetProgress?: (key: string) => void
  /** a worn tool let be (the executor's: no new one could be made lately), used till it breaks */
  toolMuted?: (tool: WornTool) => boolean
  /**
   * notes blocks a mine step couldn't get to (collectBlock's unreachable), and whether a block is one of them: left
   * by the next steps a while (Executor.unreachable)
   */
  unreachable?: { note: (positions: readonly Vec3[]) => void, has: (pos: Vec3) => boolean }
}

export interface StepOutcome {
  /** what the step added of its item */
  gained: number
  /** the step came out other than planned (another wood, another animal): plan again before going on */
  replan?: boolean
}

export type StepRunner<S extends PlanStep = PlanStep> = (step: S, ctx: StepContext) => Promise<StepOutcome>

/**
 * The blocks the bot builds with, cheapest first: the pathfinder's bridges, towers and floors (its scaffoldingBlocks
 * setting is this list, createPlugin), the End's pillars and the shelter's towers. Full solid blocks that don't fall,
 * have no block entity, and that a mine or a walk through the nether leaves the bot with (no planks: the crafts want
 * them). A mine step for one brings SCAFFOLD_BUFFER more than its plan uses.
 */
export const SCAFFOLD_ITEMS = ['dirt', 'coarse_dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'basalt', 'end_stone', 'cobbled_deepslate', 'cobblestone', 'blackstone', 'deepslate', 'stone', 'stone_bricks', 'sandstone']
export const SCAFFOLD_BUFFER = 24

/** the blocks a mine step climbs out of a mine for first */
export const SURFACE_BLOCKS = /(_log|_leaves|^sand|^red_sand|^sugar_cane|^pumpkin|^melon|^cactus|^bamboo|^short_grass|^sweet_berry_bush|^wheat|^carrots|^potatoes|^beetroots|^hay_block)$/

/** the stone a mine step leaves when water is against it, like an ore (there is always more without) */
export const STONES = ['stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'cobblestone']

/** how far under its starting level a mine step for a block that isn't an ore goes (stone, dirt, sand...) */
export const SHALLOW_DEPTH = 8

/** how far below an ore's level (ORE_LEVELS) a block of it is still mined */
export const ORE_DEPTH = 24

/** how far a crafting table or furnace may be to be used when the bot carries its own */
export const NEAR_STATION = 6

/** how far to look for a block or an animal before exploring */
export const SEARCH_RADIUS = 64

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log']
const MEAT_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit']

/**
 * Blocks that will do instead of the step's when none of those is near: another wood (the plan crafts what the logs
 * held make once it plans again), deepslate for stone (cobbled deepslate is a stone crafting material too)
 */
export function blockSubstitutes (step: Pick<MineStep, 'block' | 'blocks'>): string[] {
  if (LOGS.includes(step.block)) return LOGS.filter(l => !step.blocks.includes(l))
  if (step.block === 'stone') return ['deepslate'].filter(b => !step.blocks.includes(b))
  return []
}

/** the meats the meat animals drop: a hunt for one may take another animal's (the plan goes on with that meat) */
const MEATS = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit']

/** the meat a meat animal drops (its loot table's), else null */
export function meatOf (mob: string): string | null {
  const i = MEAT_ANIMALS.indexOf(mob)
  return i < 0 ? null : MEATS[i]
}

/** animals that will do instead of the step's: any other meat animal for meat */
export function mobSubstitutes (step: Pick<KillStep, 'mob' | 'item'>): string[] {
  // (for its meat only: a sheep's wool, a cow's leather, a chicken's feather is that animal's; a 26.3 bot hunted pigs
  // 15 plans in a row 'for white_wool', the base's bed never made)
  if (!MEAT_ANIMALS.includes(step.mob) || !MEATS.includes(step.item)) return []
  return MEAT_ANIMALS.filter(m => m !== step.mob)
}

function startCount (ctx: StepContext, key: string, now: () => number): number {
  if (typeof ctx.state[key] !== 'number') ctx.state[key] = now()
  return ctx.state[key]
}

function dimensionOf (bot: Bot): string {
  return normalizeDimension(bot.game?.dimension)
}

/**
 * Brings one of `names` within the search radius: a block seen there now, else the nearest the memory has (walked
 * to, forgotten when it's gone), else exploring. Resolves the names found near, or throws NOT_FOUND.
 */
async function findBlocks (bot: Bot, names: string[], ctx: StepContext, alternatives: string[] = [], exclude: ((pos: Vec3) => boolean) | undefined = ctx.protect): Promise<string[]> {
  const near = (list: string[]): boolean => list.length > 0 && findNear(bot, list, SEARCH_RADIUS, exclude) != null
  if (near(names)) return names
  const dimension = dimensionOf(bot)
  for (let i = 0; i < 3; i++) {
    const known = ctx.memory.findBlocks(names, { dimension, near: bot.entity.position, count: 1, maxDistance: 512 })[0]
    if (known == null) break
    try {
      await navigateNear(bot, new Vec3(known.x, known.y, known.z), 8, ctx.signal)
    } catch (err) {
      if (isAbort(err)) throw err
    }
    if (near(names)) return names
    // not there any more (or not reachable): drop it
    ctx.memory.forgetBlock(known, dimension)
  }
  if (near(alternatives)) return alternatives
  ctx.log(`exploring for ${names.join(', ')}`)
  const all = [...names, ...alternatives]
  // the food that grows is looked for no further out than the animals: none there, the plan goes for another food
  const food = all.some(n => SIGHTED_BLOCKS.includes(n))
  const maxRadius = food ? HUNT_EXPLORE_RADIUS : undefined
  // (the other food that grows noted on the way: none of it seen is the land's, Executor.noteMissing)
  const remember = maxRadius != null ? SIGHTED_BLOCKS : undefined
  if (!food) {
    ctx.state.explore ??= { leg: 0 }
    if (await exploreForBlocks(bot, { names: all, memory: ctx.memory, center: ctx.home ?? undefined, exclude, maxRadius, progress: ctx.state.explore, room: ctx.room, remember }, ctx.signal)) {
      if (near(names)) return names
      if (near(alternatives)) return alternatives
    }
    throw new SkillError('NOT_FOUND', `no ${names.join(', ')} found exploring`)
  }
  // the food's exploring: FOOD_EXPLORE_TICKS of its own at most (a reflex's ticks not counted), its spiral kept across
  // the plans (foodExploreProgress) so the next one for it goes on further out
  const { key, progress } = foodExploreProgress(ctx, all)
  const result = await withinOwnTicks(bot, ctx.state, 'exploreTicks', FOOD_EXPLORE_TICKS, ctx.signal, async (s) =>
    await exploreForBlocks(bot, { names: all, memory: ctx.memory, center: ctx.home ?? undefined, exclude, maxRadius, progress, room: ctx.room, remember }, s))
  // (found, or its spiral ran out: the next exploring for it starts over, as a step's own did)
  if (result !== 'timeout') ctx.forgetProgress?.(key)
  if (result === true) {
    if (near(names)) return names
    if (near(alternatives)) return alternatives
  }
  throw new SkillError('NOT_FOUND', `no ${names.join(', ')} found exploring${result === 'timeout' ? ` in its ${FOOD_EXPLORE_TICKS} ticks` : ''}`)
}

/**
 * the ticks a mine step's exploring for the food that grows (SIGHTED_BLOCKS) takes at most, across its preemptions:
 * NOT_FOUND then, and the plans go for another food a while (Executor.noteMissing). The exploring for kelp of a 1.21.11
 * bot's food restock on a snowy spruce land, cut off by 7 reflexes (falls, the night, fights, meals) and resumed each
 * time where it was, walked 166 blocks over 29000 ticks before its spiral ran out, the enchanting held up (rt-1)
 */
export const FOOD_EXPLORE_TICKS = 6000

/**
 * A mine step's exploring progress for the food that grows: the executor's, kept across the plans (one cut off by its
 * ticks goes on further out next time), else the step's own, kept across its preemptions
 */
export function foodExploreProgress (ctx: Pick<StepContext, 'progress' | 'state'>, names: readonly string[]): { key: string, progress: { leg: number } } {
  const key = `explore:${[...names].sort().join(',')}`
  return { key, progress: ctx.progress?.(key) ?? (ctx.state.explore ??= { leg: 0 }) }
}

/**
 * Runs `fn` for `ticks` physics ticks at most, counted in `state[counter]` (the task's state: the ticks of each run of a
 * step a reflex preempted add up). Resolves what `fn` resolved, or 'timeout' once the ticks are spent (`fn` aborted).
 */
export async function withinOwnTicks<T> (bot: Bot, state: Record<string, any>, counter: string, ticks: number, signal: AbortSignal, fn: (s: AbortSignal) => Promise<T>): Promise<T | 'timeout'> {
  const spent = (): number => Number(state[counter] ?? 0)
  if (spent() >= ticks) return 'timeout'
  const ctrl = new AbortController()
  const onOuter = (): void => ctrl.abort(signal.reason)
  if (signal.aborted) onOuter()
  signal.addEventListener('abort', onOuter, { once: true })
  let out = false
  const count = (): void => {
    state[counter] = spent() + 1
    if (spent() >= ticks && !ctrl.signal.aborted) {
      out = true
      ctrl.abort(new TaskError('TIMEOUT', `out of its ${ticks} ticks`))
    }
  }
  bot.on('physicsTick', count)
  try {
    return await fn(ctrl.signal)
  } catch (err) {
    if (out && !signal.aborted) return 'timeout'
    throw err
  } finally {
    bot.off('physicsTick', count)
    signal.removeEventListener('abort', onOuter)
  }
}

/**
 * A mine step: the blocks found (near, remembered, else explored for: a staircase down to an ore's level and tunnels
 * there) and broken. Its tool is watched as the step wears it (watchToolWear): about to break (MIN_TOOL_USES left) with
 * no spare of its tier, the step hands back for a new one (replan; the executor's replaceWornTools makes it), at once,
 * not only between batches. The pickaxe's wear is mostly the exploring's and the pathfinder's digging on the way, which
 * a check between batches never saw: in rt-1 and grim-2 (1.21.11) the stone pickaxe broke down the staircase of 'mine
 * 33 raw_iron' and the iron one down that of 'mine 5 diamond', NO_TOOL at y 46 and y 3, with no warning (the axe's
 * between its batches of logs did warn).
 */
export const runMine: StepRunner<MineStep> = async (step, ctx) => {
  const kind = toolKindFor(ctx.bot.registry as any, step.block)
  const muted = (tool: WornTool): boolean => ctx.toolMuted?.(tool) === true
  if (ctx.replacingTools === true || kind == null || typeof (ctx.bot as any).on !== 'function') return await mineBlocks(step, ctx, muted)
  const outer = ctx.signal
  const ctrl = new AbortController()
  const onOuter = (): void => ctrl.abort(outer.reason)
  if (outer.aborted) onOuter()
  outer.addEventListener('abort', onOuter, { once: true })
  let worn: WornTool | null = null
  const unwatch = watchToolWear(ctx.bot as any, {
    minUses: MIN_TOOL_USES,
    kinds: [kind],
    active: () => true,
    muted,
    stop: tool => {
      worn = tool
      ctrl.abort(new TaskError('TOOL_WORN', `the ${tool.name} has ${tool.uses} uses left, no spare of its tier`))
    }
  })
  const start = (): number => ctx.state.start ?? countItems(ctx.bot, step.item)
  try {
    return await mineBlocks(step, { ...ctx, signal: ctrl.signal }, muted)
  } catch (err) {
    if (worn == null || outer.aborted) throw err
    const tool: WornTool = worn
    ctx.log(`mine ${step.item}: the ${tool.name} has ${tool.uses} uses left and no spare: back for another`)
    return { gained: countItems(ctx.bot, step.item) - start(), replan: true }
  } finally {
    unwatch()
    outer.removeEventListener('abort', onOuter)
  }
}

async function mineBlocks (step: MineStep, ctx: StepContext, muted: (tool: WornTool) => boolean): Promise<StepOutcome> {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  // stone mined for a plan brings a few more along: the pathfinder towers and bridges with them, and lava is plugged
  const buffer = SCAFFOLD_ITEMS.includes(step.item) ? Math.max(0, SCAFFOLD_BUFFER - start) : 0
  const target = start + step.count + buffer
  const perBlock = step.blockCount > 0 ? step.count / step.blockCount : 1
  let failures = 0
  let substituted = 0
  // what isn't an ore is mined near the level the step starts at: a block at a time down the nearest one, the bot
  // ends at the bottom of a shaft it can't plan out of
  const startY = startCount(ctx, 'startY', () => Math.floor(bot.entity.position.y))
  const level = oreLevel(step.blocks)
  const shallow = level == null
  let deep = !shallow
  // an ore is mined down to ORE_DEPTH below its level and no deeper: iron at y -29, the nearest by a straight line,
  // was a trip down through the deep caves (seed 2), where the bot died
  const tooDeep = (pos: Vec3): boolean => level != null && pos.y < level - ORE_DEPTH
  // a berry bush or a crop not grown yet drops no food: passed over (GROWN_AGE)
  const unripe = growsAny(step.blocks) ? (pos: Vec3): boolean => !isGrown(bot.blockAt(pos) as any) : () => false
  // an ore with water against it is left: mined, it lets the water in, and on seed 3 the bot drowned mining iron under
  // a lake (the raw iron floating up out of reach, the drowning reflex too late)
  // (and stone: on seed 4 the cobblestone for a furnace was dug at y 4 by a flooded cave's water, and the bot drowned)
  // (and a lake's or beach's floor: a 1.21.11 bot dug the sand for its brew's bottles from under a lake, went down
  // after its drops and drowned, full-1.21.11-fresh-j)
  const submerged = leftWhenSubmerged(step.blocks, step.block) ? (pos: Vec3): boolean => waterBeside(p => bot.blockAt(p) as any, pos) : () => false
  // what grows on the surface is taken from under the open sky (a tree's leaves and logs over it count as open):
  // the azaleas of a lush cave have oak logs, and on seed 4 the wood for a new pickaxe was cut 55 blocks down one,
  // in the dark among its pools, where a skeleton, a drowned and the water killed the bot four times
  const lookup = (p: Vec3): any => bot.blockAt(p)
  const underRoof = shallow && SURFACE_BLOCKS.test(step.block) ? (pos: Vec3): boolean => !openSky(lookup, pos) : () => false
  // (and the blocks the steps lately couldn't get to: a 1.21.11 bot shut in its house planned the same log 7 blocks
  // off 48 times, every try 'no path', and the game stopped, ls-1.21.11 t103051)
  const exclude = (pos: Vec3): boolean => ctx.protect?.(pos) === true || ctx.unreachable?.has(pos) === true || unripe(pos) || submerged(pos) || underRoof(pos) || (!deep && pos.y < startY - SHALLOW_DEPTH) || tooDeep(pos)
  while (countItems(bot, step.item) < target) {
    throwIfAborted(signal)
    const subs = blockSubstitutes(step)
    // the tool about to break: back to the executor, which makes another before the step goes on
    const kind = toolKindFor(bot.registry as any, step.block)
    // (one muted is used till it breaks: no new one could be made)
    if (ctx.replacingTools !== true && kind != null && wornOutTools(bot.inventory.items(), { minUses: MIN_TOOL_USES }).some(w => w.kind === kind && !muted({ kind: w.kind, material: w.material, name: w.item.name, uses: w.uses }))) {
      return { gained: countItems(bot, step.item) - start, replan: true }
    }
    // none near the level: deeper after all
    if (!deep && findNear(bot, [...step.blocks, ...subs], SEARCH_RADIUS, exclude) == null && findNear(bot, step.blocks, SEARCH_RADIUS, ctx.protect) != null) deep = true
    // what grows or lies on the surface (logs, sand) is got from up there: a log 24 blocks over a mine is a dig up
    // through the rock, into whatever cave is in the way
    if (shallow && SURFACE_BLOCKS.test(step.block)) await ensureSurface(bot, signal)
    const names = await findBlocks(bot, step.blocks, ctx, subs, exclude)
    const isSub = names !== step.blocks
    const left = isSub ? step.blockCount - substituted : Math.ceil((target - countItems(bot, step.item)) / perBlock - 1e-9)
    if (left <= 0) break
    try {
      // a tool getting low comes back between fewer blocks (the pathfinder's digging on the way wears it too)
      const batch = kind != null && wornOutTools(bot.inventory.items(), { minUses: 64 }).some(w => w.kind === kind) ? 2 : 8
      const res = await collectBlock(bot, { names, count: Math.min(left, batch), maxDistance: SEARCH_RADIUS, exclude, unwanted: ctx.unwanted, room: ctx.room }, signal)
      for (const pos of res.positions) ctx.memory.forgetBlock(pos, dimensionOf(bot))
      if (res.unreachable != null) ctx.unreachable?.note(res.unreachable)
      // a crop taken from a farm (a village's) is sown again from what it dropped: the farm grows back
      if (growsAny(step.blocks)) await resow(bot, res.positions, names, signal)
      if (isSub) substituted += res.mined
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'NO_TOOL', 'INVENTORY_FULL', 'DIED')) throw err
      const partial = (err as TaskError).partial as { mined?: number, positions?: Vec3[], unreachable?: Vec3[] } | undefined
      for (const pos of partial?.positions ?? []) ctx.memory.forgetBlock(pos, dimensionOf(bot))
      if (partial?.unreachable != null) ctx.unreachable?.note(partial.unreachable)
      if (isSub) substituted += partial?.mined ?? 0
      if (++failures > 4) throw err
      trace('executor: mine failed', (err as Error).message)
      if (TaskError.is(err, 'NO_PATH')) await unstick(bot, signal)
    }
    if (isSub && substituted >= step.blockCount) return { gained: countItems(bot, step.item) - start, replan: true }
  }
  return { gained: countItems(bot, step.item) - start }
}

/** sows the farmland under crops just harvested (of the blocks `names`) again with their seed, when it's held */
export async function resow (bot: Bot, crops: readonly Vec3[], names: readonly string[], signal: AbortSignal): Promise<number> {
  let n = 0
  const seeds = names.map(c => SEED_OF[c]).filter((s): s is string => s != null)
  for (const pos of crops) {
    const below = pos.offset(0, -1, 0)
    if (bot.blockAt(below)?.name !== 'farmland') continue
    const seed = seeds.find(s => countItems(bot, s) > 0)
    if (seed == null) continue
    try {
      await sow(bot, below, seed, signal)
      n++
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return n
}

/**
 * Runs a craft or smelt that puts its table or furnace down, and when there's no room for it where the bot is (a
 * one-wide tunnel or a shaft down a mine) digs a nook into the wall beside it and tries again; only with no wall to
 * dig into (lava or water behind it) it climbs out to the surface, a long way up past the caves, and tries there.
 */
export async function withRoom<T> (bot: Bot, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isSkillError(err, 'CANNOT_PLACE')) throw err
    trace('executor: no room for the station here:', (err as Error).message)
    if (await digNook(bot, signal)) {
      try {
        return await fn()
      } catch (again) {
        if (!isSkillError(again, 'CANNOT_PLACE')) throw again
      }
    }
    if (!(await ensureSurface(bot, signal))) await unstick(bot, signal)
    try {
      return await fn()
    } catch (again) {
      if (!isSkillError(again, 'CANNOT_PLACE')) throw again
    }
    // still none up here (on a tree's leaves, on a pillar, on a one-wide ridge): somewhere a few blocks off with room
    await toRoom(bot, signal)
    return await fn()
  }
}

/**
 * Walks to a place within ROOM_SEARCH blocks with a free cell next to it to put a block in (findPlacementNear): the
 * eight ways out, nearest first. The craft of a wooden pickaxe on seed 5 found no room where the bot came down from a
 * tree, five times over, and the wood milestone failed.
 */
export async function toRoom (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const lookup = (p: Vec3): any => bot.blockAt(p)
  const here = bot.entity.position.floored()
  for (const r of [3, 6, 10]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      throwIfAborted(signal)
      const spot = here.offset(dx * r, 0, dz * r)
      try {
        await navigate(bot, { goal: new goals.GoalNearXZ(spot.x, spot.z, 1), maxTicks: 400 }, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        continue
      }
      if (findPlacementNear(lookup, bot.entity.position) != null) return true
    }
  }
  return false
}

/**
 * The item carried, worn (the armor slots) or in the off hand: the armor reflex puts a crafted chestplate on while the
 * step is preempted (picking its table up), and the step, resumed, counted it gone and crafted another, "short of 1
 * iron_chestplate" (seeds 3, 5 and 1234567890)
 */
export function ownedCount (bot: Bot, name: string): number {
  let n = countItems(bot, name)
  for (const slot of [5, 6, 7, 8]) {
    const item = bot.inventory.slots[slot]
    if (item?.name === name) n += item.count
  }
  return n
}

export const runCraft: StepRunner<CraftStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => ownedCount(bot, step.item))
  const want = start + step.count - ownedCount(bot, step.item)
  if (want > 0) {
    const table = step.table && ctx.table != null && bot.entity.position.distanceTo(ctx.table) <= 48 ? ctx.table : undefined
    // with a table in the bag, one close by or the bag's (put down and taken back): a table left far off up a hill
    // costs a trip the pathfinder may not make
    const tableDistance = countItems(bot, 'crafting_table') > 0 ? NEAR_STATION : undefined
    await withRoom(bot, signal, async () => await craft(bot, { item: step.item, count: want, table, tableDistance, pickUpTable: table == null }, signal))
  }
  return { gained: ownedCount(bot, step.item) - start }
}

export const runSmelt: StepRunner<SmeltStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const furnace = ctx.furnace != null && bot.entity.position.distanceTo(ctx.furnace) <= 48 ? ctx.furnace : undefined
  // the fuels the plan chose, one after the other (it kept the planks a later craft needs out of them), then the
  // skill's own choice by preference for what's left
  const fuels: Array<string | undefined> = [...step.fuel.map(f => f.name).filter(n => countItems(bot, n) > 0), undefined]
  // a big smelt away from the base runs in a few furnaces at once (smeltParallel); the single furnace below smelts
  // what is left
  if (furnace == null && step.inputs.length === 1 && step.count - (countItems(bot, step.item) - start) >= PARALLEL_MIN_ITEMS) {
    try {
      const n = step.count - (countItems(bot, step.item) - start)
      await withRoom(bot, signal, async () => await smeltParallel(bot, { input: step.inputs[0].name, count: n }, signal))
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'DIED')) throw err
      trace('executor: parallel smelt failed', (err as Error).message)
    }
  }
  for (const input of step.inputs) {
    for (const fuel of fuels) {
      const done = countItems(bot, step.item) - start
      const n = Math.min(input.count, step.count - done, countItems(bot, input.name))
      if (n <= 0) break
      if (fuel != null && countItems(bot, fuel) === 0) continue
      const furnaceDistance = countItems(bot, 'furnace') > 0 ? NEAR_STATION : undefined
      // a furnace drops nothing to a hand without a pickaxe: it stays where it was put then
      const canPickUp = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
      try {
        await withRoom(bot, signal, async () => await smelt(bot, { input: input.name, count: n, fuel, furnace, furnaceDistance, pickUpFurnace: furnace == null && canPickUp }, signal))
      } catch (err) {
        // out of this fuel: the next one
        if (fuel == null || !TaskError.is(err, 'MISSING_ITEMS')) throw err
      }
    }
  }
  const gained = countItems(bot, step.item) - start
  if (gained < step.count) throw new SkillError('MISSING_ITEMS', `smelted ${gained} of ${step.count} ${step.item}`, { gained })
  return { gained }
}

/** the blocks of a lake's or a beach's floor: one with water against it is left (runMine's submerged) */
export const WATER_FLOOR_BLOCKS = ['sand', 'red_sand', 'gravel', 'clay']

/** whether a mine step leaves its blocks with water against them: the ores', the stones' and a water floor's */
export function leftWhenSubmerged (blocks: readonly string[], block: string): boolean {
  return oreLevel([...blocks]) != null || STONES.includes(block) || WATER_FLOOR_BLOCKS.includes(block)
}

/** how far from home the hunt explores for its animals before it gives up on them */
export const HUNT_EXPLORE_RADIUS = 96
/** the farthest the hunt's exploring goes out, once the nearer land had none (huntRadius) */
export const HUNT_EXPLORE_MAX = 384

/**
 * How far the hunt explores after `misses` explorations in a row found none: twice as far each time, to
 * HUNT_EXPLORE_MAX. A 26.3 bot whose base was on a snowy mountain walked the same 96-block spiral for cows five times
 * from t107000 to past t220000, and never got its food milestone (seed 31337)
 */
export function huntRadius (misses: number): number {
  return Math.min(HUNT_EXPLORE_MAX, HUNT_EXPLORE_RADIUS * 2 ** Math.max(0, misses))
}

/** how far below the bot an animal is left alone (down a ravine, a cliff) */
export const PREY_BELOW = 12

/**
 * Whether an animal is in a place a hunt from the surface doesn't go: under a roof (a cave it fell into) while the bot
 * is under the sky, or far below the bot. A rabbit in a cave on seed 4 led a hunt down to y 0, into the mobs.
 */
export function outOfTheWay (bot: Bot, pos: Vec3): boolean {
  const lookup = (p: Vec3): { name: string, boundingBox: string } | null => bot.blockAt(p) as any
  if (pos.y < bot.entity.position.y - PREY_BELOW) return true
  return openSky(lookup, bot.entity.position.floored()) && !openSky(lookup, pos.floored())
}

/**
 * A hunt's exploring progress for its animals at a radius: the executor's, kept across the plans (a hunt's plan made
 * again, a top-up between or a death, started its spiral over and never came to its end to go further out, 26.3 seed
 * 31337), else the step's own, kept across its preemptions
 */
export function huntProgress (ctx: Pick<StepContext, 'progress' | 'state'>, mobs: readonly string[], radius: number): { key: string, progress: { leg: number } } {
  const key = `hunt:${[...mobs].sort().join(',')}:${radius}`
  return { key, progress: ctx.progress?.(key) ?? (ctx.state.explore ??= { leg: 0 }) }
}

/** ticks a kill step waits at the herd for a calf to grow into a surplus adult, at most */
export const HERD_GROW_WAIT = 12000

/**
 * A kill step with none of its animals near and a herd of one of them kept (the plan counts on the herd's surplus or
 * its calves nearly grown, herdSupply): to the herd first (the bot off at the mine, out of its sight), its counts
 * noted as seen there, and a calf nearly grown waited for (HERD_GROW_WAIT at most). Resolves whether it went; once a
 * step (ctx.state.herdVisited), then the step explores as for any.
 */
async function toTheHerd (bot: Bot, ctx: StepContext, mobs: readonly string[]): Promise<boolean> {
  const herd = herdFromMemory(ctx.memory, bot.entity.position)
  if (herd == null || !mobs.includes(herd.mob) || dimensionOf(bot) !== 'overworld') return false
  const age = (): number => Number((bot.time as any)?.age ?? 0)
  const supply = herdSupply(bot, ctx.memory, herd.mob, age())
  if (supply == null || (supply.surplus === 0 && supply.growTicks > HERD_GROW_WAIT)) return false
  ctx.state.herdVisited = true
  const pen = herdPenOf(ctx.memory, herd)
  // (in by its gate: the pathfinder never breaks its ring)
  if (pen != null) protectPen(bot, pen)
  if (Math.hypot(bot.entity.position.x - herd.pos.x, bot.entity.position.z - herd.pos.z) > 16) {
    ctx.log(`to the herd at ${herd.pos.toString()} for its ${herd.mob}s`)
    await travel(bot, { target: herd.pos, range: 8 }, ctx.signal).catch(err => { if (isAbort(err)) throw err })
  }
  const census = noteHerd(bot, ctx.memory, herd)
  if (census == null || herdSurplus(census.adults.length) > 0 || census.calves.length === 0) return true
  const left = herdSupply(bot, ctx.memory, herd.mob, age())
  if (left == null || left.growTicks > HERD_GROW_WAIT) return true
  ctx.log(`waiting at the herd for a calf to grow (${left.growTicks} ticks or so)`)
  await waitUntil(bot, () => herdSurplus(herdCensus(bot, herd, pen)?.adults.length ?? 0) > 0, left.growTicks + 1200, ctx.signal)
  return true
}

export const runKill: StepRunner<KillStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const target = start + step.count
  const subs = mobSubstitutes(step)
  let failures = 0
  let substituted = 0
  // animals the bot couldn't get to (across a ravine, up a cliff): passed over for the others
  const passed = new Set<number>()
  // (never the herd's breeders, the last two adults of its pen, nor its calves: herdSpares, as the herd is now)
  const nearest = (mobs: string[], range: number): Entity | null => {
    const spared = herdSpares(bot, ctx.memory)
    return nearestOfType(bot, mobs, range, e => passed.has(e.id) || spared.has(e.id) || outOfTheWay(bot, e.position))
  }
  while (countItems(bot, step.item) < target) {
    throwIfAborted(signal)
    let mob = step.mob
    if (nearest([step.mob], SEARCH_RADIUS) == null) {
      const sub = subs.find(m => nearest([m], SEARCH_RADIUS) != null)
      if (sub != null && ctx.notNear != null && ctx.isNotNear?.(step.mob) !== true) {
        // none of the step's near, another meat animal is: planned again for that one, its own meat and its cooking
        // (the step's animal and the others not near dear a while, Sightings.notNear)
        ctx.log(`no ${step.mob} near, a ${sub} is: planning for its ${meatOf(sub) ?? 'meat'}`)
        ctx.notNear([step.mob, ...subs.filter(m => nearest([m], SEARCH_RADIUS) == null)])
        return { gained: countItems(bot, step.item) - start, replan: true }
      }
      if (sub != null) mob = sub
      else if (ctx.state.herdVisited !== true && await toTheHerd(bot, ctx, [step.mob, ...subs])) {
        continue
      } else if (countItems(bot, step.item) > start && ctx.notNear != null && ctx.isNotNear?.(step.mob) !== true) {
        // the ones near taken, some of the meat got: planned again from here (the water by the bot to fish, the meat to
        // cook) before an exploring for more (the 3 rabbits of a snowy field killed, the step explored 8000 ticks on)
        ctx.log(`no more ${step.mob} near: planning again with the ${countItems(bot, step.item) - start} ${step.item} got`)
        ctx.notNear([step.mob, ...subs])
        return { gained: countItems(bot, step.item) - start, replan: true }
      } else {
        ctx.log(`exploring for a ${[step.mob, ...subs].join(' or ')}`)
        passed.clear()
        // not far out: none in HUNT_EXPLORE_RADIUS of home is a land without them (a snowy taiga's rabbits only), and
        // the plan goes for another food then; the food that grows is noted on the way for it
        // further out once the nearer land had none, its spiral not walked again (skipWithin)
        const misses = Math.min(...[step.mob, ...subs].map(m => ctx.misses?.(m) ?? 0))
        const radius = huntRadius(misses)
        const { key, progress } = huntProgress(ctx, [step.mob, ...subs], radius)
        const found = await exploreSurface(bot, { found: () => nearest([step.mob, ...subs], 32) != null, center: ctx.home ?? undefined, maxRadius: radius, skipWithin: misses > 0 ? huntRadius(misses - 1) : undefined, memory: ctx.memory, remember: SIGHTED_BLOCKS, progress }, signal)
        if (!found) {
          ctx.forgetProgress?.(key)
          throw new SkillError('NOT_FOUND', `no ${step.mob} found exploring`)
        }
        continue
      }
    }
    const prey = nearest([mob], SEARCH_RADIUS)
    if (prey == null) continue
    // a trip to an animal from the bottom of a mine is a search the pathfinder doesn't finish: climb out first
    if (prey.position.distanceTo(bot.entity.position) > 8) await ensureSurface(bot, signal)
    try {
      // (another animal's meat counted as its own: a 26.3 bot hunting rabbits for a cow's step logged 'for beef 0 / 5')
      const meat = mob === step.mob ? step.item : meatOf(mob) ?? step.item
      trace('executor: hunting a', mob, 'for', meat, countItems(bot, meat), mob === step.mob ? `/ ${target}` : `(in place of ${step.mob} for ${step.item})`)
      // after an animal over the surface, not down a ravine or through a cave on the way
      const res = await onTheSurface(bot, async () => await hunt(bot, prey, { signal, range: SEARCH_RADIUS }))
      trace('executor: hunt', res.killed ? 'killed' : 'lost', 'the', mob, 'drops', res.drops)
      if (mob !== step.mob && res.killed) substituted++
      // its meat got: planned again with it (cooked, or more of that animal), not hunted on for the step's
      if (mob !== step.mob && res.killed && (res.drops[meatOf(mob) ?? ''] ?? 0) > 0) return { gained: countItems(bot, step.item) - start, replan: true }
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'DIED', 'INVENTORY_FULL')) throw err
      passed.add(prey.id)
      if (++failures > 8) throw err
      trace('executor: hunt failed', (err as Error).message)
      if (TaskError.is(err, 'NO_PATH')) await unstick(bot, signal)
    }
    if (substituted >= step.kills) return { gained: countItems(bot, step.item) - start, replan: true }
  }
  return { gained: countItems(bot, step.item) - start }
}

export const runLoot: StepRunner<LootStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const want = start + step.count - countItems(bot, step.item)
  if (want > 0) {
    const chest = new Vec3(step.from.x, step.from.y, step.from.z)
    // a chest out of the loaded chunks (the base's, from 160 blocks off down a mine) walked to first: 'the chunk
    // isn't loaded' three times and the step failed (26.3)
    if (bot.blockAt(chest) == null || bot.entity.position.distanceTo(chest) > 48) {
      // (the base's by its entrance: travel's stair down from over a dug-in base ends on its roof)
      const door = baseWayIn(ctx.memory, chest, bot.entity.position, step.from.dimension)
      if (door != null) await pickaxeForTheWay(bot, signal)
      const target = door != null ? new Vec3(door.x, door.y, door.z) : chest
      await travel(bot, { target, range: door != null ? 1 : 3, exactY: true }, signal).catch(err => { if (isAbort(err)) throw err })
    }
    // (the window's contents remembered whatever came out: chest.ts rememberContents)
    let res
    try {
      res = await retrieveItems(bot, { chest, filter: step.item, count: want, memory: ctx.memory }, signal)
    } catch (err) {
      // the chest is gone (forgotten by the take): planned again at once, no retry of it
      if (!isSkillError(err, 'NOT_FOUND') || bot.blockAt(chest) == null) throw err
      ctx.log(`loot: ${(err as Error).message}: planning again`)
      return { gained: countItems(bot, step.item) - start, replan: true }
    }
    // the chest held less than the memory said (taken in a run whose memory wasn't saved): the memory has its true
    // contents now, and the plan is made again at once, not the loot tried again (a 26.3 replacement for a worn
    // pickaxe walked to the base for 'loot 1 diamond_pickaxe' and gained 0)
    const got = res.moved[step.item] ?? 0
    if (got < want) {
      ctx.log(`loot: the chest at ${chest.toString()} had ${got} of the ${want} ${step.item} remembered: planning again`)
      return { gained: countItems(bot, step.item) - start, replan: true }
    }
  }
  return { gained: countItems(bot, step.item) - start }
}

export const runFill: StepRunner<FillStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const target = start + step.count
  let failures = 0
  while (countItems(bot, step.item) < target) {
    throwIfAborted(signal)
    const source = (): boolean => bot.findBlock({ matching: (b: any) => isSource(b, step.fluid), maxDistance: 32 }) != null
    if (!source()) {
      ctx.log(`exploring for ${step.fluid}`)
      const found = step.fluid === 'water'
        ? await exploreSurface(bot, { found: source, center: ctx.home ?? undefined }, signal)
        : await exploreForBlocks(bot, { names: ['lava'], radius: 32 }, signal)
      if (!found) throw new SkillError('NOT_FOUND', `no ${step.fluid} source found exploring`)
    }
    try {
      await fillBucket(bot, { fluid: step.fluid, maxDistance: 32 }, signal)
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'MISSING_ITEMS')) throw err
      if (++failures > 3) throw err
    }
  }
  return { gained: countItems(bot, step.item) - start }
}

/** ticks a farm step waits at its farm for half the plots to grow before it harvests what has */
export const FARM_WAIT_TICKS = 2400

/**
 * A farm step: with no farm of its crop known, one is sown by water near home (the hoe and seeds the plan got) and
 * noted, and the step hands back (replan): the growing is the next plans', which go for nearer food meanwhile and come
 * back when the farm costs less than they do. With one known, the bot goes to it, waits a while for the crops, and
 * harvests the grown ones, each plot sown again.
 */
export const runFarm: StepRunner<FarmStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const dimension = dimensionOf(bot)
  const item = step.item
  const start = startCount(ctx, 'start', () => countItems(bot, item))
  const farm = knownFarms(ctx.memory, dimension).find(f => f.crop === step.crop)
  if (farm == null) {
    const res = await plantFarm(bot, { seed: step.seed, center: ctx.home ?? undefined, plots: step.plots }, signal)
    rememberFarm(ctx.memory, res, Number((bot.time as any)?.age ?? 0), dimension)
    ctx.log(`a farm of ${res.cells.length} ${res.crop} sown by the water at ${res.water.toString()}`)
    return { gained: countItems(bot, item) - start, replan: true }
  }
  const cells = farmCells(farm)
  await navigateNear(bot, farm.water, 3, signal)
  const lookup = (p: Vec3): any => bot.blockAt(p)
  // (waited for only when half the plots are a stage short of grown or more: a 26.3 bot back from a death waited out
  // the 2400 ticks three times at a farm with nothing near grown and harvested nothing, full-26.3-fresh-d)
  if (nearlyGrownPlots(lookup, cells, farm.crop).length * 2 >= cells.length) {
    await waitUntil(bot, () => grownPlots(lookup, cells, farm.crop).length * 2 >= cells.length, FARM_WAIT_TICKS, signal)
  }
  const got = await harvestFarm(bot, { cells, crop: farm.crop }, signal)
  ctx.log(`harvested the ${farm.crop}: ${Object.entries(got).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing grown'}`)
  // sown again: the farm grows from now
  rememberFarm(ctx.memory, { water: farm.water, cells, crop: farm.crop }, Number((bot.time as any)?.age ?? 0), dimension)
  return { gained: countItems(bot, item) - start, replan: true }
}

/** how many times a fish step's expected ticks (its catches') it fishes at most before it hands back */
export const FISH_STEP_FACTOR = 3
/** how far from the bot a fish step looks for water to fish in (the fish skill's radius) */
export const FISH_RADIUS = 32

/**
 * A fish step: the rod cast into water near (any, open or not), until the step's fish is had. With no water to fish in,
 * a frozen lake's ice broken open (iceHoleFor: a 3 x 3 hole, the ice turns to water), else explored for out to
 * HUNT_EXPLORE_RADIUS (NOT_FOUND then: the plans go for another food). It hands back after FISH_STEP_FACTOR times its
 * catches' expected ticks.
 */
export const runFish: StepRunner<FishStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const target = start + step.count
  const budget = step.catches * FISHING.catchTicks * FISH_STEP_FACTOR
  const fished = (): number => Number(ctx.state.fished ?? 0)
  const water = (): boolean => fishingSpotFor(bot, bot.entity.position, FISH_RADIUS, false) != null
  for (let tries = 0; tries < 4 && countItems(bot, step.item) < target && fished() < budget; tries++) {
    throwIfAborted(signal)
    if (!water()) {
      const hole = iceHoleFor(bot, bot.entity.position, FISH_RADIUS)
      if (hole != null) {
        ctx.log(`breaking the ice at ${hole[0].toString()} to fish`)
        try {
          await collectBlock(bot, { positions: hole, count: hole.length, pickup: false, anyTool: true }, signal)
        } catch (err) {
          if (isAbort(err) || TaskError.is(err, 'DIED')) throw err
          trace('executor: the ice hole', (err as Error).message)
        }
        continue
      }
      ctx.log('exploring for water to fish in')
      ctx.state.explore ??= { leg: 0 }
      const found = await exploreSurface(bot, { found: () => water() || iceHoleFor(bot, bot.entity.position, FISH_RADIUS) != null, center: ctx.home ?? undefined, maxRadius: HUNT_EXPLORE_RADIUS, memory: ctx.memory, remember: SIGHTED_BLOCKS, progress: ctx.state.explore }, signal)
      if (!found) throw new SkillError('NOT_FOUND', 'no water to fish in found exploring')
      continue
    }
    try {
      const res = await fish(bot, { until: b => countItems(b, step.item) >= target, radius: FISH_RADIUS, open: false, maxTicks: budget - fished() }, signal)
      ctx.state.fished = fished() + res.ticks
      trace('executor: fished', JSON.stringify(res.caught), 'in', res.casts, 'casts')
    } catch (err) {
      const partial = (err as TaskError).partial as { ticks?: number } | undefined
      ctx.state.fished = fished() + (partial?.ticks ?? 0)
      if (isAbort(err) || TaskError.is(err, 'DIED', 'MISSING_ITEMS', 'INVENTORY_FULL')) throw err
      trace('executor: fishing', (err as Error).message)
      if (TaskError.is(err, 'TIMEOUT')) break
    }
  }
  return { gained: countItems(bot, step.item) - start }
}

/** bartering with piglins is the nether skills' (not wired yet): the plan has to do without it */
export const runBarter: StepRunner = async (step) => {
  throw new TaskError('FAILED', `bartering for ${step.item} is not wired yet`)
}

export const DEFAULT_RUNNERS: { [K in PlanStep['kind']]: StepRunner<Extract<PlanStep, { kind: K }>> } = {
  mine: runMine,
  craft: runCraft,
  smelt: runSmelt,
  kill: runKill,
  loot: runLoot,
  fill: runFill,
  barter: runBarter,
  farm: runFarm,
  fish: runFish
}
