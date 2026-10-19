// An End City and its ship: the city spotted by its purpur in the loaded chunks (or gone to where the seed puts one),
// the shulkers about shot when they open (Shulker.hurt turns a projectile away while its lid is shut: peek 0) and their
// bullets hit away (ShulkerBullet.hurt destroys it) or taken on the shield (no levitation: ShulkerBullet.onHitEntity
// adds it only when the hit hurt), the ship's item frame reached, hit (ItemFrame.hurt drops its item: the elytra) and
// the elytra picked up; the ship's chests looted.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { findBlocks } from '../../core/findBlocks'
import { normalizeDimension } from '../../core/memory'
import { TaskError, throwIfAborted, waitTicks, type Entity, type SkillOptions, isAlive, metadataValue, hasLineOfSight, yawPitchOf } from '../../skills/combatUtil'
import { aim, arrowWorld } from '../../skills/shoot'
import { motionTrackerOf } from '../../skills/motion'
import { pickupDrops } from '../../skills/pickupDrops'
import { retrieveItems } from '../../skills/chest'
import { countItems, eyePosition, trace } from '../../skills/util'
import { bridgeOverLava } from '../../nether/safety'
import { travel } from '../../skills/travel'
import { END_CITY_POI, END_SHIP_POI, PURPUR_BLOCKS, endCityCandidates, frameItemName, purpurClusters, type PurpurCluster } from '../endCity'
import type { Seed } from '../../worldgen'
import { SCAFFOLD_ITEMS, blockGetter, goto, holdOneOf, isOpenAt, towerUp, worldMinY } from './world'

/** the cities seen in the loaded chunks (purpur within `range`), remembered */
export function spotEndCities (bot: Bot, range = 128): PurpurCluster[] {
  const ids = PURPUR_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  const points = findBlocks(bot, { matching: ids, maxDistance: range, count: 2048 })
  const cities = purpurClusters(points)
  const memory = bot.survival?.memory
  for (const c of cities) {
    if (memory == null) break
    const known = memory.getPois(END_CITY_POI, { dimension: 'the_end', near: c.center })[0]
    if (known != null && Math.hypot(known.x - c.center.x, known.z - c.center.z) < 48) continue
    memory.addPoi(END_CITY_POI, c.center, 'the_end', `${c.count} purpur, y ${c.minY}..${c.maxY}`)
  }
  return cities
}

