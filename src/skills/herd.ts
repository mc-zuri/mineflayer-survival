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

/**
 * adults of the herd never killed: a kill comes from a herd of 4 or more, the 3 kept breeding a pair while the third
 * stands in for a breeder lost (a cow out by the gate, a creeper's blast, a kill that took the wrong one): a herd of
 * two that lost one was a herd no more
 */
export const BREEDERS_KEPT = 3

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
 * adult while the herd has `keep` or fewer (the last BREEDERS_KEPT are bred on, never killed)
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

/**
 * the wild adults of a herd's kinds seen, noted in the memory by chunk (a point of interest at their middle, the note
 * their kind and count): where a herd is started from when none live near home (Animal: a farm animal never despawns,
 * Animal.removeWhenFarAway, and wanders, so a group seen stays about where it was)
 */
export const ANIMALS_POI = 'animals'
/** how far about the bot its wild animals are noted (noteAnimals), the chunks of none forgotten */
export const ANIMALS_SIGHT = 48
/** how long a group of animals noted counts (three days: they may be hunted or wander off) */
export const ANIMALS_TTL = 72000

export interface AnimalGroup {
  pos: Vec3
  mob: string
  adults: number
  /** the memory's tick it was noted at */
  seen: number
}

function chunkKey (p: { x: number, z: number }): string {
  return `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`
}

function readGroup (poi: { x: number, y: number, z: number, note?: string, seen: number }): AnimalGroup | null {
  try {
    const n = JSON.parse(poi.note ?? '')
    if (typeof n?.mob === 'string') return { pos: new Vec3(poi.x, poi.y, poi.z), mob: n.mob, adults: Number(n.adults ?? 0), seen: poi.seen }
  } catch {}
  return null
}

/**
 * The wild adults of HERD_MOBS within ANIMALS_SIGHT of the bot noted by chunk (ANIMALS_POI), the herd's own (`spared`,
 * herdSpares, and those in its pen) not; the groups noted before in the chunks in sight with none of their kind now
 * forgotten. Resolves the groups noted.
 */
export function noteAnimals (bot: Bot, memory: WorldMemory, spared: ReadonlySet<number> = new Set()): number {
  if (bot.entity == null || normalizeDimension(bot.game?.dimension) !== 'overworld') return 0
  const at = bot.entity.position
  const herd = herdFromMemory(memory)
  const pen = herd != null ? herdPenOf(memory, herd) : null
  const groups = new Map<string, { mob: string, sum: Vec3, n: number }>()
  for (const e of Object.values(bot.entities ?? {})) {
    if (e === bot.entity || e.name == null || !(HERD_MOBS as readonly string[]).includes(e.name)) continue
    if (e.position.distanceTo(at) > ANIMALS_SIGHT || spared.has(e.id) || !isAdult(bot, e) || !isAlive(bot, e)) continue
    if (herd != null && inHerd(herd, pen, e)) continue
    const k = `${e.name}@${chunkKey(e.position)}`
    const g = groups.get(k) ?? { mob: e.name, sum: new Vec3(0, 0, 0), n: 0 }
    g.sum = g.sum.plus(e.position)
    g.n++
    groups.set(k, g)
  }
  // (the chunks in sight: their old groups are as seen now, or gone)
  for (const poi of memory.getPois(ANIMALS_POI, { dimension: 'overworld' })) {
    if (Math.hypot(poi.x - at.x, poi.z - at.z) > ANIMALS_SIGHT - 8) continue
    const g = readGroup(poi)
    if (g == null || !groups.has(`${g.mob}@${chunkKey(poi)}`)) memory.removePoi(ANIMALS_POI, poi, 'overworld')
  }
  for (const [k, g] of groups) {
    for (const poi of memory.getPois(ANIMALS_POI, { dimension: 'overworld' })) {
      if (`${readGroup(poi)?.mob ?? ''}@${chunkKey(poi)}` === k) memory.removePoi(ANIMALS_POI, poi, 'overworld')
    }
    memory.addPoi(ANIMALS_POI, g.sum.scaled(1 / g.n).floored(), 'overworld', JSON.stringify({ mob: g.mob, adults: g.n }))
  }
  return groups.size
}

/**
 * The groups of wild animals noted (noteAnimals) within `range` of `near`, seen within ANIMALS_TTL of `now` (the
 * memory's tick), of `mobs`, `least` adults of a kind at the least (the groups of a kind within 16 of each other
 * counted together: a herd of two straddling a chunk's edge), the nearest `near` first
 */
export function rememberedAnimals (memory: WorldMemory, near: Vec3, range: number, now: number, mobs: readonly string[] = HERD_MOBS, least = 2): AnimalGroup[] {
  const all = memory.getPois(ANIMALS_POI, { dimension: 'overworld' })
    .map(readGroup)
    .filter((g): g is AnimalGroup => g != null && mobs.includes(g.mob) && now - g.seen <= ANIMALS_TTL && Math.hypot(g.pos.x - near.x, g.pos.z - near.z) <= range)
  return all
    .map(g => ({ ...g, adults: all.filter(o => o.mob === g.mob && o.pos.distanceTo(g.pos) <= 16).reduce((n, o) => n + o.adults, 0) }))
    .filter(g => g.adults >= least)
    .sort((a, b) => a.pos.distanceTo(near) - b.pos.distanceTo(near))
}
