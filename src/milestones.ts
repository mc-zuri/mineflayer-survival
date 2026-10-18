// The milestone handlers past the overworld's gear, over the nether, stronghold and End skills: the nether (a portal
// built and gone through, blaze rods at a fortress's spawner, pearls by bartering or from endermen, and back), the
// eyes (crafted, thrown and crossed to the stronghold, down to its portal room) and the End (the frame filled and gone
// through, the dragon fought, out by the exit portal). Each skill runs as one foreground task, so the reflexes still
// preempt it (it starts over after).
import type { Bot } from 'mineflayer'
import { EYES_FOR_FRAME, EYES_TARGET } from './planner/progression'
import type { MilestoneHandler } from './runner'
import { buildPortal, collectBlazeRods, enterNether, obtainPearls, returnOverworld } from './nether/skills'
import { craftEyes, strongholdToPortalRoom } from './end/strongholdSkills'
import { enterEnd, fightDragon, isInEnd, leaveEnd } from './end/skills'
import { enchantGear } from './skills/enchant'
import { countItems } from './skills/util'
import { normalizeDimension } from './core/memory'
import { TaskError } from './core/errors'
import { FARM_PLOTS } from './core/crops'
import { findFarmSite, knownFarms, plantFarm, rememberFarm, SEED_OF } from './skills/farm'
import type { Executor } from './executor/executor'
import { Vec3 } from 'vec3'

const inNether = (bot: Bot): boolean => normalizeDimension(bot.game?.dimension) === 'the_nether'

/** rods and pearls still wanted for EYES_TARGET eyes (each rod is 2 powder, an eye a pearl and a powder) */
export function netherNeeds (inv: { count: (name: string) => number }): { rods: number, pearls: number } {
  const eyes = inv.count('ender_eye')
  const powder = inv.count('blaze_powder') + 2 * inv.count('blaze_rod')
  const wanted = Math.max(0, EYES_TARGET - eyes)
  return { rods: Math.max(0, Math.ceil((wanted - powder) / 2)), pearls: Math.max(0, wanted - inv.count('ender_pearl')) }
}

export const enchantingHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal }) => {
  await executor.obtain(milestone.goals(state), signal)
  await executor.task('enchant the gear', async (s) => await enchantGear(bot, { executor, signal: s }), signal)
}

export const netherHandler: MilestoneHandler = async ({ bot, executor, signal, log }) => {
  const count = (name: string): number => countItems(bot, name)
  if (!inNether(bot)) {
    if (executor.memory.getPois('nether_portal', { dimension: 'overworld' }).length === 0) {
      log('building a nether portal')
      await executor.task('build a nether portal', async (s) => await buildPortal(bot, {}, s), signal)
    }
    await executor.task('into the nether', async (s) => await enterNether(bot, { build: true }, s), signal)
  }
  const needs = netherNeeds({ count })
  if (needs.rods > 0) {
    log(`blaze rods: ${needs.rods} to get`)
    await executor.task('blaze rods', async (s) => await collectBlazeRods(bot, { count: count('blaze_rod') + needs.rods }, s), signal)
  }
  const pearls = netherNeeds({ count }).pearls
  if (pearls > 0) {
    log(`ender pearls: ${pearls} to get`)
    await executor.task('ender pearls', async (s) => await obtainPearls(bot, { pearls: count('ender_pearl') + pearls }, s), signal)
  }
  await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
}

export const eyesHandler: MilestoneHandler = async ({ bot, executor, signal, log }) => {
  if (inNether(bot)) await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
  await executor.task('craft the eyes', async (s) => await craftEyes(bot, { count: EYES_TARGET }, s), signal)
  log(`${countItems(bot, 'ender_eye')} eyes: off to the stronghold`)
  const { room } = await executor.task('to the stronghold', async (s) => await strongholdToPortalRoom(bot, {}, s), signal)
  // the milestone's check: the stronghold remembered, enough eyes left for the frame
  executor.memory.addPoi('stronghold', room.room.center, 'overworld', 'portal room')
  if (countItems(bot, 'ender_eye') < EYES_FOR_FRAME) log(`only ${countItems(bot, 'ender_eye')} eyes left for the frame`)
}

