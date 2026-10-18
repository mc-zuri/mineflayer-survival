// What the bot sees about it, for the planner's find costs (ObtainOptions.findCost): an animal in sight is a walk away,
// not the source's estimate for one somewhere; a berry bush or crop in the loaded chunks the same; and what a step
// looked for and didn't find (no cow in a snowy taiga) is dear for a while, so the next plan goes for another source.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import { isGrown } from '../core/crops'
import { normalizeDimension } from '../core/memory'
import type { FindTarget } from '../planner/obtain'
import { WALK_TICKS_PER_BLOCK } from '../planner/sources'
import { nearestOfType } from '../skills/hunt'
import { findNear } from './explore'

/** how far an animal or block counts as in sight */
export const SIGHT_RADIUS = 64

/** how long a block or mob looked for and not found stays dear (half a day) */
export const SCARCE_TICKS = 12000

/** how many times the source's estimate one not found costs */
export const SCARCE_FACTOR = 8

/** the blocks whose sighting the plans count on: the food that grows on the surface (the rest go by the memory) */
export const SIGHTED_BLOCKS = ['sweet_berry_bush', 'melon', 'carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block', 'kelp', 'kelp_plant']

export class Sightings {
  private readonly missed = new Map<string, number>()

  /**
   * @param now the tick count (the task runner's)
   * @param outOfTheWay animals a hunt from where the bot is passes over (down a ravine, in a cave)
   */
  constructor (private readonly bot: Bot, private readonly now: () => number, private readonly outOfTheWay: (pos: Vec3) => boolean = () => false) {}

  /** the names a step looked for and didn't find */
  missing (names: readonly string[]): void {
    for (const n of names) this.missed.set(n, this.now())
  }

  /** whether a name was looked for and not found within SCARCE_TICKS */
  isScarce (name: string): boolean {
    const at = this.missed.get(name)
    return at != null && this.now() - at < SCARCE_TICKS
  }

  /** the find cost for the planner: in sight, a walk; not found lately, SCARCE_FACTOR times the estimate */
  cost (t: FindTarget): number | undefined {
    const bot = this.bot
    if (bot.entity == null || t.dimension !== normalizeDimension(bot.game?.dimension)) return undefined
    const seen = this.sighted(t)
    if (seen != null) {
      this.missed.delete(t.name)
      return Math.ceil(seen * WALK_TICKS_PER_BLOCK)
    }
    if (this.isScarce(t.name)) return t.find * SCARCE_FACTOR
    return undefined
  }

  /** the distance to the nearest one in sight, or null */
  private sighted (t: FindTarget): number | null {
    const bot = this.bot
    if (t.kind === 'mob') {
      if (bot.entities == null) return null
      const e = nearestOfType(bot, [t.name], SIGHT_RADIUS, e => this.outOfTheWay(e.position))
      return e == null ? null : e.position.distanceTo(bot.entity.position)
    }
    if (!SIGHTED_BLOCKS.includes(t.name) || typeof bot.findBlocks !== 'function') return null
    const pos = findNear(bot, [t.name], SIGHT_RADIUS, p => !isGrown(bot.blockAt(p) as any))
    return pos == null ? null : pos.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position)
  }
}
