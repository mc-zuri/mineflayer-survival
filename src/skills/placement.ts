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

export interface FindPlacementOptions {
  /** how far from the bot's block, horizontally (default 2) */
  radius?: number
  /** keep the block above free too (a chest won't open under a solid block; default false) */
  freeAbove?: boolean
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
