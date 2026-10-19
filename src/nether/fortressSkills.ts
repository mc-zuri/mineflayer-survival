// findFortress / findBlazeSpawner / collectBlazeRods: to a nether fortress (the seed's candidates, nearest first, or a
// straight walk along an axis without it), recognised by its nether bricks; its blaze spawner; blazes fought there
// (shot at range, met with the sword and the shield close up) until the bot has its rods.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Pos } from '../core/memory'
import { findBlocks } from '../core/findBlocks'
import type { Seed } from '../worldgen/random'
import { parseSeed } from '../worldgen/random'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { travel } from '../skills/travel'
import { moveNear } from '../skills/gridWalk'
import { countItems, trace, waitTicks } from '../skills/util'
import { eat } from '../skills/eat'
import { drinkPotion, findPotion, hasEffect } from '../skills/potion'
import { fight, lowerShield, raiseShield } from '../skills/fight'
import { shoot } from '../skills/shoot'
import { collectDropsNear } from '../skills/hunt'
import { type Entity, eyePosition, isAlive } from '../skills/combatUtil'
import {
  FORTRESS_BLOCKS, estimateBlazeSpawner, explorationRoute, fortressCandidates, netherComplexes, recognizeFortress,
  type ExploreOptions, type FortressSighting, type SpawnerEstimate
} from './fortress'
import { dimensionOf } from './portalTravel'
import { withNetherSafety, type NetherSafetyOptions } from './safety'

const v3 = (p: Pos): Vec3 => new Vec3(p.x, p.y, p.z)

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
  const run = async (): Promise<FindFortressResult> => {
    const seen = fortressInView(bot)
    if (seen != null) { remember(seen); return { fortress: seen, via: 'in_view', ticks } }
    let found: FortressSighting | null = null
    const onHop = (): boolean => { found = fortressInView(bot); return found != null }
    const known = bot.survival?.memory.getPois('fortress', { dimension: 'the_nether', near: bot.entity.position })[0]
    if (known != null) {
      await travel(bot, { target: v3(known), range: 16, hop: args.hop, onHop }, signal)
      found = found ?? fortressInView(bot)
      if (found != null) { remember(found); return { fortress: found, via: 'memory', ticks } }
    }
    if (args.seed != null) {
      const seed = levelSeed(args.seed)
      const from = bot.entity.position
      const sure = fortressCandidates(seed, from, { radius: args.regions ?? 2 })
      const maybe = netherComplexes(seed, from, { radius: args.regions ?? 2 }).filter(c => c.structure === 'bastion_remnant')
      // a sure fortress first unless a bastion roll is much nearer (it is one only in basalt deltas)
      const order = [...sure.map(c => ({ c, cost: c.distance })), ...maybe.map(c => ({ c, cost: c.distance * 2.5 }))].sort((a, b) => a.cost - b.cost)
      for (const { c } of order) {
        trace('findFortress: candidate', c.structure, c.x, c.z, Math.round(c.distance))
        // the start piece sits in the fortress's middle rows, at y 48-70
        try {
          await travel(bot, { target: new Vec3(c.x + 8, 64, c.z + 8), range: 24, hop: args.hop, onHop }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('findFortress: trip to', c.x, c.z, 'failed:', (err as Error).message)
        }
        found = found ?? fortressInView(bot)
        if (found != null) { remember(found); return { fortress: found, via: 'seed', ticks } }
      }
      throw new SkillError('NOT_FOUND', `no fortress at the seed's ${order.length} candidates`)
    }
    const route = explorationRoute(bot.entity.position, args.explore)
    const last = route[route.length - 1]
    await travel(bot, { target: v3(last), range: 8, hop: args.hop ?? 32, onHop }, signal)
    found = found ?? fortressInView(bot)
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
/** the health the blaze fight backs off at: higher among 3 blazes or more (their fireballs come together) */
export function retreatHealth (blazes: number, set?: number): number {
  return set ?? (blazes >= 3 ? 12 : BLAZE_RETREAT_HEALTH)
}

/** how far from the spawner the bot backs off to (along the way it came) */
export const BLAZE_RETREAT_DISTANCE = 36

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
      const spawners = fortressSpawnersInView(bot)
      if (spawners.length > 0) return estimateBlazeSpawner({ spawners, from: bot.entity.position })
      return estimateBlazeSpawner({ blazes: sightings, fortress, from: bot.entity.position })
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

/** from further than this from the spawner, the camp is gone to by a trip (travel) first */
export const CAMP_TRIP = 48

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
  /** drink fire resistance when the bot has a potion of it and the effect is off (default true) */
  fireResistance?: boolean
  safety?: NetherSafetyOptions | false
}

export interface BlazeRodsResult {
  rods: number
  kills: number
  ticks: number
}

/**
 * Blaze rods by the spawner: near it (where its blazes come out), each blaze shot with the bow while it hovers off
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
  const run = async (): Promise<BlazeRodsResult> => {
    if (countItems(bot, 'blaze_rod') >= count) return { rods: countItems(bot, 'blaze_rod'), kills, ticks }
    const spawner = args.spawner != null ? v3(args.spawner) : v3(await findBlazeSpawner(bot, { safety: false }, signal))
    const standOff = args.standOff ?? 5
    const spots = campSpots(bot, spawner, standOff)
    const camp = async (): Promise<void> => {
      if (bot.entity.position.distanceTo(spawner) <= standOff + 3 && seesFrom(bot, eyePosition(bot), spawner.offset(0.5, 0.5, 0.5), spawner)) return
      // from afar (back from the portal after a death): a trip to the fortress first, by the way walked before (the
      // nether's trail) and in hops, not one goto on a straight line across the lava sea
      if (bot.entity.position.distanceTo(spawner) > CAMP_TRIP) {
        await travel(bot, { target: spawner, range: 16 }, signal).catch(err => {
          if (isAbort(err)) throw err
          trace('collectBlazeRods: the trip to the spawner:', (err as Error).message)
        })
      }
      for (const spot of spots.slice(0, 3)) {
        try {
          await moveNear(bot, spot, 0, signal)
          return
        } catch (err) {
          if (isAbort(err)) throw err
          trace('collectBlazeRods: no way to', spot.toString(), (err as Error).message)
        }
      }
      try {
        await moveNear(bot, spawner, standOff, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('collectBlazeRods: no way to the spawner:', (err as Error).message)
      }
    }
    trace('collectBlazeRods: spawner at', spawner.toString())
    await camp()
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
        if (bot.health <= (args.eatAt ?? 12) && bot.food < 20) {
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
          await camp()
          await waitTicks(bot, 5, signal)
          continue
        }
        lastSight = ticks
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
            await fight(bot, blaze, { signal: cut.signal, maxTicks: 300, maxDistance: 16 })
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
