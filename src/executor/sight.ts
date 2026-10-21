// What the bot sees about it, for the planner's find costs (ObtainOptions.findCost): an animal in sight is a walk away,
// not the source's estimate for one somewhere; a berry bush or crop in the loaded chunks the same; and what a step
// looked for and didn't find (no cow in a snowy taiga) is dear for a while, so the next plan goes for another source.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import { isGrown } from '../core/crops'
import { normalizeDimension } from '../core/memory'
import type { FindTarget } from '../planner/obtain'
import { WALK_TICKS_PER_BLOCK } from '../planner/sources'
import { dayPhase } from '../planner/schedule'
import { nearestOfType } from '../skills/hunt'
import { findNear } from './explore'
import { fishableWaterNear } from '../skills/fish'

/** how far an animal or block counts as in sight */
export const SIGHT_RADIUS = 64

/** how long a block or mob looked for and not found stays dear (half a day) */
export const SCARCE_TICKS = 12000

/**
 * how many times the source's estimate one not found costs (16: an exploration that found none walked some 20000
 * ticks; at 8 a missed hunt, 3200, was still cheaper than a village's crops, and was walked again)
 */
export const SCARCE_FACTOR = 16

/** misses in a row (each within GIVE_UP_TICKS of the last) after which a source is given up on for GIVE_UP_TICKS */
export const GIVE_UP_MISSES = 2
/** misses count as in a row when each is within this of the last (three days: a hunt's tries were a day apart and more) */
export const MISS_STREAK_TICKS = 72000
/** the sources of one biome only (RARE_FIND; the sea's kelp, KELP_BLOCKS): given up on at their first miss */
export const RARE_SOURCES = ['melon', 'sweet_berry_bush', 'kelp', 'kelp_plant']

/** how long a source missed GIVE_UP_MISSES times is given up on (a day) */
export const GIVE_UP_TICKS = 24000
/** how many times the source's estimate one given up on costs: the last resort, when nothing else is to be had */
export const GIVE_UP_FACTOR = 64

/** the animals the sightings watch for (Sightings.look): the meat animals */
export const WATCHED_MOBS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit']

/**
 * the fish the hunt kills in the water (MOB_SOURCES' cod and salmon, a river's or the sea's): none is had where no water
 * is, so the water's miss is theirs and theirs the water's. A 26.3 bot on a snowy mountain with no water in its 96
 * blocks, every land food given up, planned 'kill 7 salmon' and explored the mountain for them (full-26.3-s31337-h,
 * t221841)
 */
export const WATER_MOBS = ['cod', 'salmon']

/** the crops and hay of a village's farms (BLOCK_SOURCES' 5000 to find: a village somewhere) */
export const VILLAGE_CROPS = ['carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block']
/** how far off a village noted counts as near for its crops */
export const VILLAGE_RANGE = 512
/**
 * how many times dearer a village's crops are with no village noted within VILLAGE_RANGE: crops and hay grow wild in a
 * village's farms only, so with none known they're the last resort (GIVE_UP_FACTOR's): a 26.3 bot on seed 31337's peaks,
 * the cows not near, planned 'mine 14 carrot' and explored 96 blocks for a village's carrots twice, 9000 ticks at food 0
 * to 6 (full-26.3-s31337-h, t115742 and t126906), and at the taiga after its trip there 8000 ticks more (hunt2-f,
 * t206766); a 1.21.11 bot in a pine taiga with no village planned 'mine 9 wheat' and explored for it 6000 ticks, its own
 * farm growing by home (f5-1.21.11 resumed from its base, t146449 to t152231)
 */
export const NO_VILLAGE_FACTOR = 64

/**
 * the sea's kelp (BLOCK_SOURCES' 1000 to find: the sea near), had only where an ocean that grows it is (foodLand's
 * KELP_BIOMES), and in the water: as dear as the water once none was found
 */
export const KELP_BLOCKS = ['kelp', 'kelp_plant']
/**
 * how far off an ocean that grows kelp (or kelp remembered) counts as near: the exploring's 96 blocks about home
 * (HUNT_EXPLORE_RADIUS) and the 48 it sees from there
 */
export const OCEAN_RANGE = 144
/**
 * how many times dearer kelp is with no such ocean known within OCEAN_RANGE (a sea somewhere: as dear as RARE_FIND's
 * melons): a 1.21.11 bot on a snowy spruce land with no sea about, its animals not near, planned 'mine 10 kelp' for
 * its food restock and explored 166 blocks for it from t157268 to t186669, the enchanting held up (rt-1)
 */
export const NO_OCEAN_FACTOR = 16

/** the blocks whose sighting the plans count on: the food that grows on the surface (the rest go by the memory) */
export const SIGHTED_BLOCKS = ['sweet_berry_bush', 'melon', 'carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block', 'kelp', 'kelp_plant']

