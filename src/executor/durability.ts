// Tool wear: how many uses a tool has left, and which tool kinds want a new one made before the old one breaks.
import { parseTool, toolKindForMaterial, TOOL_MATERIALS, type ToolKind, type ToolMaterial } from '../core/items'
import type { RegistryLike } from '../core/registry'

export interface WornItem {
  name: string
  /** prismarine-item's: the max damage of the item (DataComponents.MAX_DAMAGE) */
  maxDurability?: number | null
  /** prismarine-item's: the damage taken (DataComponents.DAMAGE) */
  durabilityUsed?: number | null
}

/** uses left before the item breaks (ItemStack.hurtAndBreak breaks it when the damage reaches the max); Infinity for an item that doesn't wear */
export function usesLeft (item: WornItem): number {
  const max = item.maxDurability ?? 0
  if (max <= 0) return Infinity
  return max - (item.durabilityUsed ?? 0)
}

export interface WearOptions {
  /** make a new one when the best tool of the kind has this many uses left or fewer (default 12) */
  minUses?: number
}

/**
 * The tool kinds to make a new tool of before going on: those whose best tool held (by harvest tier) has `minUses` or
 * fewer uses left, with no other tool of at least its tier in better shape. One entry per kind, with the worn tool.
 */
export function wornOutTools (items: readonly WornItem[], opts: WearOptions = {}): Array<{ kind: ToolKind, material: ToolMaterial, item: WornItem, uses: number }> {
  const minUses = opts.minUses ?? 12
  const byKind = new Map<ToolKind, WornItem[]>()
  for (const item of items) {
    const tool = parseTool(item.name)
    if (tool == null) continue
    const list = byKind.get(tool.kind) ?? []
    list.push(item)
    byKind.set(tool.kind, list)
  }
  const out: Array<{ kind: ToolKind, material: ToolMaterial, item: WornItem, uses: number }> = []
  for (const [kind, list] of byKind) {
    const tier = (i: WornItem): number => TOOL_MATERIALS[(parseTool(i.name) as { material: ToolMaterial }).material].tier
    const top = Math.max(...list.map(tier))
    const best = list.filter(i => tier(i) === top).sort((a, b) => usesLeft(b) - usesLeft(a))[0]
    const uses = usesLeft(best)
    if (uses <= minUses) out.push({ kind, material: (parseTool(best.name) as { material: ToolMaterial }).material, item: best, uses })
  }
  return out
}

/** the tool kind that mines a block (its minecraft-data material), null when the hand does as well */
export function toolKindFor (registry: RegistryLike, block: string): ToolKind | null {
  return toolKindForMaterial(registry.blocksByName[block]?.material)
}
