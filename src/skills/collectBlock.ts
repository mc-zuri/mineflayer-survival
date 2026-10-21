// collectBlock: break blocks (the nearest of some kinds, or given positions) and pick up what they drop.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import type { TaskError } from '../core/errors'
import { harvestToolFor } from './equipBest'
import { navigate } from './navigate'
import { nearbyDrops, pickupDrops } from './pickupDrops'
import { keepRoom, unwantedDrop } from './bag'
import {
  blockIds, countsDelta, emptySlots, eyeHeight, trace, inventoryCounts, inventoryItems, settleInventory, sumPositive, vecKey, waitTicks, waitUntil, withinReach,
  type Block, type ItemCounts
} from './util'
import { dig } from '../core/actions'
import { isInfested } from '../core/infested'
import { findBlocks } from '../core/findBlocks'
import { dangerAt } from './danger'

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
  /** targets in a row the bot can't get to before it gives up (default 3) */
  maxUnreachable?: number
  /** blocks of `names` never broken (the base's walls): their positions */
  exclude?: (pos: Vec3) => boolean
  /**
   * Pass over blocks of `names` with lava beside or over them (default true): broken, the block's cell opens to the
   * lava (FlowingFluid spreads into it), and the bot that broke it stands next to it. Blocks given by `positions` are
   * passed over so only when it's true, checked as each one's turn comes (the lava one broken before let in)
   */
  avoidLava?: boolean
  /**
   * With avoidLava, blocks given by `positions` with lava only under them are broken all the same (default false): a
   * lake's obsidian lid, the lava under it not coming up into the cell (FlowingFluid spreads down and sideways)
   */
  lavaUnder?: boolean
  /**
   * Break a block with no harvest tool at hand too (by hand: stone in 150 ticks), for a way through rather than what
   * it drops (default false: NO_TOOL)
   */
  anyTool?: boolean
  /**
   * Drops not picked up (the route's stone the stock has enough of; default: what the bag's keeper says no to, but
   * the drops of the blocks asked for by name: skills/bag.ts unwantedDrop)
   */
  unwanted?: (name: string) => boolean
  /**
   * Makes room in the bag when it's short (the executor's: the junk and the route's stone thrown behind, the rest in a
   * depot): before each block, and before the pickup of a block's drops with no slot free (default: the bag's
   * keeper's, skills/bag.ts keepRoom), `toward` the block to break
   */
  room?: (toward?: Vec3) => Promise<void>
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0), new Vec3(0, -1, 0)]

/** whether lava touches the block at `pos` (a side, above, or below unless `below` is false) */
export function lavaBeside (lookup: (pos: Vec3) => { name: string } | null, pos: Vec3, below = true): boolean {
  return SIDES.some(d => (below || d.y >= 0) && lookup(pos.plus(d))?.name === 'lava')
}

/** water (or a plant that grows in it) against a face of the block: an ore under a lake or in a flooded cave */
export function waterBeside (lookup: (pos: Vec3) => { name: string } | null, pos: Vec3): boolean {
  return SIDES.some(d => WATER_BLOCKS.has(lookup(pos.plus(d))?.name ?? ''))
}
const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

export interface CollectBlockResult {
  /** blocks broken */
  mined: number
  positions: Vec3[]
  /** the inventory's change, by item name */
  items: ItemCounts
  /** items gained: the inventory's gains added up */
  count: number
  /** the targets the bot couldn't get to (no path, the walk ended out of reach): the caller's to leave a while */
  unreachable?: Vec3[]
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

async function digBlock (bot: Bot, block: Block, signal?: AbortSignal): Promise<void> {
  // only what the crosshair hits breaks: the leaves in front of a log first
  await dig(bot, block, { signal })
}

/** the swords a cobweb is broken with, the quickest first (the sword's mining speed on a web is 15 whatever it's made of) */
const SWORD_ORDER = ['wooden_sword', 'stone_sword', 'golden_sword', 'copper_sword', 'iron_sword', 'diamond_sword', 'netherite_sword']

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
  // targets in a row the bot couldn't get to, and all of them
  let unreachable = 0
  const unreached: Vec3[] = []
  // blocks broken without a harvest tool (anyTool): they drop nothing
  let toolless = 0
  const result = (): CollectBlockResult => {
    const items = countsDelta(before, inventoryCounts(bot))
    return { mined: positions.length, positions, items, count: sumPositive(items), ...(unreached.length > 0 ? { unreachable: [...unreached] } : {}) }
  }

