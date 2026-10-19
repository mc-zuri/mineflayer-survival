// storeItems / retrieveItems: move items into or out of a chest (or a barrel, any container mineflayer opens),
// checked against both the inventory and the container.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { navigateToReach } from './navigate'
import { collectBlock } from './collectBlock'
import { blockAtOrThrow, countsDelta, itemMatcher, settleInventory, trace, type Block, type ItemCounts, type ItemFilter } from './util'
import { protectedCounts, type ProtectOptions } from '../executor/keep'

export interface ChestArgs {
  chest: Vec3
  /** the items to move: a name, names, or a test (default: everything) */
  filter?: ItemFilter
  /** at most this many items of each kind (default: all of them) */
  count?: number
  /**
   * A store leaves the bag what keep.ts protectedCounts protects (the best tool of each kind, the shield, the bow and
   * arrows, the water bucket, the food's working set), with these options; false: anything asked goes
   */
  protect?: ProtectOptions | false
}

export interface ChestResult {
  chest: Vec3
  /** items moved, by item name */
  moved: ItemCounts
}

function countBy (items: Item[]): ItemCounts {
  const counts: ItemCounts = {}
  for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

/**
 * Blocks with a full collision shape set never to conduct redstone (BlockBehaviour.Properties.isRedstoneConductor):
 * the glass, the leaves, ice. (Any other full block is taken to conduct: a block broken that didn't keep the chest
 * shut costs a dig, one left that did costs the chest)
 */
const NON_CONDUCTORS = /(glass$|glass_pane$|_leaves$|^ice$|^frosted_ice$)/

/**
 * Whether the block conducts redstone, as ChestBlock asks of the block over a chest: a block whose collision shape is
 * a full cube (BlockStateBase.isCollisionShapeFullBlock, the Properties default), but the glass, leaves, ice and the
 * other blocks set never to
 */
export function isRedstoneConductor (block: { name: string, boundingBox?: string, shapes?: number[][] } | null): boolean {
  if (block == null || block.boundingBox !== 'block' || NON_CONDUCTORS.test(block.name)) return false
  const shapes = block.shapes
  if (shapes == null) return true
  return shapes.length === 1 && shapes[0][0] <= 0 && shapes[0][1] <= 0 && shapes[0][2] <= 0 && shapes[0][3] >= 1 && shapes[0][4] >= 1 && shapes[0][5] >= 1
}

const CLOCKWISE: Record<string, [number, number]> = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }

/**
 * The cells over a chest that keep it shut: its own and, for a double chest, its other half's (ChestBlock.
 * getConnectedDirection: clockwise of the facing for the left half, counter-clockwise for the right)
 */
export function chestLids (block: { name: string, position: Vec3, getProperties?: () => Record<string, unknown> }): Vec3[] {
  const cells = [block.position.offset(0, 1, 0)]
  const props = block.getProperties?.() ?? {}
  const facing = CLOCKWISE[String(props.facing)]
  if (facing != null && (props.type === 'left' || props.type === 'right')) {
    const [dx, dz] = props.type === 'left' ? facing : [-facing[0], -facing[1]]
    cells.push(block.position.offset(dx, 1, dz))
  }
  return cells
}

/**
 * A chest with a block that conducts redstone over it (or over its other half) doesn't open (ChestBlock.
 * isChestBlockedAt, combined over both halves by DoubleBlockCombiner): the server sends no window, and mineflayer
 * waits for one 20 s. The blocks over it are broken first (their drops left: the bag is full when it stores). A 26.3
 * base's one chest stood under the stone of its wall, and every store there failed 'windowOpen did not fire', the bag
 * full of cobblestone down the mine.
 */
async function unblockChest (bot: Bot, block: Block, signal?: AbortSignal): Promise<void> {
  if (block.name !== 'chest' && block.name !== 'trapped_chest') return
  for (const cell of chestLids(block as any)) {
    const over = bot.blockAt(cell)
    if (over == null || !isRedstoneConductor(over as any)) continue
    trace('chest:', over.name, 'at', cell.toString(), 'keeps the chest at', block.position.toString(), 'shut: breaking it')
    await collectBlock(bot, { positions: [cell], anyTool: true, pickup: false }, signal)
  }
}

/**
 * How many of an item the container's slots (`intoContainer`) or the inventory's slots of the window take: the empty
 * slots' stacks and what the stacks of it lack (AbstractContainerMenu.moveItemStackTo fills those)
 */
