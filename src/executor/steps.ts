// One runner per kind of plan step, each over the skills: mine → collectBlock (finding or exploring for the block
// first), craft, smelt, kill → hunt, loot → retrieveItems, fill → fillBucket; barter waits for the nether skills.
// A runner keeps its starting count in the task's state, so a step a reflex preempted picks up where it was.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from '../core/errors'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import type { CraftStep, FillStep, KillStep, LootStep, MineStep, PlanStep, SmeltStep } from '../planner/steps'
import { SkillError, isAbort, isSkillError, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { craft } from '../skills/craft'
import { smelt } from '../skills/smelt'
import { retrieveItems } from '../skills/chest'
import { fillBucket, isSource } from '../skills/bucket'
import { hunt, nearestOfType } from '../skills/hunt'
import type { Entity } from '../skills/combatUtil'
import { navigate, navigateNear } from '../skills/navigate'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { countItems, trace } from '../skills/util'
import { findPlacementNear } from '../skills/placement'
import { digNook, ensureSurface, exploreForBlocks, exploreSurface, findNear, onTheSurface, openSky, oreLevel, unstick } from './explore'
import { toolKindFor, wornOutTools } from './durability'
import { growsAny, isGrown } from '../core/crops'

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
}

export interface StepOutcome {
  /** what the step added of its item */
  gained: number
  /** the step came out other than planned (another wood, another animal): plan again before going on */
  replan?: boolean
}

export type StepRunner<S extends PlanStep = PlanStep> = (step: S, ctx: StepContext) => Promise<StepOutcome>

/** the blocks the pathfinder builds with (BlockInfo.scaffoldingBlockItems), kept this many on top of what a plan uses */
export const SCAFFOLD_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt']
export const SCAFFOLD_BUFFER = 24

/** the blocks a mine step climbs out of a mine for first */
export const SURFACE_BLOCKS = /(_log|_leaves|^sand|^red_sand|^sugar_cane|^pumpkin|^melon|^cactus|^bamboo|^short_grass|^sweet_berry_bush|^wheat|^carrots|^potatoes|^beetroots|^hay_block)$/

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

/** animals that will do instead of the step's: any other meat animal for meat */
export function mobSubstitutes (step: Pick<KillStep, 'mob' | 'item'>): string[] {
  if (!MEAT_ANIMALS.includes(step.mob)) return []
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
  if (await exploreForBlocks(bot, { names: all, memory: ctx.memory, center: ctx.home ?? undefined, exclude }, ctx.signal)) {
    if (near(names)) return names
    if (near(alternatives)) return alternatives
  }
  throw new SkillError('NOT_FOUND', `no ${names.join(', ')} found exploring`)
}

export const runMine: StepRunner<MineStep> = async (step, ctx) => {
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
  const exclude = (pos: Vec3): boolean => ctx.protect?.(pos) === true || unripe(pos) || (!deep && pos.y < startY - SHALLOW_DEPTH) || tooDeep(pos)
  while (countItems(bot, step.item) < target) {
    throwIfAborted(signal)
    const subs = blockSubstitutes(step)
    // the tool about to break: back to the executor, which makes another before the step goes on
    const kind = toolKindFor(bot.registry as any, step.block)
    if (ctx.replacingTools !== true && kind != null && wornOutTools(bot.inventory.items(), { minUses: MIN_TOOL_USES }).some(w => w.kind === kind)) {
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
      const res = await collectBlock(bot, { names, count: Math.min(left, batch), maxDistance: SEARCH_RADIUS, exclude }, signal)
      for (const pos of res.positions) ctx.memory.forgetBlock(pos, dimensionOf(bot))
      if (isSub) substituted += res.mined
    } catch (err) {
      if (isAbort(err) || TaskError.is(err, 'NO_TOOL', 'INVENTORY_FULL', 'DIED')) throw err
      const partial = (err as TaskError).partial as { mined?: number, positions?: Vec3[] } | undefined
      for (const pos of partial?.positions ?? []) ctx.memory.forgetBlock(pos, dimensionOf(bot))
      if (isSub) substituted += partial?.mined ?? 0
      if (++failures > 4) throw err
      trace('executor: mine failed', (err as Error).message)
      if (TaskError.is(err, 'NO_PATH')) await unstick(bot, signal)
    }
    if (isSub && substituted >= step.blockCount) return { gained: countItems(bot, step.item) - start, replan: true }
  }
  return { gained: countItems(bot, step.item) - start }
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

export const runCraft: StepRunner<CraftStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const want = start + step.count - countItems(bot, step.item)
  if (want > 0) {
    const table = step.table && ctx.table != null && bot.entity.position.distanceTo(ctx.table) <= 48 ? ctx.table : undefined
    // with a table in the bag, one close by or the bag's (put down and taken back): a table left far off up a hill
    // costs a trip the pathfinder may not make
    const tableDistance = countItems(bot, 'crafting_table') > 0 ? NEAR_STATION : undefined
    await withRoom(bot, signal, async () => await craft(bot, { item: step.item, count: want, table, tableDistance, pickUpTable: table == null }, signal))
  }
  return { gained: countItems(bot, step.item) - start }
}

