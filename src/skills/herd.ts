// The herd kept for food by home: two adults or more of a kind shut in a pen (pen.ts), bred with their food as the
// cooldown allows (husbandry.ts: Animal.mobInteract, BreedGoal, the parents' 6000 ticks), the adults beyond the
// BREEDERS_KEPT breeders slaughtered for their meat, the calves left to grow (a baby drops nothing:
// Mob.shouldDropLoot; it grows up in 24000 ticks, AgeableMob.BABY_START_AGE). Pure decisions over counts, the herd as
// the memory remembers it, and what the planner and the hunt take from it: the surplus as cheap meat, the breeders and
// the calves never killed.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { BREED_COOLDOWN_TICKS, BREEDING_FOOD, isAdult } from './husbandry'
import { inPen, penFromMemory, type PenPlan } from './pen'
import { type Entity, isAlive } from './combatUtil'
import { countItems } from './util'

/** the point of interest where the bot's herd lives (its pen's middle, or where it was let out of eggs) */
export const HERD = 'herd'

/** adults of the herd never killed: the pair it is bred on */
export const BREEDERS_KEPT = 2

/** the kinds a herd is started with, the first with two adults near and its food held: cows, else sheep, else pigs */
export const HERD_MOBS = ['cow', 'sheep', 'pig'] as const

/** AgeableMob.BABY_START_AGE: a baby grows up in 24000 ticks */
export const GROW_UP_TICKS = 24000

/** the raw meat each kept animal drops (the loot tables: a cow 1 to 3 beef, a pig 1 to 3 porkchops, a sheep 1 to 2 mutton) */
export const MEAT_OF: Readonly<Record<string, string>> = { cow: 'beef', mooshroom: 'beef', pig: 'porkchop', sheep: 'mutton' }

/** the cooked food points one kill is expected to give: 2 beef or porkchops at 8, 1.5 mutton at 6 (Foods) */
export const POINTS_PER_KILL: Readonly<Record<string, number>> = { cow: 16, mooshroom: 16, pig: 16, sheep: 9 }

/** how far from a herd without a pen its animals are counted as the herd's */
export const LOOSE_HERD_RANGE = 16

/** how near the herd the bot must be for its animals to be tracked (counted live, not as remembered) */
export const HERD_SEEN_RANGE = 48

/** the herd as remembered: where it lives, its kind, its counts when last seen, the world age it was last bred at */
export interface Herd {
  pos: Vec3
  mob: string
  adults: number
  calves: number
  /** the world age (bot.time.age) of the last breeding, null when none is known */
  bred: number | null
}

/** the herd nearest `near` as remembered (the HERD point of interest; an egg herd's note is its kind alone), or null */
export function herdFromMemory (memory: WorldMemory, near?: Vec3): Herd | null {
  const poi = memory.getPois(HERD, { dimension: 'overworld', near })[0]
  if (poi == null) return null
  const pos = new Vec3(poi.x, poi.y, poi.z)
  try {
    const n = JSON.parse(poi.note ?? '')
    if (n != null && typeof n === 'object' && typeof n.mob === 'string') {
      return { pos, mob: n.mob, adults: Number(n.adults ?? 0), calves: Number(n.calves ?? 0), bred: typeof n.bred === 'number' ? n.bred : null }
    }
  } catch {}
  return { pos, mob: poi.note != null && poi.note !== '' ? poi.note : 'cow', adults: 0, calves: 0, bred: null }
}

/** remembers the herd (herdFromMemory), moved from `from` when it lived there before (the eggs' spot, now its pen) */
export function rememberHerd (memory: WorldMemory, herd: Herd, from?: Vec3): void {
  if (from != null && !from.floored().equals(herd.pos.floored())) memory.removePoi(HERD, from.floored(), 'overworld')
  memory.addPoi(HERD, herd.pos.floored(), 'overworld', JSON.stringify({ mob: herd.mob, adults: herd.adults, calves: herd.calves, bred: herd.bred }))
}

