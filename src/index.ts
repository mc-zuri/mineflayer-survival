import type { Bot } from 'mineflayer'
import { createPlugin as createPathfinder } from '@nxg-org/mineflayer-pathfinder'

export interface SurvivalOptions {
  /** load the pathfinder if the bot doesn't have it yet (default true) */
  loadPathfinder?: boolean
}

export interface Survival {
  options: Required<SurvivalOptions>
}

export function createPlugin (opts: SurvivalOptions = {}) {
  const options: Required<SurvivalOptions> = { loadPathfinder: true, ...opts }
  return function (bot: Bot): void {
    if (options.loadPathfinder && bot.pathfinder == null) bot.loadPlugin(createPathfinder())
    bot.survival = { options }
  }
}

declare module 'mineflayer' {
  interface Bot {
    survival: Survival
  }
}
