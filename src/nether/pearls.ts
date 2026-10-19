// Ender pearls: bartered from piglins (gold ingots dropped by an adult piglin, the pearls picked up from what it
// throws back), or taken from endermen (in the warped forest, or the overworld at night), fought looking at their
// legs, never their eyes.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { navigate } from '../skills/navigate'
import { pickupDrops, nearbyDrops } from '../skills/pickupDrops'
import { countItems, findInventoryItem, settleInventory, trace, waitTicks, waitUntil } from '../skills/util'
import { fight } from '../skills/fight'
import { collectDropsNear } from '../skills/hunt'
import { type Entity, isAlive, metadataValue, yawPitchOf } from '../skills/combatUtil'
import { BARTER_TICKS_PER_INGOT } from '../planner/sources'
import { goldForPearls } from './barter'
import { wearGold } from './safety'

/** an adult piglin (Piglin.DATA_BABY_ID: babies take gold but don't barter, PiglinAi.isAdmiringItem needs an adult) */
export function isAdultPiglin (bot: Bot, e: Entity): boolean {
  return e.name === 'piglin' && metadataValue(bot, e, 'baby') !== true && isAlive(bot, e)
}

/** the piglin holds gold in its off hand: it's admiring an ingot (PiglinAi.holdInOffHand), the barter comes after */
export function isAdmiring (e: Entity): boolean {
  return (e as any).equipment?.[1]?.name === 'gold_ingot'
}

export interface BarterArgs {
  /** pearls wanted in the inventory (default 2) */
  pearls?: number
  /** gold to trade at most (default: all the bot has) */
  maxIngots?: number
  /** a piglin to trade with (default: the adult piglins within `range`) */
  piglin?: Entity
  /** how far to look for piglins (default 16) */
  range?: number
  /** other barter items worth picking up (default obsidian, string, fire charges) */
  keep?: string[]
  /** ticks to give up after (default: 140 per ingot, and 600) */
  maxTicks?: number
}

export interface BarterResult {
  pearls: number
  /** ingots given away */
  ingots: number
  /** what came back and was picked up */
  items: Record<string, number>
  ticks: number
}

/**
 * Barters gold for ender pearls. With a gold piece on (wearGold, so they don't attack), next to the adult piglins,
 * the bot drops one ingot for each piglin not already admiring one (PiglinAi.wantsToPickup takes a gold ingot from
 * the ground; it admires it for 120 ticks, then throws its loot toward the nearest player it sees), picks up the
 * pearls (and `keep`) they throw, until it has `pearls` or the gold runs out.
 */
