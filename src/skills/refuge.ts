// refuge: safe first after a respawn with nothing (the death's bag left where it fell), at night or with hostiles
// about, the kit after: in behind the base's shut door, up a pillar out of the zombies' reach, down a hole sealed over
// the head, or a run from them toward the base. A 1.21.11 bot killed at night respawned bare by its base, a zombie
// there already, went for its base's chest, fought the zombie with its fists and died 750 ticks after the respawn
// (full-1.21.11-fresh-m, t133686 to t134432); the death's chain went on down a night's mine bare.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { hasLineOfSight, isAlive, type Entity } from './combatUtil'
import { armorPoints, botIsBrightOutside, defaultDigCost, findShelterSpot, isEnclosed, leaveAtDay, shelter, shelterRefusals, sleepThroughNight } from './shelter'
import { placeRefused, refusedGroundNear } from './spawnProtection'
import { bestMeleeWeapon } from './weapons'
import { doorOpen, isHandDoor, shutDoor } from './indoors'
import { collectBlock } from './collectBlock'
import { bestFoodInInventory, eat } from './eat'
import { fleeFrom } from './escape'
import { trace, waitTicks } from './util'
import { placeBlock } from './placeBlock'
import type { BlockLookup } from './placement'
import { SCAFFOLD_ITEMS, countItems, digDown, towerUp } from '../end/skills/world'
import { blockIdsNamed, findBlock, findBlocks } from '../core/findBlocks'
import { isBed } from '../core/items'
import type { BaseRecord } from '../base/pois'
import type { Pos } from '../core/memory'

/** what the bot does first after a respawn: in behind the base's door, the bed, a pillar, a hole, or a run */
export type Refuge = 'base' | 'sleep' | 'pillar' | 'hole' | 'flee'

/** hostiles within this many blocks make a respawn one to get safe from first, by day too */
export const REFUGE_THREAT_RANGE = 16
/** the base's door within this many blocks is gone in behind */
export const REFUGE_BASE_RANGE = 48
/**
 * the base's door is got to first when the bot's no further from it than this many times the nearest threat is: its
 * sprint (some 5.6 blocks a second) against a zombie's walk (some 2.3), the door's opening and shutting and a path's
 * bends between; a threat by the door (between the bot and it) is nearer it than the bot
 */
export const REFUGE_BASE_LEAD = 1.2
/** a pillar's height: the feet 3 over the ground, out of the reach of a mob's attack box (a zombie's is 1.95 high, Mob.getAttackBoundingBox inflated across only) */
export const PILLAR_HEIGHT = 3
/** the nearest threat this far off at least to climb a pillar of the blocks at hand (a jump and a block a step) */
export const PILLAR_CLEAR = 2
/** ...and to punch the dirt for one first (by hand some 15 ticks a block, 3 of them, then the climb) */
export const PUNCH_CLEAR = 10
/** the nearest threat this far off at least to dig a hole in (3 blocks by hand and the seal, some 60 ticks: a zombie's walk of 7) */
export const HOLE_CLEAR = 8
/** by day a pillar only for a threat this near (the undead burn in the sun: one further off is run from) */
export const PILLAR_DAY_RANGE = 8
/** the choices one respawn makes at most */
export const REFUGE_TRIES = 8
/** ticks a pillar is held at most (a night and then some) */
export const PILLAR_MAX_TICKS = 14000
/** soft ground a hand punches out for a pillar's blocks (they drop dirt: Blocks.GRASS_BLOCK's loot) */
export const PUNCH_GROUND = ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'moss_block']

/**
 * The mobs a pillar PILLAR_HEIGHT high is safe from: they walk up and hit, and neither climb (a spider), shoot (a
 * skeleton, a drowned's trident), fly, nor blow the pillar up (a creeper)
 */
export const PILLAR_SAFE_FROM = new Set(['zombie', 'husk', 'zombie_villager', 'vindicator', 'piglin_brute', 'zombified_piglin', 'silverfish', 'endermite'])

