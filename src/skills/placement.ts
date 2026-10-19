// Where to put a block next to the bot (a crafting table, a furnace, a chest, a bed): pure, over a block lookup, so the
// unit tests run it on a made-up world.
import { Vec3 } from 'vec3'
import { CARDINALS, REPLACEABLE_BLOCKS } from './util'

export interface BlockView {
  name: string
  /** minecraft-data's boundingBox: 'block' for a full collision box, 'empty' for none */
  boundingBox: string
}

export type BlockLookup = (pos: Vec3) => BlockView | null

export const isSolid = (block: BlockView | null): boolean => block != null && block.boundingBox === 'block'
/** a block a placed one takes the place of (fluids left out: a table isn't put in water or lava) */
export const isFree = (block: BlockView | null): boolean =>
  block != null && REPLACEABLE_BLOCKS.has(block.name) && block.name !== 'water' && block.name !== 'lava'

/**
 * Blocks that do something when clicked: placing against one opens or toggles it instead (the bot doesn't sneak to
 * place), so they're not used to place against.
 */
const INTERACTIVE = /(^|_)(crafting_table|furnace|smoker|chest|barrel|bed|door|trapdoor|fence_gate|lever|button|anvil|enchanting_table|shulker_box|hopper|dispenser|dropper|brewing_stand|loom|stonecutter|grindstone|cartography_table|smithing_table|lectern|beacon|bell|note_block|repeater|comparator|daylight_detector|jukebox|crafter|cake|composter|respawn_anchor|lodestone|sign|decorated_pot|chiseled_bookshelf)$/
export const isInteractive = (name: string): boolean => INTERACTIVE.test(name)

/** the cells the bot's box overlaps (EntityType.PLAYER: 0.6 wide, 1.8 high) at `position` (its feet) */
export function botCells (position: Vec3, width = 0.6, height = 1.8): Vec3[] {
  const cells: Vec3[] = []
  const half = width / 2
  const eps = 1e-7
  for (let x = Math.floor(position.x - half + eps); x <= Math.floor(position.x + half - eps); x++) {
    for (let y = Math.floor(position.y + eps); y <= Math.floor(position.y + height - eps); y++) {
      for (let z = Math.floor(position.z - half + eps); z <= Math.floor(position.z + half - eps); z++) cells.push(new Vec3(x, y, z))
    }
  }
  return cells
}

/** whether the bot's box at `position` (its feet) reaches into `cell` at all */
export function boxInCell (position: Vec3, cell: Vec3): boolean {
  return botCells(position).some(c => c.equals(cell))
}

/**
 * Where the bot steps to get its box out of `cell` before a block goes in it (the server refuses a block whose
 * collision shape the player is in: BlockItem.canPlace, Level.isUnobstructed; a gate's bar is a quarter of the cell
 * across, and a bot standing half in the gate's cell, its feet's cell, had the gate refused three times, 26.3: the
 * reach goal took it as out by the cell beside it its box was in too): the middle of the nearest cell about its feet
 * the bot stands in (room for its feet and head, a floor), out of `cell`'s column. Null when its box is out of
 * `cell` already, or there's nowhere to step.
 */
export function cellToStepOff (lookup: BlockLookup, position: Vec3, cell: Vec3): Vec3 | null {
  if (!boxInCell(position, cell)) return null
  const feet = position.floored()
  const passable = (p: Vec3): boolean => {
    const b = lookup(p)
    return b != null && b.boundingBox === 'empty' && b.name !== 'lava' && b.name !== 'water'
  }
  let best: { pos: Vec3, d: number } | null = null
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const pos = feet.offset(dx, 0, dz)
      if (pos.x === cell.x && pos.z === cell.z) continue
      if (!passable(pos) || !passable(pos.offset(0, 1, 0)) || !isSolid(lookup(pos.offset(0, -1, 0)))) continue
      const d = Math.hypot(pos.x + 0.5 - position.x, pos.z + 0.5 - position.z) + (dx !== 0 && dz !== 0 ? 0.5 : 0)
      if (best == null || d < best.d) best = { pos, d }
    }
  }
  return best?.pos ?? null
}

