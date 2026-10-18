// The bot's hands, as vanilla's player uses them: a dig breaks only the block the crosshair hits
// (Minecraft.hitResult → MultiPlayerGameMode.startDestroyBlock), so a log behind leaves has the leaves broken first,
// and a dig through mineflayer-mouse when it is loaded (its own packets and the client's animations). mineflayer's
// bot.dig alone digs any block in reach, through whatever is in front of it.
import type { Bot } from 'mineflayer'
import type { Block } from '../skills/util'
import { digInSight } from '@nxg-org/mineflayer-pathfinder'

export interface DigOptions {
  signal?: AbortSignal
  /** whether a block in the crosshair's way may be broken first (default: any that breaks but a fluid or the floor) */
  digObstruction?: (block: Block) => boolean
}

/** digs the block through the crosshair (digInSight); resolves when it is gone */
export async function dig (bot: Bot, block: Block, options: DigOptions = {}): Promise<void> {
  await digInSight(bot, block as any, { signal: options.signal, digObstruction: options.digObstruction as any })
}
