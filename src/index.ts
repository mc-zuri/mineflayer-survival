import type { Bot } from 'mineflayer'
import { createPlugin as createPathfinder } from '@nxg-org/mineflayer-pathfinder'
import { TaskRunner } from './core/taskRunner'
import { WorldMemory, normalizeDimension } from './core/memory'
import { ReflexEngine, type ReflexEngineOptions } from './reflexes'
import { play, type MilestoneHandler, type PlayOptions, type PlayResult } from './runner'
import type { MilestoneId } from './planner/progression'

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
export * as executor from './executor'
export { Executor } from './executor/executor'
export type { ExecutorOptions, ObtainOutcome } from './executor/executor'
export { Runner, play, progressState, UNWIRED } from './runner'
export type { PlayOptions, PlayResult, MilestoneEvent, MilestoneHandler, MilestoneContext } from './runner'

export interface SurvivalOptions {
  /** load the pathfinder if the bot doesn't have it yet (default true) */
  loadPathfinder?: boolean
  /** the always-on reflexes (eat, fight or flee, creepers, lava and fire, drowning, armor, totem); false for none (default true) */
  reflexes?: boolean | ReflexEngineOptions
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
}

export function createPlugin (opts: SurvivalOptions = {}): (bot: Bot) => void {
  const options: Required<SurvivalOptions> = { loadPathfinder: true, reflexes: true, ...opts }
  return function (bot: Bot): void {
    if (options.loadPathfinder && bot.pathfinder == null) bot.loadPlugin(createPathfinder())
    const tasks = new TaskRunner(bot)
    const memory = new WorldMemory()
    const reflexes = options.reflexes === false ? null : new ReflexEngine(bot, { sink: tasks, ...(options.reflexes === true ? {} : options.reflexes) })
    bot.survival = { options, tasks, memory, reflexes, handlers: {}, advancements: new Set(), play: async (playOptions) => await play(bot, playOptions) }
    bot.on('physicsTick', () => { memory.now = tasks.tick })
    bot.on('death', () => {
      // the running and queued tasks can't go on; the death spot is where the items are
      if (bot.entity != null) memory.setDeath(bot.entity.position, normalizeDimension(bot.game?.dimension))
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
