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

/** a tool the wear watch stopped a task for: the best of its kind, worn down with no spare of its tier */
export interface WornTool {
  kind: ToolKind
  material: ToolMaterial
  name: string
  uses: number
}

/** what the wear watch reads of the bot: the held item and the bag, each tick */
export interface WearSource {
  heldItem: (WornItem & { slot?: number }) | null
  inventory: { items: () => WornItem[] }
  on: (event: 'physicsTick', listener: () => void) => unknown
  removeListener: (event: 'physicsTick', listener: () => void) => unknown
}

export interface WearWatchOptions {
  /** a tool with this many uses left or fewer is worn (wornOutTools' minUses) */
  minUses: number
  /** whether the watched task is the one running now (a reflex that preempted it wears its own tools) */
  active: () => boolean
  /** a worn tool let be (its replacement failed a while ago) */
  muted?: (tool: WornTool) => boolean
  /** called once, with the tool, when the task is to stop */
  stop: (tool: WornTool) => void
}

/**
 * Watches the held tool's wear while a task runs (ItemStack.hurtAndBreak: a use takes a point of damage from the tool
 * in hand): once a use brings it to `minUses` or fewer uses left and it's the best of its kind with no other of at
 * least its tier in better shape (wornOutTools), `stop` is called, once. Only a tool seen to wear counts (the task
 * uses it); one carried worn is let be. Returns the unwatch.
 */
export function watchToolWear (source: WearSource, opts: WearWatchOptions): () => void {
  let last: { slot: number | undefined, name: string, uses: number } | null = null
  let done = false
  const onTick = (): void => {
    if (done) return
    const held = source.heldItem
    const tool = held == null ? null : parseTool(held.name)
    if (!opts.active() || held == null || tool == null) { last = null; return }
    const uses = usesLeft(held)
    const wore = last != null && last.slot === held.slot && last.name === held.name && uses < last.uses
    last = { slot: held.slot, name: held.name, uses }
    if (!wore || uses > opts.minUses) return
    const worn = wornOutTools(source.inventory.items(), { minUses: opts.minUses }).find(w => w.kind === tool.kind)
    if (worn == null) return
    const out: WornTool = { kind: worn.kind, material: worn.material, name: worn.item.name, uses: worn.uses }
    if (opts.muted?.(out) === true) return
    done = true
    source.removeListener('physicsTick', onTick)
    opts.stop(out)
  }
  source.on('physicsTick', onTick)
  return () => { done = true; source.removeListener('physicsTick', onTick) }
}

/**
 * The tiers a worn tool is replaced with, its own first, then the lower ones down to stone (a stone pickaxe digs a
 * way on where no diamond one can be made); a wooden or golden one by a wooden one or better
 */
export function replacementTiers (material: ToolMaterial): ToolMaterial[] {
  const tier = TOOL_MATERIALS[material].tier
  if (tier === 0) return ['wooden']
  const out: ToolMaterial[] = []
  for (const m of ['netherite', 'diamond', 'iron', 'stone'] as const) if (TOOL_MATERIALS[m].tier <= tier) out.push(m)
  return out
}
