import type { Bot } from 'mineflayer'
import { createPlugin as createPathfinder } from '@nxg-org/mineflayer-pathfinder'
import { TaskRunner } from './core/taskRunner'
import { WorldMemory, normalizeDimension } from './core/memory'
import { ReflexEngine, type ReflexEngineOptions } from './reflexes'

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
}

export function createPlugin (opts: SurvivalOptions = {}): (bot: Bot) => void {
  const options: Required<SurvivalOptions> = { loadPathfinder: true, reflexes: true, ...opts }
  return function (bot: Bot): void {
    if (options.loadPathfinder && bot.pathfinder == null) bot.loadPlugin(createPathfinder())
    const tasks = new TaskRunner(bot)
    const memory = new WorldMemory()
    const reflexes = options.reflexes === false ? null : new ReflexEngine(bot, { sink: tasks, ...(options.reflexes === true ? {} : options.reflexes) })
    bot.survival = { options, tasks, memory, reflexes }
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