/** the neutral mobs that are no threat till provoked (the hostiles reflex's ignore list) */
const NO_THREAT = new Set(['enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'ender_dragon', 'wither', 'warden', 'shulker', 'ghast', 'happy_ghast'])
/** attack a player on sight but aren't typed 'hostile' by minecraft-data (the reflexes' HOSTILE_UNTYPED) */
const UNTYPED_HOSTILE = new Set(['slime', 'magma_cube', 'phantom', 'hoglin'])

export interface RefugeSituation {
  /** dark outside, in the overworld (the undead walk) */
  night: boolean
  /** the hostiles within REFUGE_THREAT_RANGE, with how far off each is */
  threats: Array<{ name: string, distance: number }>
  /** a melee weapon and some armor at hand: the reflexes fight, no refuge wanted */
  armed: boolean
  /** behind the base's shut door, or shut in a hole (isEnclosed) */
  sheltered: boolean
  /** the base's door within reach: the bot's way to the cell behind it, and the nearest threat's */
  base: { distance: number, threatDistance: number } | null
  /** a bed within reach to sleep the night through */
  bed: boolean
  /** blocks carried to pillar with (SCAFFOLD_ITEMS) */
  pillarBlocks: number
  /** soft ground about to punch out the pillar's blocks from */
  dirtNear: boolean
  /** ground about to dig a hole in (findShelterSpot) */
  hole: boolean
  /** the refuges that failed this respawn */
  failed: ReadonlySet<Refuge>
}

/**
 * What a respawn does first: nothing when it's armed, sheltered already, or it's day with nothing about. Else in
 * order: in behind the base's door, when the bot gets there before the threats (REFUGE_BASE_LEAD: its sprint against
 * their walk); the bed, at night
 * with nothing about; up a pillar of the blocks at hand or of punched dirt, when every threat is a melee one it's safe
 * from (PILLAR_SAFE_FROM) and none too near to climb (PILLAR_CLEAR, PUNCH_CLEAR), by day only for one within
 * PILLAR_DAY_RANGE; at night a hole sealed over the head (the night's shelter) with none within HOLE_CLEAR; else a run
 * from them. Null when nothing's left to do (the reflexes then: a bare bot cornered fights).
 */
export function chooseRefuge (s: RefugeSituation): Refuge | null {
  if (s.armed || s.sheltered) return null
  if (!s.night && s.threats.length === 0) return null
  const ok = (r: Refuge): boolean => !s.failed.has(r)
  const nearest = Math.min(Infinity, ...s.threats.map(t => t.distance))
  if (ok('base') && s.base != null && (s.base.distance <= 2 || s.base.distance < s.base.threatDistance * REFUGE_BASE_LEAD)) return 'base'
  if (ok('sleep') && s.night && s.bed && s.threats.length === 0) return 'sleep'
  const melee = s.threats.length > 0 && s.threats.every(t => PILLAR_SAFE_FROM.has(t.name))
  const climb = (s.pillarBlocks >= PILLAR_HEIGHT && nearest >= PILLAR_CLEAR) || (s.dirtNear && nearest >= PUNCH_CLEAR)
  if (ok('pillar') && melee && (s.night || nearest <= PILLAR_DAY_RANGE) && climb) return 'pillar'
  if (ok('hole') && s.night && s.hole && nearest >= HOLE_CLEAR) return 'hole'
  if (ok('flee') && s.threats.length > 0) return 'flee'
  return null
}

/** the threats of a refuge: the living hostiles (not the neutral ones) within `range` of the bot, nearest first */
export function refugeThreats (bot: Bot, range = REFUGE_THREAT_RANGE): Entity[] {
  const pos = bot.entity.position
  return Object.values(bot.entities ?? {})
    .filter(e => e !== bot.entity && e.name != null && !NO_THREAT.has(e.name) &&
      ((bot.registry.entitiesByName as any)[e.name]?.type === 'hostile' || UNTYPED_HOSTILE.has(e.name)) &&
      isAlive(bot, e) && e.position.distanceTo(pos) <= range)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
}

export interface BaseDoor {
  /** the door's lower half */
  door: Vec3
  /** the cell behind it, in the base's box */
  inside: Vec3
  /** the cell before it */
  outside: Vec3
}

type Bounds = NonNullable<BaseRecord['bounds']>

/** the world's blocks to search (a loaded world, or the bot's own search) */
function searchable (bot: Bot): boolean {
  return typeof (bot.world as any)?.getColumn === 'function' || typeof bot.findBlocks === 'function'
}

/** a cell within the base's box (baseRecord's bounds: the max corner left out) */
export function inBounds (p: Pos, b: Bounds): boolean {
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  const z = Math.floor(p.z)
  return x >= b.min.x && y >= b.min.y && z >= b.min.z && x < b.max.x && y < b.max.y && z < b.max.z
}

const FACINGS: Record<string, Vec3> = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0) }

const standable = (lookup: BlockLookup, feet: Vec3): boolean => {
  const floor = lookup(feet.offset(0, -1, 0))
  const a = lookup(feet)
  const b = lookup(feet.offset(0, 1, 0))
  return floor?.boundingBox === 'block' && a?.boundingBox === 'empty' && b?.boundingBox === 'empty' &&
    !/water|lava|fire/.test(a.name) && !/water|lava|fire/.test(b.name)
}

