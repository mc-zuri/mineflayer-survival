// Experience: the levels vanilla's Player counts, where the points come from (ExperienceOrb drops of ores, furnace
// output, kills), picking the orbs up, and gainLevels: mining, smelting and killing until the bot has the levels.
// The same in 26.3 (the levels, the ores' and recipes' experience, the orbs), as is the enchanting table
// (EnchantmentMenu, EnchantmentHelper, the enchantments' data) and the anvil (AnvilMenu).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, isSkillError, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { harvestToolFor } from './equipBest'
import { fight } from './fight'
import { navigate, walkTo } from './navigate'
import { chooseFuel, smelt } from './smelt'
import { blockIds, countItems, inventoryItems, trace, waitUntil } from './util'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import type { TaskError } from '../core/errors'
import { findBlocks } from '../core/findBlocks'

/** Player.getXpNeededForNextLevel: the points from `level` to the next */
export function xpNeededForNextLevel (level: number): number {
  if (level >= 30) return 112 + (level - 30) * 9
  if (level >= 15) return 37 + (level - 15) * 5
  return 7 + level * 2
}

/** the points a player at 0 needs to reach `level` (the sum of xpNeededForNextLevel below it) */
export function totalXpForLevel (level: number): number {
  let total = 0
  for (let l = 0; l < level; l++) total += xpNeededForNextLevel(l)
  return total
}

/** the points still needed for `level` from a level and its progress (Player.experienceProgress, 0 - 1) */
export function xpToLevel (target: number, level: number, progress = 0): number {
  if (level >= target) return 0
  return Math.max(0, totalXpForLevel(target) - totalXpForLevel(level) - Math.floor(progress * xpNeededForNextLevel(level)))
}

/**
 * The experience ores drop when mined without silk touch (the blocks' xp range, DropExperienceBlock /
 * RedStoneOreBlock): [min, max] points.
 */
export const XP_ORES: Record<string, [number, number]> = {
  coal_ore: [0, 2],
  deepslate_coal_ore: [0, 2],
  nether_gold_ore: [0, 1],
  redstone_ore: [1, 5],
  deepslate_redstone_ore: [1, 5],
  lapis_ore: [2, 5],
  deepslate_lapis_ore: [2, 5],
  nether_quartz_ore: [2, 5],
  diamond_ore: [3, 7],
  deepslate_diamond_ore: [3, 7],
  emerald_ore: [3, 7],
  deepslate_emerald_ore: [3, 7]
}

/** the points a smelt of one item gives when its output is taken (the smelting recipes' experience) */
export const SMELT_XP: Record<string, number> = {
  raw_iron: 0.7,
  raw_gold: 1,
  raw_copper: 0.7,
  ancient_debris: 2,
  beef: 0.35,
  porkchop: 0.35,
  chicken: 0.35,
  mutton: 0.35,
  rabbit: 0.35,
  cod: 0.35,
  salmon: 0.35,
  potato: 0.35
}

/** mobs worth killing for their points (Monster.getBaseExperienceReward: 5), creepers left out (they blow up) */
export const XP_MOBS = ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'zombie_villager', 'witch', 'slime', 'silverfish']

export type XpSource = 'ore' | 'smelt' | 'kill'

/** the bot's experience as the server last sent it (ClientboundSetExperiencePacket) */
export function experience (bot: Bot): { level: number, points: number, progress: number } {
  const xp = (bot as any).experience ?? {}
  return { level: xp.level ?? 0, points: xp.points ?? 0, progress: xp.progress ?? 0 }
}

export function isOrb (entity: Bot['entities'][string]): boolean {
  return entity.name === 'experience_orb'
}

export interface CollectOrbsArgs {
  /** where to look (default: the bot) */
  near?: Vec3
  /** how far from `near` (default 8: ExperienceOrb follows a player within 8 blocks) */
  radius?: number
  /** give up after (default 200) */
  maxTicks?: number
}

/**
 * Picks up the experience orbs about: ExperienceOrb.tick flies an orb at the nearest player within 8 blocks and
 * playerTouch takes it (a player takes one orb every 2 ticks: Player.takeXpDelay), so the bot waits near them, and
 * walks up to the ones further off. Resolves the points gained.
 */
export async function collectOrbs (bot: Bot, args: CollectOrbsArgs = {}, signal?: AbortSignal): Promise<number> {
  const radius = args.radius ?? 8
  const maxTicks = args.maxTicks ?? 200
  const before = experience(bot).points
  const near = (): Vec3 => args.near ?? bot.entity.position
  const orbs = (): Array<Bot['entities'][string]> => Object.values(bot.entities)
    .filter(e => isOrb(e) && e.position.distanceTo(near()) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    for (;;) {
      if (ticks >= maxTicks) break
      throwIfAborted(signal)
      const next = orbs()[0]
      if (next == null) break
      const gone = (): boolean => bot.entities[next.id] == null
      const distance = next.position.distanceTo(bot.entity.position)
      if (distance > 6) {
        try {
          const p = next.position.floored()
          await navigate(bot, { goal: new goals.GoalNear(p.x, p.y, p.z, 1), reached: () => gone() || next.position.distanceTo(bot.entity.position) < 2 }, signal)
        } catch (err) {
          if (isAbort(err)) throw err
        }
      } else if (distance > 1.5) {
        await walkTo(bot, next.position, { within: 0.8, maxTicks: 20, until: gone }, signal)
      }
      await waitUntil(bot, gone, 10, signal)
    }
  } finally {
    bot.off('physicsTick', onTick)
  }
  // the points come in a tick after the touch
  await waitUntil(bot, () => experience(bot).points > before, 2, signal)
  return experience(bot).points - before
}

