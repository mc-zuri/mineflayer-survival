// village: a village told from what the bot sees (its bell, villagers, beds and composters by dirt paths, crops on
// farmland), noted in the memory as a point of interest with its farms' grown crops and hay bales, which the food
// plans then count on. Taking crops is fine with the villagers; a villager is never hit (it isn't a hostile, and an
// iron golem nearby turns on whoever hurts one: IronGolem's DefendVillageTargetGoal).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { normalizeDimension } from '../core/memory'
import { findBlock, findBlocks } from '../core/findBlocks'

/** blocks only villages have, one enough (a bell, VillagerProfession's job sites with paths) */
export const VILLAGE_BLOCKS = ['bell']
/** blocks villages have many of: some of each in sight together are a village */
export const VILLAGE_HINTS = ['dirt_path', 'composter', 'farmland', 'hay_block']
/** the village's food the memory keeps (the plans' SIGHTED_BLOCKS of a village) */
export const VILLAGE_FOOD = ['carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block']
/** villagers and their guards */
export const VILLAGE_MOBS = ['villager', 'iron_golem']

/** how far to look for the signs of a village */
export const VILLAGE_RADIUS = 48
/** two villages noted within this of each other are the same */
export const SAME_VILLAGE = 96

export interface VillageSigns {
  /** the bell, if seen */
  bell: Vec3 | null
  /** villagers or iron golems in sight */
  villagers: Vec3[]
  /** how many of each hint block are in sight */
  hints: Record<string, number>
}

/**
 * Whether what's in sight is a village, and where: its bell, else a villager with dirt paths or farmland about (a
 * wandering trader alone, or a path by a lone house, is none)
 */
export function villageAt (signs: VillageSigns): Vec3 | null {
  if (signs.bell != null) return signs.bell
  const h = (n: string): number => signs.hints[n] ?? 0
  if (signs.villagers.length > 0 && (h('dirt_path') >= 6 || h('farmland') >= 4)) return signs.villagers[0]
  return null
}

/** what the bot sees of a village now */
export function villageSigns (bot: Bot, radius = VILLAGE_RADIUS): VillageSigns {
  const id = (n: string): number | undefined => bot.registry.blocksByName[n]?.id
  const bellId = id('bell')
  const bell = bellId == null ? null : findBlock(bot, { matching: bellId, maxDistance: radius })?.position ?? null
  const hints: Record<string, number> = {}
  for (const n of VILLAGE_HINTS) {
    const i = id(n)
    hints[n] = i == null ? 0 : findBlocks(bot, { matching: i, maxDistance: radius, count: 16 }).length
  }
  const villagers = Object.values(bot.entities)
    .filter(e => e !== bot.entity && VILLAGE_MOBS.includes(e.name ?? '') && e.position.distanceTo(bot.entity.position) <= radius)
    .map(e => e.position.floored())
  return { bell, villagers, hints }
}

/**
 * Looks for a village about the bot and notes one found: a 'village' point of interest (unless one is noted within
 * SAME_VILLAGE), and its crops and hay bales remembered for the plans. Resolves the village's place, or null.
 */
export function noteVillage (bot: Bot, memory: WorldMemory, rememberFood: (names: readonly string[]) => void): Vec3 | null {
  const at = villageAt(villageSigns(bot))
  if (at == null) return null
  const dimension = normalizeDimension(bot.game?.dimension)
  const known = memory.getPois('village', { dimension }).some(p => new Vec3(p.x, p.y, p.z).distanceTo(at) < SAME_VILLAGE)
  if (!known) memory.addPoi('village', at, dimension)
  rememberFood(VILLAGE_FOOD)
  return at
}