/**
 * how long an animal a kill step found none of within its search radius (while another meat animal was there) stays
 * dear: the plan made again goes for the one in sight, its meat and cooking named (a 26.3 bot's 'kill 3 cow for 5
 * beef' hunted the rabbits of a snowy mountain 'for beef 0 / 5', full-26.3-s31337-e)
 */
export const NOT_NEAR_TICKS = 6000

/**
 * The monsters that spawn in the dark only (Monster.checkMonsterSpawnRules, isDarkEnoughToSpawn: block light 0, sky
 * light under the night's): on the surface at night, in the caves; a hunt for one by day walks the surface for none. A
 * 26.3 bot's string for the bow and for a bed's wool hunted spiders by day, 'exploring for a spider' from t106025 to its
 * NOT_FOUND at t114736, and from t28925 on (f3-run1, f3-26.3)
 */
export const NIGHT_MOBS = ['spider', 'zombie', 'skeleton', 'creeper', 'enderman', 'witch']
/** how many times dearer a night monster not in sight is by day in the overworld, with no spawner of it near */
export const DAY_MONSTER_FACTOR = 16
/**
 * how many times dearer a land animal is with none of its biomes surveyed or read from the seed near (MOB_BIOMES): the
 * land about known (MIN_SURVEYED chunks) and none of them in it
 */
export const NO_LAND_FACTOR = 16

/** what the executor knows of a mob's land: a spawner of it noted near, whether its biomes are about (null: not known) */
export interface MobLand {
  spawner?: boolean
  land?: boolean | null
}

export class Sightings {
  /** the tick a name was last looked for and not found, and the misses in a row */
  private readonly missed = new Map<string, { at: number, misses: number }>()
  /** the tick a name was last not near a step that looked for it (no exploring: no miss) */
  private readonly away = new Map<string, number>()
  /** the tick each watched animal was last in sight (look) */
  private readonly lastSeen = new Map<string, number>()

  /**
   * @param now the tick count (the task runner's)
   * @param outOfTheWay animals a hunt from where the bot is passes over (down a ravine, in a cave)
   * @param spared the ids of the animals no hunt takes (the herd's breeders and calves, herdSpares)
   */
  /**
   * @param villageNear whether a village is noted within VILLAGE_RANGE (its crops and hay are the plans' to count on
   * only then)
   * @param oceanNear whether an ocean that grows kelp (or kelp remembered) is known within OCEAN_RANGE (kelp is the
   * plans' to count on only then)
   * @param mobLand a spawner of a mob noted near, and whether the biomes it spawns in are about (MobLand)
   * @param ownCrop whether a crop block is one of the bot's own farm's (its plots' crops: no wild crop in sight)
   */
  constructor (private readonly bot: Bot, private readonly now: () => number, private readonly outOfTheWay: (pos: Vec3) => boolean = () => false, private readonly spared: () => ReadonlySet<number> = () => new Set(), private readonly villageNear: () => boolean = () => true, private readonly oceanNear: () => boolean = () => true, private readonly mobLand: (mob: string) => MobLand = () => ({}), private readonly ownCrop: (pos: Vec3) => boolean = () => false) {}

  /** the names a step looked for and didn't find */
  missing (names: readonly string[]): void {
    const now = this.now()
    for (const n of names) {
      const last = this.missed.get(n)
      const misses = last != null && now - last.at < MISS_STREAK_TICKS ? last.misses + 1 : 1
      this.missed.set(n, { at: now, misses })
    }
  }

  /** the misses and the not-nears of the names forgotten: the bot is on other land (a food land, foodLand.ts) */
  forget (names: readonly string[]): void {
    for (const n of names) {
      this.missed.delete(n)
      this.away.delete(n)
    }
  }

  /** notes the watched animals in sight now (the executor's, every second): an exploring for a plant sees them too */
  look (): void {
    const bot = this.bot
    if (bot.entity == null || bot.entities == null) return
    const spared = this.spared()
    for (const name of WATCHED_MOBS) {
      if (nearestOfType(bot, [name], SIGHT_RADIUS, e => spared.has(e.id) || this.outOfTheWay(e.position)) != null) this.lastSeen.set(name, this.now())
    }
  }

  /** the watched animals not in sight since `since` (look's) */
  unseenSince (since: number): string[] {
    return WATCHED_MOBS.filter(n => (this.lastSeen.get(n) ?? -Infinity) < since)
  }

  /** the names a step found none of near it, without exploring for them */
  notNear (names: readonly string[]): void {
    for (const n of names) this.away.set(n, this.now())
  }

  /** whether a name was not near a step within NOT_NEAR_TICKS (and not seen since) */
  isNotNear (name: string): boolean {
    const at = this.away.get(name)
    return at != null && this.now() - at < NOT_NEAR_TICKS
  }

  /** the misses in a row of a name, the last within MISS_STREAK_TICKS (0 when none lately) */
  misses (name: string): number {
    const last = this.missed.get(name)
    return last != null && this.now() - last.at < MISS_STREAK_TICKS ? last.misses : 0
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
    const misses = RARE_SOURCES.includes(name) ? 1 : GIVE_UP_MISSES
    return last != null && last.misses >= misses && this.now() - last.at < GIVE_UP_TICKS
  }