export function roomFor (window: { slots: Array<{ type: number, count: number } | null>, inventoryStart: number, inventoryEnd: number }, type: number, stackSize: number, intoContainer: boolean): number {
  const [start, end] = intoContainer ? [0, window.inventoryStart] : [window.inventoryStart, window.inventoryEnd]
  let room = 0
  for (let i = start; i < end; i++) {
    const it = window.slots[i]
    if (it == null) room += stackSize
    else if (it.type === type) room += Math.max(0, stackSize - it.count)
  }
  return room
}

async function transfer (bot: Bot, args: ChestArgs, direction: 'store' | 'retrieve', signal?: AbortSignal): Promise<ChestResult> {
  throwIfAborted(signal)
  let block = blockAtOrThrow(bot, args.chest.floored())
  await navigateToReach(bot, block.position, signal)
  if (chestLids(block as any).some(cell => isRedstoneConductor(bot.blockAt(cell) as any))) {
    await unblockChest(bot, block, signal)
    block = blockAtOrThrow(bot, args.chest.floored())
  }
  const matches = itemMatcher(args.filter ?? (() => true))
  await settleInventory(bot, signal)
  const window = await bot.openContainer(block)
  await settleInventory(bot, signal)
  // both sides counted in the container's window (its inventory slots and its own)
  const before = countBy(window.items())
  const containerBefore = countBy(window.containerItems())
  let moved: ItemCounts = {}
  let full = false
  try {
    const source = direction === 'store' ? window.items() : window.containerItems()
    const wanted = countBy(source.filter(matches))
    // (a store leaves the bag its protected items: the bot's only diamond pickaxe in a base's chest 160 blocks off
    // was no pickaxe for the obsidian)
    if (direction === 'store' && args.protect !== false) {
      const bag = window.items().map(i => ({ name: i.name, count: i.count }))
      // (the off hand's counts with the bag's: a shield held there leaves the bag's spare free to go)
      const offhand = bot.inventory?.slots?.[45]
      if (offhand != null) bag.push({ name: offhand.name, count: offhand.count })
      const kept = protectedCounts(bag, bot.registry as any, args.protect ?? {})
      if (offhand != null && kept[offhand.name] != null) kept[offhand.name] = Math.max(0, kept[offhand.name] - offhand.count)
      for (const name of Object.keys(wanted)) wanted[name] = Math.max(0, wanted[name] - (kept[name] ?? 0))
    }
    for (const [name, total] of Object.entries(wanted)) {
      throwIfAborted(signal, { chest: block.position, moved: countsDelta(before, countBy(window.items())) })
      const type = bot.registry.itemsByName[name].id
      // no more than the other side has room for: a deposit of 28 stacks into a chest of 27 slots moved 1792 raw
      // iron out of the inventory's slots and 1728 into the chest (the last stack held on the cursor)
      const room = roomFor(window, type, bot.registry.items[type]?.stackSize ?? 64, direction === 'store')
      const count = Math.min(total, args.count ?? total, room)
      if (count < Math.min(total, args.count ?? total)) full = true
      if (count <= 0) continue
      try {
        if (direction === 'store') await window.deposit(type, null, count)
        else await window.withdraw(type, null, count)
      } catch (err) {
        // mineflayer gives up when the destination fills (what moved stays moved)
        if (!/full|no space|not enough/i.test((err as Error).message)) throw err
        full = true
        break
      }
    }
    const containerAfter = countBy(window.containerItems())
    moved = countsDelta(before, countBy(window.items()))
    for (const name of Object.keys(moved)) moved[name] = direction === 'store' ? -moved[name] : moved[name]
    // what left one side came into the other
    const container = countsDelta(containerBefore, containerAfter)
    for (const [name, n] of Object.entries(moved)) {
      if ((container[name] ?? 0) !== (direction === 'store' ? n : -n)) {
        throw new SkillError('VERIFY_FAILED', `${n} ${name} left the ${direction === 'store' ? 'inventory' : 'chest'}, ${Math.abs(container[name] ?? 0)} reached the other side`, { chest: block.position, moved })
      }
    }
  } finally {
    window.close()
  }
  const result = { chest: block.position, moved }
  if (full) throw new SkillError('NO_SPACE', direction === 'store' ? 'the chest is full' : 'the inventory is full', result)
  return result
}

export async function storeItems (bot: Bot, args: ChestArgs, signal?: AbortSignal): Promise<ChestResult> {
  return await transfer(bot, args, 'store', signal)
}

export async function retrieveItems (bot: Bot, args: ChestArgs, signal?: AbortSignal): Promise<ChestResult> {
  return await transfer(bot, args, 'retrieve', signal)
}
