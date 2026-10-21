// Shared helpers of the skills: waiting in game ticks (so the skills keep working when the server runs in lockstep,
// faster than 50 ms a tick), and counting the inventory to check a skill's result.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { SkillError, abortError, throwIfAborted } from './errors'

export type Block = NonNullable<ReturnType<Bot['blockAt']>>

/** a trace of what the skills do, on stderr when SURVIVAL_DEBUG is set */
export function trace (...args: unknown[]): void {
  if (process.env.SURVIVAL_DEBUG != null && process.env.SURVIVAL_DEBUG !== '') console.error('[skills]', ...args)
}

/** waits `ticks` client ticks (mineflayer's physicsTick, one per server tick under lockstep) */
export async function waitTicks (bot: Bot, ticks: number, signal?: AbortSignal): Promise<void> {
  await waitUntil(bot, () => false, ticks, signal)
}

/**
 * Checks `done` now and after each client tick, for up to `maxTicks` ticks.
 * Resolves true once it holds, false when the ticks run out; rejects with ABORTED when the signal fires.
 */
export async function waitUntil (bot: Bot, done: () => boolean, maxTicks: number, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  if (done()) return true
  if (maxTicks <= 0) return false
  return await new Promise<boolean>((resolve, reject) => {
    let ticks = 0
    const cleanup = (): void => {
      bot.off('physicsTick', onTick)
      bot.off('end', onEnd)
      signal?.removeEventListener('abort', onAbort)
    }
    const onTick = (): void => {
      ticks++
      let ok: boolean
      try {
        ok = done()
      } catch (err) {
        cleanup()
        reject(err)
        return
      }
      if (ok || ticks >= maxTicks) {
        cleanup()
        resolve(ok)
      }
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortError(signal))
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('the bot disconnected'))
    }
    bot.on('physicsTick', onTick)
    bot.on('end', onEnd)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const INVENTORY_PACKETS = ['set_slot', 'window_items', 'set_player_inventory', 'set_cursor_item']

/**
 * Waits for the server's inventory updates to stop (`quietTicks` ticks without one, up to `maxTicks`). Each update
 * the server sends bumps its menu's state id (AbstractContainerMenu.incrementStateId: an item used up by placing it,
 * picked up, worn down): a click sent before it arrives carries a state id behind the server's and is answered with
 * the whole menu as it was then (broadcastFullState), undoing the clicks made since. So a run of clicks starts once
 * the inventory has settled.
 */
export async function settleInventory (bot: Bot, signal?: AbortSignal, quietTicks = 2, maxTicks = 20): Promise<void> {
  let quiet = 0
  const onPacket = (): void => { quiet = -1 }
  for (const name of INVENTORY_PACKETS) bot._client.on(name, onPacket)
  try {
    await waitUntil(bot, () => ++quiet >= quietTicks, maxTicks, signal)
  } finally {
    for (const name of INVENTORY_PACKETS) bot._client.off(name, onPacket)
  }
}

/**
 * Has the server send the whole of the open menu (the inventory when none is open), so the inventory the skill checks
 * is the server's: a click on no slot (-1, which AbstractContainerMenu.doClick ignores) with a state id behind the
 * server's, which ServerGamePacketListenerImpl.handleContainerClick answers with broadcastFullState. From 1.17.1 (the
 * state id); before, and with an item on the cursor, it does nothing.
 */
export async function resyncInventory (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const window = bot.currentWindow ?? bot.inventory
  if (!bot.supportFeature('stateIdUsed') || window.selectedItem != null) return false
  let synced = false
  const onItems = (packet: any): void => { if (packet.windowId === window.id) synced = true }
  bot._client.on('window_items', onItems)
  try {
    bot._client.write('window_click', {
      windowId: window.id,
      stateId: ((bot as any)._stateId ?? 0) - 1,
      slot: -1,
      mouseButton: 0,
      mode: 0,
      changedSlots: [],
      // the empty cursor: no stack from 1.21.5 (HashedStack.EMPTY), an empty slot before
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cursorItem: (bot.registry as any).version['>=']('1.21.5') === true ? undefined : require('prismarine-item')(bot.registry).toNotch(null)
    })
    return await waitUntil(bot, () => synced, 20, signal)
  } finally {
    bot._client.off('window_items', onItems)
  }
}

export type ItemFilter = string | string[] | ((item: Item) => boolean)

export function itemMatcher (filter: ItemFilter): (item: Item) => boolean {
  if (typeof filter === 'function') return filter
  const names = new Set(typeof filter === 'string' ? [filter] : filter)
  return item => names.has(item.name)
}

/** the items of the inventory: the 36 main slots and the off hand (armor and the crafting grid left out) */
export function inventoryItems (bot: Bot): Item[] {
  const items = bot.inventory.items()
  const offhand = bot.inventory.slots[45]
  if (offhand != null && !items.includes(offhand)) items.push(offhand)
  return items
}

export function countItems (bot: Bot, filter: ItemFilter): number {
  const matches = itemMatcher(filter)
  let count = 0
  for (const item of inventoryItems(bot)) if (matches(item)) count += item.count
  return count
}

export type ItemCounts = Record<string, number>

export function inventoryCounts (bot: Bot): ItemCounts {
  const counts: ItemCounts = {}
  for (const item of inventoryItems(bot)) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

/** after - before, by item name, the names that didn't change left out */
export function countsDelta (before: ItemCounts, after: ItemCounts): ItemCounts {
  const delta: ItemCounts = {}
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] ?? 0) - (before[name] ?? 0)
    if (d !== 0) delta[name] = d
  }
  return delta
}

