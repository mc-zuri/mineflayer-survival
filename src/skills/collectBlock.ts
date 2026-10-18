// collectBlock: break blocks (the nearest of some kinds, or given positions) and pick up what they drop.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import type { TaskError } from '../core/errors'
import { harvestToolFor } from './equipBest'
import { navigate } from './navigate'
import { nearbyDrops, pickupDrops } from './pickupDrops'
import {
  blockIds, countsDelta, eyeHeight, trace, inventoryCounts, inventoryItems, settleInventory, sumPositive, vecKey, waitTicks, waitUntil, withinReach,
  type Block, type ItemCounts
} from './util'

export interface CollectBlockArgs {
  /** block names to look for, nearest first */
  names?: string[]
  /** or these blocks, in this order */
  positions?: Vec3[]
  /** blocks to break (default: every position given, else 1) */
  count?: number
  /** how far to look for `names` (default 64) */
  maxDistance?: number
  /** pick up the drops (default true) */
  pickup?: boolean
  /**
   * Leave the bottom block of a column plant (sugar cane, cactus, bamboo) found by name, breaking the one above it, so
   * it grows back (default true)
   */
  keepBase?: boolean
}

export interface CollectBlockResult {
  /** blocks broken */
  mined: number
  positions: Vec3[]
  /** the inventory's change, by item name */
  items: ItemCounts
  /** items gained: the inventory's gains added up */
  count: number
}

/**
 * Plants that grow up from their bottom block (SugarCaneBlock, CactusBlock, BambooStalkBlock: a random tick adds a
 * block on top while the column is short enough); when one breaks, the ones over it can't survive and break too.
 */
export const COLUMN_PLANTS = new Set(['sugar_cane', 'cactus', 'bamboo'])

/**
 * The block to break to harvest the column plant at `pos` and leave its bottom block to grow back: the second one
 * from the bottom (SugarCaneBlock.canSurvive: the one above stands on its own kind). Null for a column of one.
 */
export function columnHarvestTarget (lookup: (pos: Vec3) => { name: string } | null, pos: Vec3): Vec3 | null {
  const name = lookup(pos)?.name
  if (name == null || !COLUMN_PLANTS.has(name)) return null
  let base = pos.floored()
  for (let i = 0; i < 32 && lookup(base.offset(0, -1, 0))?.name === name; i++) base = base.offset(0, -1, 0)
  const second = base.offset(0, 1, 0)
  return lookup(second)?.name === name ? second : null
}

function sameBlock (bot: Bot, pos: Vec3, type: number): boolean {
  return bot.blockAt(pos)?.type === type
}

async function digBlock (bot: Bot, block: Block): Promise<void> {
  try {
    await bot.dig(block, true, 'raycast')
  } catch (err) {
    // no face in view from here (the raycast choice): dig the face the bot looks at the block's centre through
    if (!/not in view/i.test((err as Error).message)) throw err
    await bot.dig(block, true)
  }
}

