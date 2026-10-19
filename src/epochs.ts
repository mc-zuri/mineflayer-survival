// The epochs after the dragon (play's `epochs` option): the game won, the bot goes on making its world better. Each is a
// milestone of its own (done, available, a handler), worked in order once the milestones are done, and none of them
// stops play: one that fails is left out after maxFailures, one not available (no spawner known for the experience
// farm) waits. The farm epoch keeps a wheat farm of FARM_EPOCH_PLOTS by water near home (the seeds from the grass,
// sown again after each harvest, bone meal on it when held: bread, and wheat to breed with), the experience farm is
// built round a zombie spawner seen on the way (skills/spawnerFarm.ts) and is then the levels' first source, and the
// mending epoch fishes in open water for a book of mending (skills/fish.ts) and puts it on the pickaxe, the sword and
// the chestplate in turn at an anvil.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Milestone, ProgressState } from './planner/progression'
import type { MilestoneHandler } from './runner'
import type { Executor } from './executor/executor'
import { TaskError } from './core/errors'
import { normalizeDimension } from './core/memory'
import { FARM_PLOTS } from './core/crops'
import { makeWaterHole } from './skills/caneFarm'
import { boneMealFarm, extendFarm, farmCells, farmPlots, findFarmSite, grownPlots, harvestFarm, knownFarms, plantFarm } from './skills/farm'
import { bestRod, fish, fishingSpotFor, mendingBooks } from './skills/fish'
import { applyBooks } from './skills/anvil'
import { itemKind } from './skills/enchant'
import { BOOTH_MOBS, buildSpawnerFarm, knownFarmableSpawners, rememberXpFarm, SPAWNER_POI, useSpawnerFarm, XP_FARM_POI } from './skills/spawnerFarm'
import { travel } from './skills/travel'
import { experience } from './skills/xp'
import { countItems } from './skills/util'
import { FARM_RANGE, levelsToward } from './milestones'

/** the plots the farm epoch keeps sown: two farms' worth (FARM_PLOTS each), one water's row all round */
export const FARM_EPOCH_PLOTS = 2 * FARM_PLOTS
/** the gear mending goes on, in turn: the pickaxe, the sword, the chestplate (the most used, the dearest) */
export const MENDING_KINDS = ['pickaxe', 'sword', 'chestplate'] as const
/** ticks of fishing a book of mending is waited for at a go (three days: the treasure is 1 catch in 20, a book 1 in 6 of it) */
export const MENDING_FISH_TICKS = 72000
/** the levels held for the anvil's work on the gear */
export const MENDING_LEVELS = 8
/** how far from home open water is looked for */
export const FISHING_RANGE = 64
/** levels the experience farm is used for once built (an enchanting table's top offer) */
export const XP_FARM_LEVELS = 30
/** ticks the experience farm's first levels may take */
export const XP_FARM_TICKS = 36000

function ownsKind (state: Pick<ProgressState, 'inventory' | 'equipment'>, kind: string): boolean {
  return [...state.inventory.entries().map(i => i.name), ...(state.equipment ?? [])].some(n => itemKind(n) === kind)
}

/** the gear kinds the bot owns (carried or worn) that have no mending yet */
export function unmendedKinds (state: Pick<ProgressState, 'inventory' | 'equipment' | 'mended'>): string[] {
  const owned = [...state.inventory.entries().map(i => i.name), ...(state.equipment ?? [])]
  const mended = state.mended ?? []
  return MENDING_KINDS.filter(kind => owned.some(n => itemKind(n) === kind) && !mended.some(n => itemKind(n) === kind))
}

const home = (bot: Bot, executor: Executor): Vec3 => {
  const b = executor.memory.base
  return b != null && b.dimension === normalizeDimension(bot.game?.dimension) ? new Vec3(b.x, b.y, b.z) : bot.entity.position.clone()
}

const fatal = (signal: AbortSignal, err: unknown): boolean => signal.aborted || TaskError.is(err, 'DIED')

export const EPOCHS: readonly Milestone[] = [
  {
    id: 'farm',
    title: `a wheat farm of ${FARM_EPOCH_PLOTS} plots by water near home, kept sown`,
    done: s => farmPlots(s.memory) >= FARM_EPOCH_PLOTS,
    goals: () => [{ item: '#hoes', count: 1 }]
  },
  {
    id: 'xp_farm',
    title: 'an experience farm round a zombie spawner',
    available: s => knownFarmableSpawners(s.memory).length > 0,
    done: s => s.memory.getPois(XP_FARM_POI).length > 0,
    goals: () => [{ item: 'cobblestone', count: 32 }, { item: 'cobblestone_slab', count: 1 }]
  },
  {
    id: 'mending',
    title: 'mending on the pickaxe, the sword and the chestplate, from books fished in open water',
    // (a pickaxe owned at least: a bot that died and lost its gear has nothing mended, not everything)
    done: s => ownsKind(s, 'pickaxe') && unmendedKinds(s).length === 0,
    goals: () => [{ item: 'fishing_rod', count: 1 }]
  }
]

export function isEpoch (id: string): boolean {
  return EPOCHS.some(e => e.id === id)
}

