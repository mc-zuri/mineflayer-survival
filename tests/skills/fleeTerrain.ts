// The ground by two creeper deaths of a 1.21.11 lockstep game (seed -3348798922721507200, ls3b-1.21.11), read from the
// game's 07-enchanting checkpoint's region files: '#' a full block of the ground, 'W' an oak log, 'L' oak leaves, '.'
// open (air, grass, leaf litter), '~' water. Layers from y0 up, rows from z0 on, columns from x0 on. Under the box is
// ground, over it and round it open over the ground's level (y0 for the first, its grass).
import { Vec3 } from 'vec3'

export interface Grid { x0: number, y0: number, z0: number, layers: string[][] }

export const LS3B_CREEPER_1 = { x0: 150, y0: 68, z0: 312, layers: 
[
  // y 68
  ['###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################',
   '###################'],
  // y 69
  ['######.............',
   '#####..............',
   '####...............',
   '###................',
   '##.................',
   '##...............W.',
   '##.................',
   '#...W..............',
   '#................W.',
   '#......W...........',
   '##.................',
   '##.................',
   '##.......W....W....',
   '##................W',
   '##.................',
   '##.................',
   '##.............W...',
   '##.................',
   '##.................'],
  // y 70
  ['...................',
   '..W................',
   '...................',
   '...................',
   '...................',
   '.................W.',
   '...................',
   '....W..............',
   '.................W.',
   '.......W...........',
   '........LLLL.......',
   '.......LLLLL.......',
   '.......LLWLL..W....',
   '.......LLLLL......W',
   '.......LLLLL.......',
   '...................',
   '...............W...',
   '...................',
   '...................'],
  // y 71
  ['.................LL',
   '..W................',
   '...................',
   '...............LLLL',
   '...............LLLL',
   '..LLLLL........LLWL',
   '..LLLLL........LLLL',
   '..LLWLL.........LLL',
   '..LLLLL..........W.',
   '..LLLL.W...........',
   '.......LLLL........',
   '.......LLLLL....LLL',
   '.......LLWLL..W.LLL',
   '.......LLLLL....LLW',
   '.......LLLLL....LLL',
   '.................LL',
   '...............W...',
   '...................',
   '...................'],
  // y 72
  ['LLLLLLLLLL.......LL',
   'LLWLL.LLLL.........',
   'LLLLL..............',
   'LLLLL...........LLL',
   '...............LLLL',
   '...LLL.........LLWL',
   '..LLLLL........LLLL',
   '..LLWLL........LLLL',
   '..LLLLL..L.....LLWL',
   'L..LLL.WWWL....LLLL',
   'L........L..LLLLLLL',
   'L.......LL..LLLLLLL',
   '........LWL.LLWLLLL',
   '.........LL.LLLLLLW',
   '.............LLLLLL',
   '.............LLLLLL',
   '.............LLWLL.',
   '.............LLLLL.',
   '..............LLL..']
]
} satisfies Grid
export const LS3B_CREEPER_2 = { x0: 16, y0: 63, z0: 196, layers: 
[
  // y 63
  ['#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '####...################',
   '######....#############',
   '#######....############',
   '########....###########'],
  // y 64
  ['#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######################',
   '#######.....###########',
   '###..........##########',
   '##.......W...##########',
   '#...........###########',
   '............###########',
   '............###########',
   '..W........############',
   '...........############',
   '...........############',
   '...........############'],
  // y 65
  ['########......#########',
   '##########....#########',
   '###########...#########',
   '############.##########',
   '############.##########',
   '###########...#########',
   '######........#########',
   '##.............########',
   '...............########',
   '.........W.....########',
   '...............########',
   '...............########',
   '...............########',
   '..W...........#########',
   '..............#########',
   '...........W.##########',
   '............###########'],
  // y 66
  ['#######.............#..',
   '#######.........W......',
   '#######................',
   '########.............W.',
   '#########..............',
   '#####.W................',
   '..............W........',
   '........LLLL...........',
   '.......LLLLL...........',
   '.......LLWLL...W.......',
   '.......LLLLL...........',
   '.LLL....LLLL...........',
   'LLLLL..................',
   'LLWLL..................',
   'LLLLL..................',
   '.LLL.......W...........',
   '.......................'],
  // y 67
  ['####...................',
   '###.............W......',
   '##.....................',
   '.....................W.',
   '.......................',
   'W.....W................',
   '..............W........',
   '.......LLLL..LLLLL.....',
   '.......LLLLL.LLLLL.....',
   '.......LLWLL.LLWLL.....',
   '.......LLLLL.LLLLL.....',
   '.LLLL...LLLL..LLLL.....',
   'LLLLL..................',
   'LLWLL..................',
   'LLLLL..................',
   'LLLLL......W...........',
   'L......................']
]
} satisfies Grid