/** the herd's pen (remembered by its middle), null for a loose herd */
export function herdPenOf (memory: WorldMemory, herd: Herd): PenPlan | null {
  return penFromMemory(memory, herd.pos, 4)
}

/** whether an animal is one of the herd's: of its kind, in its pen (or near where a loose herd lives) */
export function inHerd (herd: Pick<Herd, 'pos' | 'mob'>, pen: Pick<PenPlan, 'center' | 'size'> | null, e: { name?: string, position: Vec3 }): boolean {
  if (e.name !== herd.mob) return false
  return pen != null ? inPen(pen, e.position) : Math.hypot(e.position.x - herd.pos.x, e.position.z - herd.pos.z) <= LOOSE_HERD_RANGE
}

/** the herd's adults beyond the breeders */
export function herdSurplus (adults: number, keep = BREEDERS_KEPT): number {
  return Math.max(0, adults - keep)
}

/**
 * The herd's animals a kill may not take: every calf (it drops nothing, and it's the herd's next adult), and every
 * adult while the herd has `keep` or fewer (the last two are bred on, never killed)
 */
export function breedersToSpare (animals: ReadonlyArray<{ id: number, adult: boolean }>, keep = BREEDERS_KEPT): Set<number> {
  const adults = animals.filter(a => a.adult).length
  return new Set(animals.filter(a => !a.adult || adults <= keep).map(a => a.id))
}

/** the adults to slaughter: `count` of the surplus at most (the adults beyond `keep`), never a calf */
export function slaughterPick (animals: ReadonlyArray<{ id: number, adult: boolean }>, count: number, keep = BREEDERS_KEPT): number[] {
  const adults = animals.filter(a => a.adult)
  return adults.slice(0, Math.max(0, Math.min(count, adults.length - keep))).map(a => a.id)
}

/** the animals a pen of `size` across holds before the surplus is slaughtered whatever the food (a quarter of its inside cells, 4 at least) */
export function herdCap (size: number): number {
  return Math.max(4, Math.floor((size - 2) ** 2 / 4))
}

export interface HerdChoreState {
  adults: number
  calves: number
  /** the breeding food held (two a pair) */
  food: number
  /** the most the pen holds (herdCap) */
  cap: number
  /** ticks since the herd was last bred, null for never */
  sinceBred: number | null
  /** food points wanted (the stock short of its mark, a trip's food): the surplus slaughtered for them */
  want: number
  /** the cooked points a kill gives (POINTS_PER_KILL) */
  perKill: number
  keep?: number
}

/**
 * The herd's chores now: the pairs to breed (the cooldown over since the last breeding, two of the food a pair, room
 * in the pen for the calves once the slaughter is done) and the surplus adults to slaughter (as many as the food
 * wanted takes, or the pen's overflow; never the breeders, never a calf). The breeding goes first: the surplus is
 * bred too before it's killed (the calves come all the same, BreedGoal).
 */
export function herdChores (s: HerdChoreState): { breed: number, slaughter: number } {
  const keep = s.keep ?? BREEDERS_KEPT
  const surplus = herdSurplus(s.adults, keep)
  const over = Math.max(0, s.adults + s.calves - s.cap)
  const forFood = s.want > 0 && s.perKill > 0 ? Math.ceil(s.want / s.perKill) : 0
  const slaughter = Math.min(surplus, Math.max(over, forFood))
  const ready = s.sinceBred == null || s.sinceBred >= BREED_COOLDOWN_TICKS
  const room = s.cap - (s.adults - slaughter + s.calves)
  const breed = ready && s.adults >= 2 ? Math.max(0, Math.min(Math.floor(s.adults / 2), Math.floor(s.food / 2), room)) : 0
  return { breed, slaughter }
}