export const runSmelt: StepRunner<SmeltStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const furnace = ctx.furnace != null && bot.entity.position.distanceTo(ctx.furnace) <= 48 ? ctx.furnace : undefined
  // the fuels the plan chose, one after the other (it kept the planks a later craft needs out of them), then the
  // skill's own choice by preference for what's left
  const fuels: Array<string | undefined> = [...step.fuel.map(f => f.name).filter(n => countItems(bot, n) > 0), undefined]
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

export const runKill: StepRunner<KillStep> = async (step, ctx) => {
  const { bot, signal } = ctx
  const start = startCount(ctx, 'start', () => countItems(bot, step.item))
  const target = start + step.count
  const subs = mobSubstitutes(step)
  let failures = 0
  let substituted = 0
  // animals the bot couldn't get to (across a ravine, up a cliff): passed over for the others
  const passed = new Set<number>()
  const nearest = (mobs: string[], range: number): Entity | null => nearestOfType(bot, mobs, range, e => passed.has(e.id) || outOfTheWay(bot, e.position))
  while (countItems(bot, step.item) < target) {
    throwIfAborted(signal)
    let mob = step.mob
    if (nearest([step.mob], SEARCH_RADIUS) == null) {
      const sub = subs.find(m => nearest([m], SEARCH_RADIUS) != null)
      if (sub != null) mob = sub
      else {
        ctx.log(`exploring for a ${[step.mob, ...subs].join(' or ')}`)
        passed.clear()
        const found = await exploreSurface(bot, { found: () => nearest([step.mob, ...subs], 32) != null, center: ctx.home ?? undefined }, signal)
        if (!found) throw new SkillError('NOT_FOUND', `no ${step.mob} found exploring`)
        continue
      }
    }
    const prey = nearest([mob], SEARCH_RADIUS)
    if (prey == null) continue
    // a trip to an animal from the bottom of a mine is a search the pathfinder doesn't finish: climb out first
    if (prey.position.distanceTo(bot.entity.position) > 8) await ensureSurface(bot, signal)
    try {
      trace('executor: hunting a', mob, 'for', step.item, countItems(bot, step.item), '/', target)
      // after an animal over the surface, not down a ravine or through a cave on the way
      const res = await onTheSurface(bot, async () => await hunt(bot, prey, { signal, range: SEARCH_RADIUS }))
      trace('executor: hunt', res.killed ? 'killed' : 'lost', 'the', mob, 'drops', res.drops)
      if (mob !== step.mob && res.killed) substituted++
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
    const res = await retrieveItems(bot, { chest, filter: step.item, count: want }, signal)
    const known = ctx.memory.chestAt(chest, step.from.dimension)
    if (known != null) {
      const items = { ...known.items }
      for (const [name, n] of Object.entries(res.moved)) items[name] = Math.max(0, (items[name] ?? 0) - n)
      ctx.memory.rememberChest(chest, items, step.from.dimension)
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
  barter: runBarter
}