/** item frames with an elytra in them (an End Ship's), nearest first */
export function elytraFrames (bot: Bot): Entity[] {
  const name = (id: number): string | undefined => bot.registry.items[id]?.name
  return Object.values(bot.entities)
    .filter(e => e.name === 'item_frame' && frameItemName(metadataValue(bot, e, 'item'), name) === 'elytra')
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

/** the ships seen (an elytra's frame) get remembered */
export function spotEndShips (bot: Bot): Entity[] {
  const frames = elytraFrames(bot)
  for (const f of frames) bot.survival?.memory.addPoi(END_SHIP_POI, f.position.floored(), 'the_end', 'elytra')
  return frames
}

export interface SeekCityOptions extends SkillOptions {
  /** the world's seed: the cities' candidate chunks (END_CITIES), nearest first */
  seed?: Seed
  /** how many candidates or legs to try (default 8) */
  tries?: number
}

/**
 * To an End City with a ship: one with its elytra frame in sight already, else the remembered ships and cities, else
 * the seed's candidates nearest first, else legs out away from 0, 0; each trip's hops look for purpur and the frame.
 * Resolves the frame of an elytra once one is in sight (the city's ship), null when none was found.
 */
export async function seekEndShip (bot: Bot, opts: SeekCityOptions = {}): Promise<Entity | null> {
  const signal = opts.signal
  if (normalizeDimension(bot.game?.dimension) !== 'the_end') throw new TaskError('NOT_FOUND', 'not in the End')
  const found = (): Entity | null => { spotEndCities(bot); return spotEndShips(bot)[0] ?? null }
  let frame = found()
  if (frame != null) return frame
  const memory = bot.survival?.memory
  const visited: Vec3[] = []
  const targets = (): Vec3[] => {
    const out: Vec3[] = []
    for (const p of memory?.getPois(END_SHIP_POI, { dimension: 'the_end', near: bot.entity.position }) ?? []) out.push(new Vec3(p.x, p.y, p.z))
    for (const p of memory?.getPois(END_CITY_POI, { dimension: 'the_end', near: bot.entity.position }) ?? []) out.push(new Vec3(p.x, p.y, p.z))
    if (opts.seed != null) for (const c of endCityCandidates(opts.seed, bot.entity.position)) out.push(new Vec3(c.x, 64, c.z))
    return out.filter(t => !visited.some(v => Math.hypot(v.x - t.x, v.z - t.z) < 64))
  }
  const tries = opts.tries ?? 8
  for (let i = 0; i < tries; i++) {
    throwIfAborted(signal)
    let target = targets()[0]
    if (target == null) {
      // out away from 0, 0, turning a little each leg
      const out = Math.atan2(bot.entity.position.z, bot.entity.position.x) + (i % 2 === 0 ? 0.6 : -0.6) * Math.ceil(i / 2)
      target = bot.entity.position.offset(Math.cos(out) * 160, 0, Math.sin(out) * 160)
    }
    visited.push(target)
    trace('seekEndShip: to', target.toString())
    try {
      await travel(bot, { target, range: 24, onHop: () => found() != null }, signal)
    } catch (err) {
      if (signal?.aborted === true) throw err
      trace('seekEndShip: the way to', target.toString(), 'failed:', (err as Error).message)
    }
    frame = found()
    if (frame != null) return frame
  }
  return null
}

/** a shulker's lid is open (Shulker.DATA_PEEK_ID over 0): an arrow hurts it */
export function shulkerOpen (bot: Bot, shulker: Entity): boolean {
  const peek = metadataValue(bot, shulker, 'peek')
  return typeof peek === 'number' && peek > 0
}

/** the shulkers within `range` of `near` (default the bot) that see the bot, nearest first */
export function threateningShulkers (bot: Bot, range = 16, near: Vec3 = bot.entity.position): Entity[] {
  return Object.values(bot.entities)
    .filter(e => e.name === 'shulker' && isAlive(bot, e) && e.position.distanceTo(near) <= range && hasLineOfSight(bot, e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

/**
 * Hits away the shulker bullets within reach and raises the shield against those further in: a guard run each tick
 * while the bot climbs to the ship. Resolves what it did this tick.
 */
export function guardBullets (bot: Bot, reach = 3): 'hit' | 'shield' | null {
  const eye = eyePosition(bot)
  const bullets = Object.values(bot.entities).filter(e => e.name === 'shulker_bullet' && e.position.distanceTo(eye) <= 6)
  if (bullets.length === 0) return null
  const near = bullets.sort((a, b) => a.position.distanceTo(eye) - b.position.distanceTo(eye))[0]
  if (near.position.distanceTo(eye) <= reach) {
    const { yaw, pitch } = yawPitchOf(near.position.minus(eye))
    void bot.look(yaw, pitch, true)
    bot.attack(near)
    return 'hit'
  }
  const shield = bot.inventory.slots[45]?.name === 'shield'
  if (shield) {
    const { yaw, pitch } = yawPitchOf(near.position.minus(eye))
    void bot.look(yaw, pitch, true)
    bot.activateItem(true)
    return 'shield'
  }
  return null
}

export interface ShootShulkerOptions extends SkillOptions {
  /** ticks to wait for the lid to open (default 200) */
  maxTicks?: number
  /** arrows to loose (default 6) */
  maxShots?: number
}

/**
 * Shoots a shulker with the bow: drawn, held till the lid is open (an arrow off a shut one is turned away), loosed;
 * again till it's dead. The bullets about are hit away meanwhile. Resolves whether it died.
 */
export async function shootShulker (bot: Bot, shulker: Entity, opts: ShootShulkerOptions = {}): Promise<boolean> {
  const signal = opts.signal
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (bow == null) throw new TaskError('MISSING_ITEMS', 'no bow')
  if (countItems(bot, ['arrow', 'spectral_arrow', 'tipped_arrow']) === 0) throw new TaskError('MISSING_ITEMS', 'no arrows')
  const world = arrowWorld(bot)
  motionTrackerOf(bot).track(shulker)
  let shots = 0
  try {
    for (let t = 0; t < (opts.maxTicks ?? 200) && shots < (opts.maxShots ?? 6); t++) {
      throwIfAborted(signal)
      if (!isAlive(bot, shulker)) return true
      if (bot.heldItem?.name !== 'bow') { await bot.equip(bow, 'hand'); bot.activateItem() }
      if (!bot.usingHeldItem) bot.activateItem()
      const sol = aim(bot, shulker, { world })
      if (sol != null) await bot.look(sol.yaw, sol.pitch, true)
      await waitTicks(bot, 1, signal)
      const drawn = (bot as any).itemUseTicks ?? 22
      if (sol != null && shulkerOpen(bot, shulker) && drawn >= 20) {
        bot.deactivateItem()
        shots++
        await waitTicks(bot, Math.ceil(sol.ticks) + 4, signal)
      }
    }
    return !isAlive(bot, shulker)
  } finally {
    motionTrackerOf(bot).untrack(shulker)
    bot.deactivateItem()
  }
}

/** shoots the shulkers that see the bot within `range`, nearest first; resolves the ones killed */
export async function clearShulkers (bot: Bot, opts: SkillOptions & { range?: number, near?: Vec3, max?: number } = {}): Promise<number> {
  let killed = 0
  for (let i = 0; i < (opts.max ?? 8); i++) {
    const s = threateningShulkers(bot, opts.range ?? 16, opts.near)[0]
    if (s == null) break
    if (await shootShulker(bot, s, { signal: opts.signal })) killed++
    else break
  }
  return killed
}

/** ItemFrame's Direction (its data's facing: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east) as a step */
const FACING: Record<number, Vec3> = { 0: new Vec3(0, -1, 0), 1: new Vec3(0, 1, 0), 2: new Vec3(0, 0, -1), 3: new Vec3(0, 0, 1), 4: new Vec3(-1, 0, 0), 5: new Vec3(1, 0, 0) }

/** where to stand to hit a frame: two cells out along its facing, the feet a block under it (the eyes at its height) */
export function frameStand (framePos: Vec3, facing: number): Vec3 {
  const f = FACING[facing] ?? new Vec3(0, 0, 0)
  const cell = framePos.floored()
  const out = f.y !== 0 ? cell.plus(f.scaled(2)) : cell.plus(f.scaled(2)).offset(0, -1, 0)
  return out
}

/**
 * To within a hit of the frame: up a pillar beside the ship to the stand's height (the nearest column round it open
 * from the ground to there, bridged out to over the void first), then the pathfinder the last of the way (through the
 * ship's hull: purpur digs fast). The bullets are guarded against all the while.
 */
export async function reachFrame (bot: Bot, frame: Entity, opts: SkillOptions = {}): Promise<void> {
  const signal = opts.signal
  const facing = Number(metadataValue(bot, frame, 'direction') ?? 2)
  const stand = frameStand(frame.position, facing)
  const close = (): boolean => bot.entity.position.distanceTo(frame.position) <= 2.8 && Math.abs(bot.entity.position.y + 1.62 - frame.position.y) < 1.6
  if (close()) return
  const guard = (): void => { guardBullets(bot) }
  bot.on('physicsTick', guard)
  try {
    if (bot.entity.position.y < stand.y - 3) {
      const get = blockGetter(bot)
      const minY = worldMinY(bot)
      // a column round the stand open from its ground (or the void's level of the island near) up to the stand
      let best = null as { x: number, z: number, ground: number | null, cost: number } | null
      for (let r = 2; r <= 10; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
            const x = stand.x + dx
            const z = stand.z + dz
            // open from over the stand down to its ground, the island's (no higher than a few blocks over the bot: not
            // the ship's deck or a tower's roof) or the void's
            let ground: number | null = null
            let open = true
            for (let y = stand.y + 2; y >= minY; y--) {
              const b = get(new Vec3(x, y, z))
              if (b == null) { open = false; break }
              if (b.boundingBox !== 'empty') { ground = y + 1; break }
            }
            if (!open || (ground != null && ground > Math.min(stand.y, bot.entity.position.y + 4))) continue
            const cost = r * 4 + (ground == null ? 200 : stand.y - ground) + Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z) / 4
            if (best == null || cost < best.cost) best = { x, z, ground, cost }
          }
        }
        if (best?.ground != null) break
      }
      if (best == null) throw new TaskError('NO_PATH', `no open column up to the frame at ${frame.position.floored().toString()}`)
      const blocks = countItems(bot, SCAFFOLD_ITEMS)
      if (best.ground != null) {
        if (blocks < stand.y - best.ground) throw new TaskError('MISSING_ITEMS', `${stand.y - best.ground} blocks to pillar up to the ship, ${blocks} held`)
        trace('reachFrame: pillar at', best.x, best.ground, best.z, 'up to', stand.y)
        const foot = new Vec3(best.x, best.ground, best.z)
        await goto(bot, new goals.GoalBlock(foot.x, foot.y, foot.z), () => bot.entity.position.floored().equals(foot), { signal, target: foot.offset(0.5, 0, 0.5), strayLimit: 64, maxTicks: 6000 })
      } else {
        // over the void: bridged out at the bot's level toward the column, then up
        const feet = bot.entity.position.floored()
        const dx = best.x - feet.x
        const dz = best.z - feet.z
        for (const [axis, n] of [['x', dx], ['z', dz]] as const) {
          if (n === 0) continue
          const dir = axis === 'x' ? new Vec3(Math.sign(n), 0, 0) : new Vec3(0, 0, Math.sign(n))
          await bridgeOverLava(bot, { direction: dir, length: Math.abs(n), rails: false, item: SCAFFOLD_ITEMS.find(i => countItems(bot, i) > 0) }, signal)
        }
      }
      await towerUp(bot, stand.y, { signal })
    }
    // the last of the way: into the ship, digging through its hull
    await holdOneOf(bot, ['diamond_pickaxe', 'netherite_pickaxe', 'iron_pickaxe', 'stone_pickaxe'])
    await goto(bot, new goals.GoalNear(stand.x, stand.y, stand.z, 1), close, { signal, target: stand.offset(0.5, 0, 0.5), strayLimit: 16, maxTicks: 2400 })
    if (!close()) throw new TaskError('NO_PATH', `stopped ${bot.entity.position.distanceTo(frame.position).toFixed(1)} from the frame`)
  } finally {
    bot.off('physicsTick', guard)
    bot.deactivateItem()
  }
}

export interface TakeElytraResult {
  frame: Vec3
  ticks: number
  /** what the ship's chests gave */
  looted: Record<string, number>
}

/**
 * The ship's elytra: the shulkers that see the bot shot, the frame reached and hit (twice at most: a hit drops the
 * item), the elytra picked up, and the chests within 8 of the frame looted. Throws NOT_FOUND without a frame in sight.
 */
export async function takeElytra (bot: Bot, opts: SkillOptions & { frame?: Entity, loot?: boolean } = {}): Promise<TakeElytraResult> {
  const signal = opts.signal
  const frame = opts.frame ?? elytraFrames(bot)[0]
  if (frame == null) throw new TaskError('NOT_FOUND', 'no item frame with an elytra in sight')
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  const at = frame.position.clone()
  const before = countItems(bot, 'elytra')
  try {
    // under the ship first: the columns round it in the loaded chunks (a frame seen from the city's far side had none
    // of its columns to pillar up loaded: 'no open column', 26.3)
    if (Math.hypot(at.x - bot.entity.position.x, at.z - bot.entity.position.z) > 24) {
      await travel(bot, { target: new Vec3(at.x, bot.entity.position.y, at.z), range: 16 }, signal).catch(err => {
        if (signal?.aborted === true) throw err
        trace('takeElytra: under the ship:', (err as Error).message)
      })
    }
    if (countItems(bot, 'bow') > 0) await clearShulkers(bot, { signal, near: at, range: 20 }).catch(err => { if (signal?.aborted === true) throw err; trace('takeElytra: shulkers:', (err as Error).message) })
    await reachFrame(bot, frame, { signal })
    // the shulkers in the ship's cabin, now in sight
    if (countItems(bot, 'bow') > 0) await clearShulkers(bot, { signal, near: at, range: 10 }).catch(err => { if (signal?.aborted === true) throw err })
    for (let i = 0; i < 3 && isAlive(bot, frame) && elytraFrames(bot).some(f => f.id === frame.id); i++) {
      throwIfAborted(signal)
      await bot.lookAt(frame.position, true)
      bot.attack(frame)
      await waitTicks(bot, 10, signal)
    }
    await pickupDrops(bot, { near: at, radius: 6, names: ['elytra'] }, signal)
    if (countItems(bot, 'elytra') <= before) {
      // it fell: further down
      await pickupDrops(bot, { near: at, radius: 16, names: ['elytra'] }, signal).catch(() => {})
    }
    if (countItems(bot, 'elytra') <= before) throw new TaskError('FAILED', `the elytra from the frame at ${at.floored().toString()} wasn't picked up`)
    bot.survival?.memory.removePoi(END_SHIP_POI, at.floored(), 'the_end')
    const looted: Record<string, number> = {}
    if (opts.loot !== false) {
      const id = bot.registry.blocksByName.chest?.id
      for (const chest of id == null ? [] : findBlocks(bot, { matching: id, point: at, maxDistance: 8, count: 4 })) {
        try {
          const res = await retrieveItems(bot, { chest }, signal)
          for (const [n, c] of Object.entries(res.moved)) looted[n] = (looted[n] ?? 0) + c
        } catch (err) {
          if (signal?.aborted === true) throw err
          trace('takeElytra: chest at', chest.toString(), (err as Error).message)
        }
      }
    }
    return { frame: at, ticks, looted }
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/** whether a cell is open for the body (feet and head), for the tests' worlds too */
export function bodyFits (get: (p: Vec3) => { name: string, boundingBox: string } | null, feet: Vec3): boolean {
  return isOpenAt(get, feet) && isOpenAt(get, feet.offset(0, 1, 0))
}