export async function barterForPearls (bot: Bot, args: BarterArgs = {}, signal?: AbortSignal): Promise<BarterResult> {
  throwIfAborted(signal)
  const wanted = args.pearls ?? 2
  const range = args.range ?? 16
  const keep = ['ender_pearl', ...(args.keep ?? ['obsidian', 'string', 'fire_charge'])]
  const maxIngots = Math.min(args.maxIngots ?? Infinity, countItems(bot, 'gold_ingot'))
  if (maxIngots === 0) throw new SkillError('MISSING_ITEMS', 'no gold ingots to barter with')
  const maxTicks = args.maxTicks ?? (Math.ceil(maxIngots) * (BARTER_TICKS_PER_INGOT + 20) + 600)
  const startPearls = countItems(bot, 'ender_pearl')
  const before: Record<string, number> = {}
  for (const name of keep) before[name] = countItems(bot, name)
  let ingots = 0
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  const result = (): BarterResult => {
    const items: Record<string, number> = {}
    for (const name of keep) { const d = countItems(bot, name) - before[name]; if (d > 0) items[name] = d }
    return { pearls: countItems(bot, 'ender_pearl') - startPearls, ingots, items, ticks }
  }
  try {
    await wearGold(bot, signal)
    const piglins = (): Entity[] => args.piglin != null
      ? (isAdultPiglin(bot, args.piglin) ? [args.piglin] : [])
      : Object.values(bot.entities).filter(e => isAdultPiglin(bot, e) && e.position.distanceTo(bot.entity.position) <= range)
    if (piglins().length === 0) throw new SkillError('NOT_FOUND', `no adult piglin within ${range} blocks`)
    // ingots on the ground near the piglins (dropped, not yet taken)
    const groundGold = (): Entity[] => nearbyDrops(bot, bot.entity.position, 8, ['gold_ingot'])
    const pending = new Map<number, number>()
    while (countItems(bot, 'ender_pearl') - startPearls < wanted) {
      throwIfAborted(signal, result())
      if (ticks > maxTicks) throw new SkillError('TIMEOUT', `${result().pearls} of ${wanted} pearls after ${ticks} ticks`, result())
      const all = piglins()
      if (all.length === 0) throw new SkillError('NOT_FOUND', 'the piglins are gone', result())
      const near = all.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      // close enough that the piglins see the bot (they throw toward it) and walk to the gold
      if (near.position.distanceTo(bot.entity.position) > 4) {
        try {
          await navigate(bot, { goal: new goals.GoalNear(Math.floor(near.position.x), Math.floor(near.position.y), Math.floor(near.position.z), 2), reached: () => near.position.distanceTo(bot.entity.position) <= 4 }, signal)
        } catch (err) { if (isAbort(err)) throw err }
      }
      // what they threw: pick it up
      const loot = nearbyDrops(bot, bot.entity.position, 10, keep)
      if (loot.length > 0) {
        await pickupDrops(bot, { near: bot.entity.position, radius: 10, names: keep, waitTicks: 15 }, signal)
        continue
      }
      // an ingot for each piglin that isn't busy with one
      const idle = all.filter(p => !isAdmiring(p) && (pending.get(p.id) ?? -1000) < ticks - 60)
      const free = idle.length - groundGold().length
      if (free > 0 && ingots < maxIngots && countItems(bot, 'gold_ingot') > 0) {
        const target = idle[0]
        const ingot = findInventoryItem(bot, 'gold_ingot')
        if (ingot != null) {
          await settleInventory(bot, signal)
          const { yaw, pitch } = yawPitchOf(target.position.offset(0, 0.5, 0).minus(bot.entity.position.offset(0, 1.62, 0)))
          await bot.look(yaw, pitch, true)
          // Q drops one, thrown along the look (Player.drop)
          await bot.toss(ingot.type, null, 1)
          ingots++
          pending.set(target.id, ticks)
          trace('barterForPearls: dropped ingot', ingots, 'for piglin', target.id)
        }
        continue
      }
      if (ingots >= maxIngots || countItems(bot, 'gold_ingot') === 0) {
        // the last trades still to come back
        const busy = all.some(isAdmiring) || groundGold().length > 0
        if (!busy) {
          await waitTicks(bot, 20, signal)
          if (nearbyDrops(bot, bot.entity.position, 10, keep).length === 0 && !piglins().some(isAdmiring)) break
        }
      }
      await waitTicks(bot, 5, signal)
    }
    await pickupDrops(bot, { near: bot.entity.position, radius: 10, names: keep, waitTicks: 15 }, signal).catch(err => { if (isAbort(err)) throw err })
    const res = result()
    if (res.pearls < wanted) throw new SkillError('MISSING_ITEMS', `${res.pearls} of ${wanted} pearls after ${res.ingots} ingots`, res)
    return res
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/** the ingots to barter for `pearls` pearls with 90% confidence (planBarter over the piglin_bartering table) */
export function ingotsForPearls (pearls: number, confidence = 0.9): number {
  return goldForPearls(pearls, { confidence }).ingots
}

// ---- endermen

/** EnderMan.isLookingAtMe: a player looking within this of the line to its eyes angers it (1 - 0.025 / distance) */
export function looksAtEnderman (eye: Vec3, look: Vec3, enderman: Entity): boolean {
  const eyes = enderman.position.offset(0, 2.55, 0)
  const to = eyes.minus(eye)
  const d = to.norm()
  const dot = look.normalize().dot(to.scaled(1 / d))
  return dot > 1 - 0.025 / d
}

export interface HuntEndermenArgs {
  /** pearls wanted in the inventory (default 2) */
  pearls?: number
  /** how far to look for them (default 48) */
  range?: number
  /** ticks to give up after (default 12000) */
  maxTicks?: number
  /** anger one in sight by a stare and fight it where the bot stands, before walking up to it (default true) */
  provoke?: boolean
}

/**
 * Ender pearls from endermen. The nearest one in sight is angered by a stare from more than STARE_TELEPORT off, and
 * comes; else the bot walks up to it looking at the ground before it (never at its eyes: EnderMan.isLookingAtMe), and
 * fights it aimed at its legs: the hits land on its box all the same, and a look along its
 * body never meets its eyes until it's angry anyway. Endermen live in the warped forest, the end, and the overworld at
 * night.
 */
export async function huntEndermen (bot: Bot, args: HuntEndermenArgs = {}, signal?: AbortSignal): Promise<{ pearls: number, kills: number, ticks: number }> {
  const wanted = args.pearls ?? 2
  const range = args.range ?? 48
  const maxTicks = args.maxTicks ?? 12000
  const start = countItems(bot, 'ender_pearl')
  let kills = 0
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    while (countItems(bot, 'ender_pearl') - start < wanted) {
      throwIfAborted(signal)
      if (ticks > maxTicks) throw new SkillError('TIMEOUT', `${countItems(bot, 'ender_pearl') - start} of ${wanted} pearls after ${ticks} ticks`)
      const enderman = Object.values(bot.entities)
        .filter(e => e.name === 'enderman' && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= range)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (enderman == null) {
        if (kills === 0 && ticks > 200) throw new SkillError('NOT_FOUND', `no enderman within ${range} blocks`)
        await waitTicks(bot, 20, signal)
        continue
      }
      if (args.provoke !== false && !isAngryEnderman(bot, enderman) && enderman.position.distanceTo(bot.entity.position) > STARE_TELEPORT && eyesInSight(bot, enderman)) {
        // a stare from where the bot stands: it comes (teleporting toward the bot from over 16 off), and the fight is
        // on the bot's ground, not after it across the forest (run d's hunts on 26.3: 'still alive after 600 ticks'
        // and NO_PATH, eight times over, the endermen on the huge fungi)
        if (await provokeEnderman(bot, enderman, signal)) {
          await waitUntil(bot, () => !isAlive(bot, enderman) || enderman.position.distanceTo(bot.entity.position) <= 4, 200, signal)
        }
      }
      if (enderman.position.distanceTo(bot.entity.position) > 4) {
        // the walk with the eyes down: the pathfinder looks where it goes, which is along the ground
        const onLook = (): void => {
          if (looksAtEnderman(bot.entity.position.offset(0, 1.62, 0), viewVector(bot), enderman)) void bot.look(bot.entity.yaw, -0.6, true)
        }
        bot.on('physicsTick', onLook)
        try {
          await navigate(bot, { goal: new goals.GoalNear(Math.floor(enderman.position.x), Math.floor(enderman.position.y), Math.floor(enderman.position.z), 3), reached: () => enderman.position.distanceTo(bot.entity.position) <= 4 || !isAlive(bot, enderman) }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('huntEndermen:', (err as Error).message)
        } finally {
          bot.off('physicsTick', onLook)
        }
      }
      if (!isAlive(bot, enderman)) continue
      try {
        const res = await fight(bot, enderman, { signal, aimHeight: 0.3, maxTicks: 600, maxDistance: 32 })
        if (res.killed) {
          kills++
          await collectDropsNear(bot, res.lastPosition, { signal, radius: 6 })
        }
      } catch (err) {
        if (isAbort(err)) throw err
        // it teleported off
        trace('huntEndermen:', (err as Error).message)
      }
    }
    return { pearls: countItems(bot, 'ender_pearl') - start, kills, ticks }
  } finally {
    bot.off('physicsTick', onTick)
  }
}

/** EnderMan.DATA_CREEPY: angry at a player and coming for it */
export function isAngryEnderman (bot: Bot, e: Entity): boolean {
  return metadataValue(bot, e, 'creepy') === true
}

/** a stare within this teleports the enderman away (EndermanLookForPlayerGoal.tick: distanceToSqr < 16) */
export const STARE_TELEPORT = 4
/** ticks a stare is held for an enderman to take it (EndermanLookForPlayerGoal's aggroTime is 5) */
export const STARE_TICKS = 40

/** its eyes with no block between them and the bot's (Player.hasLineOfSight, which isBeingStaredBy needs) */
export function eyesInSight (bot: Bot, e: Entity): boolean {
  const raycast = (bot.world as any)?.raycast
  if (typeof raycast !== 'function') return true
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const to = e.position.offset(0, ENDERMAN_EYE, 0).minus(eye)
  const d = to.norm()
  if (d < 1e-6) return true
  return raycast.call(bot.world, eye, to.scaled(1 / d), d) == null
}

/** EnderMan's eye height */
const ENDERMAN_EYE = 2.55

/**
 * Angers an enderman by looking at its eyes (EnderMan.isBeingStaredBy, which EndermanLookForPlayerGoal takes from up
 * to 64 off), for STARE_TICKS at most; resolves whether it's angry (EnderMan.DATA_CREEPY)
 */
export async function provokeEnderman (bot: Bot, enderman: Entity, signal?: AbortSignal): Promise<boolean> {
  for (let t = 0; t < STARE_TICKS && isAlive(bot, enderman) && !isAngryEnderman(bot, enderman); t++) {
    throwIfAborted(signal)
    if (enderman.position.distanceTo(bot.entity.position) <= STARE_TELEPORT) break
    await bot.lookAt(enderman.position.offset(0, ENDERMAN_EYE, 0), true)
    await waitTicks(bot, 1, signal)
  }
  const angry = isAngryEnderman(bot, enderman)
  trace('huntEndermen: stared at enderman', enderman.id, angry ? 'angry' : 'not angry')
  return angry
}

function viewVector (bot: Bot): Vec3 {
  const { yaw, pitch } = bot.entity
  const c = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c)
}

export interface ObtainPearlsArgs {
  pearls?: number
  /** barter when the bot has gold and piglins are near (default), or 'endermen' */
  method?: 'barter' | 'endermen' | 'auto'
}

/** pearls by bartering when there's gold and piglins about, else from endermen */
export async function obtainPearls (bot: Bot, args: ObtainPearlsArgs = {}, signal?: AbortSignal): Promise<{ pearls: number, method: 'barter' | 'endermen' }> {
  const pearls = args.pearls ?? 2
  const method = args.method ?? 'auto'
  const piglin = Object.values(bot.entities).some(e => isAdultPiglin(bot, e) && e.position.distanceTo(bot.entity.position) <= 32)
  if (method === 'barter' || (method === 'auto' && piglin && countItems(bot, 'gold_ingot') > 0)) {
    const res = await barterForPearls(bot, { pearls }, signal)
    return { pearls: res.pearls, method: 'barter' }
  }
  const res = await huntEndermen(bot, { pearls }, signal)
  return { pearls: res.pearls, method: 'endermen' }
}