  /** the find cost for the planner: in sight, a walk; not found lately (or not near a step lately), SCARCE_FACTOR times the estimate */
  cost (t: FindTarget): number | undefined {
    const bot = this.bot
    if (bot.entity == null || t.dimension !== normalizeDimension(bot.game?.dimension)) return undefined
    const seen = this.sighted(t)
    if (seen != null) {
      this.missed.delete(t.name)
      this.away.delete(t.name)
      return Math.ceil(seen * WALK_TICKS_PER_BLOCK)
    }
    // (the fish in the water, and the kelp: as dear as the water once none was found)
    const water = (t.kind === 'mob' && WATER_MOBS.includes(t.name)) || (t.kind === 'block' && KELP_BLOCKS.includes(t.name)) ? 'water' : null
    if (this.givenUp(t.name) || (water != null && this.givenUp(water))) return t.find * GIVE_UP_FACTOR
    if (this.isScarce(t.name) || this.isNotNear(t.name) || (water != null && this.isScarce(water))) return t.find * SCARCE_FACTOR
    // (a village's crops with no village noted near: a guess at one somewhere)
    if (t.kind === 'block' && VILLAGE_CROPS.includes(t.name) && !this.villageNear()) return t.find * NO_VILLAGE_FACTOR
    // (kelp with no sea that grows it known near: a guess at one somewhere)
    if (t.kind === 'block' && KELP_BLOCKS.includes(t.name) && !this.oceanNear()) return t.find * NO_OCEAN_FACTOR
    if (t.kind === 'mob') {
      const land = this.mobLand(t.name)
      // (a night monster by day: none on the surface till dusk, but by a spawner of it)
      if (NIGHT_MOBS.includes(t.name) && t.dimension === 'overworld' && dayPhase(Number(bot.time?.timeOfDay ?? 0)) === 'day' && land.spawner !== true) return t.find * DAY_MONSTER_FACTOR
      // (an animal with none of its biomes about: a guess at one somewhere)
      if (land.land === false) return t.find * NO_LAND_FACTOR
    }
    return undefined
  }

  /** the distance to the nearest one in sight, or null */
  private sighted (t: FindTarget): number | null {
    const bot = this.bot
    if (t.kind === 'mob') {
      if (bot.entities == null) return null
      // (not the herd's breeders: two penned cows in sight priced a kill a walk away, and the hunt passed them over)
      const spared = this.spared()
      const e = nearestOfType(bot, [t.name], SIGHT_RADIUS, e => spared.has(e.id) || this.outOfTheWay(e.position))
      return e == null ? null : e.position.distanceTo(bot.entity.position)
    }
    // water to fish in (the planner's fishing): open water, or ice over it to break
    if (t.name === 'water') {
      if (typeof bot.findBlocks !== 'function') return null
      const w = fishableWaterNear(bot, bot.entity.position, SIGHT_RADIUS)
      return w == null ? null : w.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position)
    }
    if (!SIGHTED_BLOCKS.includes(t.name) || typeof bot.findBlocks !== 'function') return null
    // (not the crops of the bot's own farm: its harvest is the planner's farm step, which sows them again)
    const pos = findNear(bot, [t.name], SIGHT_RADIUS, p => !isGrown(bot.blockAt(p) as any) || this.ownCrop(p))
    return pos == null ? null : pos.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position)
  }
}

/** how long a block a mine step couldn't get to is left by the steps after it (UnreachableBlocks) */
export const UNREACHABLE_TICKS = 2400

/**
 * The blocks the mine steps couldn't get to lately (collectBlock's unreachable: no path to them, or a walk that ended
 * out of reach), left by the steps after for UNREACHABLE_TICKS: they go for others, or explore. A 1.21.11 bot shut in
 * its house planned 'mine 7 oak_log' 48 times in 487 ticks, the same log 7 blocks off its target each time and 'no
 * path' each try, and the game stopped (ls-1.21.11 t103051 to t103261)
 */
export class UnreachableBlocks {
  private readonly until = new Map<string, number>()

  constructor (private readonly now: () => number, private readonly ticks = UNREACHABLE_TICKS) {}

  note (positions: readonly Vec3[], dimension: string): void {
    const now = this.now()
    if (this.until.size > 1024) for (const [k, t] of this.until) if (t <= now) this.until.delete(k)
    for (const p of positions) this.until.set(unreachableKey(p, dimension), now + this.ticks)
  }

  has (pos: Vec3, dimension: string): boolean {
    const key = unreachableKey(pos, dimension)
    const t = this.until.get(key)
    if (t == null) return false
    if (t > this.now()) return true
    this.until.delete(key)
    return false
  }
}

function unreachableKey (p: Vec3, dimension: string): string {
  return `${normalizeDimension(dimension)}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}
