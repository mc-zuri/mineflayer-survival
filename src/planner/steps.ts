import { Inventory, type ItemCount } from '../core/inventory'
import { burnTicks, SMELT_TICKS } from '../core/items'
import type { Dimension, Located } from '../core/memory'
import type { RegistryLike } from '../core/registry'
import type { CraftRecipe } from './recipes'
import { GOLD_ARMOR } from './sources'
import { itemTags } from '../core/tags'

export type Station = 'crafting_table' | 'furnace'

interface StepBase {
  /** the item the step is for */
  item: string
  /** how many of `item` it should leave in the inventory once done */
  count: number
  /** estimated ticks */
  cost: number
  /** other items it is expected to yield (the flint of gravel, the leather of a cow), and of `item` what's expected beyond `count` */
  extra?: ItemCount[]
}

/** break blocks until `count` of `item` are picked up */
export interface MineStep extends StepBase {
  kind: 'mine'
  /** the block the estimate is for */
  block: string
  /** every block that drops the item and the held tools can harvest, cheapest first */
  blocks: string[]
  /** expected blocks to break */
  blockCount: number
  /** the tool to break it with; null for the hand */
  tool: string | null
  dimension: Dimension
}

export interface CraftStep extends StepBase {
  kind: 'craft'
  recipe: CraftRecipe
  /** times the recipe is applied (`count` = crafts × recipe.count) */
  crafts: number
  /** the inventory items the crafts use, in total */
  ingredients: ItemCount[]
  /** needs a crafting table */
  table: boolean
}

export interface SmeltStep extends StepBase {
  kind: 'smelt'
  /** the input item (the first of `inputs`) */
  input: string
  /** what goes in, `count` in all (usually one item) */
  inputs: ItemCount[]
  fuel: ItemCount[]
  station: 'furnace'
}

export interface KillStep extends StepBase {
  kind: 'kill'
  mob: string
  /** expected kills */
  kills: number
  /** the best sword held, if any */
  weapon: string | null
  dimension: Dimension
}

/** throw gold ingots to piglins while wearing gold armor */
export interface BarterStep extends StepBase {
  kind: 'barter'
  pay: ItemCount
  /** the gold armor piece to wear */
  wear: string
}

/** take items out of a remembered chest */
export interface LootStep extends StepBase {
  kind: 'loot'
  from: Located
}

/** use buckets on a fluid source */
export interface FillStep extends StepBase {
  kind: 'fill'
  fluid: 'water' | 'lava'
  dimension: Dimension
}

/** sow a farm by water (a hoe, the seeds), and harvest it when grown: a crop's items, the seeds back */
export interface FarmStep extends StepBase {
  kind: 'farm'
  /** the crop block (wheat, carrots, potatoes, beetroots) */
  crop: string
  /** what it is sown from */
  seed: string
  /** plots sown */
  plots: number
  /** harvests to make */
  cycles: number
}

/** fish with a rod in water (the fish skill): a frozen one's ice broken open first */
export interface FishStep extends StepBase {
  kind: 'fish'
  /** expected catches */
  catches: number
  dimension: Dimension
}

export type PlanStep = MineStep | CraftStep | SmeltStep | KillStep | BarterStep | LootStep | FillStep | FarmStep | FishStep

export interface CheckResult {
  ok: boolean
  /** the first failing step, with why */
  error?: { index: number, step: PlanStep, reason: string }
  /** the inventory after the steps that ran */
  inventory: Inventory
}

function harvestNames (registry: RegistryLike, block: string): string[] | null {
  const tools = registry.blocksByName[block]?.harvestTools
  if (tools == null) return null
  return Object.keys(tools).map(id => registry.items[Number(id)]?.name).filter((n): n is string => n != null)
}

/**
 * Runs a plan against an inventory with the steps' expected yields, checking every step's
 * preconditions: tools that harvest the block, ingredients, fuel, stations, payment. The
 * skills layer can use it to recheck the rest of a plan after a step came out differently.
 */
export function checkPlan (registry: RegistryLike, steps: readonly PlanStep[], start: Inventory | Record<string, number>, stations: readonly Station[] = []): CheckResult {
  const inv = start instanceof Inventory ? start.clone() : new Inventory(registry, start)
  const hasStation = (s: Station): boolean => stations.includes(s) || inv.has(s)
  const take = (items: ItemCount[]): string | null => {
    for (const i of items) if (inv.count(i.name) < i.count) return `needs ${i.count} ${i.name}, has ${inv.count(i.name)}`
    for (const i of items) inv.remove(i.name, i.count)
    return null
  }
  const before = (step: PlanStep): string | null => {
    switch (step.kind) {
      case 'mine': {
        const harvest = harvestNames(registry, step.block)
        if (harvest != null && !harvest.some(t => inv.has(t))) return `nothing to harvest ${step.block} with`
        if (step.tool != null && !inv.has(step.tool)) return `no ${step.tool}`
        return null
      }
      case 'craft': {
        if (step.table && !hasStation('crafting_table')) return 'no crafting table'
        if (step.crafts * step.recipe.count !== step.count) return 'count is not crafts × recipe count'
        for (const ing of step.recipe.ingredients) {
          const used = step.ingredients.filter(i => ing.items.includes(i.name)).reduce((n, i) => n + i.count, 0)
          if (used !== ing.count * step.crafts) return `uses ${used} of [${ing.items.join(', ')}], the recipe needs ${ing.count * step.crafts}`
        }
        const err = take(step.ingredients)
        if (err != null) return err
        for (const r of step.recipe.remainders) inv.add(r.name, r.count * step.crafts)
        return null
      }
      case 'smelt': {
        if (!hasStation('furnace')) return 'no furnace'
        const burn = step.fuel.reduce((n, f) => n + burnTicks(f.name) * f.count, 0)
        if (burn < step.count * SMELT_TICKS) return `fuel burns ${burn} ticks, ${step.count} items need ${step.count * SMELT_TICKS}`
        if (step.inputs.reduce((n, i) => n + i.count, 0) !== step.count) return 'inputs do not add up to count'
        return take([...step.inputs, ...step.fuel])
      }
      case 'barter':
        if (!GOLD_ARMOR.some(a => inv.has(a))) return 'no gold armor to wear'
        return take([step.pay])
      case 'fill':
        return take([{ name: 'bucket', count: step.count }])
      case 'farm':
        // (a hoe only to till new plots: a farm sown already is harvested and sown again by hand; the plan for one with
        // no hoe held failed its check 'no hoe' every time, and the nether gate's food with it, five failures and the
        // game stopped, full-1.21.11-fresh-m)
        if (step.plots > 0 && inv.countAny(itemTags(registry).resolve('#hoes')) === 0) return 'no hoe'
        if (inv.count(step.seed) < step.plots) return `needs ${step.plots} ${step.seed}, has ${inv.count(step.seed)}`
        return null
      case 'fish':
        return inv.has('fishing_rod') ? null : 'no fishing_rod'
      case 'kill':
      case 'loot':
        return null
    }
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const reason = before(step)
    if (reason != null) return { ok: false, error: { index, step, reason }, inventory: inv }
    inv.add(step.item, step.count)
    for (const e of step.extra ?? []) inv.add(e.name, e.count)
  }
  return { ok: true, inventory: inv }
}