const NAMES: Record<string, string> = { '#': 'grass_block', W: 'oak_log', L: 'oak_leaves', '.': 'air', '~': 'water' }
const SOLID = new Set(['grass_block', 'oak_log', 'oak_leaves', 'cobblestone', 'stone', 'dirt'])

/** the grid's block name at `p` (the ground under the box, open over it and round it but for the ground's level) */
export function gridWorld (grid: Grid, extra: Record<string, string> = {}): (p: Vec3) => string {
  return (p: Vec3): string => {
    const f = p.floored()
    const set = extra[`${f.x},${f.y},${f.z}`]
    if (set != null) return set
    const layer = grid.layers[f.y - grid.y0]
    const row = layer?.[f.z - grid.z0]
    const c = row?.[f.x - grid.x0]
    if (c != null) return NAMES[c] ?? 'stone'
    return f.y <= grid.y0 ? 'grass_block' : 'air'
  }
}

/** a lookup of the grid's blocks with their collision (the leaves and logs full blocks, as the game's) */
export function gridBlocks (world: (p: Vec3) => string): (p: Vec3) => { name: string, boundingBox: string, position: Vec3 } {
  return (p: Vec3) => {
    const name = world(p)
    return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty', position: p.floored() }
  }
}

/**
 * Whether the player's body (0.6 across, 1.8 high) gets `distance` blocks along the heading (mineflayer yaw) from
 * `from` on its feet: each tenth of a block its box clear of the full blocks, or one step up taken where the cells over
 * the step are open and the room over its head to jump is (the cell over its box's top). A rough walk, not the physics:
 * enough to tell a way from a corner the body catches on.
 */
export function bodyGets (blocks: (p: Vec3) => { boundingBox: string }, from: Vec3, heading: number, distance: number): boolean {
  const dx = -Math.sin(heading)
  const dz = -Math.cos(heading)
  let x = from.x
  let y = from.y
  let z = from.z
  const solid = (cx: number, cy: number, cz: number): boolean => blocks(new Vec3(cx, cy, cz)).boundingBox === 'block'
  const hits = (bx: number, by: number, bz: number): boolean => {
    for (let cx = Math.floor(bx - 0.3); cx <= Math.floor(bx + 0.3 - 1e-6); cx++) {
      for (let cy = Math.floor(by); cy <= Math.floor(by + 1.8 - 1e-6); cy++) {
        for (let cz = Math.floor(bz - 0.3); cz <= Math.floor(bz + 0.3 - 1e-6); cz++) if (solid(cx, cy, cz)) return true
      }
    }
    return false
  }
  for (let d = 0; d < distance; d += 0.1) {
    const nx = x + dx * 0.1
    const nz = z + dz * 0.1
    if (!hits(nx, y, nz)) {
      x = nx
      z = nz
      // (down a step, the ground under it)
      while (!hits(x, y - 1, z) && y > from.y - 3) y -= 1
      continue
    }
    // a step up: the box a block higher clear there, and the room to jump where it is
    if (!hits(nx, y + 1, nz) && !hits(x, y + 1, z)) {
      x = nx
      z = nz
      y += 1
      continue
    }
    return false
  }
  return true
}