/**
 * The base's door to shut itself in behind: of its doors (lower halves, with their facing: DoorBlock.FACING, the
 * panel across it), the one with a side to stand in out of the box and one in it (the airlock's outer door; the base
 * blueprint's inner one has both in it), the nearest the entrance first; null with none.
 */
export function baseDoor (lookup: BlockLookup, doors: Array<{ pos: Vec3, facing: string }>, base: { bounds: Bounds, entrance: Pos | null }): BaseDoor | null {
  let best: { refuge: BaseDoor, d: number } | null = null
  for (const { pos, facing } of doors) {
    const f = FACINGS[facing]
    if (f == null) continue
    const sides = [pos.plus(f), pos.minus(f)]
    const inside = sides.find(c => inBounds(c, base.bounds))
    const outside = sides.find(c => !inBounds(c, base.bounds))
    if (inside == null || outside == null || !standable(lookup, inside) || !standable(lookup, outside)) continue
    const d = base.entrance == null ? 0 : outside.distanceTo(new Vec3(base.entrance.x, base.entrance.y, base.entrance.z))
    if (best == null || d < best.d) best = { refuge: { door: pos, inside, outside }, d }
  }
  return best?.refuge ?? null
}

/** the base's door (baseDoor) as the world has it now, the hand doors in its box and a block about it */
export function findBaseDoor (bot: Bot, base: BaseRecord | null): BaseDoor | null {
  if (base?.bounds == null || !searchable(bot)) return null
  const { min, max } = base.bounds
  const centre = new Vec3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
  if (bot.entity.position.distanceTo(centre) > REFUGE_BASE_RANGE) return null
  const ids = blockIdsNamed(bot, isHandDoor)
  if (ids.length === 0) return null
  const reach = Math.ceil(centre.distanceTo(new Vec3(max.x, max.y, max.z))) + 2
  const doors: Array<{ pos: Vec3, facing: string }> = []
  for (const at of findBlocks(bot, { matching: ids, point: centre, maxDistance: reach, count: 16 })) {
    const props = (bot.blockAt(at) as any)?.getProperties?.() ?? {}
    if (props.half !== 'lower') continue
    // (a door in the box or on its rim: the shell's)
    if (!inBounds(at, { min: { x: min.x - 1, y: min.y - 1, z: min.z - 1 }, max: { x: max.x + 1, y: max.y + 1, z: max.z + 1 } })) continue
    doors.push({ pos: at, facing: String(props.facing) })
  }
  return baseDoor((p) => bot.blockAt(p) as any, doors, { bounds: base.bounds, entrance: base.entrance })
}

/** how near the base's entrance the bot is for its step to be put back (mendBaseStep) */
export const STEP_MEND_RANGE = 6

/**
 * The base's entrance step put back: the floor of the cell outside its outer door (the entrance's, a block over the
 * ground about a dug-in base's door) when it's no floor, a block of the bag's scaffolding (else of its planks) placed
 * there, the bot within STEP_MEND_RANGE of it. Whether one was placed. A 1.21.11 bot's walk to the base's chest dug the
 * step and the ground under it out from beside it, and the door stood over a hole two deep: the base's door no way in
 * (baseDoor: no side out of the box to stand in), and back from a death the searches for the chest timed out from
 * beside the hole for 100000 ticks (f9-1.21.11, t228597; t321486 on)
 */
export async function mendBaseStep (bot: Bot, base: BaseRecord | null, signal?: AbortSignal): Promise<boolean> {
  const e = base?.entrance
  if (e == null || typeof bot.blockAt !== 'function') return false
  const floor = new Vec3(e.x, e.y - 1, e.z)
  const block = bot.blockAt(floor)
  if (block == null || block.boundingBox === 'block' || /water|lava/.test(block.name)) return false
  if (bot.entity.position.distanceTo(floor.offset(0.5, 0.5, 0.5)) > STEP_MEND_RANGE) return false
  const item = SCAFFOLD_ITEMS.find(n => countItems(bot, [n]) > 0) ?? bot.inventory.items().find(i => i.name.endsWith('_planks'))?.name
  if (item == null) return false
  try {
    await placeBlock(bot, { pos: floor, item }, signal)
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    trace('mendBaseStep: no', item, 'at', floor.toString(), ':', (err as Error).message)
    return false
  }
}

