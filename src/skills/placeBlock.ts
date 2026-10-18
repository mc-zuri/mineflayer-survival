// placeBlock: put an item's block at a position, against one of its solid neighbours, checked in the world.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { navigateToReach } from './navigate'
import { isFree, isInteractive, isSolid } from './placement'
import { FACES, blockAtOrThrow, countItems, findInventoryItem, settleInventory, waitUntil, withinReach, type Block } from './util'

export interface PlaceBlockArgs {
  pos: Vec3
  /** the item to place */
  item: string
  /** the block to place against (default: a solid neighbour, the one below first) */
  against?: Vec3
}

export interface PlaceBlockResult {
  pos: Vec3
  /** the block now there */
  block: string
  /** false when the block was there already */
  placed: boolean
}

/** the blocks an item can turn into: itself, or a wall variant (torches, signs, banners, heads) */
export function placedBlockNames (item: string): string[] {
  const names = [item]
  const wall = item.replace(/(torch|sign|banner|head|skull|coral_fan)$/, 'wall_$1')
  if (wall !== item) names.push(wall)
  return names
}

function chooseAgainst (bot: Bot, pos: Vec3): Block | null {
  for (const face of FACES) {
    const block = bot.blockAt(pos.plus(face))
    if (block != null && isSolid(block) && !isInteractive(block.name)) return block
  }
  return null
}

export async function placeBlock (bot: Bot, args: PlaceBlockArgs, signal?: AbortSignal): Promise<PlaceBlockResult> {
  throwIfAborted(signal)
  const pos = args.pos.floored()
  const wanted = placedBlockNames(args.item)
  const current = blockAtOrThrow(bot, pos)
  if (wanted.includes(current.name)) return { pos, block: current.name, placed: false }
  if (!isFree(current)) {
    throw new SkillError('CANNOT_PLACE', `${current.name} is at ${pos.toString()}`)
  }
  if (findInventoryItem(bot, args.item) == null) throw new SkillError('MISSING_ITEMS', `no ${args.item} in the inventory`)

  const against = args.against != null ? blockAtOrThrow(bot, args.against.floored()) : chooseAgainst(bot, pos)
  if (against == null || !isSolid(against)) throw new SkillError('CANNOT_PLACE', `nothing solid to place against at ${pos.toString()}`)
  const face = pos.minus(against.position)

  if (!withinReach(bot, against.position) || bot.entity.position.floored().equals(pos) || bot.entity.position.floored().offset(0, 1, 0).equals(pos)) {
    await navigateToReach(bot, pos, signal)
  }

  await settleInventory(bot, signal)
  const had = countItems(bot, args.item)
  const item = findInventoryItem(bot, args.item)
  if (item == null) throw new SkillError('MISSING_ITEMS', `no ${args.item} in the inventory`)
  await bot.equip(item, 'hand')
  try {
    await bot.placeBlock(against, face)
  } catch (err) {
    // mineflayer's wait for the block can time out though the server placed it: the world tells
    if (!wanted.includes(bot.blockAt(pos)?.name ?? '')) {
      throw new SkillError('CANNOT_PLACE', `placing ${args.item} at ${pos.toString()} failed: ${(err as Error).message}`, undefined, { cause: err })
    }
  }
  const placed = await waitUntil(bot, () => wanted.includes(bot.blockAt(pos)?.name ?? ''), 10, signal)
  const block = bot.blockAt(pos)?.name ?? 'unknown'
  if (!placed) throw new SkillError('VERIFY_FAILED', `${block} is at ${pos.toString()} after placing ${args.item}`)
  // the client puts the block down at once (its prediction); the server takes the item a tick or two later, and that
  // update bumps the menu's state id: a click before it arrives would go with a stale one (see settleInventory)
  if (bot.game.gameMode !== 'creative') await waitUntil(bot, () => countItems(bot, args.item) < had, 20, signal)
  return { pos, block, placed: true }
}
