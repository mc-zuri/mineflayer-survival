// pickupDrops: walk over the item entities near a point until they're in the inventory.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import type { TaskError } from '../core/errors'
import { navigate, walkTo } from './navigate'
import { countItems, countsDelta, emptySlots, inventoryCounts, settleInventory, trace, waitUntil, type ItemCounts } from './util'
import { keepRoom, unwantedDrop } from './bag'

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
  /**
   * Items not gone for (the route's stone over what the bag carries of it; default: what the bag's keeper says no to,
   * but the items of `names`: skills/bag.ts unwantedDrop)
   */
  unwanted?: (name: string) => boolean
}

export interface PickupDropsResult {
  /** item entities picked up */
  picked: number
  /** the inventory's gain, by item name */
  items: ItemCounts
}

function droppedName (entity: Entity): string | null {
  // (an item entity whose item hasn't come yet, its metadata still to follow its spawn: prismarine-entity's
  // getDroppedItem reads undefined and throws, which ended a 26.3 barter, 'reading present')
  try {
    const item = (entity as any).getDroppedItem?.()
    return item?.name ?? null
  } catch {
    return null
  }
}

export function isItemEntity (entity: Entity): boolean {
  return entity.name === 'item' || entity.displayName === 'Item'
}

/**
 * The item entities near a point (of `names`, else any), the nearest to the bot first; never what the bot threw away
 * itself (isThrownDrop), nor an item `unwanted` says no to
 */