export interface FindPlacementOptions {
  /** how far from the bot's block, horizontally (default 2) */
  radius?: number
  /** keep the block above free too (a chest won't open under a solid block; default false) */
  freeAbove?: boolean
  /** cells not to use (a portal's way in) */
  avoid?: (pos: Vec3) => boolean
}

/**
 * A free cell next to the bot with a solid block below it to place against: at the bot's feet level first, then a
 * step down and a step up; the nearest first. Null when there's none.
 */
export function findPlacement (lookup: BlockLookup, botPosition: Vec3, opts: FindPlacementOptions = {}): Vec3 | null {
  const radius = opts.radius ?? 2
  const feet = botPosition.floored()
  const occupied = botCells(botPosition).map(cell => cell.toString())
  const candidates: Array<{ pos: Vec3, rank: number[] }> = []
  for (const [level, dy] of [0, -1, 1].entries()) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = feet.offset(dx, dy, dz)
        if (occupied.includes(pos.toString())) continue
        if (!isFree(lookup(pos))) continue
        const below = lookup(pos.offset(0, -1, 0))
        if (!isSolid(below) || isInteractive(below?.name ?? '')) continue
        if (opts.freeAbove === true && !isFree(lookup(pos.offset(0, 1, 0)))) continue
        if (opts.avoid?.(pos) === true) continue
        // the bot's own column is no place for it (it would stand on the block, or the block on it)
        if (dx === 0 && dz === 0) continue
        candidates.push({ pos, rank: [level, Math.max(Math.abs(dx), Math.abs(dz)), dx * dx + dz * dz, dx, dz] })
      }
    }
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i]
    return 0
  })
  return candidates[0]?.pos ?? null
}

/**
 * findPlacement next to the bot, then further off (the bot walks there to place it: placeBlock goes within reach)
 * when the cells around it are all taken, as up a tree among the leaves or in a one-wide tunnel.
 */
export function findPlacementNear (lookup: BlockLookup, botPosition: Vec3, opts: Omit<FindPlacementOptions, 'radius'> = {}): Vec3 | null {
  return findPlacement(lookup, botPosition, { ...opts, radius: 2 }) ?? findPlacement(lookup, botPosition, { ...opts, radius: 5 })
}

export interface BedPlacement {
  foot: Vec3
  head: Vec3
  /** the way the bed points, foot to head: the way the bot faces when it places it (BedItem: the player's facing) */
  facing: Vec3
}

/** two free cells in a line from the bot, foot then head, each with a solid block below */
export function findBedPlacement (lookup: BlockLookup, botPosition: Vec3): BedPlacement | null {
  const feet = botPosition.floored()
  const occupied = botCells(botPosition).map(cell => cell.toString())
  for (const facing of CARDINALS) {
    const foot = feet.plus(facing)
    const head = foot.plus(facing)
    const ok = [foot, head].every(pos => !occupied.includes(pos.toString()) && isFree(lookup(pos)) && isSolid(lookup(pos.offset(0, -1, 0))))
    if (ok) return { foot, head, facing }
  }
  return null
}

/**
 * A bed's two cells within `radius` of `near` (feet level, a block down or up), both free with solid ground under, and
 * a cell behind the foot for the bot to stand in and face along the bed from (BedItem puts the head the way the
 * player faces; with only the foot's cell picked, a bed put down facing a wall or the drop beside it fails); none of
 * the three where `avoid` says; the nearest to `near` first
 */