/** the herd's animals as tracked now: its adults and its calves, null when the bot is too far off to see them */
export function herdCensus (bot: Bot, herd: Herd, pen: PenPlan | null): { adults: Entity[], calves: Entity[] } | null {
  if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return null
  if (Math.hypot(bot.entity.position.x - herd.pos.x, bot.entity.position.z - herd.pos.z) > HERD_SEEN_RANGE) return null
  const all = Object.values(bot.entities ?? {}).filter(e => e !== bot.entity && inHerd(herd, pen, e) && isAlive(bot, e))
  return { adults: all.filter(e => isAdult(bot, e)), calves: all.filter(e => !isAdult(bot, e)) }
}

/**
 * The ids of the herd's animals no kill takes (breedersToSpare over the herd as tracked now): none when there's no
 * herd or it isn't in sight
 */
export function herdSpares (bot: Bot, memory: WorldMemory): Set<number> {
  const herd = herdFromMemory(memory, bot.entity?.position)
  if (herd == null) return new Set()
  const census = herdCensus(bot, herd, herdPenOf(memory, herd))
  if (census == null) return new Set()
  return breedersToSpare([...census.adults.map(e => ({ id: e.id, adult: true })), ...census.calves.map(e => ({ id: e.id, adult: false }))])
}

/** what the herd gives a plan's kills of its kind (ObtainOptions.herd) */
export interface HerdSupply {
  /** adults beyond the breeders, to kill now */
  surplus: number
  /** calves that will be surplus adults once grown */
  growing: number
  /** ticks till they are */
  growTicks: number
  /** the walk to the herd, in blocks */
  distance: number
}

/**
 * The herd's supply of its kind for the planner: its surplus adults and its calves to grow, as tracked now or as
 * last remembered (the herd out of sight), and the walk there; undefined for another kind or no herd
 */
export function herdSupply (bot: Bot, memory: WorldMemory, mob: string, now: number): HerdSupply | undefined {
  if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return undefined
  const herd = herdFromMemory(memory, bot.entity.position)
  if (herd == null || herd.mob !== mob) return undefined
  const census = herdCensus(bot, herd, herdPenOf(memory, herd))
  const adults = census?.adults.length ?? herd.adults
  const calves = census?.calves.length ?? herd.calves
  const surplus = herdSurplus(adults)
  const growing = herdSurplus(adults + calves) - surplus
  if (surplus + growing === 0) return undefined
  // (the calves of the last breeding the latest to grow; with none known, half the growing)
  const growTicks = herd.bred != null ? Math.max(0, herd.bred + GROW_UP_TICKS - now) : GROW_UP_TICKS / 2
  return { surplus, growing, growTicks, distance: bot.entity.position.distanceTo(herd.pos) }
}

/** the herd's kind to start with among the animals near: the first of HERD_MOBS with two adults near and its food held */
export function chooseHerdMob (adultsNear: Readonly<Record<string, number>>, hasFood: (mob: string) => boolean): string | null {
  return HERD_MOBS.find(m => (adultsNear[m] ?? 0) >= 2 && hasFood(m)) ?? null
}

/** whether the bot holds the food a kind is led and bred with */
export function holdsBreedingFood (bot: Bot, mob: string): boolean {
  return (BREEDING_FOOD[mob] ?? []).some(f => countItems(bot, f) > 0)
}

/** the breeding food the bot holds for a kind */
export function breedingFoodHeld (bot: Bot, mob: string): number {
  return (BREEDING_FOOD[mob] ?? []).reduce((n, f) => n + countItems(bot, f), 0)
}

/** the herd's counts as seen now remembered (for the plans made out of its sight); the census, null out of sight */
export function noteHerd (bot: Bot, memory: WorldMemory, herd: Herd): { adults: Entity[], calves: Entity[] } | null {
  const census = herdCensus(bot, herd, herdPenOf(memory, herd))
  if (census != null) rememberHerd(memory, { ...herd, adults: census.adults.length, calves: census.calves.length })
  return census
}
