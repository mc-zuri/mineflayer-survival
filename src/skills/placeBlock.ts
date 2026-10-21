// placeBlock: put an item's block at a position, against one of its solid neighbours, checked in the world.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigateNear, navigateToReach, walkTo } from './navigate'
import { boxInCell, cellToStepOff, isFree, isInteractive, isSolid } from './placement'
import { FACES, blockAtOrThrow, countItems, findInventoryItem, settleInventory, trace, waitTicks, waitUntil, withinReach, type Block } from './util'
import { placeAgainst } from '../core/actions'
import { underSpawnProtection } from './spawnProtection'

export interface PlaceBlockArgs {
  pos: Vec3
  /** the item to place */
  item: string
  /** the block to place against (default: a solid neighbour, the one below first) */
  against?: Vec3
  /**
   * The horizontal way the bot faces as it places (a cardinal vector), for the blocks whose state follows the
   * player's facing (BlockPlaceContext.getHorizontalDirection: a bed's head and a door point that way, a chest or a
   * furnace faces back at the player). The bot looks that way, down at the face, instead of at the face's middle.
   */
  facing?: Vec3
  /** the block goes into water or lava there, which it replaces (a pedestal in a lava lake; default false) */
  intoFluid?: boolean
}

/** mineflayer's yaw for a horizontal direction (0 looks to -z, pi/2 to -x) */
export function yawFor (dir: Vec3): number {
  return Math.atan2(-dir.x, -dir.z)
}

