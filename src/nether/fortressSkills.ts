// findFortress / findBlazeSpawner / collectBlazeRods: to a nether fortress (the seed's candidates, nearest first, or a
// straight walk along an axis without it), recognised by its nether bricks; its blaze spawner; blazes fought there
// (from a nook built by it, else camped near it: shot at range, met with the sword and the shield close up) until the
// bot has its rods.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Pos } from '../core/memory'
import { findBlocks } from '../core/findBlocks'
import type { Seed } from '../worldgen/random'
import { parseSeed } from '../worldgen/random'
import { SkillError, isAbort, isSkillError, throwIfAborted } from '../skills/errors'
import { travel } from '../skills/travel'
import { moveNear } from '../skills/gridWalk'
import { tunnelTo } from '../skills/tunnel'
import { countItems, trace, waitTicks } from '../skills/util'
import { eat } from '../skills/eat'
import { craft } from '../skills/craft'
import { chooseFuel, smelt } from '../skills/smelt'
import { drinkPotion, findPotion, hasEffect } from '../skills/potion'
import { fight, lowerShield, raiseShield } from '../skills/fight'
import { shoot } from '../skills/shoot'
import { collectDropsNear } from '../skills/hunt'
import { type Entity, eyePosition, isAlive } from '../skills/combatUtil'
import {
  FORTRESS_BLOCKS, estimateBlazeSpawner, explorationRoute, fortressCandidates, recognizeFortress, seededComplexes,
  type ExploreOptions, type FortressSighting, type SpawnerEstimate
} from './fortress'
import { dimensionOf } from './portalTravel'
import { withNetherSafety, type NetherSafetyOptions } from './safety'
import { SPAWN_RANGE, type BlazeNook, type NookLookup, buildNook, fightFromNook, nookAround, nookBlocks, openNook, planBlazeNooks, sealAndHeal, withBlocksKept } from './blazeFight'
import { walkTo } from '../skills/navigate'

const v3 = (p: Pos): Vec3 => new Vec3(p.x, p.y, p.z)

/** the memory's kind for a blaze spawner the bot found no way to (markSpawnerUnreachable) */
export const UNREACHABLE_SPAWNER = 'blaze_spawner_unreachable'

/** a spawner this near one the bot found no way to is that one */
export const SAME_SPAWNER = 6

/** blazes this near (sideways) a spawner left out are taken for its */
export const SPAWNER_BLAZES_RANGE = 32

/** a fortress whose seen bounds come within this of a spawner the bot found no way to is that spawner's */
export const SAME_FORTRESS = 32

/**
 * Remembers the spawner as one the bot found no way to (UNREACHABLE_SPAWNER), and forgets it as the one to go to
 * ('blaze_spawner')
 */
export function markSpawnerUnreachable (bot: Bot, spawner: Pos): void {
  const memory = bot.survival?.memory
  if (memory == null) return
  for (const p of memory.getPois('blaze_spawner', { dimension: 'the_nether' })) {
    if (Math.hypot(p.x - spawner.x, p.y - spawner.y, p.z - spawner.z) <= SAME_SPAWNER) memory.removePoi('blaze_spawner', p, 'the_nether')
  }
  memory.addPoi(UNREACHABLE_SPAWNER, { x: Math.floor(spawner.x), y: Math.floor(spawner.y), z: Math.floor(spawner.z) }, 'the_nether')
}

/** the spawners the bot found no way to */
export function unreachableSpawners (bot: Bot): Pos[] {
  return bot.survival?.memory?.getPois(UNREACHABLE_SPAWNER, { dimension: 'the_nether' }) ?? []
}

/** whether the spawner is (near) one of `exclude` */
export function excludedSpawner (spawner: Pos, exclude: readonly Pos[]): boolean {
  return exclude.some(e => Math.hypot(e.x - spawner.x, e.y - spawner.y, e.z - spawner.z) <= SAME_SPAWNER)
}

/** whether the fortress seen is the one with one of `exclude` in it (its bounds and SAME_FORTRESS round them) */
export function excludedFortress (f: { min: Pos, max: Pos }, exclude: readonly Pos[]): boolean {
  return exclude.some(e => e.x >= f.min.x - SAME_FORTRESS && e.x <= f.max.x + SAME_FORTRESS && e.z >= f.min.z - SAME_FORTRESS && e.z <= f.max.z + SAME_FORTRESS)
}

/** the seed as a level seed: a number or bigint as is, text as WorldOptions.parseSeed reads it */
export function levelSeed (seed: Seed): Seed {
  return typeof seed === 'string' ? parseSeed(seed) : seed
}

/** fortress blocks in the loaded chunks around the bot */
export function scanFortressBlocks (bot: Bot, maxDistance = 128, count = 4096): Array<{ name: string, pos: Pos }> {
  const ids = FORTRESS_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n != null)
  return findBlocks(bot, { matching: ids, maxDistance, count }).map(p => ({ name: bot.blockAt(p)?.name ?? '', pos: { x: p.x, y: p.y, z: p.z } }))
}

/** the fortress in view (the loaded chunks), or null */
export function fortressInView (bot: Bot, maxDistance = 128): FortressSighting | null {
  return recognizeFortress(scanFortressBlocks(bot, maxDistance))
}

export interface FindFortressArgs {
  /** the world's seed: go to the nearest fortress it places (optionally from the run options) */
  seed?: Seed
  /** regions round the bot to take candidates from (default 2) */
  regions?: number
  /** without a seed: the walk (default: along the nearer axis, away from 0) */
  explore?: ExploreOptions
  /** blocks per travel hop, each followed by a scan (default 48) */
  hop?: number
  /** spawners (or places) whose fortress isn't the one: the bot found no way to them (unreachableSpawners) */
  exclude?: Pos[]
  safety?: NetherSafetyOptions | false
}

export interface FindFortressResult {
  fortress: FortressSighting
  /** how it was found */
  via: 'in_view' | 'memory' | 'seed' | 'explore'
  ticks: number
}

