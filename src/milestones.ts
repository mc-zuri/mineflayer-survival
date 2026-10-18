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

/** the handlers play uses unless bot.survival.handlers or its options name others */
export const MILESTONE_HANDLERS = {
  enchanting: enchantingHandler,
  nether: netherHandler,
  eyes: eyesHandler,
  end: endHandler
}