export function nearbyDrops (bot: Bot, near: Vec3, radius: number, names?: string[], unwanted?: (name: string) => boolean): Entity[] {
  const wanted = names != null ? new Set(names) : null
  return Object.values(bot.entities)
    .filter(entity => {
      if (entity === bot.entity || !isItemEntity(entity) || (entity as any).isValid === false || entity.position.distanceTo(near) > radius) return false
      const name = droppedName(entity)
      if (wanted != null && !wanted.has(name ?? '')) return false
      if (name != null && unwanted?.(name) === true) return false
      return !isThrownDrop(bot, entity, name)
    })
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

/** ticks an item lies on the ground before it despawns (ItemEntity.LIFETIME) */
export const ITEM_LIFETIME = 6000

/**
 * Ticks a thrown item can't be picked up, by anyone, the thrower too (Player.drop: ItemEntity.setPickUpDelay(40)); a
 * block's drop has 10 (Block.popResource: ItemEntity.setDefaultPickUpDelay)
 */
export const THROWN_PICKUP_DELAY = 40

/** how far from where a thrown item was last seen one of the same name counts as it, once its entity is gone (a new id) */
export const THROWN_RADIUS = 2

interface Thrown { name: string, pos: Vec3, tick: number, untilGone?: boolean }

/** what the bot threw away and lies on the ground still, by entity id (the bot's tick count when thrown) */
const thrownDrops = new WeakMap<Bot, Map<number, Thrown>>()

/**
 * Whether the item entity is one the bot threw away (markThrown) less than ITEM_LIFETIME ago: its entity, or, once
 * that's gone from the client's entities (not picked up), an item of its name within THROWN_RADIUS of where it lay (its
 * chunk saved and loaded again gives it another id). The pickups after a block mined went back for the cobblestone
 * just thrown away for room, and the bag was full again.
 */
export function isThrownDrop (bot: Bot, drop: Entity, name: string | null = droppedName(drop)): boolean {
  const thrown = thrownDrops.get(bot)
  if (thrown == null || thrown.size === 0) return false
  const now = tickCount(bot)
  for (const [id, t] of thrown) if (now - t.tick >= ITEM_LIFETIME) thrown.delete(id)
  const own = thrown.get(drop.id)
  if (own != null) {
    own.pos = drop.position.clone()
    return true
  }
  if (name == null) return false
  for (const [id, t] of thrown) if (t.untilGone !== true && t.name === name && bot.entities[id] == null && t.pos.distanceTo(drop.position) <= THROWN_RADIUS) return true
  return false
}

/**
 * Remembers an item entity the bot threw away (isThrownDrop); `untilGone`: only while its entity is there (a stack
 * thrown into lava burns, and the drops of the blocks dug there after are no thrown ones)
 */
export function markThrown (bot: Bot, drop: Entity, name: string, untilGone = false): void {
  let thrown = thrownDrops.get(bot)
  if (thrown == null) {
    const map = new Map<number, Thrown>()
    thrownDrops.set(bot, thrown = map)
    // one the bot picked up (walking over it) lies there no more
    bot.on('playerCollect', (collector: Entity, collected: Entity) => { if (collector === bot.entity) map.delete(collected.id) })
    bot.on('entityGone', (gone: Entity) => { if (map.get(gone.id)?.untilGone === true) map.delete(gone.id) })
  }
  thrown.set(drop.id, { name, pos: drop.position.clone(), tick: tickCount(bot), ...(untilGone ? { untilGone } : {}) })
}

/** the item entities lying about now, by id (to tell the ones a toss makes) */
export function itemEntityIds (bot: Bot): Set<number> {
  return new Set(Object.values(bot.entities).filter(e => e !== bot.entity && isItemEntity(e)).map(e => e.id))
}

/**
 * The yaw to throw along with no pit to throw into: the way with the most room at head height (a stack thrown at a wall
 * falls at the bot's feet, and is picked up again once its 40 ticks are up), behind the bot first
 */
export function tossYaw (bot: Bot): number {
  const feet = bot.entity.position.floored()
  const open = (p: Vec3): boolean => { const b = bot.blockAt(p); return b == null || b.boundingBox === 'empty' }
  let best = { yaw: bot.entity.yaw + Math.PI, run: -1 }
  for (const turn of [Math.PI, Math.PI / 2, -Math.PI / 2, 0]) {
    const yaw = bot.entity.yaw + turn
    // mineflayer's yaw: 0 looks to -z, pi/2 to -x
    const dx = Math.round(-Math.sin(yaw))
    const dz = Math.round(-Math.cos(yaw))
    let run = 0
    while (run < 4 && open(feet.offset(dx * (run + 1), 1, dz * (run + 1)))) run++
    if (run > best.run) best = { yaw, run }
  }
  return best.yaw
}

/**
 * Throws `count` of an item away and remembers the item entities that came of it (markThrown), so no pickup goes back
 * for them: along a look given (a throw into lava, explore.ts lavaThrow; into a pit, `pit` set, explore.ts pitThrow);
 * into the pit `into` (a cell beside the bot under its floor, explore.ts dumpPit), aimed at its far side (Player.drop
 * throws along the look at 0.3 a tick, give or take 0.1 up or down) where the bot walking by doesn't touch it; else
 * level, the way with the most room (tossYaw), some 3 blocks off. Resolves the count thrown.
 */
export async function tossAway (bot: Bot, name: string, count: number, signal?: AbortSignal, into?: Vec3 | { yaw: number, pitch: number, pit?: Vec3 }): Promise<number> {
  const id = bot.registry.itemsByName[name]?.id
  if (id == null || count <= 0) return 0
  const before = itemEntityIds(bot)
  const had = countItems(bot, name)
  if (into != null && !(into instanceof Vec3)) {
    await bot.look(into.yaw, into.pitch, true)
  } else if (into != null) {
    const feet = bot.entity.position.floored()
    const dx = Math.sign(into.x - feet.x)
    const dz = Math.sign(into.z - feet.z)
    await bot.lookAt(new Vec3(into.x + 0.5 + dx * 0.35, into.y + 0.1, into.z + 0.5 + dz * 0.35), true)
  } else {
    await bot.look(tossYaw(bot), 0, true)
  }
  await settleInventory(bot, signal)
  await bot.toss(id, null, Math.min(count, had))
  // the item entity comes a tick or two after the click (ServerboundContainerClickPacket, then the entity's spawn and
  // its item's data)
  const ours = (): Entity[] => Object.values(bot.entities).filter(e => !before.has(e.id) && isItemEntity(e) && e.position.distanceTo(bot.entity.position) <= 6 && droppedName(e) === name)
  await waitUntil(bot, () => ours().length > 0, 10, signal)
  // (into lava: it burns, Entity.lavaHurt)
  const burns = into != null && !(into instanceof Vec3) && into.pit == null
  for (const e of ours()) markThrown(bot, e, name, burns)
  const thrown = Math.max(0, had - countItems(bot, name))
  const where = into instanceof Vec3 ? `into ${into.toString()}` : into?.pit != null ? `into ${into.pit.toString()} along a look` : into != null ? 'into the lava' : 'behind'
  trace('tossAway:', thrown, name, where, 'from', bot.entity.position.toString())
  return thrown
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

/**
 * The height an item comes to rest at in its landing cell: on top of what fills the cell part way (a dirt path or
 * farmland at 15/16, a slab, snow), else the cell's floor. The item on a dirt path lies at 0.9375 up, where the client's
 * stale position (the server sends an item's every 20 ticks at most) had it inside the block, and the bot standing
 * on it was taken for not touching it (the eyes thrown at seed 2's spawn).
 */
export function restingY (blockAt: (pos: Vec3) => { boundingBox: string, shapes?: number[][] } | null, cell: Vec3): number {
  const b = blockAt(cell)
  if (b == null || b.boundingBox === 'empty' || b.shapes == null || b.shapes.length === 0) return cell.y
  return cell.y + Math.min(1, Math.max(...b.shapes.map(s => s[4])))
}

/** ticks a drop the bot couldn't get to is passed over by the pickups after (unless it moved): a minute */
export const UNREACHABLE_DROP_TICKS = 1200

/** the drops given up on, by entity id: where each lay and when (the bot's tick count, the lockstep client's or the world's age) */
const unreachableDrops = new WeakMap<Bot, Map<number, { pos: Vec3, tick: number }>>()

function tickCount (bot: Bot): number {
  return (bot as any).lockstep?.ticks ?? Number(bot.time?.age ?? 0)
}

/**
 * Whether a drop was given up on by an earlier pickup and still lies where it was then (within half a block), less
 * than UNREACHABLE_DROP_TICKS ago: the pickup after each block mined (collectBlock) asked again for the same item it
 * couldn't get to, and the bot walked into the same corner every time (5 times in 400 ticks on a play run).
 */
export function isUnreachableDrop (bot: Bot, drop: Entity): boolean {
  const given = unreachableDrops.get(bot)?.get(drop.id)
  if (given == null) return false
  if (tickCount(bot) - given.tick >= UNREACHABLE_DROP_TICKS || given.pos.distanceTo(drop.position) > 0.5) {
    unreachableDrops.get(bot)?.delete(drop.id)
    return false
  }
  return true
}

/** remembers a drop the bot couldn't get to (isUnreachableDrop) */
export function markUnreachableDrop (bot: Bot, drop: Entity): void {
  let given = unreachableDrops.get(bot)
  if (given == null) unreachableDrops.set(bot, given = new Map())
  given.set(drop.id, { pos: drop.position.clone(), tick: tickCount(bot) })
}

/** the bag's keeper's room for a full bag (keepRoom); whether it was asked */
async function keepRoomFor (bot: Bot, signal?: AbortSignal, toward?: Vec3): Promise<boolean> {
  try {
    return await keepRoom(bot, signal, toward)
  } catch (err) {
    if (isAbort(err)) throw err
    return true
  }
}

export async function pickupDrops (bot: Bot, args: PickupDropsArgs = {}, signal?: AbortSignal): Promise<PickupDropsResult> {
  const near = args.near ?? bot.entity.position.clone()
  const radius = args.radius ?? 8
  const wait = args.waitTicks ?? 30
  const before = inventoryCounts(bot)
  const skipped = new Set<number>()
  let picked = 0
  const result = (): PickupDropsResult => ({ picked, items: countsDelta(before, inventoryCounts(bot)) })
  const unwanted = args.unwanted ?? ((name: string): boolean => args.names?.includes(name) !== true && unwantedDrop(bot, name))
  // the bag's keeper asked for room once for a full bag (again only after it made some)
  let roomAsked = false

  for (;;) {
    throwIfAborted(signal, result())
    const drop = nearbyDrops(bot, near, radius, args.names, unwanted).find(entity => !skipped.has(entity.id) && !isUnreachableDrop(bot, entity))
    if (drop == null) break
    if (emptySlots(bot) === 0) {
      // (a stack that isn't full can still take it, so try, but don't treat a refusal as the item being gone)
      const name = droppedName(drop)
      if (name == null || !bot.inventory.items().some(item => item.name === name && item.count < item.stackSize)) {
        // room made first, by the bag's keeper (the route's stone thrown into a pit, the rest in a depot): obsidian
        // mined by a 26.3 deep lake failed its pickup 'the inventory is full' block after block, the bag full of the
        // walk's cobblestone
        if (!roomAsked && await keepRoomFor(bot, signal, drop.position)) {
          roomAsked = emptySlots(bot) === 0
          continue
        }
        throw new SkillError('NO_SPACE', 'the inventory is full', result())
      }
    }

    const gone = (): boolean => bot.entities[drop.id] == null || (drop as any).isValid === false
    trace('pickupDrops:', droppedName(drop), 'at', drop.position.toString(), 'bot at', bot.entity.position.toString())
    // where the item lies, or falls to (the bot doesn't see a block's drop fall: the server moves it, and tells the
    // client every 20 ticks at most)
    const cell = landingCell(bot, drop.position)
    const floor = restingY(p => bot.blockAt(p) as any, cell)
    const rest = (): Vec3 => new Vec3(drop.position.x, Math.max(floor, Math.min(drop.position.y, cell.y)), drop.position.z)
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
      markUnreachableDrop(bot, drop)
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
