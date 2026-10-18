// storeItems / retrieveItems: move items into or out of a chest (or a barrel, any container mineflayer opens),
// checked against both the inventory and the container.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { navigateToReach } from './navigate'
import { blockAtOrThrow, countsDelta, itemMatcher, settleInventory, type ItemCounts, type ItemFilter } from './util'

export interface ChestArgs {
  chest: Vec3
  /** the items to move: a name, names, or a test (default: everything) */
  filter?: ItemFilter
  /** at most this many items of each kind (default: all of them) */
  count?: number
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

async function transfer (bot: Bot, args: ChestArgs, direction: 'store' | 'retrieve', signal?: AbortSignal): Promise<ChestResult> {
  throwIfAborted(signal)
  const block = blockAtOrThrow(bot, args.chest.floored())
  await navigateToReach(bot, block.position, signal)
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
    for (const [name, total] of Object.entries(wanted)) {
      throwIfAborted(signal, { chest: block.position, moved: countsDelta(before, countBy(window.items())) })
      const count = Math.min(total, args.count ?? total)
      const type = bot.registry.itemsByName[name].id
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