/** the bot in the base's box with its door shut */
export function shutInBase (bot: Bot, base: BaseRecord | null, door: BaseDoor | null): boolean {
  return base?.bounds != null && door != null && inBounds(bot.entity.position, base.bounds) && !doorOpen(bot, door.door)
}

/** the situation chooseRefuge judges, as the world has it now */
export function refugeSituation (bot: Bot, opts: { base: BaseRecord | null, failed: ReadonlySet<Refuge> }): RefugeSituation {
  const lookup: BlockLookup = (p) => bot.blockAt(p) as any
  const pos = bot.entity.position
  const overworld = /overworld/.test(String(bot.game?.dimension ?? 'overworld'))
  const night = overworld && bot.time != null && !botIsBrightOutside(bot)
  const threats = refugeThreats(bot)
  const armed = bestMeleeWeapon(bot) != null && armorPoints(bot) > 0
  const search = searchable(bot)
  const door = overworld && search ? findBaseDoor(bot, opts.base) : null
  const sheltered = (typeof bot.blockAt === 'function' && isEnclosed(lookup, pos.floored())) || shutInBase(bot, opts.base, door)
  const inside = door?.inside.offset(0.5, 0, 0.5)
  const base = door == null || inside == null
    ? null
    : { distance: pos.distanceTo(inside), threatDistance: Math.min(Infinity, ...threats.map(e => e.position.distanceTo(inside))) }
  const bed = night && search && findBlock(bot, { matching: blockIdsNamed(bot, isBed), maxDistance: 16 }) != null
  // (no pillar where the server refuses its blocks: the spawn's square, a claim; skills/spawnProtection)
  const pillarRefused = placeRefused(bot, pos.floored())
  const pillarBlocks = pillarRefused ? 0 : countItems(bot, SCAFFOLD_ITEMS)
  const dirtNear = !pillarRefused && search && findBlocks(bot, { matching: blockIdsNamed(bot, n => PUNCH_GROUND.includes(n)), maxDistance: 5, count: PILLAR_HEIGHT }).length >= PILLAR_HEIGHT - pillarBlocks
  const hasPickaxe = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
  // (a column the server lets it dig, or ground it refuses about, which the shelter walks out of first)
  const hole = night && typeof bot.blockAt === 'function' &&
    (findShelterSpot(lookup, pos, { radius: 6, digCost: defaultDigCost(hasPickaxe), refusals: shelterRefusals(bot) }) != null || refusedGroundNear(bot, pos, 6))
  return {
    night,
    threats: threats.map(e => ({ name: e.name ?? '?', distance: e.position.distanceTo(pos) })),
    armed,
    sheltered,
    base,
    bed,
    pillarBlocks,
    dirtNear,
    hole,
    failed: opts.failed
  }
}

/** the situation in words, for the log: "night, 2 zombies within 16 (the nearest 4.2 off)" */
export function describeSituation (s: RefugeSituation): string {
  const kinds: Record<string, number> = {}
  for (const t of s.threats) kinds[t.name] = (kinds[t.name] ?? 0) + 1
  const list = Object.entries(kinds).map(([n, k]) => `${k} ${n}`).join(', ')
  const nearest = Math.min(Infinity, ...s.threats.map(t => t.distance))
  return `${s.night ? 'night' : 'day'}, ${s.threats.length === 0 ? 'no hostiles' : `${list} within ${REFUGE_THREAT_RANGE} (the nearest ${nearest.toFixed(1)} off)`}`
}

export interface TakeRefugeOptions {
  signal?: AbortSignal
  /** the base (its door, its way in, the way a flee leans) */
  base: BaseRecord | null
}

/**
 * Takes the refuge chosen (chooseRefuge): its own way with the threats, the hostiles reflex and the night's held
 * meanwhile (the reflex's flee off a pillar, its fight at the base's door with the fists). In the base: in behind the
 * door and shut (the kit's chests are in there). The bed: slept in, the monsters not fought. A pillar: up it, held till
 * the day (leaveAtDay) and down again; hurt up there, or a mob it isn't safe from in sight, it's given up (thrown). A
 * hole: the night's shelter. A run: from the threats, toward the base.
 */
