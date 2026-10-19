// craft: an item from the inventory, through the crafting steps mineflayer-crafting-util plans (planks, sticks, ...),
// at a crafting table nearby, or one the bot places (and crafts first, when it has none).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { buildStatic } from 'mineflayer-crafting-util'
import { SkillError, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { navigateToReach } from './navigate'
import { settlePickups } from './pickupDrops'
import { placeBlock } from './placeBlock'
import { findPlacementNear } from './placement'
import { countItems, inventoryItems, itemId, resyncInventory, settleInventory, type Block } from './util'
import { findBlock } from '../core/findBlocks'

type CraftingFunc = Awaited<ReturnType<typeof buildStatic>>
export type CraftingPlan = ReturnType<CraftingFunc>

const planners = new WeakMap<object, Promise<CraftingFunc>>()

async function plannerFor (registry: any): Promise<CraftingFunc> {
  let planner = planners.get(registry)
  if (planner == null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Recipe } = require('prismarine-recipe')(registry)
    planner = buildStatic(Recipe)
    planners.set(registry, planner)
  }
  return await planner
}

/**
 * The crafting plan for `count` of an item from the given items: every step down to what's there (logs to planks to
 * sticks), and whether a step needs a crafting table.
 */
export async function planCraft (registry: any, available: Array<{ id: number, count: number }>, item: string, count: number): Promise<CraftingPlan> {
  const planner = await plannerFor(registry)
  const wanted = registry.itemsByName[item]
  if (wanted == null) throw new SkillError('NOT_FOUND', `no item named ${item}`)
  return planner({ id: wanted.id, count }, {
    availableItems: available.map(entry => ({ ...entry })),
    careAboutExisting: false,
    includeRecursion: true,
    multipleRecipes: true
  })
}

async function planFromInventory (bot: Bot, item: string, count: number): Promise<CraftingPlan> {
  return await planCraft(bot.registry, inventoryItems(bot).map(it => ({ id: it.type, count: it.count })), item, count)
}

function describe (bot: Bot, items: Array<{ id: number, count: number }>): string {
  return items.map(it => `${it.count} ${bot.registry.items[it.id]?.name ?? it.id}`).join(', ')
}

export interface CraftArgs {
  item: string
  /** items wanted (default 1); a recipe making more gives the extra too */
  count?: number
  /** the crafting table to use (default: the nearest within `tableDistance`, else one the bot places) */
  table?: Vec3
  /** how far to look for a table (default 16) */
  tableDistance?: number
  /** break the table the bot placed and take it back once done (default false) */
  pickUpTable?: boolean
}

export interface CraftResult {
  item: string
  /** the inventory's gain of the item */
  crafted: number
  /** the table used, if a step needed one */
  table: Vec3 | null
  placedTable: boolean
}

async function getTable (bot: Bot, args: CraftArgs, signal?: AbortSignal): Promise<{ table: Block, placed: boolean }> {
  const tableId = bot.registry.blocksByName.crafting_table.id
  if (args.table != null) {
    const block = bot.blockAt(args.table)
    if (block?.type !== tableId) throw new SkillError('NOT_FOUND', `no crafting table at ${args.table.toString()}`)
    return { table: block, placed: false }
  }
  const found = findBlock(bot, { matching: tableId, maxDistance: args.tableDistance ?? 16 })
  if (found != null) return { table: found, placed: false }

  if (countItems(bot, 'crafting_table') === 0) await craft(bot, { item: 'crafting_table' }, signal)
  const pos = findPlacementNear(pos => bot.blockAt(pos), bot.entity.position)
  if (pos == null) throw new SkillError('CANNOT_PLACE', 'no room next to the bot for a crafting table')
  await placeBlock(bot, { pos, item: 'crafting_table' }, signal)
  const table = bot.blockAt(pos)
  if (table?.type !== tableId) throw new SkillError('VERIFY_FAILED', `no crafting table at ${pos.toString()} after placing it`)
  return { table, placed: true }
}

/** the crafts of one bot.craft, which a reflex waits for at most (a craft's clicks take 2 ticks or so: the grid's
 * answer and the result's) */
export const CRAFTS_PER_HOLD = 4

/**
 * bot.craft with the reflexes held back while its clicks are on their way, as a player in the inventory screen does
 * nothing else: a reflex's equip clicked in the same menu between the craft's clicks and the craft took its ingredients
 * from where they no longer were ('missing ingredient' right after the armor reflex fired, 1.21.11 seed 3). In parts
 * of CRAFTS_PER_HOLD, the abort checked between them, so a reflex waits for a part at most.
 */
