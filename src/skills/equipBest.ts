// equipBest: the best item of a category into the hand, and the tool choice behind it (pure, for the unit tests).
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { SkillError, throwIfAborted } from './errors'
import { inventoryItems, type Block } from './util'

export type ToolCategory = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | 'shears'

/**
 * The tiers best first, as ToolMaterial ranks them (netherite, diamond, iron, copper, stone, gold, wood): gold digs
 * fast but harvests only what wood does, and wears out first.
 */
export const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'copper', 'stone', 'golden', 'wooden'] as const

export function toolCategory (name: string): ToolCategory | null {
  if (name === 'shears') return 'shears'
  const match = /_(pickaxe|axe|shovel|hoe|sword)$/.exec(name)
  return match != null ? match[1] as ToolCategory : null
}

/** 0 for the best tier, higher for worse ones; -1 when the name isn't a tiered tool */
export function toolTier (name: string): number {
  const material = name.slice(0, name.lastIndexOf('_'))
  return (TOOL_TIERS as readonly string[]).indexOf(material)
}

function remainingDurability (item: Item): number {
  const max = item.maxDurability ?? 0
  return max - (item.durabilityUsed ?? 0)
}

/** the best item of the category among `items`: the best tier, then the most durability left */
export function chooseBest (items: Item[], category: ToolCategory): Item | null {
  let best: Item | null = null
  for (const item of items) {
    if (toolCategory(item.name) !== category) continue
    if (best == null) {
      best = item
      continue
    }
    const tier = toolTier(item.name)
    const bestTier = toolTier(best.name)
    if (tier < bestTier || (tier === bestTier && remainingDurability(item) > remainingDurability(best))) best = item
  }
  return best
}

/**
 * Whether the block drops anything when broken with `item` in hand (Player.hasCorrectToolForDrops: blocks that need a
 * tool list it in minecraft-data's harvestTools).
 */
export function canHarvestWith (block: Pick<Block, 'harvestTools'>, item: Pick<Item, 'type'> | null): boolean {
  const tools = block.harvestTools
  if (tools == null) return true
  return item != null && Boolean(tools[item.type])
}

/** an item among `items` the block drops something with, or null; undefined when the bare hand does */
export function harvestToolFor (block: Pick<Block, 'harvestTools'>, items: Item[]): Item | null | undefined {
  if (block.harvestTools == null) return undefined
  return items.find(item => canHarvestWith(block, item)) ?? null
}

export interface EquipBestArgs {
  category: ToolCategory
  destination?: 'hand' | 'off-hand'
}

export async function equipBest (bot: Bot, args: EquipBestArgs, signal?: AbortSignal): Promise<Item> {
  throwIfAborted(signal)
  const destination = args.destination ?? 'hand'
  const best = chooseBest(inventoryItems(bot), args.category)
  if (best == null) throw new SkillError('MISSING_ITEMS', `no ${args.category} in the inventory`)
  await bot.equip(best, destination)
  const held = destination === 'hand' ? bot.heldItem : bot.inventory.slots[45]
  if (held?.name !== best.name) throw new SkillError('VERIFY_FAILED', `${best.name} isn't in the ${destination} after equipping it`)
  return held
}