export async function collectBlock (bot: Bot, args: CollectBlockArgs, signal?: AbortSignal): Promise<CollectBlockResult> {
  if ((args.names == null || args.names.length === 0) && (args.positions == null || args.positions.length === 0)) {
    throw new SkillError('NOT_FOUND', 'collectBlock needs block names or positions')
  }
  const count = args.count ?? args.positions?.length ?? 1
  const maxDistance = args.maxDistance ?? 64
  const pickup = args.pickup ?? true
  const ids = args.names != null ? blockIds(bot, args.names) : []
  if (args.names != null && ids.length === 0) throw new SkillError('NOT_FOUND', `no blocks named ${args.names.join(', ')}`)

  const before = inventoryCounts(bot)
  const positions: Vec3[] = []
  const minedTypes: number[] = []
  const tried = new Set<string>()
  let lastFailure: SkillError | null = null
  const result = (): CollectBlockResult => {
    const items = countsDelta(before, inventoryCounts(bot))
    return { mined: positions.length, positions, items, count: sumPositive(items) }
  }

  const nextTarget = (): Block | null => {
    if (args.positions != null) {
      for (const pos of args.positions) {
        const key = vecKey(pos.floored())
        if (tried.has(key)) continue
        tried.add(key)
        const block = bot.blockAt(pos.floored())
        if (block != null && block.type !== 0 && (ids.length === 0 || ids.includes(block.type))) return block
      }
      return null
    }
    // a column plant's bottom block stays to grow back: the one above it is broken instead (and the rest falls)
    const keepBase = args.keepBase !== false
    const targets = new Map<string, Vec3>()
    for (const pos of bot.findBlocks({ matching: ids, maxDistance, count: 256 })) {
      const target = keepBase && COLUMN_PLANTS.has(bot.blockAt(pos)?.name ?? '') ? columnHarvestTarget(p => bot.blockAt(p), pos) : pos
      if (target != null) targets.set(vecKey(target), target)
    }
    const found = [...targets.values()]
      .filter(pos => !tried.has(vecKey(pos)))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    if (found.length === 0) return null
    tried.add(vecKey(found[0]))
    return bot.blockAt(found[0])
  }

  // what the blocks drop (minecraft-data's drops): the pathfinder can break one on its way (to stand where it was),
  // and its drop counts as one broken here
  const dropsOf = (id: number): string[] => (bot.registry.blocks[id]?.drops ?? [])
    .map(drop => bot.registry.items[typeof drop === 'number' ? drop : (drop as any).drop?.id ?? (drop as any).id]?.name)
    .filter((n): n is string => n != null)
  const dropNames = new Set<string>()
  for (const id of ids) for (const name of dropsOf(id)) dropNames.add(name)
  // what the broken blocks drop, the items picked up (not the sticks and saplings of leaves decaying up a tree)
  const pickupNames = (types: number[]): string[] | undefined => {
    const names = [...new Set(types.flatMap(dropsOf))]
    return names.length > 0 ? names : undefined
  }
  const gainedDrops = (): number => dropNames.size === 0 ? 0 : sumPositive(countsDelta(before, inventoryCounts(bot)), name => dropNames.has(name))
  const enough = (): boolean => positions.length >= count || gainedDrops() >= count

  while (!enough()) {
    throwIfAborted(signal, result())
    const block = nextTarget()
    if (block == null) break
    const pos = block.position

    if (harvestToolFor(block, inventoryItems(bot)) === null) {
      throw new SkillError('NO_TOOL', `${block.name} drops nothing without one of its harvest tools`, result())
    }

    // the best tool (the pathfinder's choice, the one GoalMineBlock digs with)
    bot.pathingUtil.refresh()
    const tool = bot.pathingUtil.bestHarvestingTool(block as any)
    if (tool != null && bot.heldItem?.slot !== tool.slot) {
      await settleInventory(bot, signal)
      await bot.equip(tool, 'hand')
    }

    const gone = (): boolean => !sameBlock(bot, pos, block.type)
    trace('collectBlock: target', block.name, pos.toString(), 'from', bot.entity.position.toString(), 'tool', tool?.name ?? 'hand')
    if (!withinReach(bot, pos)) {
      try {
        // GoalMineBlock digs the block once there (its onFinish)
        const goal = goals.GoalMineBlock.fromBlock(bot.pathfinder.world, block as any, 4, eyeHeight(bot))
        await navigate(bot, { goal, reached: () => gone() || withinReach(bot, pos) }, signal)
      } catch (err) {
        if (isAbort(err)) throw (err as TaskError).withPartial?.(result()) ?? err
        if (!gone() && !withinReach(bot, pos)) {
          lastFailure = err instanceof SkillError ? err : new SkillError('NO_PATH', (err as Error).message, undefined, { cause: err })
          continue
        }
      }
    }

    if (!gone()) {
      const current = bot.blockAt(pos)
      if (current == null) continue
      try {
        await digBlock(bot, current)
      } catch (err) {
        lastFailure = new SkillError('VERIFY_FAILED', `digging ${block.name} at ${pos.toString()} failed: ${(err as Error).message}`, undefined, { cause: err })
        continue
      }
    }
    // the client breaks the block at once (its prediction); the server puts it back if it refuses the break
    await waitTicks(bot, 2, signal)
    if (!gone()) {
      lastFailure = new SkillError('VERIFY_FAILED', `${block.name} at ${pos.toString()} is still there after digging it`)
      continue
    }
    positions.push(pos)
    trace('collectBlock: broke', block.name, pos.toString(), 'from', bot.entity.position.toString())
    minedTypes.push(block.type)

    if (pickup) {
      // Block.dropResources: the drops spawn on the break, the bot hears of them a tick or two later
      const centre = pos.offset(0.5, 0.5, 0.5)
      if ((bot.registry.blocks[block.type]?.drops?.length ?? 0) > 0) await waitUntil(bot, () => nearbyDrops(bot, centre, 3).length > 0, 10, signal)
      const picked = await pickupDrops(bot, { near: centre, radius: 6, names: pickupNames([block.type]) }, signal)
      trace('collectBlock: picked up', picked.items)
    }
  }
  // drops that fell or showed up late, around every block broken
  if (pickup) {
    for (const pos of positions) {
      const names = pickupNames(minedTypes)
      if (nearbyDrops(bot, pos.offset(0.5, 0.5, 0.5), 8, names).length > 0) await pickupDrops(bot, { near: pos.offset(0.5, 0.5, 0.5), radius: 8, names }, signal)
    }
  }

  const res = result()
  if (!enough()) {
    const missing = `broke ${positions.length} of ${count} blocks`
    if (lastFailure != null) throw new SkillError(lastFailure.reason, `${missing}: ${lastFailure.message}`, res, { cause: lastFailure })
    throw new SkillError('NOT_FOUND', `${missing}: no more ${args.names?.join(', ') ?? 'blocks'} found`, res)
  }
  // (minecraft-data's drops: empty for the blocks that drop nothing without silk touch, as glass)
  const dropsSomething = minedTypes.some(type => (bot.registry.blocks[type]?.drops?.length ?? 0) > 0)
  if (pickup && res.count === 0 && dropsSomething) {
    throw new SkillError('VERIFY_FAILED', `broke ${positions.length} blocks but no item came into the inventory`, res)
  }
  return res
}

export interface HarvestSugarCaneArgs {
  /** sugar cane wanted (default 3: a craft of paper) */
  count?: number
  /** how far to look (default 64) */
  maxDistance?: number
}

/**
 * Sugar cane from the columns nearby (it grows only beside water: SugarCaneBlock.canSurvive), the bottom block of
 * each left to grow back.
 */
export async function harvestSugarCane (bot: Bot, args: HarvestSugarCaneArgs = {}, signal?: AbortSignal): Promise<CollectBlockResult> {
  return await collectBlock(bot, { names: ['sugar_cane'], count: args.count ?? 3, maxDistance: args.maxDistance, keepBase: true }, signal)
}