/** the next epoch to work: in order, not reached, skipped or done, and available now */
export function nextEpoch (state: ProgressState, reached: readonly string[], skip: ReadonlySet<string> = new Set()): Milestone | null {
  return EPOCHS.find(e => !skip.has(e.id) && !reached.includes(e.id) && !e.done(state) && (e.available?.(state) ?? true)) ?? null
}

/** bread baked from the wheat once there's this much (BREAD: 3 wheat), the rest kept to breed with */
export const WHEAT_KEPT = 16

/**
 * A farm's cycle: bone meal held put on the crops not grown (BoneMealItem), the grown plots harvested and sown again
 * from their seeds (harvestFarm), and the wheat over WHEAT_KEPT baked into bread. Resolves the plots harvested.
 */
export async function farmCycle (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  const dimension = normalizeDimension(bot.game?.dimension)
  let harvested = 0
  for (const farm of knownFarms(executor.memory, dimension)) {
    const cells = farmCells(farm)
    if (farm.water.distanceTo(bot.entity.position) > FARM_RANGE) continue
    if (countItems(bot, 'bone_meal') > 0) {
      const uses = await executor.task('bone meal on the farm', async (s) => await boneMealFarm(bot, { cells, crop: farm.crop }, s), signal)
        .catch(err => { if (fatal(signal, err)) throw err; return 0 })
      if (uses > 0) log(`farm: ${uses} bone meal on the ${farm.crop} at ${farm.water.toString()}`)
    }
    const grown = grownPlots(pos => bot.blockAt(pos) as any, cells, farm.crop)
    if (grown.length === 0) continue
    const got = await executor.task('harvest the farm', async (s) => await harvestFarm(bot, { cells, crop: farm.crop }, s), signal)
      .catch(err => { if (fatal(signal, err)) throw err; log(`farm: harvest: ${(err as Error).message}`); return null })
    if (got == null) continue
    harvested += grown.length
    const sown = cells.filter(c => bot.blockAt(c.offset(0, 1, 0))?.name === farm.crop).length
    log(`farm: ${grown.length} plots of ${farm.crop} harvested at ${farm.water.toString()} (${Object.entries(got).map(([k, n]) => `${n} ${k}`).join(', ')}), ${sown} of ${cells.length} sown again`)
  }
  const wheat = countItems(bot, 'wheat')
  if (wheat >= WHEAT_KEPT + 3) {
    const before = countItems(bot, 'bread')
    await executor.obtain([{ item: 'bread', count: before + Math.floor((wheat - WHEAT_KEPT) / 3) }], signal)
      .catch(err => { if (fatal(signal, err)) throw err; log(`farm: no bread: ${(err as Error).message}`) })
    if (countItems(bot, 'bread') > before) log(`farm: ${countItems(bot, 'bread') - before} bread baked`)
  }
  return harvested
}

/**
 * The farm: a cycle on what's there (farmCycle), the farm grown to FARM_EPOCH_PLOTS (seeds from the grass, sown in a
 * row beside its water, findFarmSite; a water hole dug and filled from the bucket when no water near home has ground
 * beside it left), and a cycle again (the bone meal held grows the new plots up at once)
 */
export const farmEpochHandler: MilestoneHandler = async ({ bot, executor, signal, log }) => {
  const dimension = normalizeDimension(bot.game?.dimension)
  if (dimension !== 'overworld') throw new TaskError('FAILED', 'the farm is in the overworld')
  await farmCycle(bot, executor, signal, log)
  const at = home(bot, executor)
  for (let round = 0; round < 3; round++) {
    const have = farmPlots(executor.memory, dimension)
    if (have >= FARM_EPOCH_PLOTS) break
    const want = Math.min(FARM_EPOCH_PLOTS - have, 4 * FARM_PLOTS)
    await executor.obtain([{ item: '#hoes', count: 1 }, { item: 'wheat_seeds', count: want }], signal)
    // by the farm's water first (its row has room for 16), else the best water near home, else a hole dug for it
    const farms = knownFarms(executor.memory, dimension).sort((a, b) => a.water.distanceTo(at) - b.water.distanceTo(at))
    let center = farms[0]?.water ?? at
    let radius = farms.length > 0 ? 1 : 24
    if (findFarmSite(pos => bot.blockAt(pos) as any, center, radius, want) == null) {
      center = at
      radius = 24
      if (findFarmSite(pos => bot.blockAt(pos) as any, center, radius, want) == null && countItems(bot, 'water_bucket') > 0) {
        await executor.task('a water hole for the farm', async (s) => await makeWaterHole(bot, at, s), signal).catch(err => { if (fatal(signal, err)) throw err })
      }
    }
    const res = await executor.task('sow the farm', async (s) => await plantFarm(bot, { seed: 'wheat_seeds', center, plots: want, radius }, s), signal)
    const rec = extendFarm(executor.memory, res, Number((bot.time as any)?.age ?? 0), dimension)
    log(`farm: ${res.cells.length} more wheat by the water at ${res.water.toString()} (${rec.cells.length} there, ${farmPlots(executor.memory, dimension)} in all)`)
  }
  await farmCycle(bot, executor, signal, log)
}

