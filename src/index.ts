import type { Bot } from 'mineflayer'
import { createPlugin as createPathfinder } from '@nxg-org/mineflayer-pathfinder'
import { TaskRunner } from './core/taskRunner'
import { WorldMemory, normalizeDimension } from './core/memory'
import { ReflexEngine, type ReflexEngineOptions } from './reflexes'
import { play, type MilestoneHandler, type PlayOptions, type PlayResult } from './runner'
import { keepHeadAboveWater } from './skills/breath'
import { openSky } from './executor/explore'
import type { MilestoneId } from './planner/progression'
import { Diagnostics, type DiagnosticsOptions } from './diagnostics'
import { StockPolicy, type StockOptions } from './planner/stock'
import { advancementsDone, type AdvancementProgressPacket } from './core/advancements'
import { SCAFFOLD_ITEMS } from './executor/steps'
import { rememberNetherDeath } from './nether/deaths'
import { keepNetherTrail, pruneTrail } from './nether/trail'

export * from './core'
export * from './planner'

export * as base from './base'
export * as reflexes from './reflexes'
export * as combat from './skills/combat'
export * as gather from './skills/gather'
export * as enchanting from './skills/enchanting'
export * as nether from './nether'
export * as end from './end'
export * as worldgen from './worldgen'
export * as diagnostics from './diagnostics'
export { Diagnostics } from './diagnostics'
export type { DiagnosticsOptions, StuckReport, ReportKind } from './diagnostics'
export * as executor from './executor'
export { Executor } from './executor/executor'
export type { ExecutorOptions, ObtainOutcome } from './executor/executor'
export { Runner, play, progressState, fileSaveStore, UNWIRED } from './runner'
export type { PlayOptions, PlayResult, MilestoneEvent, MilestoneHandler, MilestoneContext, SaveStore } from './runner'

export interface SurvivalOptions {
  /** load the pathfinder if the bot doesn't have it yet (default true) */
  loadPathfinder?: boolean
  /** the always-on reflexes (eat, fight or flee, creepers, lava and fire, drowning, armor, totem); false for none (default true) */
  reflexes?: boolean | ReflexEngineOptions
  /** the stuck reports (bot.survival.diagnostics): where they're written, how many kept */
  diagnostics?: DiagnosticsOptions
  /** the stock policy (planner/stock.ts): its marks, overrides and working set; false or enabled: false for none */
  stock?: StockOptions | false
}

export interface Survival {
  options: Required<SurvivalOptions>
  /** the foreground task queue; reflexes preempt the running task */
  tasks: TaskRunner
  /** what the bot has seen of the world */
  memory: WorldMemory
  /** the reflexes, handing their urgent tasks to `tasks` (null when turned off) */
  reflexes: ReflexEngine | null
  /**
   * Handlers for milestones play has none for (the nether, eyes and end ones until those skills are wired): play
   * stops at a milestone of UNWIRED without one.
   */
  handlers: Partial<Record<MilestoneId, MilestoneHandler>>
  /** advancements earned, by id without the namespace ('end/kill_dragon'), for the milestones that check one */
  advancements: Set<string>
  /** plays from where the bot is, milestone by milestone (see PlayOptions) */
  play: (options?: PlayOptions) => Promise<PlayResult>
  /** stuck reports: lastReports(), onReport(cb), dump() */
  diagnostics: Diagnostics
  /** what play keeps on hand beyond the milestones' needs (null when turned off) */
  stock: StockPolicy | null
}

/**
 * the pathfinder builds with the blocks the survival skills count and keep (SCAFFOLD_ITEMS, cheapest first): its
 * search's budget and its places, the other settings as they are
 */
function useScaffoldItems (bot: Bot): void {
  const pf = bot.pathfinder as any
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null) return
  pf.setMoveOptions({ ...pf.defaultMoveSettings, scaffoldingBlocks: [...SCAFFOLD_ITEMS] })
}

export function createPlugin (opts: SurvivalOptions = {}): (bot: Bot) => void {
  const options: Required<SurvivalOptions> = { loadPathfinder: true, reflexes: true, diagnostics: {}, stock: {}, ...opts }
  return function (bot: Bot): void {
    if (options.loadPathfinder && bot.pathfinder == null) bot.loadPlugin(createPathfinder())
    useScaffoldItems(bot)
    // no walk or swim with the head under water and no air over it (a flooded cave): the bot drowns on the way
    keepHeadAboveWater(bot)
    const tasks = new TaskRunner(bot)
    const memory = new WorldMemory()
    const reflexes = options.reflexes === false ? null : new ReflexEngine(bot, { sink: tasks, ...(options.reflexes === true ? {} : options.reflexes) })
    const diagnostics = new Diagnostics(bot, options.diagnostics)
    const stock = options.stock === false || options.stock.enabled === false ? null : new StockPolicy(options.stock)
    bot.survival = { options, tasks, memory, reflexes, handlers: {}, advancements: new Set(), play: async (playOptions) => await play(bot, playOptions), diagnostics, stock }
    bot.on('physicsTick', () => { memory.now = tasks.tick })
    // where the bot walks the nether, to go that way again (travel by trailRoute)
    keepNetherTrail(bot, memory)
    // the advancements as the server tells them: the End milestone's check is the dragon's minecraft:end/kill_dragon
    ;(bot as any)._client?.on?.('advancements', (packet: AdvancementProgressPacket) => {
      for (const id of advancementsDone(packet)) bot.survival.advancements.add(id)
    })
    bot.on('death', () => {
      // the running and queued tasks can't go on; the death spot is where the items are
      if (bot.entity != null) {
        // (in the overworld: the nether's roof is over everything)
        const dimension = normalizeDimension(bot.game?.dimension)
        const lookup = (p: any): any => bot.blockAt(p)
        memory.setDeath(bot.entity.position, dimension, dimension === 'overworld' ? !openSky(lookup, bot.entity.position.floored()) : undefined)
        if (dimension === 'the_nether') {
          rememberNetherDeath(memory, bot.entity.position)
          pruneTrail(memory, bot.entity.position)
        }
      }
      tasks.cancelAll('DIED', 'the bot died')
    })
    bot.once('end', () => {
      reflexes?.stop()
      tasks.destroy()
    })
  }
}

declare module 'mineflayer' {
  interface Bot {
    survival: Survival
  }
}

export { enableLockstep, createLockstepBot } from './lockstep'
export type { Lockstep, LockstepOptions, LockstepMode } from './lockstep'