export function sumPositive (counts: ItemCounts, filter?: (name: string) => boolean): number {
  let sum = 0
  for (const [name, count] of Object.entries(counts)) if (count > 0 && (filter == null || filter(name))) sum += count
  return sum
}

/** the slots of the 36 main slots that are empty (an item can always be picked up into them) */
export function emptySlots (bot: Bot): number {
  let empty = 0
  for (let slot = bot.inventory.inventoryStart; slot < bot.inventory.inventoryEnd; slot++) if (bot.inventory.slots[slot] == null) empty++
  return empty
}

export function itemId (bot: Bot, name: string): number {
  const item = bot.registry.itemsByName[name]
  if (item == null) throw new SkillError('NOT_FOUND', `no item named ${name} in ${bot.version}`)
  return item.id
}

export function findInventoryItem (bot: Bot, filter: ItemFilter): Item | null {
  const matches = itemMatcher(filter)
  return inventoryItems(bot).find(matches) ?? null
}

/** the bot's eyes (Entity.getEyePosition) */
export function eyePosition (bot: Bot): Vec3 {
  return bot.entity.position.offset(0, eyeHeight(bot), 0)
}

/** the height of the bot's eyes over its feet (1.62 standing, 1.27 sneaking) */
export function eyeHeight (bot: Bot): number {
  return (bot.entity as any).eyeHeight ?? 1.62
}

/** vanilla's block interaction range (Player.blockInteractionRange, the attribute's default 4.5) */
export function blockReach (bot: Bot): number {
  const attribute = (bot.entity as any).attributes?.['minecraft:block_interaction_range'] ?? (bot.entity as any).attributes?.['minecraft:player.block_interaction_range']
  return typeof attribute?.value === 'number' ? attribute.value : 4.5
}

/**
 * Whether the bot can click the block from where it stands: the server's check (ServerGamePacketListenerImpl,
 * Player.isWithinBlockInteractionRange) is the distance from the eyes to the block's box, within the range + 1.
 * The client keeps to the range itself, so this does too.
 */
export function withinReach (bot: Bot, pos: Vec3, reach = blockReach(bot)): boolean {
  const eye = eyePosition(bot)
  const dx = Math.max(pos.x - eye.x, 0, eye.x - (pos.x + 1))
  const dy = Math.max(pos.y - eye.y, 0, eye.y - (pos.y + 1))
  const dz = Math.max(pos.z - eye.z, 0, eye.z - (pos.z + 1))
  return dx * dx + dy * dy + dz * dz < reach * reach
}

/**
 * Whether the bot's eyes see `point`: no block's collision box in the way (the block at `through`, the one the point
 * is on, excepted). A use the server raycasts for (a bucket's) hits what's first along the look.
 */
export function canSee (bot: Bot, point: Vec3, through?: Vec3, eye: Vec3 = eyePosition(bot)): boolean {
  const delta = point.minus(eye)
  const dist = delta.norm()
  if (dist < 1e-6) return true
  const hit: any = bot.world.raycast(eye, delta.scaled(1 / dist), dist + 1e-3)
  if (hit == null) return true
  if (through != null && (hit.position as Vec3).equals(through)) return true
  return hit.intersect != null && hit.intersect.distanceTo(eye) >= dist - 1e-4
}

export function blockAtOrThrow (bot: Bot, pos: Vec3): Block {
  const block = bot.blockAt(pos)
  if (block == null) throw new SkillError('NOT_FOUND', `the chunk at ${pos.toString()} isn't loaded`)
  return block
}

export function blockIds (bot: Bot, names: string[]): number[] {
  const ids: number[] = []
  for (const name of names) {
    const block = bot.registry.blocksByName[name]
    if (block != null) ids.push(block.id)
  }
  return ids
}

export const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air'])

export { isInfested } from '../core/infested'

/** blocks a placed block replaces (BlockBehaviour.canBeReplaced: the replaceable tag and the fluids) */
export const REPLACEABLE_BLOCKS = new Set([
  ...AIR_BLOCKS, 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine',
  'glow_lichen', 'light', 'structure_void', 'seagrass', 'tall_seagrass', 'fire', 'soul_fire', 'bush', 'short_dry_grass',
  'tall_dry_grass', 'leaf_litter', 'resin_clump', 'warped_roots', 'crimson_roots', 'nether_sprouts', 'hanging_roots',
  'bubble_column',
  // 26.3's #replaceable adds red_shrub (otherwise the same as 1.21.11's)
  'red_shrub'
])

export function vecKey (pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`
}

export const CARDINALS = [new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
export const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), ...CARDINALS]
