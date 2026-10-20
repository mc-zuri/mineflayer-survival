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

/** misses in a row (each within GIVE_UP_TICKS of the last) after which a source is given up on for GIVE_UP_TICKS */
export const GIVE_UP_MISSES = 2
/** how long a source missed GIVE_UP_MISSES times is given up on (a day) */
export const GIVE_UP_TICKS = 24000
/** how many times the source's estimate one given up on costs: the last resort, when nothing else is to be had */
export const GIVE_UP_FACTOR = 64

/** the blocks whose sighting the plans count on: the food that grows on the surface (the rest go by the memory) */
export const SIGHTED_BLOCKS = ['sweet_berry_bush', 'melon', 'carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block', 'kelp', 'kelp_plant']

export class Sightings {
  /** the tick a name was last looked for and not found, and the misses in a row */
  private readonly missed = new Map<string, { at: number, misses: number }>()

  /**
   * @param now the tick count (the task runner's)
   * @param outOfTheWay animals a hunt from where the bot is passes over (down a ravine, in a cave)
   */
  constructor (private readonly bot: Bot, private readonly now: () => number, private readonly outOfTheWay: (pos: Vec3) => boolean = () => false) {}

  /** the names a step looked for and didn't find */
  missing (names: readonly string[]): void {
    const now = this.now()
    for (const n of names) {
      const last = this.missed.get(n)
      const misses = last != null && now - last.at < GIVE_UP_TICKS ? last.misses + 1 : 1
      this.missed.set(n, { at: now, misses })
    }
  }

  /** whether a name was looked for and not found within SCARCE_TICKS */
  isScarce (name: string): boolean {
    const last = this.missed.get(name)
    return last != null && (this.now() - last.at < SCARCE_TICKS || this.givenUp(name))
  }

  /**
   * whether a name was looked for and not found GIVE_UP_MISSES times in a row, the last within GIVE_UP_TICKS: the
   * plans take it as the last resort for a day. Seed 2's nether kit explored for melons twice and for berry bushes in
   * between, 30000 ticks for none, with a wheat farm and animals by the base (full-26.3-fresh-l)
   */
  givenUp (name: string): boolean {
    const last = this.missed.get(name)
    return last != null && last.misses >= GIVE_UP_MISSES && this.now() - last.at < GIVE_UP_TICKS
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
    if (this.givenUp(t.name)) return t.find * GIVE_UP_FACTOR
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
