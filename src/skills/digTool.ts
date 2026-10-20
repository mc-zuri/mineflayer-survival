// The pickaxe a dig takes: a stone one for what a stone one harvests (stone, deepslate, coal, iron, copper and lapis
// ore), the iron one saved for the ores that need it (diamond, redstone, gold, emerald), as players dig a staircase and
// a strip mine with stone pickaxes and keep the iron one for the ores. Every dig goes by the pathfinder's tool choice
// (PathingUtil.bestHarvestingTool and currentHarvestingTool: GoalMineBlock's, the pathfinder's digs on the way,
// collectBlock's, the staircases' and tunnels'), so the choice is made there. In rt-1 and grim-2 (1.21.11) the iron
// pickaxe dug the staircase down to the diamonds' level and broke on the way (y 46 and y 3), the stone one in the bag.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { usesLeft } from '../executor/durability'
import { toolTier } from './equipBest'

/** the pickaxes a stone one digs for where it harvests as well: iron's 250 uses kept for the ores that need it */
export const SAVED_PICKAXES: ReadonlySet<string> = new Set(['iron_pickaxe'])

/** the pickaxe that digs the rest */
export const DIGGING_PICKAXE = 'stone_pickaxe'

/** a block as the tool choice sees it: minecraft-data's harvest tools (item ids), none when the hand harvests it */
export interface DugBlock {
  harvestTools?: Partial<Record<string, boolean>> | null
}

/**
 * The tool a dig takes, of the `chosen` (the fastest: the pathfinder's), `items` the bag's: a saved pickaxe (iron)
 * gives way to a stone one carried, the most worn first (its slot freed soonest), where the stone one harvests the
 * block too (no harvest tools, or the stone pickaxe among them); else the chosen. A stone pickaxe broken leaves the
 * iron one to dig on (the dug routes make another: explore.ts pickaxeKeeper).
 */
export function diggingTool<T extends Pick<Item, 'name' | 'type'> & { maxDurability?: number | null, durabilityUsed?: number | null }> (block: DugBlock | null, chosen: T | null, items: readonly T[], stoneId: number | null): T | null {
  if (chosen == null || block == null || !SAVED_PICKAXES.has(chosen.name)) return chosen
  const tools = block.harvestTools
  if (tools != null && (stoneId == null || !(tools[stoneId] ?? false))) return chosen
  const stone = items
    .filter(i => i.name === DIGGING_PICKAXE && usesLeft(i) > 0)
    .sort((a, b) => usesLeft(a) - usesLeft(b))[0]
  return stone ?? chosen
}

/**
 * The pathfinder's tool choice (bot.pathingUtil) made to save the iron pickaxe (diggingTool), but while a reflex runs
 * (a task above priority 0: the way out of lava, water or a fight is dug as fast as it goes). Once per bot.
 */
export function saveBetterPickaxes (bot: Bot): void {
  const util = (bot as any).pathingUtil
  if (util == null || util.__savesPickaxes === true) return
  util.__savesPickaxes = true
  const urgent = (): boolean => ((bot as any).survival?.tasks?.current?.priority ?? 0) > 0
  const choose = (block: any, chosen: Item | null): Item | null => {
    if (urgent()) return chosen
    return diggingTool(block, chosen, bot.inventory.items(), bot.registry.itemsByName[DIGGING_PICKAXE]?.id ?? null)
  }
  for (const method of ['bestHarvestingTool', 'currentHarvestingTool'] as const) {
    const original = util[method]
    if (typeof original !== 'function') continue
    util[method] = function (this: unknown, block: any): Item | null {
      return choose(block, original.call(util, block))
    }
  }
}

/**
 * Whether the bag's best pickaxe is a saved one (iron: none better) with no stone one to dig the rest with: a dug route
 * makes one then (explore.ts pickaxeKeeper)
 */
export function wantsDiggingPickaxe (items: ReadonlyArray<{ name: string, maxDurability?: number | null, durabilityUsed?: number | null }>): boolean {
  const pickaxes = items.filter(i => i.name.endsWith('_pickaxe') && usesLeft(i) > 0)
  if (pickaxes.some(i => i.name === DIGGING_PICKAXE)) return false
  const best = pickaxes.sort((a, b) => toolTier(a.name) - toolTier(b.name))[0]
  return best != null && SAVED_PICKAXES.has(best.name)
}