/**
 * The experience farm: to the nearest zombie spawner noted (travel), the blocks got, the farm built round it
 * (buildSpawnerFarm) and remembered, then used for XP_FARM_LEVELS
 */
export const xpFarmEpochHandler: MilestoneHandler = async ({ bot, executor, signal, log }) => {
  const dimension = normalizeDimension(bot.game?.dimension)
  const spawner = knownFarmableSpawners(executor.memory, bot.entity.position, dimension)[0]
  if (spawner == null) throw new TaskError('NOT_FOUND', `no ${BOOTH_MOBS.join(' or ')} spawner known`)
  await executor.obtain([{ item: 'cobblestone', count: 32 }, { item: 'cobblestone_slab', count: 1 }], signal)
  log(`xp farm: the ${spawner.mob} spawner at ${spawner.pos.toString()}`)
  await executor.task('to the spawner', async (s) => await travel(bot, { target: spawner.pos, range: 3, exactY: true }, s), signal)
  let farm
  try {
    farm = await executor.task('build the xp farm', async (s) => await buildSpawnerFarm(bot, spawner.pos, s), signal)
  } catch (err) {
    if (fatal(signal, err)) throw err
    // a spawner the booth can't be built round (no spawner there after all, no wall for it) is forgotten
    if (TaskError.is(err, 'NOT_FOUND')) executor.memory.removePoi(SPAWNER_POI, spawner.pos, dimension)
    throw err
  }
  rememberXpFarm(executor.memory, farm)
  log(`xp farm built: the booth at ${farm.stand.toString()}`)
  if (experience(bot).level < XP_FARM_LEVELS) {
    const res = await executor.task('levels at the xp farm', async (s) => await useSpawnerFarm(bot, farm, { level: XP_FARM_LEVELS, maxTicks: XP_FARM_TICKS }, s), signal)
      .catch(err => { if (fatal(signal, err)) throw err; log(`xp farm: ${(err as Error).message}`); return null })
    if (res != null) log(`xp farm: level ${res.level} after ${res.kills} kills in ${res.ticks} ticks`)
  }
}

/**
 * Mending: a book of mending fished in open water near home (a rod got, made again when it breaks) within
 * MENDING_FISH_TICKS, then the books held put on the gear at an anvil (applyBooks: mending on the pickaxe, then the
 * sword, then the chestplate, the other books fished where they're wanted)
 */
export const mendingEpochHandler: MilestoneHandler = async ({ bot, executor, signal, log }) => {
  const start = executor.tasks.tick
  while (mendingBooks(bot).length === 0) {
    if (executor.tasks.tick - start >= MENDING_FISH_TICKS) throw new TaskError('TIMEOUT', `no book of mending in ${MENDING_FISH_TICKS} ticks of fishing`)
    if (bestRod(bot) == null) await executor.obtain([{ item: 'fishing_rod', count: 1 }], signal)
    const center = home(bot, executor)
    if (fishingSpotFor(bot, bot.entity.position, FISHING_RANGE) == null && fishingSpotFor(bot, center, FISHING_RANGE) != null) {
      await executor.task('to the water', async (s) => await travel(bot, { target: center, range: 8 }, s), signal)
    }
    try {
      const res = await executor.task('fish for mending', async (s) => await fish(bot, { until: b => mendingBooks(b).length > 0, maxTicks: MENDING_FISH_TICKS - (executor.tasks.tick - start), radius: FISHING_RANGE }, s), signal)
      log(`mending: ${res.catches} caught in ${res.casts} casts (${Object.entries(res.caught).map(([k, n]) => `${n} ${k}`).join(', ')})`)
    } catch (err) {
      if (fatal(signal, err)) throw err
      // a broken rod: another one made, and on
      if (TaskError.is(err, 'MISSING_ITEMS') && bestRod(bot) == null) continue
      throw err
    }
  }
  if (bot.findBlock({ matching: ['anvil', 'chipped_anvil', 'damaged_anvil'].map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null), maxDistance: 16 }) == null) {
    await executor.obtain([{ item: 'anvil', count: 1 }], signal)
  }
  // the levels the anvil asks (a book of mending on gear never worked: 2, BookItem's cost of 2 per level; more when
  // the gear went through an anvil before, AnvilMenu's prior work penalty)
  if (experience(bot).level < MENDING_LEVELS) await levelsToward(bot, executor, MENDING_LEVELS, signal, log)
  const done = await executor.task('mending on the gear', async (s) => await applyBooks(bot, {}, s), signal)
  for (const r of done) log(`anvil: ${r.item} now ${r.enchants.map(e => `${e.name ?? '?'} ${e.lvl}`).join(', ')} for ${r.cost} levels`)
  if (!done.some(r => r.enchants.some(e => e.name === 'mending'))) throw new TaskError('FAILED', `the book of mending went on nothing (level ${experience(bot).level})`)
}

/** the epochs' handlers, by id */
export const EPOCH_HANDLERS: Record<string, MilestoneHandler> = {
  farm: farmEpochHandler,
  xp_farm: xpFarmEpochHandler,
  mending: mendingEpochHandler
}