export const endHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  if (!isInEnd(bot)) {
    // the End kit: a bow, arrows, blocks to pillar, a water bucket, food
    try {
      await executor.obtain(milestone.goals(state).map(g => ({ ...g, optional: true })), signal)
    } catch (err) {
      log(`End kit short: ${(err as Error).message}`)
    }
    await executor.task('into the End', async (s) => await enterEnd(bot, { signal: s }), signal)
  }
  const fight = await executor.task('fight the dragon', async (s) => await fightDragon(bot, { signal: s }), signal)
  log(`dragon ${fight.killed ? 'killed' : 'not killed'} in ${fight.ticks} ticks (${fight.meleeHits} hits, ${fight.arrows} arrows)`)
  if (!fight.killed) return
  // the milestone's check: vanilla's end/kill_dragon advancement
  bot.survival.advancements.add('end/kill_dragon')
  await executor.task('out of the End', async (s) => await leaveEnd(bot, { signal: s }), signal)
}

/** what a farm's start may cost (a hoe and the seeds from grass) before it is left for later */
export const FARM_START_TICKS = 2000

/**
 * Sows a farm of wheat by water near home when none is sown yet and its start is cheap (water within 24 blocks with
 * ground by it, the hoe and seeds for FARM_START_TICKS or less): the renewable food of day 1, harvested when it has
 * grown, while the hunt or the berries feed the bot now. Resolves whether one was sown.
 */
export async function startFarm (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<boolean> {
  const dimension = normalizeDimension(bot.game?.dimension)
  if (dimension !== 'overworld' || knownFarms(executor.memory, dimension).length > 0) return false
  const home = executor.memory.base != null ? new Vec3(executor.memory.base.x, executor.memory.base.y, executor.memory.base.z) : bot.entity.position
  const site = findFarmSite(pos => bot.blockAt(pos) as any, home, 24)
  if (site == null) { log('no water with ground by it near: no farm yet'); return false }
  const plots = Math.min(FARM_PLOTS, site.cells.length)
  const requests = [{ item: '#hoes', count: 1 }, { item: 'wheat_seeds', count: plots }]
  const plan = executor.plan(requests)
  if (!plan.ok || plan.cost > FARM_START_TICKS) { log(`a farm would cost ${plan.ok ? plan.cost : 'no plan'} ticks to start: not now`); return false }
  await executor.obtain(requests, signal)
  const res = await executor.task('sow a farm', async (s) => await plantFarm(bot, { seed: 'wheat_seeds', center: site.water, plots, radius: 4 }, s), signal)
  rememberFarm(executor.memory, res, Number((bot.time as any)?.age ?? 0), dimension)
  log(`a farm of ${res.cells.length} wheat sown by the water at ${res.water.toString()}`)
  return true
}

/** how far a grown farm is gone back to for its harvest when food is wanted */
export const FARM_RANGE = 96

/**
 * The renewable food first: a farm the bot sowed that has grown (Executor.farmCost: nothing left to wait), within
 * FARM_RANGE, harvested and sown again, and its wheat baked into bread. Resolves the bread made.
 */
export async function harvestGrownFarms (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  const dimension = normalizeDimension(bot.game?.dimension)
  let bread = 0
  for (const farm of knownFarms(executor.memory, dimension)) {
    const walk = bot.entity.position.distanceTo(farm.water)
    const cost = executor.farmCost(farm.crop)
    if (walk > FARM_RANGE || cost == null || cost > walk * 5 + 1) continue
    const item = farm.crop === 'wheat' ? 'wheat' : farm.crop === 'beetroots' ? 'beetroot' : SEED_OF[farm.crop]
    log(`the ${farm.crop} at ${farm.water.toString()} has grown: harvesting it`)
    await executor.runStep({ kind: 'farm', item, count: farm.cells.length, crop: farm.crop, seed: SEED_OF[farm.crop], plots: 0, cycles: 1, cost }, signal)
  }
  const wheat = countItems(bot, 'wheat')
  if (wheat >= 3) {
    const before = countItems(bot, 'bread')
    await executor.obtain([{ item: 'bread', count: before + Math.floor(wheat / 3) }], signal)
    bread = countItems(bot, 'bread') - before
  }
  return bread
}

/** food: a grown farm harvested and the farm started (the renewable food), then the points from the cheapest source */
export const foodHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  try {
    await harvestGrownFarms(bot, executor, signal, log)
    await startFarm(bot, executor, signal, log)
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`no farm: ${(err as Error).message}`)
  }
  await executor.obtain(milestone.goals(state), signal)
}

/** the handlers play uses unless bot.survival.handlers or its options name others */
export const MILESTONE_HANDLERS = {
  food: foodHandler,
  enchanting: enchantingHandler,
  nether: netherHandler,
  eyes: eyesHandler,
  end: endHandler
}
