// pickupDrops: walk over the item entities near a point until they're in the inventory.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import type { TaskError } from '../core/errors'
import { navigate, walkTo } from './navigate'
import { countsDelta, emptySlots, inventoryCounts, trace, waitUntil, type ItemCounts } from './util'

type Entity = Bot['entities'][string]

export interface PickupDropsArgs {
  /** where to look (default: the bot) */
  near?: Vec3
  /** how far from `near` (default 8) */
  radius?: number
  /** only these items (default: all) */
  names?: string[]
  /** ticks to wait at an item for it to be picked up (default 30: the 10 tick pickup delay of a block's drop and more) */
  waitTicks?: number
}

export interface PickupDropsResult {
  /** item entities picked up */
  picked: number
  /** the inventory's gain, by item name */
  items: ItemCounts
}

function droppedName (entity: Entity): string | null {
  const item = (entity as any).getDroppedItem?.()
  return item?.name ?? null
}

export function isItemEntity (entity: Entity): boolean {
  return entity.name === 'item' || entity.displayName === 'Item'
}

export function nearbyDrops (bot: Bot, near: Vec3, radius: number, names?: string[]): Entity[] {
  const wanted = names != null ? new Set(names) : null
  return Object.values(bot.entities)
    .filter(entity => entity !== bot.entity && isItemEntity(entity) && (entity as any).isValid !== false &&
      entity.position.distanceTo(near) <= radius && (wanted == null || wanted.has(droppedName(entity) ?? '')))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

/**
 * Whether the player standing at `player` picks up an item at `item`: Player.aiStep touches the entities its box,
 * inflated by 1 horizontally and 0.5 vertically, meets (the player 0.6 wide and 1.8 high, the item 0.25 a side).
 */
export function touches (player: Vec3, item: Vec3): boolean {
  const reach = 0.3 + 1 + 0.125
  return Math.abs(player.x - item.x) < reach && Math.abs(player.z - item.z) < reach &&
    item.y + 0.25 > player.y - 0.5 && item.y < player.y + 1.8 + 0.5
}

/**
 * A goal to stand where the bot picks up an item: next to it or on it, the bot's block's middle within a block of
 * it on each axis (the touch reaches 1.425, the pathfinder ends a move a little off its block's middle).
 */
export class GoalTouch extends goals.Goal {
  constructor (public readonly item: Vec3) {
    super()
  }

  isEnd (node: { x: number, y: number, z: number }): boolean {
    return Math.abs(node.x + 0.5 - this.item.x) <= 1 && Math.abs(node.z + 0.5 - this.item.z) <= 1 &&
      this.item.y + 0.25 > node.y - 0.5 && this.item.y < node.y + 2.3
  }

  heuristic (node: { x: number, y: number, z: number }): number {
    return this.distHeuristic(node) * (20 / 4.317)
  }

  distHeuristic (node: { x: number, y: number, z: number }): number {
    const dx = Math.max(0, Math.abs(node.x + 0.5 - this.item.x) - 1)
    const dz = Math.max(0, Math.abs(node.z + 0.5 - this.item.z) - 1)
    const dy = Math.max(0, node.y - 0.5 - this.item.y, this.item.y - (node.y + 2.3))
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
}

/** the block an item lies in, or falls to: down its column to the first block over a solid one */
export function landingCell (bot: Bot, pos: Vec3): Vec3 {
  const cell = pos.floored()
  for (let i = 0; i < 32; i++) {
    const below = bot.blockAt(cell.offset(0, -1, 0))
    if (below == null || below.boundingBox === 'block') break
    cell.y--
  }
  return cell
}

export async function pickupDrops (bot: Bot, args: PickupDropsArgs = {}, signal?: AbortSignal): Promise<PickupDropsResult> {
  const near = args.near ?? bot.entity.position.clone()
  const radius = args.radius ?? 8
  const wait = args.waitTicks ?? 30
  const before = inventoryCounts(bot)
  const skipped = new Set<number>()
  let picked = 0
  const result = (): PickupDropsResult => ({ picked, items: countsDelta(before, inventoryCounts(bot)) })

  for (;;) {
    throwIfAborted(signal, result())
    const drop = nearbyDrops(bot, near, radius, args.names).find(entity => !skipped.has(entity.id))
    if (drop == null) break
    if (emptySlots(bot) === 0) {
      // (a stack that isn't full can still take it, so try, but don't treat a refusal as the item being gone)
      const name = droppedName(drop)
      if (name == null || !bot.inventory.items().some(item => item.name === name && item.count < item.stackSize)) {
        throw new SkillError('NO_SPACE', 'the inventory is full', result())
      }
    }

    const gone = (): boolean => bot.entities[drop.id] == null || (drop as any).isValid === false
    trace('pickupDrops:', droppedName(drop), 'at', drop.position.toString(), 'bot at', bot.entity.position.toString())
    // where the item lies, or falls to (the bot doesn't see a block's drop fall: the server moves it, and tells the
    // client every 20 ticks at most)
    const cell = landingCell(bot, drop.position)
    const rest = (): Vec3 => new Vec3(drop.position.x, Math.min(drop.position.y, cell.y), drop.position.z)
    const touching = (): boolean => touches(bot.entity.position, rest())
    try {
      await navigate(bot, { goal: new GoalTouch(rest()), reached: () => gone() || touching() }, signal)
    } catch (err) {
      if (isAbort(err)) throw (err as TaskError).withPartial?.(result()) ?? err
      trace('pickupDrops: no path to', droppedName(drop), 'at', drop.position.toString(), (err as Error).message)
    }
    // the pathfinder stops near its last block: the last step at the item, when it's a few blocks off on the level
    const off = rest().minus(bot.entity.position)
    if (!gone() && !touching() && Math.hypot(off.x, off.z) < 4 && Math.abs(off.y) < 1.5) {
      await walkTo(bot, rest(), { until: () => gone() || touching() }, signal)
    }
    if (!gone() && !touching()) {
      trace('pickupDrops: no way to', droppedName(drop), 'at', drop.position.toString(), 'bot at', bot.entity.position.toString())
      skipped.add(drop.id)
      continue
    }
    if (await waitUntil(bot, gone, wait, signal)) picked++
    else {
      trace('pickupDrops: gave up on', droppedName(drop), 'at', drop.position.toString(), 'bot at', bot.entity.position.toString())
      skipped.add(drop.id)
    }
  }
  return result()
}