export function findBedPlacementNear (lookup: BlockLookup, near: Vec3, radius = 5, avoid?: (pos: Vec3) => boolean): (BedPlacement & { stand: Vec3 }) | null {
  const start = near.floored()
  let best: (BedPlacement & { stand: Vec3 }) | null = null
  let bestScore = Infinity
  // the bed's own cells over a floor that does nothing when clicked: put down against a chest's top (the trip kit's,
  // just put down under it) the bed opened the chest instead (the server's menu, which the client never closed:
  // every click after went to it, the eyes stayed in the bag and none went into a frame, 1.21.11)
  const floor = (pos: Vec3): boolean => { const below = lookup(pos.offset(0, -1, 0)); return isSolid(below) && !isInteractive(below?.name ?? '') }
  const ground = (pos: Vec3): boolean => isFree(lookup(pos)) && isSolid(lookup(pos.offset(0, -1, 0))) && avoid?.(pos) !== true
  for (const dy of [0, -1, 1]) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const score = Math.hypot(dx, dz) + Math.abs(dy) * 1.5
        if (score >= bestScore) continue
        const foot = start.offset(dx, dy, dz)
        if (!ground(foot) || !floor(foot)) continue
        for (const facing of CARDINALS) {
          const head = foot.plus(facing)
          const stand = foot.minus(facing)
          if (!ground(head) || !floor(head) || !ground(stand) || !isFree(lookup(stand.offset(0, 1, 0)))) continue
          best = { foot, head, facing, stand }
          bestScore = score
          break
        }
      }
    }
  }
  return best
}

/** blocks not dug for a bed's room: unbreakable, a portal's, or slow */
const NOT_DUG = new Set(['bedrock', 'end_portal_frame', 'end_portal', 'nether_portal', 'obsidian', 'crying_obsidian', 'reinforced_deepslate', 'spawner', 'chest', 'barrier'])
const LIQUIDS = new Set(['water', 'lava'])

/** blocks that fall into a cell dug under them (FallingBlock) */
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding|.*_concrete_powder)$/

/**
 * Room for a bed dug out beside the bot where none is free (a kit's chest in the 1-wide tunnel the bot came by to the
 * stronghold, a 1-wide staircase): the two cells straight out from the bot's feet, foot then head, with solid ground
 * under them, and the head room over both (ServerPlayer.bedBlocked: a suffocating block over the bed's head or foot
 * is OBSTRUCTED, no sleep and no respawn point set); no water or lava against any cell dug, and nothing that falls
 * over the head room. The way with the fewest blocks to dig first. The bot stands where it is to put it down, facing
 * along it.
 */
export function bedRoomToDig (lookup: BlockLookup, feet: Vec3, avoid?: (pos: Vec3) => boolean): (BedPlacement & { stand: Vec3, dig: Vec3[] }) | null {
  const at = feet.floored()
  let best: (BedPlacement & { stand: Vec3, dig: Vec3[] }) | null = null
  // nothing to flow in once it's dug
  const wet = (cell: Vec3): boolean => [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)].some(d => LIQUIDS.has(lookup(cell.plus(d))?.name ?? ''))
  const diggable = (b: BlockView): boolean => b.boundingBox === 'block' && !NOT_DUG.has(b.name) && !isInteractive(b.name)
  for (const facing of CARDINALS) {
    const foot = at.plus(facing)
    const head = foot.plus(facing)
    const dig: Vec3[] = []
    let ok = true
    for (const cell of [foot, head]) {
      const b = lookup(cell)
      const below = lookup(cell.offset(0, -1, 0))
      if (b == null || !isSolid(below) || isInteractive(below?.name ?? '') || avoid?.(cell) === true) { ok = false; break }
      if (!isFree(b)) {
        if (!diggable(b) || wet(cell)) { ok = false; break }
        dig.push(cell)
      }
      // the head room: not suffocating (open, a torch), else dug
      const up = cell.offset(0, 1, 0)
      const over = lookup(up)
      if (over == null || LIQUIDS.has(over.name)) { ok = false; break }
      if (over.boundingBox !== 'block') continue
      if (!diggable(over) || wet(up) || FALLING.test(lookup(up.offset(0, 1, 0))?.name ?? '')) { ok = false; break }
      dig.push(up)
    }
    if (ok && (best == null || dig.length < best.dig.length)) best = { foot, head, facing, stand: at, dig }
  }
  return best
}