export async function craftHeld (bot: Bot, recipe: any, times: number, table: Block | undefined, signal?: AbortSignal): Promise<void> {
  const engine = (bot as any).survival?.reflexes as { reflexes: Array<{ name: string }>, inhibit: (names: string[]) => () => void } | null | undefined
  for (let done = 0; done < times;) {
    throwIfAborted(signal)
    const n = Math.min(CRAFTS_PER_HOLD, times - done)
    const release = engine?.inhibit(engine.reflexes.map(r => r.name))
    try {
      await bot.craft(recipe, n, table)
    } finally {
      release?.()
    }
    done += n
  }
}

export async function craft (bot: Bot, args: CraftArgs, signal?: AbortSignal): Promise<CraftResult> {
  throwIfAborted(signal)
  const count = args.count ?? 1
  itemId(bot, args.item)
  const before = countItems(bot, args.item)
  let table: Block | null = null
  let placedTable = false
  const result = (): CraftResult => ({ item: args.item, crafted: countItems(bot, args.item) - before, table: table?.position ?? null, placedTable })

  let plan = await planFromInventory(bot, args.item, count)
  if (plan.status !== 'complete') {
    throw new SkillError('MISSING_ITEMS', `can't craft ${count} ${args.item}: short of ${describe(bot, plan.itemsRequiredBase)}`, { ...result(), plan })
  }

  if (plan.requiresCraftingTable) {
    ({ table, placed: placedTable } = await getTable(bot, args, signal))
    // the table can have taken planks the plan counted on
    if (placedTable) {
      plan = await planFromInventory(bot, args.item, count)
      if (plan.status !== 'complete') {
        throw new SkillError('MISSING_ITEMS', `can't craft ${count} ${args.item} after making the table: short of ${describe(bot, plan.itemsRequiredBase)}`, { ...result(), plan })
      }
    }
    await navigateToReach(bot, table.position, signal)
  }
  // the drops in reach in before the menu opens (a staircase stopped mid-dig by a worn pickaxe crafted its next one
  // as the last block's drops came in, and the craft failed 'the server's menu kept changing')
  if (plan.recipesToDo.length > 0) {
    await settlePickups(bot, signal)
  }

  for (const step of plan.recipesToDo) {
    throwIfAborted(signal, result())
    const recipe: any = step.recipe
    const needsTable = recipe.requiresTable === true
    if (needsTable && table == null) throw new SkillError('VERIFY_FAILED', 'the plan needs a crafting table it didn\'t ask for', result())
    const resultName = bot.registry.items[recipe.result.id]?.name ?? String(recipe.result.id)
    await settleInventory(bot, signal)
    const made = countItems(bot, resultName)
    try {
      await craftHeld(bot, recipe, step.recipeApplications, needsTable ? table ?? undefined : undefined, signal)
    } catch (err) {
      if (signal?.aborted === true) throw err
      throw new SkillError('VERIFY_FAILED', `crafting ${resultName} x${step.recipeApplications} failed: ${(err as Error).message}`, result(), { cause: err })
    }
    const wanted = recipe.result.count * step.recipeApplications
    let gained = countItems(bot, resultName) - made
    if (gained < wanted) {
      // the server's answers to the clicks can still be on their way: a click behind the menu's state id is answered
      // with the whole menu as it was then (broadcastFullState), which undoes the clicks' prediction until the later
      // answers come (a pickup's slot update between two clicks). Short by what the server has, not the prediction.
      await settleInventory(bot, signal)
      await resyncInventory(bot, signal)
      gained = countItems(bot, resultName) - made
    }
    if (gained < wanted) {
      // a full bag has nowhere to put the result: NO_SPACE, which the executor makes room for (a VERIFY_FAILED it
      // took for a bad craft, three times over, and the step failed: 26.3's planks, paper and books)
      const full = (bot.inventory.emptySlotCount?.() ?? 1) === 0
      throw new SkillError(full ? 'NO_SPACE' : 'VERIFY_FAILED', `crafting ${resultName} x${step.recipeApplications} gave ${gained} of ${wanted}${full ? ': the inventory is full' : ''}`, result())
    }
  }

  // the count the server has, not the clicks' prediction of it
  await settleInventory(bot, signal)
  await resyncInventory(bot, signal)
  const res = result()
  if (res.crafted < count) throw new SkillError('VERIFY_FAILED', `crafted ${res.crafted} of ${count} ${args.item}`, res)

  if (placedTable && args.pickUpTable === true && table != null) {
    await collectBlock(bot, { positions: [table.position] }, signal)
  }
  return res
}