/**
 * To the nearest nether fortress. In view already: done. With the seed: its complexes, the sure fortresses nearest
 * first, then the bastion rolls (a fortress after all where the chunk is basalt deltas); without it: the axis walk.
 * Each trip scans the chunks after every hop, and stops at the first fortress recognised (FORTRESS_BLOCKS).
 */
export async function findFortress (bot: Bot, args: FindFortressArgs = {}, signal?: AbortSignal): Promise<FindFortressResult> {
  throwIfAborted(signal)
  if (dimensionOf(bot) !== 'the_nether') throw new SkillError('VERIFY_FAILED', `fortresses are in the nether, not ${dimensionOf(bot)}`)
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  const remember = (f: FortressSighting): void => { bot.survival?.memory.addPoi('fortress', f.center, 'the_nether') }
  const exclude = args.exclude ?? []
  // (a fortress with a spawner the bot found no way to isn't the one: another)
  const inView = (): FortressSighting | null => {
    const f = fortressInView(bot)
    return f == null || excludedFortress(f, exclude) ? null : f
  }
  const run = async (): Promise<FindFortressResult> => {
    const seen = inView()
    if (seen != null) { remember(seen); return { fortress: seen, via: 'in_view', ticks } }
    let found: FortressSighting | null = null
    const onHop = (): boolean => { found = inView(); return found != null }
    const near = (p: Pos, d: number): boolean => exclude.some(e => Math.hypot(e.x - p.x, e.z - p.z) <= d)
    const known = bot.survival?.memory.getPois('fortress', { dimension: 'the_nether', near: bot.entity.position }).filter(p => !near(p, 128))[0]
    if (known != null) {
      await travel(bot, { target: v3(known), range: 16, hop: args.hop, onHop }, signal)
      found = found ?? inView()
      if (found != null) { remember(found); return { fortress: found, via: 'memory', ticks } }
    }
    if (args.seed != null) {
      const seed = levelSeed(args.seed)
      const from = bot.entity.position
      // with the seed's biomes: a bastion roll in a basalt delta is a fortress, one by a delta maybe one, the rest bastions
      const complexes = seededComplexes(seed, from, { radius: args.regions ?? 2 })
      const sure = complexes.filter(c => c.structure === 'fortress')
      const maybe = complexes.filter(c => c.maybe)
      // a sure fortress first unless a maybe one is much nearer
      const order = [...sure.map(c => ({ c, cost: c.distance })), ...maybe.map(c => ({ c, cost: c.distance * 2.5 }))]
        .filter(({ c }) => !near({ x: c.x + 8, y: 64, z: c.z + 8 }, 128))
        .sort((a, b) => a.cost - b.cost)
      for (const { c } of order) {
        trace('findFortress: candidate', c.structure, c.x, c.z, Math.round(c.distance))
        // the start piece sits in the fortress's middle rows, at y 48-70
        try {
          await travel(bot, { target: new Vec3(c.x + 8, 64, c.z + 8), range: 24, hop: args.hop, onHop }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('findFortress: trip to', c.x, c.z, 'failed:', (err as Error).message)
        }
        found = found ?? inView()
        if (found != null) { remember(found); return { fortress: found, via: 'seed', ticks } }
      }
      throw new SkillError('NOT_FOUND', `no fortress at the seed's ${order.length} candidates`)
    }
    const route = explorationRoute(bot.entity.position, args.explore)
    const last = route[route.length - 1]
    await travel(bot, { target: v3(last), range: 8, hop: args.hop ?? 32, onHop }, signal)
    found = found ?? inView()
    if (found == null) throw new SkillError('NOT_FOUND', `no fortress along ${route.length * (args.explore?.step ?? 32)} blocks of the axis walk`)
    remember(found)
    return { fortress: found, via: 'explore', ticks }
  }
  try {
    return args.safety === false ? await run() : await withNetherSafety(bot, run, args.safety)
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/** whether nothing solid is between the eyes and the point (the block at `through` excepted) */
export function seesFrom (bot: Bot, eye: Vec3, point: Vec3, through?: Vec3): boolean {
  const d = point.minus(eye)
  const len = d.norm()
  if (len < 1e-6) return true
  const hit: any = (bot.world as any).raycast(eye, d.scaled(1 / len), len)
  if (hit == null) return true
  if (through != null && (hit.position as Vec3).equals(through)) return true
  return hit.intersect != null && hit.intersect.distanceTo(eye) >= len - 1e-3
}

/**
 * Where to stand by a spawner: a cell on the floor 3 to `standOff` + 2 blocks from it, within 2 of its height, that
 * sees it (the blazes come out within 4 of it: SpawnData's spawn range) - nearest the bot first.
 */
export function campSpots (bot: Bot, spawner: Vec3, standOff = 5): Vec3[] {
  const out: Array<{ cell: Vec3, d: number }> = []
  const free = (p: Vec3): boolean => { const b = bot.blockAt(p); return b != null && b.boundingBox === 'empty' && b.name !== 'lava' && b.name !== 'fire' }
  const r = standOff + 2
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const cell = spawner.offset(dx, dy, dz)
        const h = Math.hypot(dx, dz)
        if (h < 3 || h > r) continue
        if (!free(cell) || !free(cell.offset(0, 1, 0)) || bot.blockAt(cell.offset(0, -1, 0))?.boundingBox !== 'block') continue
        if (!seesFrom(bot, cell.offset(0.5, 1.62, 0.5), spawner.offset(0.5, 0.5, 0.5), spawner)) continue
        out.push({ cell, d: cell.distanceTo(bot.entity.position) + Math.abs(h - standOff) * 2 })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).map(c => c.cell)
}

/** puts out the fire blocks within `radius` of the bot's feet (a hit each, from where it stands); resolves how many */
export async function putOutFiresNear (bot: Bot, radius: number, signal?: AbortSignal): Promise<number> {
  const ids = ['fire', 'soul_fire'].map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  const fires = findBlocks(bot, { matching: ids, maxDistance: radius + 1, count: 16 })
    .filter(p => p.distanceTo(bot.entity.position) <= radius + 1)
  let out = 0
  for (const p of fires) {
    throwIfAborted(signal)
    const block = bot.blockAt(p)
    if (block == null || !['fire', 'soul_fire'].includes(block.name)) continue
    await bot.dig(block as any, true).then(() => { out++ }, () => {})
  }
  return out
}

/** health the blaze fight backs off at to heal, and how many times a fight does */
export const BLAZE_RETREAT_HEALTH = 8
export const BLAZE_RETREATS = 6
/** the food level the blaze fight eats at, whatever the health (the eat reflex's 14, held back through the fight) */
export const BLAZE_EAT_FOOD = 14
/** how far from a spawner the blaze fight camps */
export const BLAZE_STAND_OFF = 9

/**
 * Whether the bot `distance` from the spawner is at its camp: within standOff + 3, and out of the spawn volume
 * (BaseSpawner: each blaze comes out within SPAWN_RANGE of the spawner's middle across). A 26.3 bot left on a melee
 * nook's stand 2 off the spawner, the nook's walls not put up, took that for its camp and fought on there with the
 * blazes coming out on top of it, and burned (full-26.3-fresh-d)
 */
export function atCamp (distance: number, standOff: number): boolean {
  return distance <= standOff + 3 && distance > SPAWN_RANGE + 1
}

/** a blaze this near and the camp's meal waits for it to be fought (BlazeAttackGoal hits within 2, every 20 ticks) */
export const BLAZE_MEAL_CLEAR = 6
/** at or under this food level the camp eats with blazes on it all the same */
export const BLAZE_STARVING = 6

/**
 * Whether the camp's fight eats now: hurt (at `eatAt` or under) with room for it, or the food at BLAZE_EAT_FOOD or
 * under; not with a blaze within BLAZE_MEAL_CLEAR (`close` of them) unless starving. A 26.3 bot at 19 health and food 7
 * stood eating with two blazes on it, 0.5 and 2.4 off, punched and burning, 4 and more a hit, and died in 60 ticks
 * (full-26.3-fresh-d)
 */
export function campMealDue (food: number, health: number, eatAt: number, close: number): boolean {
  const want = (health <= eatAt && food < 20) || food <= BLAZE_EAT_FOOD
  return want && (close === 0 || food <= BLAZE_STARVING)
}

/** the health the blaze fight backs off at: higher among 3 blazes or more (their fireballs come together) */
export function retreatHealth (blazes: number, set?: number): number {
  return set ?? (blazes >= 3 ? 12 : BLAZE_RETREAT_HEALTH)
}

/** how far from the spawner the bot backs off to (along the way it came) */
export const BLAZE_RETREAT_DISTANCE = 36

/** the health the camp's retreat heals to, shut in */
export const SEAL_HEAL_TO = 18

/**
 * The camp's retreat where the bot stands: shut in there (a nook round its feet, nookAround, its open side toward the
 * spawner, and that shut too: sealAndHeal), fed and healed, and opened toward the spawner again. No blaze's fireball nor
 * a wither skeleton's sword reaches into a box of full blocks. The walk off 36 blocks along the way it came took a 26.3
 * bot at 10 health, burning, into a fortress's corridors, where a wither skeleton killed it (full-26.3-fresh-d).
 * Resolves false, the walk then, when there's no box to be had there (no floor, a wall that isn't a full block, too
 * few blocks in the bag) or its front wouldn't shut.
 */
export async function healSealed (bot: Bot, toward: Vec3, signal?: AbortSignal): Promise<boolean> {
  const feet = bot.entity.position.floored()
  const d = toward.minus(feet)
  const facing = Math.abs(d.x) >= Math.abs(d.z) ? new Vec3(d.x < 0 ? -1 : 1, 0, 0) : new Vec3(0, 0, d.z < 0 ? -1 : 1)
  const lookup = (p: Vec3): any => bot.blockAt(p)
  const nook = nookAround(lookup, feet, facing)
  if (nook == null) return false
  const front = nook.front.filter(p => lookup(p)?.boundingBox !== 'block').length
  if (nookBlocks(bot) < nook.build.length + front) return false
  trace('collectBlazeRods: shut in at', feet.toString(), 'to heal,', nook.build.length + front, 'blocks')
  // (the body in the middle of its cell: half in a wall's cell, the wall's block would walk it out of the box)
  await walkTo(bot, feet.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal)
  try {
    await buildNook(bot, nook, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('collectBlazeRods: no box:', (err as Error).message)
    return false
  }
  const shut = await sealAndHeal(bot, nook, SEAL_HEAL_TO, signal)
  if (shut) await openNook(bot, nook, signal)
  return shut
}

/** ticks the blaze fight waits with blazes about and none in sight before it moves to another camp spot */
export const BLIND_TICKS = 200

/**
 * The camp spot to move to when no blaze is in sight: the first of `spots` not tried whose eyes see one of the
 * blazes (`targets`, their middles), else the first not tried; null when all are tried
 */
export function nextCampSpot (bot: Bot, spots: readonly Vec3[], targets: readonly Vec3[], tried: ReadonlySet<string>): Vec3 | null {
  const left = spots.filter(s => !tried.has(s.toString()))
  return left.find(s => targets.some(t => seesFrom(bot, s.offset(0.5, 1.62, 0.5), t))) ?? left[0] ?? null
}

export interface FindSpawnerArgs {
  fortress?: FortressSighting
  /** the world's seed: the fortress's start piece (its candidate chunk) is the first place to look */
  seed?: Seed
  /** stop searching after this many trips round the fortress (default 6) */
  maxTrips?: number
  /** spawners not to take (the bot found no way to them: unreachableSpawners) */
  exclude?: Pos[]
  safety?: NetherSafetyOptions | false
}

/**
 * Spawner blocks in the loaded chunks that stand in a fortress: nether bricks within 6 blocks (a fortress's are all
 * blaze spawners, on its MonsterThrone pieces; a bastion's magma cube spawner has none about).
 */
export function fortressSpawnersInView (bot: Bot, maxDistance = 128): Pos[] {
  const id = bot.registry.blocksByName.spawner?.id
  if (id == null) return []
  const bricks = FORTRESS_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n != null)
  return findBlocks(bot, { matching: id, maxDistance, count: 16 })
    .filter(p => findBlocks(bot, { point: p, matching: bricks, maxDistance: 6, count: 1 }).length > 0)
    .map(p => ({ x: p.x, y: p.y, z: p.z }))
}

function blazesInView (bot: Bot, maxDistance = 64): Entity[] {
  return Object.values(bot.entities).filter(e => e.name === 'blaze' && e.position.distanceTo(bot.entity.position) <= maxDistance && isAlive(bot, e))
}

/**
 * The blaze spawner of the fortress: a spawner block in view (they're all blaze spawners in a fortress), else the
 * cluster of blazes about one; until then the bot walks round the fortress (its middle, then the ends of what it has
 * seen of it), looking again after each trip.
 */
export async function findBlazeSpawner (bot: Bot, args: FindSpawnerArgs = {}, signal?: AbortSignal): Promise<SpawnerEstimate> {
  const exclude = args.exclude ?? []
  const run = async (): Promise<SpawnerEstimate> => {
    let fortress = args.fortress ?? fortressInView(bot)
    if (fortress == null) throw new SkillError('NOT_FOUND', 'no fortress in view to look for the spawner in')
    const sightings: Pos[] = []
    // the start piece the seed places (NetherFortressStructure: at its candidate chunk, the deck at 48-70)
    const start: Pos[] = args.seed == null
      ? []
      : fortressCandidates(levelSeed(args.seed), bot.entity.position, { radius: 1 }).filter(c => c.distance < 320).slice(0, 1).map(c => ({ x: c.x + 8, y: 64, z: c.z + 8 }))
    const look = (): SpawnerEstimate | null => {
      // (a wide scan: the nearest few thousand bricks are only the bit of the fortress the bot stands on)
      fortress = recognizeFortress(scanFortressBlocks(bot, 128, 20000)) ?? fortress
      for (const b of blazesInView(bot)) sightings.push(b.position.clone())
      // (the spawners are checked against the fortress by the bricks about them: the sighting's extent is only what's in view)
      // (and the ones the bot found no way to left out: a fortress often has two)
      const spawners = fortressSpawnersInView(bot).filter(p => !excludedSpawner(p, exclude))
      if (spawners.length > 0) return estimateBlazeSpawner({ spawners, from: bot.entity.position })
      // (the blazes about one of them are its: they wander 20 blocks and more from it, and a cluster of them made a
      // spawner of nothing 30 off one left out, where a nook waited 24000 ticks for none, 26.3)
      const away = (p: Pos): boolean => exclude.every(e => Math.hypot(e.x - p.x, e.z - p.z) > SPAWNER_BLAZES_RANGE)
      const est = estimateBlazeSpawner({ blazes: sightings.filter(away), fortress, from: bot.entity.position })
      return est != null && est.source === 'blazes' && !away(est) ? null : est
    }
    let est = look()
    // the chunks round the bot may still be coming in (a fresh arrival)
    if (est == null || est.source === 'explore') { await waitTicks(bot, 40); est = look() }
    const visited: Pos[] = []
    for (let trip = 0; trip < (args.maxTrips ?? 6); trip++) {
      if (est != null && est.source !== 'explore') break
      const f = fortress
      // the next place to look: the middle first, then the far ends of the bricks seen, the least visited first
      // (and past the ends: more of the fortress comes into view as the bot goes)
      const spots = [...start, f.center, { x: f.min.x, y: f.center.y, z: f.center.z }, { x: f.max.x, y: f.center.y, z: f.center.z }, { x: f.center.x, y: f.center.y, z: f.min.z }, { x: f.center.x, y: f.center.y, z: f.max.z },
        { x: f.min.x - 48, y: f.center.y, z: f.center.z }, { x: f.max.x + 48, y: f.center.y, z: f.center.z }, { x: f.center.x, y: f.center.y, z: f.min.z - 48 }, { x: f.center.x, y: f.center.y, z: f.max.z + 48 }]
      const next = spots.find(s => visited.every(v => Math.hypot(v.x - s.x, v.z - s.z) > 24))
      if (next == null) break
      visited.push(next)
      trace('findBlazeSpawner: looking from', next)
      try {
        await travel(bot, { target: v3(next), range: 8, onHop: () => { const e = look(); return e != null && e.source !== 'explore' } }, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('findBlazeSpawner: trip failed:', (err as Error).message)
      }
      est = look()
    }
    if (est == null || est.source === 'explore') throw new SkillError('NOT_FOUND', 'no blaze spawner found in the fortress')
    bot.survival?.memory.addPoi('blaze_spawner', est, 'the_nether', est.source)
    return est
  }
  return args.safety === false ? await run() : await withNetherSafety(bot, run, args.safety)
}

/** arrows the bow's nook (planBlazeNooks', 7 to 13 off) is gone to with, the melee nook by the spawner with fewer */
export const NOOK_ARROWS = 16

/** whether the bag holds a bow and NOOK_ARROWS arrows */
export function shootsWell (bot: Bot): boolean {
  return countItems(bot, 'bow') > 0 && countItems(bot, ['arrow', 'spectral_arrow', 'tipped_arrow']) >= NOOK_ARROWS
}

/** the nook's blocks the bag must have: its most (planBlazeNook's maxBlocks) and the front's two */
export const NOOK_MIN_BLOCKS = 14

/** the nook each spawner's fight was fought from, per bot: gone back to after a death or a reflex's preemption */
const nooks = new WeakMap<Bot, Map<string, BlazeNook>>()

/** the nooks' key: the spawner, and whether the nook is the melee one by it */
const nookKey = (spawner: Vec3, melee: boolean): string => `${spawner.toString()}${melee ? ' melee' : ''}`

function keepNook (bot: Bot, spawner: Vec3, nook: BlazeNook, melee = false): void {
  let m = nooks.get(bot)
  if (m == null) nooks.set(bot, m = new Map())
  m.set(nookKey(spawner, melee), nook)
}

const badStands = new WeakMap<Bot, Vec3[]>()
/** the nooks whose front wouldn't shut (fightFromNook's CANNOT_PLACE), not planned again */
function badNooks (bot: Bot): Vec3[] {
  let list = badStands.get(bot)
  if (list == null) badStands.set(bot, list = [])
  return list
}

/** the nook kept for the spawner, its blocks to put again looked at afresh (null when it can't be had now) */
function keptNook (bot: Bot, spawner: Vec3, lookup: NookLookup, melee = false): BlazeNook | null {
  const kept = nooks.get(bot)?.get(nookKey(spawner, melee))
  if (kept == null) return null
  return nookAround(lookup, kept.stand, kept.facing)
}

/** shields the blaze fight carries when it can make them (the one in the off hand and a spare) */
export const BLAZE_SHIELDS = 2

/**
 * A shield made (CraftingTable: six planks and an iron ingot) while the bag has fewer than BLAZE_SHIELDS and the
 * makings; with no iron ingot, the raw iron smelted for them first (a furnace carried or made, put down and taken back
 * up): a 26.3 whole game went into seed 7741's nook with no shield and 3 raw iron, a furnace and 16 coal in the bag,
 * and was shot to 5 health there for 2 kills
 */
export async function spareShield (bot: Bot, signal?: AbortSignal): Promise<number> {
  const have = (): number => countItems(bot, 'shield')
  let made = 0
  const wood = (): boolean => countItems(bot, (i: any) => /_(planks|log|stem)$/.test(i.name)) > 0
  const want = Math.min(BLAZE_SHIELDS - have(), countItems(bot, 'raw_iron'))
  // (the fuel not the shield's wood: a log of it kept for the planks, 200 ticks a smelt)
  const fuel = chooseFuel(bot.inventory.items().filter(i => !/_(planks|log|stem)$/.test(i.name)), 200 * want) ??
    (countItems(bot, (i: any) => /_(log|stem)$/.test(i.name)) >= 3 ? chooseFuel(bot.inventory.items(), 200 * want) : null)
  if (want > 0 && countItems(bot, 'iron_ingot') === 0 && wood() && fuel != null &&
    (countItems(bot, 'furnace') > 0 || countItems(bot, ['cobblestone', 'cobbled_deepslate', 'blackstone']) >= 8)) {
    try {
      await smelt(bot, { input: 'raw_iron', count: want, fuel: fuel.name, pickUpFurnace: true }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('collectBlazeRods: no iron smelted for a shield:', (err as Error).message)
    }
  }
  while (have() < BLAZE_SHIELDS && countItems(bot, 'iron_ingot') > 0 && countItems(bot, (i: any) => /_(planks|log|stem)$/.test(i.name)) > 0) {
    try {
      await craft(bot, { item: 'shield', pickUpTable: true }, signal)
      made++
    } catch (err) {
      if (isAbort(err)) throw err
      trace('collectBlazeRods: no spare shield:', (err as Error).message)
      break
    }
  }
  return made
}

/** from further than this from the spawner, the camp is gone to by a trip (travel) first */
export const CAMP_TRIP = 48

/** times in a row the blaze fight finds no way to a camp spot, no blaze in sight, before it tunnels, then gives up */
export const CAMP_FAILS = 3

export interface BlazeRodsArgs {
  /** rods wanted in the inventory (default 6: 12 eyes) */
  count?: number
  /** the spawner to camp by (default: findBlazeSpawner's) */
  spawner?: Pos
  /** shoot blazes further than this when there's a bow and arrows (default 6) */
  shootFrom?: number
  /** stand this far from the spawner (default 5: within its 16 block activation range, outside its 4 block spawn box) */
  standOff?: number
  /** eat at or below this health (default 12) */
  eatAt?: number
  /** back out of the fight to heal at this health or lower (default BLAZE_RETREAT_HEALTH) */
  retreatAt?: number
  /** give up after this many ticks (default 24000) */
  maxTicks?: number
  /** fight from a nook built by the spawner (planBlazeNook) when one can be had (default true) */
  nook?: boolean
  /** drink fire resistance when the bot has a potion of it and the effect is off (default true) */
  fireResistance?: boolean
  /** spawners not to look for (default: the ones the bot found no way to, unreachableSpawners) */
  exclude?: Pos[]
  safety?: NetherSafetyOptions | false
}

export interface BlazeRodsResult {
  rods: number
  kills: number
  ticks: number
}

/**
 * Blaze rods by the spawner: from a nook built 7 to 13 blocks off it, open toward it (blazeFight: fightFromNook, the
 * shield up while a blaze in sight is about to shoot, the bow between), when the bag has the blocks for one and
 * there's a site; else camped near it (where its blazes come out), each blaze shot with the bow while it hovers off
 * (and the bot has arrows) or fought with the melee weapon once near, the shield up while one is charged; rods picked
 * up after each kill; eats when hurt; until `count` rods are in the inventory.
 */
export async function collectBlazeRods (bot: Bot, args: BlazeRodsArgs = {}, signal?: AbortSignal): Promise<BlazeRodsResult> {
  const count = args.count ?? 6
  const maxTicks = args.maxTicks ?? 24000
  const shootFrom = args.shootFrom ?? 6
  let ticks = 0
  let kills = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  const cameFrom = bot.entity.position.clone()
  // far enough from the spawner for a trip first: CAMP_TRIP off, or 16 over or under it (a 26.3 bot 46 blocks over
  // seed 2's throne, 15 off it sideways, was where the trips by x and z alone had left it)
  const farFrom = (spawner: Vec3): boolean => bot.entity.position.distanceTo(spawner) > CAMP_TRIP || Math.abs(bot.entity.position.y - spawner.y) > 16
  const run = async (): Promise<BlazeRodsResult> => {
    if (countItems(bot, 'blaze_rod') >= count) return { rods: countItems(bot, 'blaze_rod'), kills, ticks }
    // the blazes are this skill's to fight (the hostiles reflex took them over each time one came in range, and fought
    // them in melee about the spawner: every blaze death of 26.3 runs as to av was in it), and its meals (the eat
    // reflex, the blazes out of its sight, would eat in the open with the shield down)
    const engine = bot.survival?.reflexes
    const leave = engine?.leaveAlone(['blaze'])
    const noEat = engine?.inhibit(['eat'])
    try {
      return await fightForRods()
    } finally {
      leave?.()
      noEat?.()
    }
  }
  /**
   * The fight from a nook by the spawner (planBlazeNook: the one built before, else the cheapest), built and fought
   * from; null when there's no nook to be had (too few blocks, no site, its building failed), the camp's fight then
   */
  const fightFromCover = async (spawner: Vec3, retried = false, melee = !shootsWell(bot), stuckBefore = false): Promise<BlazeRodsResult | null> => {
    if (nookBlocks(bot) < NOOK_MIN_BLOCKS) { trace('collectBlazeRods: too few blocks for a nook,', nookBlocks(bot)); return null }
    if (farFrom(spawner)) {
      await travel(bot, { target: spawner, range: 16, exactY: true }, signal).catch(err => {
        if (isAbort(err)) throw err
        trace('collectBlazeRods: the trip to the spawner:', (err as Error).message)
      })
    }
    // a spare shield made first when it can be (a blocked fireball takes 6 of a shield's 336: it broke in a long fight
    // and the bot in the nook was hit to death); the nook's fight shuts its front against the shots without one
    await spareShield(bot, signal)
    const lookup = (p: Vec3): any => bot.blockAt(p)
    const kept = keptNook(bot, spawner, lookup, melee)
    // the one built before, else the cheapest three in turn (one the bot finds no way to, the next), not one whose
    // front wouldn't shut
    const bad = badNooks(bot)
    const candidates = kept != null ? [kept] : planBlazeNooks(lookup, spawner, { from: bot.entity.position, melee }, 3 + bad.length).filter(n => !bad.some(b => b.equals(n.stand))).slice(0, 3)
    let nook: BlazeNook | null = null
    for (const c of candidates) {
      trace('collectBlazeRods: the nook at', c.stand.toString(), 'facing', c.facing.toString(), c.build.length, 'blocks')
      try {
        await buildNook(bot, c, signal)
        nook = c
        break
      } catch (err) {
        if (isAbort(err)) throw err
        trace('collectBlazeRods: the nook not built:', (err as Error).message)
      }
    }
    if (nook == null) { trace('collectBlazeRods: no nook by the spawner at', spawner.toString(), 'of', candidates.length); return null }
    keepNook(bot, spawner, nook, melee)
    try {
      const fought = await fightFromNook(bot, nook, { count, spawner, maxTicks: maxTicks - ticks, eatAt: args.eatAt ?? 14, onKill: () => { kills++ } }, signal)
      trace('collectBlazeRods: from the nook,', fought.kills, 'kills,', fought.shots, 'shots,', fought.ticks, 'ticks')
    } catch (err) {
      // (out of food to heal on: the milestone gets more, not the camp's fight with none)
      if (isAbort(err) || isSkillError(err, 'TIMEOUT') || bot.health <= 0 || (isSkillError(err, 'MISSING_ITEMS') && (err as Error).message.includes('no food'))) throw err
      // a spawner that gives no blazes: given up as one there's no way to (the milestone's next spawner)
      if (isSkillError(err, 'NOT_FOUND') && /no blaze came/.test((err as Error).message)) {
        markSpawnerUnreachable(bot, spawner)
        throw err
      }
      trace('collectBlazeRods: the fight from the nook:', (err as Error).message)
      // a front that wouldn't shut: another nook, once
      if (isSkillError(err, 'CANNOT_PLACE') && /won't shut/.test((err as Error).message) && !retried) {
        nooks.get(bot)?.delete(nookKey(spawner, melee))
        bad.push(nook.stand)
        return await fightFromCover(spawner, true, melee)
      }
      // no kill from it for long (NOOK_STALL_TICKS) with the arrows for more: another of the bow's nooks, once (the
      // hall's nook under seed 2's throne at (-277, 77, -159) saw none of its blazes for 3000 ticks, another sees
      // other cells of the throne; the melee nook after it, in the spawn volume then, killed the 26.3 bot in iron with
      // a bow and 32 arrows, BLAZE_KIT=gateIronBow)
      if (isSkillError(err, 'STUCK') && (err as Error).message.includes('no blaze killed') && !melee && !stuckBefore && shootsWell(bot)) {
        trace('collectBlazeRods: no kill from the nook at', nook.stand.toString(), ': another bow nook')
        nooks.get(bot)?.delete(nookKey(spawner, melee))
        bad.push(nook.stand)
        return await fightFromCover(spawner, retried, false, true)
      }
      // no kill from it for long (NOOK_STALL_TICKS): the melee nook by the spawn volume, the blazes coming out within
      // the sword's reach of its front; from that one too, the camp's fight with the shield
      if (isSkillError(err, 'STUCK') && (err as Error).message.includes('no blaze killed') && !melee) {
        trace('collectBlazeRods: no kill from the nook at', nook.stand.toString(), ': the melee nook by the spawner')
        return await fightFromCover(spawner, retried, true)
      }
      return null
    }
    return { rods: countItems(bot, 'blaze_rod'), kills, ticks }
  }
  const fightForRods = async (): Promise<BlazeRodsResult> => {
    const spawner = args.spawner != null ? v3(args.spawner) : v3(await findBlazeSpawner(bot, { safety: false, exclude: args.exclude ?? unreachableSpawners(bot) }, signal))
    // the spawner kept from the pathfinder's breaking through the fight (the walks to a nook by it, to the rods on the
    // throne): a 26.3 bot's way to the melee nook on seed 7741's throne went through it, and no blaze came after
    return await withBlocksKept(bot, [spawner], async () => await fightAt(spawner))
  }
  const fightAt = async (spawner: Vec3): Promise<BlazeRodsResult> => {
    // (from 9 off, out of the swarm the spawner keeps about it, the blazes come one or two at a time and are shot:
    // camped 5 off, among 6 of them, a diamond-armored 26.3 bot burned to death five times at one spawner)
    const standOff = args.standOff ?? BLAZE_STAND_OFF
    // from cover first: a nook built by the spawner (blazeFight); the camp's fight below when none can be had
    if (args.nook !== false) {
      const fought = await fightFromCover(spawner)
      if (fought != null) return fought
    }
    const spots = campSpots(bot, spawner, standOff)
    /** to a camp spot by the spawner; resolves whether the bot got there (or near the spawner) */
    const camp = async (): Promise<boolean> => {
      if (atCamp(bot.entity.position.distanceTo(spawner), standOff) && seesFrom(bot, eyePosition(bot), spawner.offset(0.5, 0.5, 0.5), spawner)) return true
      // from afar (back from the portal after a death): a trip to the fortress first, by the way walked before (the
      // nether's trail) and in hops, not one goto on a straight line across the lava sea
      if (farFrom(spawner)) {
        await travel(bot, { target: spawner, range: 16, exactY: true }, signal).catch(err => {
          if (isAbort(err)) throw err
          trace('collectBlazeRods: the trip to the spawner:', (err as Error).message)
        })
      }
      for (const spot of spots.slice(0, 3)) {
        try {
          await moveNear(bot, spot, 0, signal)
          return true
        } catch (err) {
          if (isAbort(err)) throw err
          trace('collectBlazeRods: no way to', spot.toString(), (err as Error).message)
        }
      }
      try {
        await moveNear(bot, spawner, standOff, signal)
        return true
      } catch (err) {
        if (isAbort(err)) throw err
        trace('collectBlazeRods: no way to the spawner:', (err as Error).message)
      }
      return bot.entity.position.distanceTo(spawner) <= standOff + 3
    }
    // the camp got to (or a blaze fought) since the bot last found no way there, and the tunnel tried toward it
    let campFails = 0
    let tunnelled = false
    /**
     * No way to the camp CAMP_FAILS times in a row with no blaze in sight: a staircase dug and bridged toward the
     * spawner once (tunnelTo, its range the stand-off), then given up as one there's no way to (markSpawnerUnreachable:
     * the milestone tries the fortress's other spawner, else another fortress). A 26.3 bot 13 blocks over a fortress's
     * spawner (870, 76, 143) found no path to it, its nook or any camp spot for 6000 ticks, till it fell into the lava
     * under it and died (run blz-d).
     */
    const noWayToCamp = async (): Promise<void> => {
      if (++campFails < CAMP_FAILS) return
      if (!tunnelled) {
        tunnelled = true
        // a trip there first, in hops on partial paths and to its height (moveNear's one search timed out over and
        // over from 46 blocks over a spawner, the trip's end taken by x and z alone), then a staircase dug to it
        trace('collectBlazeRods: no way to the spawner at', spawner.toString(), ': a trip, then a tunnel toward it')
        for (const go of [
          async () => await travel(bot, { target: spawner, range: standOff + 2, exactY: true, trail: false }, signal),
          async () => await tunnelTo(bot, { target: spawner, range: standOff }, signal)
        ]) {
          try {
            await go()
            if (await camp()) { campFails = 0; return }
          } catch (err) {
            if (isAbort(err)) throw err
            trace('collectBlazeRods: toward the spawner:', (err as Error).message)
          }
        }
      }
      markSpawnerUnreachable(bot, spawner)
      throw new SkillError('NO_PATH', `no way to the blaze spawner at ${spawner.toString()}`, { rods: countItems(bot, 'blaze_rod'), kills, ticks, spawner })
    }
    trace('collectBlazeRods: spawner at', spawner.toString())
    if (!await camp()) await noWayToCamp()
    // deaths the server tells of (EntityEvent.DEATH): a blaze merely out of sight isn't a kill
    const dead = new Set<number>()
    const onDead = (e: Entity): void => { dead.add(e.id) }
    bot.on('entityDead', onDead)
    const noShot = new Map<number, number>()
    // where the bot came from: out of the blazes' way, to back off to when low
    const retreatTo = cameFrom.distanceTo(spawner) > 16 ? cameFrom : spawner.plus(cameFrom.minus(spawner).normalize().scaled(20)).floored()
    let retreats = 0
    let lastSight = ticks
    const triedSpots = new Set<string>()
    try {
      while (countItems(bot, 'blaze_rod') < count) {
        throwIfAborted(signal)
        if (dimensionOf(bot) !== 'the_nether' || bot.health <= 0) throw new SkillError('VERIFY_FAILED', `the bot ${bot.health > 0 ? 'left the nether' : 'died'} by the spawner`, { rods: countItems(bot, 'blaze_rod'), kills, ticks })
        // fire resistance through the fight when there's a potion of it (the fireballs set the bot alight)
        if (args.fireResistance !== false && !hasEffect(bot, 'fire_resistance') && findPotion(bot, 'fire_resistance') != null) {
          await drinkPotion(bot, 'fire_resistance', signal)
        }
        if (ticks > maxTicks) throw new SkillError('TIMEOUT', `${countItems(bot, 'blaze_rod')} of ${count} blaze rods after ${ticks} ticks`, { rods: countItems(bot, 'blaze_rod'), kills, ticks })
        // low: back out of the blazes' reach (the way the bot came) to eat up and heal, then on again (a 26.3 bot fought
        // on at the spawner, fireballed and burning, till it died)
        if (bot.health <= retreatHealth(blazesInView(bot, 24).length, args.retreatAt) && retreats < BLAZE_RETREATS) {
          retreats++
          // shut in where it stands to heal, when it can be
          if (await healSealed(bot, spawner, signal)) continue
          trace('collectBlazeRods: health', bot.health, 'retreating to', retreatTo.toString())
          // farther first (out of their sight: 20 blocks off they shot on and the bot was low again in a while, 26.3),
          // where it came from else
          const away = spawner.plus(retreatTo.minus(spawner).normalize().scaled(BLAZE_RETREAT_DISTANCE)).floored()
          await moveNear(bot, away, 3, signal).catch(async err => {
            if (isAbort(err)) throw err
            await moveNear(bot, retreatTo, 2, signal).catch(e => { if (isAbort(e)) throw e; trace('collectBlazeRods: no retreat:', (e as Error).message) })
          })
          await putOutFiresNear(bot, 2, signal)
          // healed up behind the shield, held toward the nearest blaze (it takes their fireballs)
          for (let i = 0; i < 12 && bot.health < 18; i++) {
            if (bot.food < 20) { try { await eat(bot, { signal }) } catch (err) { if (isAbort(err)) throw err } }
            for (let k = 0; k < 8; k++) {
              const near = blazesInView(bot, 32).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
              if (near != null) {
                await bot.lookAt(near.position.offset(0, 0.9, 0), true)
                await raiseShield(bot).catch(() => false)
              } else lowerShield(bot)
              await waitTicks(bot, 10, signal)
            }
          }
          lowerShield(bot)
          continue
        }
        if (campMealDue(bot.food, bot.health, args.eatAt ?? 12, blazesInView(bot, BLAZE_MEAL_CLEAR).length)) {
          try { await eat(bot, { signal }) } catch (err) { if (isAbort(err)) throw err }
        }
        // the spawner's blazes, and any that came at the bot
        const blazes = blazesInView(bot, 24)
          .filter(b => b.position.distanceTo(spawner) <= 20 || b.position.distanceTo(bot.entity.position) <= 10)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
        // one the bot sees (its middle, from the eyes): through a wall neither the bow nor the sword reaches it
        const blaze = blazes.find(b => seesFrom(bot, eyePosition(bot), b.position.offset(0, 0.9, 0)) && ((noShot.get(b.id) ?? -1e9) < ticks - 60 || b.position.distanceTo(bot.entity.position) <= shootFrom))
        // the fires the fireballs lit by the bot put out (netherrack burns for good; standing among them the bot
        // 'went up in flames', 26.3)
        await putOutFiresNear(bot, 2, signal)
        if (blaze == null) {
          // blazes about the spawner none of which the bot sees for a while (the bot on the room's roof, 3 over the
          // spawner, sat 24000 ticks five times with 8 blazes under it on 26.3): on to a camp spot that sees one
          if (blazes.length > 0 && ticks - lastSight > BLIND_TICKS) {
            const spot = nextCampSpot(bot, spots, blazes.map(b => b.position.offset(0, 0.9, 0)), triedSpots)
            lastSight = ticks
            if (spot != null) {
              triedSpots.add(spot.toString())
              trace('collectBlazeRods: no blaze in sight: on to', spot.toString())
              await moveNear(bot, spot, 0, signal).catch(err => { if (isAbort(err)) throw err; trace('collectBlazeRods: no way to', spot.toString(), (err as Error).message) })
              continue
            }
            triedSpots.clear()
          }
          if (await camp()) campFails = 0
          else await noWayToCamp()
          await waitTicks(bot, 5, signal)
          continue
        }
        lastSight = ticks
        campFails = 0
        const d = blaze.position.distanceTo(bot.entity.position)
        const canShoot = countItems(bot, 'bow') > 0 && countItems(bot, ['arrow', 'spectral_arrow', 'tipped_arrow']) > 0
        trace('collectBlazeRods: health', bot.health, 'blazes', blazes.length, 'target at', d.toFixed(1), canShoot && d > Math.min(shootFrom, 3.5) ? 'shoot' : 'fight', 'tick', ticks)
        // the swing or the shot cut off as soon as the health falls to the retreat's (a fight of 300 ticks among 6 blazes
        // took a 26.3 bot from 20 to 5 before the retreat was looked at, and it burned on the way out)
        const low = retreatHealth(blazes.length, args.retreatAt)
        const cut = new AbortController()
        const onParent = (): void => { cut.abort(signal?.reason) }
        signal?.addEventListener('abort', onParent, { once: true })
        const onHealth = (): void => { if (bot.health <= low) cut.abort(new Error('low health')) }
        bot.on('health', onHealth)
        try {
          if (d > Math.min(shootFrom, 3.5) && canShoot) {
            await shoot(bot, blaze, { signal: cut.signal, maxShots: 2 })
          } else {
            // (not after it into the spawn volume, where the next ones come out on the bot: back to the camp then).
            // From a camp out of it only: in it already (a throne with no floor out of it that sees the spawner, seed
            // 2's at (-277, 77, -159)), the fight is where the bot is; cut at once, the loop stood a 26.3 bot there 2
            // ticks a turn under the blazes' fire for 9000 ticks, till it burned (BLAZE_KIT=q3)
            const fromCamp = atCamp(bot.entity.position.distanceTo(spawner), Infinity)
            await fight(bot, blaze, { signal: cut.signal, maxTicks: 300, maxDistance: 16, until: () => fromCamp && !atCamp(bot.entity.position.distanceTo(spawner), Infinity) })
          }
        } catch (err) {
          if (isAbort(err) && signal?.aborted === true) throw err
          if (isAbort(err) && cut.signal.aborted) { trace('collectBlazeRods: low,', bot.health, ': the fight cut off'); continue }
          if (isAbort(err)) throw err
          // no clear shot (a wall, the fortress in the way), or it got away: another, or wait for it to come nearer
          trace('collectBlazeRods:', (err as Error).message)
          noShot.set(blaze.id, ticks)
          await waitTicks(bot, 5, signal)
        } finally {
          bot.off('health', onHealth)
          signal?.removeEventListener('abort', onParent)
        }
        if (dead.has(blaze.id)) {
          kills++
          const at = blaze.position.clone()
          const got = await collectDropsNear(bot, at, { signal, radius: 6 })
          trace('collectBlazeRods: killed a blaze, picked up', got, 'rods', countItems(bot, 'blaze_rod'))
        }
        // in the spawn volume (its rods picked up there, a fight cut off at its edge): out to the camp again
        if (!atCamp(bot.entity.position.distanceTo(spawner), Infinity)) {
          await waitTicks(bot, 1, signal)
          if (!await camp()) await noWayToCamp()
        }
      }
    } finally {
      bot.off('entityDead', onDead)
    }
    return { rods: countItems(bot, 'blaze_rod'), kills, ticks }
  }
  try {
    return args.safety === false ? await run() : await withNetherSafety(bot, run, args.safety)
  } finally {
    bot.off('physicsTick', onTick)
  }
}