export async function takeRefuge (bot: Bot, refuge: Refuge, opts: TakeRefugeOptions): Promise<void> {
  const signal = opts.signal
  const release = (bot as any).survival?.reflexes?.inhibit?.(refuge === 'sleep' ? ['night'] : ['hostiles', 'night']) as (() => void) | undefined
  try {
    switch (refuge) {
      case 'base': return await intoBase(bot, opts.base, signal)
      case 'sleep': {
        await sleepThroughNight(bot, { signal, bedDistance: 16, fight: false })
        return
      }
      case 'pillar': return await holdPillar(bot, signal)
      case 'hole': {
        await shelter(bot, { signal })
        return
      }
      case 'flee': {
        const e = opts.base?.entrance
        await fleeFrom(bot, () => refugeThreats(bot), { signal, distance: REFUGE_THREAT_RANGE + 4, maxTicks: 400, toward: e != null ? new Vec3(e.x, e.y, e.z) : undefined })
      }
    }
  } finally {
    release?.()
  }
}

/** in behind the base's door (the pathfinder opens it on its way) and shut */
async function intoBase (bot: Bot, base: BaseRecord | null, signal?: AbortSignal): Promise<void> {
  const door = findBaseDoor(bot, base)
  if (door == null) throw new SkillError('NOT_FOUND', 'no door to the base')
  const { inside } = door
  await navigate(bot, { goal: new goals.GoalBlock(inside.x, inside.y, inside.z), maxTicks: 600 }, signal)
  if (base?.bounds == null || !inBounds(bot.entity.position, base.bounds)) throw new SkillError('NO_PATH', `not in behind the base's door at ${door.door.toString()}`)
  bot.clearControlStates()
  if (!await shutDoor(bot, door.door, signal)) throw new SkillError('VERIFY_FAILED', `the base's door at ${door.door.toString()} won't shut`)
}

/**
 * The night (and the threats) waited out in the base's box behind its shut door: shut again when opened, a meal when
 * hungry, till it's bright outside (botIsBrightOutside) or maxTicks
 */
export async function waitInBase (bot: Bot, base: BaseRecord | null, opts: { signal?: AbortSignal, maxTicks?: number } = {}): Promise<{ ticks: number }> {
  const maxTicks = opts.maxTicks ?? 14000
  let ticks = 0
  for (; ticks < maxTicks && !botIsBrightOutside(bot); ticks += 20) {
    throwIfAborted(opts.signal)
    const door = findBaseDoor(bot, base)
    if (door != null && doorOpen(bot, door.door) && bot.entity.position.distanceTo(door.door.offset(0.5, 0.5, 0.5)) <= 4) await shutDoor(bot, door.door, opts.signal)
    if (bot.food <= 14 && bestFoodInInventory(bot) != null) await eat(bot, { signal: opts.signal }).catch(err => { if (isAbort(err)) throw err })
    await waitTicks(bot, 20, opts.signal)
  }
  return { ticks }
}

/** up a pillar of PILLAR_HEIGHT (its blocks punched out of the dirt about when not carried), held till the day, down again */
async function holdPillar (bot: Bot, signal?: AbortSignal): Promise<void> {
  const have = countItems(bot, SCAFFOLD_ITEMS)
  if (have < PILLAR_HEIGHT) {
    const under = bot.entity.position.floored().offset(0, -1, 0)
    await collectBlock(bot, { names: PUNCH_GROUND, count: PILLAR_HEIGHT - have, maxDistance: 6, maxUnreachable: 2, exclude: p => p.equals(under) }, signal)
    if (countItems(bot, SCAFFOLD_ITEMS) < PILLAR_HEIGHT) throw new SkillError('MISSING_ITEMS', `${countItems(bot, SCAFFOLD_ITEMS)} blocks for a pillar of ${PILLAR_HEIGHT}`)
  }
  const ground = Math.floor(bot.entity.position.y + 1e-6)
  await towerUp(bot, ground + PILLAR_HEIGHT, { signal })
  const until = leaveAtDay(bot)
  let health = bot.health
  for (let t = 0; t < PILLAR_MAX_TICKS && !until(); t++) {
    throwIfAborted(signal)
    if (bot.health < health - 0.5) throw new SkillError('VERIFY_FAILED', `hurt up the pillar (${bot.health.toFixed(1)} health)`)
    health = Math.max(health, bot.health)
    if (t % 10 === 0) {
      const unsafe = refugeThreats(bot).find(e => !PILLAR_SAFE_FROM.has(e.name ?? '') && hasLineOfSight(bot, e))
      if (unsafe != null) throw new SkillError('VERIFY_FAILED', `a ${unsafe.name ?? 'mob'} by the pillar`)
    }
    if (bot.food <= 14 && bestFoodInInventory(bot) != null) await eat(bot, { signal }).catch(err => { if (isAbort(err)) throw err })
    await waitTicks(bot, 1, signal)
  }
  await digDown(bot, ground, { signal })
}