  const nextTarget = (): Block | null => {
    if (args.positions != null) {
      for (const pos of args.positions) {
        const key = vecKey(pos.floored())
        if (tried.has(key)) continue
        tried.add(key)
        const block = bot.blockAt(pos.floored())
        // (lava there now: one of the blocks broken before let it in, FlowingFluid spreading into the cell)
        if (args.avoidLava === true && lavaBeside(p => bot.blockAt(p), pos.floored(), args.lavaUnder !== true)) {
          trace('collectBlock: passing over', block?.name, pos.toString(), ': lava against it')
          continue
        }
        if (block != null && block.type !== 0 && (ids.length === 0 || ids.includes(block.type))) return block
      }
      return null
    }
    // a column plant's bottom block stays to grow back: the one above it is broken instead (and the rest falls)
    const keepBase = args.keepBase !== false
    const targets = new Map<string, Vec3>()
    for (const pos of findBlocks(bot, { matching: ids, maxDistance, count: 256 })) {
      const target = keepBase && COLUMN_PLANTS.has(bot.blockAt(pos)?.name ?? '') ? columnHarvestTarget(p => bot.blockAt(p), pos) : pos
      if (target != null) targets.set(vecKey(target), target)
    }
    const avoidLava = args.avoidLava !== false
    // not in the deep dark's hearing (a sensor's 8 blocks: each block broken a vibration, the shriekers' call for the
    // warden) nor by pillagers in view (an outpost's hay bales: dangerAt)
    const found = [...targets.values()]
      .filter(pos => !tried.has(vecKey(pos)) && args.exclude?.(pos) !== true && !(avoidLava && lavaBeside(p => bot.blockAt(p), pos)) && !dangerAt(bot, pos))
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
  // the bag kept from filling as the blocks come in (the keeper's room and its no to the route's stone), the drops of
  // the blocks asked for by name always wanted
  const room = async (toward?: Vec3): Promise<void> => { if (args.room != null) await args.room(toward); else await keepRoom(bot, signal, toward) }
  const unwanted = args.unwanted ?? ((name: string): boolean => !dropNames.has(name) && unwantedDrop(bot, name))
  const gainedDrops = (): number => dropNames.size === 0 ? 0 : sumPositive(countsDelta(before, inventoryCounts(bot)), name => dropNames.has(name))
  const enough = (): boolean => positions.length >= count || gainedDrops() >= count

  while (!enough()) {
    throwIfAborted(signal, result())
    const block = nextTarget()
    if (block == null) break
    const pos = block.position
    // an infested block is never broken (its silverfish, and the nest it wakes: isInfested)
    if (isInfested(block.name)) {
      lastFailure = new SkillError('REFUSED', `${block.name} at ${pos.toString()} is infested (a silverfish in it): not broken`)
      continue
    }
    // the room made toward the block (the pit for what's thrown dug off the way to it), and the block there still
    await room(pos.offset(0.5, 0.5, 0.5))
    if (!sameBlock(bot, pos, block.type)) continue

    const harvestable = harvestToolFor(block, inventoryItems(bot)) !== null
    if (!harvestable && args.anyTool !== true) {
      throw new SkillError('NO_TOOL', `${block.name} drops nothing without one of its harvest tools`, result())
    }

    // the best tool (the pathfinder's choice, the one GoalMineBlock digs with)
    bot.pathingUtil.refresh()
    let tool = bot.pathingUtil.bestHarvestingTool(block as any)
    // a cobweb for its string with a sword (Blocks.COBWEB requires its tool for drops, the swords and the shears, and
    // shears drop the web itself: blocks/cobweb); the pathfinder's tools have no sword (its PathingUtil.toolsOf), and
    // a web it dug by hand dropped nothing, 'broke 3 blocks but no item came into the inventory' (26.3); its dig
    // (GoalMineBlock's) takes the sword from its memo
    if (block.name === 'cobweb') {
      const sword = inventoryItems(bot).filter(i => i.name.endsWith('_sword')).sort((a, b) => SWORD_ORDER.indexOf(a.name) - SWORD_ORDER.indexOf(b.name))[0]
      if (sword != null) {
        tool = sword
        ;(bot.pathingUtil as any).memoedBestTool[block.type] = sword
      }
    }
    if (tool != null && bot.heldItem?.slot !== tool.slot) {
      await settleInventory(bot, signal)
      await bot.equip(tool, 'hand')
    }

    const gone = (): boolean => !sameBlock(bot, pos, block.type)
    trace('collectBlock: target', block.name, pos.toString(), 'from', bot.entity.position.toString(), 'tool', tool?.name ?? 'hand')
    if (!withinReach(bot, pos)) {
      try {
        // GoalMineBlock digs the block once there (its onFinish); a cobweb is walked to and dug here, with the sword
        // (the pathfinder's dig is by hand: no sword is a tool of its, and the web drops nothing so)
        const goal = block.name === 'cobweb' ? new goals.GoalNear(pos.x, pos.y, pos.z, 2) : goals.GoalMineBlock.fromBlock(bot.pathfinder.world, block as any, 4, eyeHeight(bot))
        await navigate(bot, { goal, reached: () => gone() || withinReach(bot, pos) }, signal)
      } catch (err) {
        if (isAbort(err)) throw (err as TaskError).withPartial?.(result()) ?? err
        if (!gone() && !withinReach(bot, pos)) {
          lastFailure = err instanceof SkillError ? err : new SkillError('NO_PATH', (err as Error).message, undefined, { cause: err })
          unreached.push(pos)
          // the next nearest is most likely as far out of reach (up a cliff from a ravine): the caller decides
          if (++unreachable >= (args.maxUnreachable ?? 3)) break
          continue
        }
      }
    }

    // a walk that ended out of reach (the pathfinder's goal held 6 blocks off, 60 over a diamond) is no dig: the
    // server refuses a break out of reach, and 'still there after digging it' failed the step 77 times (26.3)
    if (!gone() && !withinReach(bot, pos)) {
      lastFailure = new SkillError('NO_PATH', `${block.name} at ${pos.toString()} is out of reach from ${bot.entity.position.floored().toString()}`)
      unreached.push(pos)
      if (++unreachable >= (args.maxUnreachable ?? 3)) break
      continue
    }
    if (!gone()) {
      const current = bot.blockAt(pos)
      if (current == null) continue
      if (tool != null && bot.heldItem?.slot !== tool.slot) await bot.equip(tool, 'hand')
      try {
        await digBlock(bot, current, signal)
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
    if (!harvestable) toolless++
    unreachable = 0
    trace('collectBlock: broke', block.name, pos.toString(), 'from', bot.entity.position.toString())
    minedTypes.push(block.type)

    if (pickup && harvestable) {
      // Block.dropResources: the drops spawn on the break, the bot hears of them a tick or two later
      const centre = pos.offset(0.5, 0.5, 0.5)
      if ((bot.registry.blocks[block.type]?.drops?.length ?? 0) > 0) await waitUntil(bot, () => nearbyDrops(bot, centre, 3).length > 0, 10, signal)
      // the walk here filled the bag (the route's cells' drops): room for the block's own first
      if (emptySlots(bot) === 0) await room(centre)
      const picked = await pickupDrops(bot, { near: centre, radius: 6, names: pickupNames([block.type]), unwanted }, signal)
      trace('collectBlock: picked up', picked.items)
    }
  }
  // drops that fell or showed up late, around every block broken
  if (pickup) {
    for (const pos of positions) {
      const names = pickupNames(minedTypes)
      if (nearbyDrops(bot, pos.offset(0.5, 0.5, 0.5), 8, names, unwanted).length > 0) await pickupDrops(bot, { near: pos.offset(0.5, 0.5, 0.5), radius: 8, names, unwanted }, signal)
    }
  }

  const res = result()
  if (!enough()) {
    const missing = `broke ${positions.length} of ${count} blocks`
    if (lastFailure != null) throw new SkillError(lastFailure.reason, `${missing}: ${lastFailure.message}`, res, { cause: lastFailure })
    throw new SkillError('NOT_FOUND', `${missing}: no more ${args.names?.join(', ') ?? 'blocks'} found`, res)
  }
  // (minecraft-data's drops: empty for the blocks that drop nothing without silk touch, as glass)
  // (and some of it wanted: the route's stone the stock has enough of is left lying)
  const dropsSomething = minedTypes.some(type => (bot.registry.blocks[type]?.drops?.length ?? 0) > 0 && !dropsOf(type).every(name => unwanted(name)))
  if (pickup && res.count === 0 && dropsSomething && toolless < positions.length) {
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
