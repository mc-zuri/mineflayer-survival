import type { Bot } from 'mineflayer'
import { createPlugin as createPathfinder } from '@nxg-org/mineflayer-pathfinder'
import { TaskRunner } from './core/taskRunner'
import { WorldMemory, normalizeDimension } from './core/memory'

export * from './core'
export * from './planner'

export * as base from './base'

export interface SurvivalOptions {
  /** load the pathfinder if the bot doesn't have it yet (default true) */
  loadPathfinder?: boolean
}

export interface Survival {
  options: Required<SurvivalOptions>
  /** the foreground task queue; reflexes preempt the running task */
  tasks: TaskRunner
  /** what the bot has seen of the world */
  memory: WorldMemory
}

export function createPlugin (opts: SurvivalOptions = {}): (bot: Bot) => void {
  const options: Required<SurvivalOptions> = { loadPathfinder: true, ...opts }
  return function (bot: Bot): void {
    if (options.loadPathfinder && bot.pathfinder == null) bot.loadPlugin(createPathfinder())
    const tasks = new TaskRunner(bot)
    const memory = new WorldMemory()
    bot.survival = { options, tasks, memory }
    bot.on('physicsTick', () => { memory.now = tasks.tick })
    bot.on('death', () => {
      // the running and queued tasks can't go on; the death spot is where the items are
      if (bot.entity != null) memory.setDeath(bot.entity.position, normalizeDimension(bot.game?.dimension))
      tasks.cancelAll('DIED', 'the bot died')
    })
    bot.once('end', () => tasks.destroy())
  }
}

declare module 'mineflayer' {
  interface Bot {
    survival: Survival
  }
}