/** whether a look of this yaw (mineflayer's radians) faces the cardinal way, within 45 degrees (Direction.fromYRot) */
export function lookFaces (yaw: number, dir: Vec3): boolean {
  return -Math.sin(yaw) * dir.x - Math.cos(yaw) * dir.z > Math.SQRT1_2
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

function againstCandidates (bot: Bot, pos: Vec3): Block[] {
  const out: Block[] = []
  for (const face of FACES) {
    const block = bot.blockAt(pos.plus(face))
    // (none in the square about the spawn a server keeps: the use on it is refused, spawn protection)
    if (block != null && isSolid(block) && !isInteractive(block.name) && !underSpawnProtection(bot, block.position)) out.push(block)
  }
  return out
}

function chooseAgainst (bot: Bot, pos: Vec3): Block | null {
  return againstCandidates(bot, pos)[0] ?? null
}

/**
 * The bot's box out of `cell` (cellToStepOff: the server refuses a block whose collision shape the player is in,
 * BlockItem.canPlace): walked to the middle of the nearest cell beside it it can stand in. Resolves whether its box is
 * out.
 */
export async function stepOff (bot: Bot, cell: Vec3, signal?: AbortSignal): Promise<boolean> {
  const lookup = (p: Vec3): any => bot.blockAt(p)
  for (let attempt = 0; attempt < 3; attempt++) {
    const to = cellToStepOff(lookup, bot.entity.position, cell)
    if (to == null) break
    trace('placeBlock: out of', cell.toString(), 'to', to.toString(), 'from', bot.entity.position.toString())
    await walkTo(bot, to.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal)
    // (stopped: the walk's momentum carried on a tick or two)
    await waitUntil(bot, () => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.01, 10, signal)
  }
  return !boxInCell(bot.entity.position, cell)
}

export async function placeBlock (bot: Bot, args: PlaceBlockArgs, signal?: AbortSignal): Promise<PlaceBlockResult> {
  throwIfAborted(signal)
  const pos = args.pos.floored()
  const wanted = placedBlockNames(args.item)
  const current = blockAtOrThrow(bot, pos)
  if (wanted.includes(current.name)) return { pos, block: current.name, placed: false }
  // nothing placed in the square about the spawn a server keeps, nor against a block in it (spawn protection: the
  // server puts it back, and the bot stood on a block it hadn't)
  if (underSpawnProtection(bot, pos) || (args.against != null && underSpawnProtection(bot, args.against))) {
    throw new SkillError('REFUSED', `${pos.toString()} is under spawn protection: no ${args.item} placed`)
  }
  if (!isFree(current) && !(args.intoFluid === true && (current.name === 'water' || current.name === 'lava'))) {
    throw new SkillError('CANNOT_PLACE', `${current.name} is at ${pos.toString()}`)
  }
  if (findInventoryItem(bot, args.item) == null) throw new SkillError('MISSING_ITEMS', `no ${args.item} in the inventory`)
  // a chest under a solid block won't open (ChestBlock.isChestBlockedAt): not put there (the base's chest under the
  // stone its dig left, every store timed out, 26.3)
  if ((args.item === 'chest' || args.item === 'trapped_chest') && isSolid(bot.blockAt(pos.offset(0, 1, 0)))) {
    throw new SkillError('CANNOT_PLACE', `${bot.blockAt(pos.offset(0, 1, 0))?.name ?? 'a block'} over ${pos.toString()}: a chest there won't open`)
  }

  const against = args.against != null ? blockAtOrThrow(bot, args.against.floored()) : chooseAgainst(bot, pos)
  if (against == null || !isSolid(against)) throw new SkillError('CANNOT_PLACE', `nothing solid to place against at ${pos.toString()}`)
  const face = pos.minus(against.position)

  if (!withinReach(bot, against.position) || bot.entity.position.floored().equals(pos) || bot.entity.position.floored().offset(0, 1, 0).equals(pos)) {
    await navigateToReach(bot, pos, signal)
  }
  // (the reach goal takes a bot standing partly in the cell as out of it, by the cell beside it its box is in too)
  const shape = bot.registry.blocksByName[args.item]?.boundingBox
  if (shape != null && shape !== 'empty') await stepOff(bot, pos, signal)

  await settleInventory(bot, signal)
  const had = countItems(bot, args.item)
  const item = findInventoryItem(bot, args.item)
  if (item == null) throw new SkillError('MISSING_ITEMS', `no ${args.item} in the inventory`)
  await bot.equip(item, 'hand')
  // the item in hand again before each place: the way to a face in sight (navigateNear) can put down a block of its own
  // and leave it held (the pathfinder's scaffolding: tuff placed for cobbled_deepslate, 26.3; andesite for cobblestone)
  const hold = async (): Promise<void> => {
    if (bot.heldItem?.name === args.item) return
    const again = findInventoryItem(bot, args.item)
    if (again == null) throw new SkillError('MISSING_ITEMS', `no ${args.item} in the inventory`)
    await bot.equip(again, 'hand')
  }
  // against a block that does something when clicked (a chest, a table): sneaking, as a player places on one
  // (Player.isSecondaryUseActive: the block's own use is passed over), the sneak sent with a tick first
  const sneak = isInteractive(against.name)
  if (sneak) {
    bot.setControlState('sneak', true)
    await waitTicks(bot, 1, signal)
  }
  const windowBefore = bot.currentWindow
  try {
    if (args.facing != null) {
      // the server takes the facing from the player's rotation at the use (ServerboundUseItemOnPacket carries none): a
      // point of a face in sight whose look faces that way (BlockPlaceContext.getHorizontalDirection, within 45 degrees
      // of it), so the look hits what the use clicks (Grim's RotationPlace: a look down the facing way, past the block,
      // missed it and the places after it were cancelled); none, the look down that way
      const facing = args.facing
      const facesWay = (): boolean => lookFaces(bot.entity.yaw, facing)
      const others = args.against != null ? [] : againstCandidates(bot, pos).filter(b => !b.position.equals(against.position))
      let placed = await placeAgainst(bot, against, face, facesWay)
      for (const other of others) {
        if (placed) break
        placed = await placeAgainst(bot, other, pos.minus(other.position), facesWay)
      }
      if (!placed) {
        await bot.look(yawFor(facing), -Math.PI / 4, true)
        // the rotation goes out with the tick's move packet (LocalPlayer.sendPosition): one tick before the use
        await waitTicks(bot, 1, signal)
        await (bot as any)._placeBlockWithOptions(against, face, { swingArm: 'right', forceLook: 'ignore' })
      }
    } else {
      // against a face the crosshair is on, as vanilla's use goes (useItemOn with the hit's block and face): the one
      // asked for, else any solid block beside the cell with its face toward it in sight; none, the plain place
      const others = args.against != null ? [] : againstCandidates(bot, pos).filter(b => !b.position.equals(against.position))
      const placeInSight = async (): Promise<boolean> => {
        if (await placeAgainst(bot, against, face)) return true
        for (const other of others) {
          if (await placeAgainst(bot, other, pos.minus(other.position))) return true
        }
        return false
      }
      let placedInSight = await placeInSight()
      if (!placedInSight) {
        // no face in sight from here (one below the eye's height seen from above, one behind a block): from beside the
        // cell, off it
        await navigateNear(bot, pos, 2, signal).catch(err => { if (isAbort(err)) throw err })
        if (shape != null && shape !== 'empty') await stepOff(bot, pos, signal)
        await hold()
        placedInSight = await placeInSight()
      }
      if (!placedInSight) {
        // a place against a face the eye can't see is one no player makes: with the actions in the ticks (a real-time
        // server's anticheat: Grim's PositionPlace cancels it, 'No block has been placed', 58 a game) it fails for the
        // caller to plan another way; without, the plain place
        if ((bot as any).actionsInTick === true) throw new SkillError('CANNOT_PLACE', `no face to place ${args.item} at ${pos.toString()} against is in sight from ${bot.entity.position.floored().toString()}`)
        await bot.placeBlock(against, face)
      }
    }
  } catch (err) {
    // mineflayer's wait for the block can time out though the server placed it: the world tells
    if (!wanted.includes(bot.blockAt(pos)?.name ?? '')) {
      throw new SkillError('CANNOT_PLACE', `placing ${args.item} at ${pos.toString()} failed: ${(err as Error).message}`, undefined, { cause: err })
    }
  } finally {
    if (sneak) bot.setControlState('sneak', false)
    // a menu the use opened instead (the block's own use): shut, or the server's open menu takes every click after
    // (the eyes' equip went to a chest's menu, and no eye went into a frame, 1.21.11)
    if (bot.currentWindow != null && bot.currentWindow !== windowBefore) bot.closeWindow(bot.currentWindow)
  }
  const placed = await waitUntil(bot, () => wanted.includes(bot.blockAt(pos)?.name ?? ''), 10, signal)
  const block = bot.blockAt(pos)?.name ?? 'unknown'
  if (!placed) throw new SkillError('VERIFY_FAILED', `${block} is at ${pos.toString()} after placing ${args.item}`)
  // the client puts the block down at once (its prediction); the server takes the item a tick or two later, and that
  // update bumps the menu's state id: a click before it arrives would go with a stale one (see settleInventory)
  if (bot.game.gameMode !== 'creative') await waitUntil(bot, () => countItems(bot, args.item) < had, 20, signal)
  return { pos, block, placed: true }
}
