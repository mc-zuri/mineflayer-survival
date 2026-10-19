import type { Bot } from 'mineflayer'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { burnTicks } from '../core/items'
import { TaskError, type SkillOptions, throwIfAborted, waitTicks } from './combatUtil'
import { findBlock } from '../core/findBlocks'

// Cooking: the raw foods and what the furnace, smoker or campfire makes of them (the smelting and smoking recipes).
export const COOKED: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp'
}

/** AbstractFurnaceBlockEntity's cooking time: 200 ticks a food in a furnace, half that in a smoker (SmokerBlockEntity). */
export const COOK_TICKS: Record<string, number> = { furnace: 200, smoker: 100 }

/** Smelts `count` of `input` and resolves with what came out (skills-gather's smelt fits). */
export type Smelter = (bot: Bot, args: { input: string, count?: number }, signal?: AbortSignal) => Promise<{ output: string | null, count: number }>

export interface CookFoodOptions extends SkillOptions {
  /** only this raw food (default: all the inventory's) */
  food?: string
  /** how many at most (default: all) */
  count?: number
  /** the smelting skill to use; default: cookNearby (a furnace or smoker within 32 blocks) */
  smelt?: Smelter
}

function countOf (bot: Bot, name: string): number {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

/** The fuel to burn for the ticks: the inventory's fuels by burn time, least wasteful first. */
export function chooseFuel (items: Array<{ name: string, count: number }>, ticks: number): { name: string, count: number } | null {
  const fuels = items.filter(i => burnTicks(i.name) > 0 && i.name !== 'lava_bucket')
  // whole items of the longest burner that's needed least of, then the rest
  fuels.sort((a, b) => burnTicks(b.name) - burnTicks(a.name))
  for (const fuel of fuels) {
    const n = Math.ceil(ticks / burnTicks(fuel.name))
    if (n <= fuel.count) return { name: fuel.name, count: n }
  }
  const best = fuels[0]
  return best == null ? null : { name: best.name, count: best.count }
}

/**
 * The default smelter: a smoker or furnace within 32 blocks, walked to, fuelled from the inventory, and emptied once
 * it's done (waiting on its ticks, not the clock).
 */
export async function cookNearby (bot: Bot, args: { input: string, count?: number }, signal?: AbortSignal): Promise<{ output: string | null, count: number }> {
  const output = COOKED[args.input] ?? null
  const ids = ['smoker', 'furnace'].map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  const block = findBlock(bot, { matching: ids, maxDistance: 32 })
  if (block == null) throw new TaskError('NOT_FOUND', 'no furnace or smoker within 32 blocks')
  const count = Math.min(args.count ?? Infinity, countOf(bot, args.input), 64)
  if (count <= 0) throw new TaskError('MISSING_ITEMS', `no ${args.input}`)
  const cookTicks = COOK_TICKS[block.name] ?? 200
  const fuel = chooseFuel(bot.inventory.items(), count * cookTicks)
  if (fuel == null) throw new TaskError('MISSING_ITEMS', 'no fuel')
  if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4) {
    await bot.pathfinder.goto(goals.GoalNear.fromBlock(block, 2))
  }
  throwIfAborted(signal)
  const before = output != null ? countOf(bot, output) : 0
  const furnace = await bot.openFurnace(block)
  try {
    const item = (name: string): number => bot.registry.itemsByName[name].id
    await furnace.putFuel(item(fuel.name), null, fuel.count)
    await furnace.putInput(item(args.input), null, count)
    // cooks one every cookTicks once lit; give it the lot and a margin
    const deadline = count * cookTicks + 100
    for (let t = 0; t < deadline; t++) {
      const out = furnace.outputItem()
      if ((out?.count ?? 0) >= count || (furnace.inputItem() == null && out != null)) break
      await waitTicks(bot, 1, signal)
    }
    if (furnace.outputItem() != null) await furnace.takeOutput()
  } finally {
    furnace.close()
  }
  const made = output != null ? countOf(bot, output) - before : 0
  if (made <= 0) throw new TaskError('TIMEOUT', `nothing came out of the ${block.name}`)
  return { output, count: made }
}

export interface CookFoodResult {
  /** cooked item to count made */
  cooked: Record<string, number>
}

/** Cooks the inventory's raw food (or the one asked for). Throws MISSING_ITEMS when there's none. */
export async function cookFood (bot: Bot, opts: CookFoodOptions = {}): Promise<CookFoodResult> {
  const smelt = opts.smelt ?? cookNearby
  const raws = Object.keys(COOKED).filter(name => (opts.food == null || opts.food === name) && countOf(bot, name) > 0)
  if (raws.length === 0) throw new TaskError('MISSING_ITEMS', `no raw ${opts.food ?? 'food'} to cook`)
  const cooked: Record<string, number> = {}
  let left = opts.count ?? Infinity
  for (const raw of raws) {
    if (left <= 0) break
    throwIfAborted(opts.signal)
    const n = Math.min(left, countOf(bot, raw))
    const result = await smelt(bot, { input: raw, count: n }, opts.signal)
    if (result.output != null) cooked[result.output] = (cooked[result.output] ?? 0) + result.count
    left -= result.count
  }
  return { cooked }
}