export interface GainLevelsArgs {
  /** the level to reach */
  level: number
  /** the ways to get points, tried in this order (default ore, smelt, kill) */
  sources?: XpSource[]
  /** how far to look for ores and mobs (default 32) */
  range?: number
  /** give up after this many ticks (default 24000, 20 minutes of game time) */
  maxTicks?: number
}

export interface GainLevelsResult {
  level: number
  /** points gained */
  points: number
  /** blocks mined, items smelted and mobs killed for them */
  mined: number
  smelted: number
  killed: number
  ticks: number
}

/**
 * Gains experience until the bot's level is `level`: mines the experience ores it finds within range (coal, redstone,
 * lapis, quartz, diamond, emerald), smelts its raw ores and meat and takes the output
 * (AbstractFurnaceBlockEntity.awardUsedRecipesAndPopExperience), kills hostile mobs, and picks the orbs up after each.
 * Tracks bot.experience; throws NOT_FOUND when nothing is left to gain points from, TIMEOUT after maxTicks.
 */
export async function gainLevels (bot: Bot, args: GainLevelsArgs, signal?: AbortSignal): Promise<GainLevelsResult> {
  const sources = args.sources ?? ['ore', 'smelt', 'kill']
  const range = args.range ?? 32
  const maxTicks = args.maxTicks ?? 24000
  const start = experience(bot).points
  let ticks = 0
  let mined = 0
  let smelted = 0
  let killed = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  const result = (): GainLevelsResult => ({ level: experience(bot).level, points: experience(bot).points - start, mined, smelted, killed, ticks })
  const skipped = new Set<string>()
  const oreIds = blockIds(bot, Object.keys(XP_ORES))

  const mineOre = async (): Promise<boolean> => {
    if (oreIds.length === 0) return false
    const items = inventoryItems(bot)
    const found = findBlocks(bot, { matching: oreIds, maxDistance: range, count: 64 })
      .filter(p => !skipped.has(p.toString()))
      .map(p => bot.blockAt(p))
      .filter((b): b is NonNullable<typeof b> => b != null && harvestToolFor(b, items) !== null)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    const ore = found[0]
    if (ore == null) return false
    trace('gainLevels: mining', ore.name, ore.position.toString())
    try {
      await collectBlock(bot, { positions: [ore.position] }, signal)
      mined++
    } catch (err) {
      if (isAbort(err)) throw err
      skipped.add(ore.position.toString())
      trace('gainLevels:', ore.name, 'failed:', (err as Error).message)
    }
    await collectOrbs(bot, { near: ore.position.offset(0.5, 0.5, 0.5) }, signal)
    return true
  }

  const smeltSome = async (): Promise<boolean> => {
    const inputs = Object.keys(SMELT_XP).filter(name => countItems(bot, name) > 0 && !skipped.has(`smelt:${name}`))
      .sort((a, b) => SMELT_XP[b] * countItems(bot, b) - SMELT_XP[a] * countItems(bot, a))
    const input = inputs[0]
    if (input == null) return false
    const count = Math.min(64, countItems(bot, input))
    if (chooseFuel(inventoryItems(bot).filter(i => i.name !== input), count * 200) == null) return false
    trace('gainLevels: smelting', count, input)
    try {
      const res = await smelt(bot, { input, count }, signal)
      smelted += res.count
    } catch (err) {
      if (isAbort(err)) throw err
      skipped.add(`smelt:${input}`)
      trace('gainLevels: smelting', input, 'failed:', (err as Error).message)
      if (!isSkillError(err)) return true
    }
    await collectOrbs(bot, {}, signal)
    return true
  }

  const killMob = async (): Promise<boolean> => {
    const target = Object.values(bot.entities)
      .filter(e => e !== bot.entity && XP_MOBS.includes(e.name ?? '') && !skipped.has(`mob:${e.id}`) && e.position.distanceTo(bot.entity.position) <= range)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (target == null) return false
    trace('gainLevels: fighting', target.name, target.id)
    try {
      const res = await fight(bot, target, { signal, maxTicks: 600 })
      if (res.killed) killed++
      await collectOrbs(bot, { near: res.lastPosition }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      skipped.add(`mob:${target.id}`)
    }
    return true
  }

  try {
    while (experience(bot).level < args.level) {
      throwIfAborted(signal, result())
      if (ticks >= maxTicks) throw new SkillError('TIMEOUT', `level ${experience(bot).level} of ${args.level} after ${ticks} ticks`, result())
      let did = false
      for (const source of sources) {
        did = source === 'ore' ? await mineOre() : source === 'smelt' ? await smeltSome() : await killMob()
        if (did) break
      }
      if (!did) {
        throw new SkillError('NOT_FOUND', `level ${experience(bot).level} of ${args.level}: no ${sources.join(', ')} left to gain experience from within ${range} blocks`, result())
      }
    }
  } catch (err) {
    if (isAbort(err)) throw (err as TaskError).withPartial?.(result()) ?? err
    throw err
  } finally {
    bot.off('physicsTick', onTick)
  }
  return result()
}
