import { BlockGetter, BlockInfo, BlockProperties, BlockRegistry, Bounds, Vec, blockRegistry, posKey } from './blocks'
import { darkSpawnCells } from './light'

// A parametric underground storage room: a shell of stone-like blocks around an interior lined with
// chests, lit so nothing spawns inside, entered through a bent airlock with a door at each end.

/** Shell materials the bot can get early, cheapest first. All four have blast resistance 6. */
export const SHELL_MATERIALS = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate'] as const
export type ShellMaterial = typeof SHELL_MATERIALS[number]

/**
 * The default shell: 2 layers of cobblestone. safety.minimumShellThickness over this blueprint (default
 * interior 7x3x7, 36 chests) proves 1 layer of any of the four materials unsafe against a charged
 * creeper (power 6: a ray crossing one layer reaches a chest with 0.165 intensity left) and 2 layers
 * safe against a creeper and a charged creeper at every point a mob can reach, with the world around
 * the shell taken as air (the room exposed on every side). 1 layer already holds against a plain
 * creeper. The four materials share resistance 6, so cobblestone, the cheapest, is the default.
 */
export const DEFAULT_SHELL_THICKNESS = 2
export const DEFAULT_SHELL_MATERIAL: ShellMaterial = 'cobblestone'

export interface BlueprintOptions {
  /** world position of the interior's min corner; the entrance is on the north (-z) side */
  origin?: Vec
  /** interior size along x */
  width?: number
  /** interior size along y */
  height?: number
  /** interior size along z */
  depth?: number
  thickness?: number
  material?: string
  /** chests stacked along the walls (at most height - 1, to leave room for torches) */
  chestLayers?: number
  furnaces?: number
  bed?: string
  door?: string
  /**
   * block light every spawnable cell must reach. Since 1.18 any light above 0 stops hostile spawning;
   * the default 8 keeps a margin (and is the pre-1.18 rule).
   */
  minLight?: number
  version?: string
}

export type BuildStage = 'floor' | 'walls' | 'ceiling' | 'furniture'
const STAGES: BuildStage[] = ['floor', 'walls', 'ceiling', 'furniture']

export interface Placement {
  pos: Vec
  block: string
  state: BlockProperties
  stateId: number
  stage: BuildStage
  /** set by the game along with another placement (a door's upper half, a bed's head) */
  autoPlaced?: boolean
  /** the neighbour the block goes against (a wall torch's wall, the floor under furniture) */
  against?: Vec
  /** the order found no solid neighbour for it (only with a world that can't hold it up) */
  unsupported?: boolean
}

export interface Blueprint {
  options: Required<Omit<BlueprintOptions, 'origin'>> & { origin: Vec }
  interior: Bounds
  /** everything the design occupies, shell included */
  bounds: Bounds
  /** cells to clear before building, from the entrance in: the interior and the airlock */
  dig: Vec[]
  /** every block of the design, ordered for building on flat ground: floor, walls, ceiling, then furniture */
  placements: Placement[]
  /** the chests */
  storage: Vec[]
  entrance: {
    /** where the bot stands to open the outer door (outside the shell, not dug by the blueprint) */
    outside: Vec
    outerDoor: Vec
    innerDoor: Vec
    /** floor-level cells of the airlock, outside in, doors included */
    path: Vec[]
  }
  /** the interior and airlock cells (the dug ones): no mob may spawn on any of them */
  airCells: Vec[]
  /** the design over a base world (air where neither has a block) */
  world: (base?: BlockGetter) => BlockGetter
}

const DIRS = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 },
  east: { x: 1, z: 0 }
} as const
type Facing = keyof typeof DIRS
const CLOCKWISE: Record<Facing, Facing> = { north: 'east', east: 'south', south: 'west', west: 'north' }

export function generateBlueprint (opts: BlueprintOptions = {}): Blueprint {
  const options = {
    origin: opts.origin ?? { x: 0, y: 0, z: 0 },
    width: opts.width ?? 7,
    height: opts.height ?? 3,
    depth: opts.depth ?? 7,
    thickness: opts.thickness ?? DEFAULT_SHELL_THICKNESS,
    material: opts.material ?? DEFAULT_SHELL_MATERIAL,
    chestLayers: opts.chestLayers ?? Math.min(2, (opts.height ?? 3) - 1),
    furnaces: opts.furnaces ?? 2,
    bed: opts.bed ?? 'white_bed',
    door: opts.door ?? 'oak_door',
    minLight: opts.minLight ?? 8,
    version: opts.version ?? '1.21.11'
  }
  const { width: W, height: H, depth: D, thickness: t, origin: o } = options
  const registry = blockRegistry(options.version)
  if (t < 1) throw new Error('the shell needs at least one layer')
  if (H < 2) throw new Error('the interior must be at least 2 high')
  if (options.chestLayers < 1 || options.chestLayers > H - 1) throw new Error(`chestLayers must be 1..${H - 1}`)
  const ex = 1 // the entrance column
  if (W < ex + 4 + options.furnaces || D < 3) throw new Error(`the interior is too small for the furniture: width >= ${ex + 4 + options.furnaces}, depth >= 3`)
  registry.block(options.material)

  const at = (x: number, y: number, z: number): Vec => ({ x: x + o.x, y: y + o.y, z: z + o.z })

  // the airlock, floor level and local: out of the room north through the shell (B), a bend east,
  // the inner door, a step east, then north through the tunnel's own shell to the outer door
  const room: Vec[] = []
  const inner: Array<[number, number]> = []
  for (let z = -1; z >= -(t + 1); z--) inner.push([ex, z])
  inner.push([ex + 1, -(t + 1)], [ex + 2, -(t + 1)])
  const innerDoor: [number, number] = [ex + 3, -(t + 1)]
  const tunnelStart: [number, number] = [ex + 4, -(t + 1)]
  const tunnel: Array<[number, number]> = [tunnelStart]
  for (let z = -(t + 2); z >= -(2 * t); z--) tunnel.push([ex + 4, z])
  const outerDoor: [number, number] = [ex + 4, -(2 * t + 1)]
  const outside: [number, number] = [ex + 4, -(2 * t + 2)]
  // the airlock from outside in
  const path: Array<[number, number]> = [outerDoor, ...[...tunnel].reverse(), innerDoor, ...[...inner].reverse()]

  const carved = new Map<string, Vec>()
  const carve = (x: number, y: number, z: number): void => { carved.set(posKey(x, y, z), { x, y, z }) }
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) { carve(x, y, z); room.push({ x, y, z }) }
  for (const [x, z] of path) for (let y = 0; y < 2; y++) carve(x, y, z)

  // the shell: every cell within t (Chebyshev) of the room, the inner airlock and the tunnel's first cell
  const core: Vec[] = [...room]
  for (const [x, z] of [...inner, innerDoor, tunnelStart]) for (let y = 0; y < 2; y++) core.push({ x, y, z })
  const shell = new Map<string, Vec>()
  for (const c of core) {
    for (let dy = -t; dy <= t; dy++) {
      for (let dz = -t; dz <= t; dz++) {
        for (let dx = -t; dx <= t; dx++) {
          const key = posKey(c.x + dx, c.y + dy, c.z + dz)
          if (!carved.has(key) && !shell.has(key)) shell.set(key, { x: c.x + dx, y: c.y + dy, z: c.z + dz })
        }
      }
    }
  }

  const placements: Placement[] = []
  const occupied = new Map<string, Placement>()
  const place = (p: Omit<Placement, 'stateId' | 'pos'> & { pos: Vec }): Placement => {
    const local = p.pos
    const placement: Placement = { ...p, pos: at(local.x, local.y, local.z), stateId: registry.stateId(p.block, p.state) }
    if (p.against != null) placement.against = at(p.against.x, p.against.y, p.against.z)
    occupied.set(posKey(local.x, local.y, local.z), placement)
    placements.push(placement)
    return placement
  }

  // shell, staged: under the floor, the walls, then over a carved cell
  const minCarvedY = new Map<string, number>()
  for (const c of carved.values()) minCarvedY.set(`${c.x},${c.z}`, Math.min(minCarvedY.get(`${c.x},${c.z}`) ?? Infinity, c.y))
  const shellCells = [...shell.values()].sort((a, b) => a.y !== b.y ? a.y - b.y : a.z !== b.z ? a.z - b.z : a.x - b.x)
  for (const s of shellCells) {
    const column = minCarvedY.get(`${s.x},${s.z}`)
    const stage: BuildStage = s.y < 0 ? 'floor' : column != null && column < s.y ? 'ceiling' : 'walls'
    place({ pos: s, block: options.material, state: {}, stage })
  }

  // chests along the west, east and south walls, facing in; neighbours in a line pair into double chests.
  // The build places each line in order, so the pairs the game makes are the ones the states say.
  const storage: Vec[] = []
  const chestLine = (cells: Array<[number, number]>, facing: Facing): void => {
    for (let y = 0; y < options.chestLayers; y++) {
      for (let i = 0; i < cells.length; i++) {
        const [x, z] = cells[i]
        // ChestBlock.getStateForPlacement: the second of a pair joins the first; LEFT has its partner clockwise
        const partner = i % 2 === 0 ? cells[i + 1] : cells[i - 1]
        let type = 'single'
        if (partner != null) {
          const cw = DIRS[CLOCKWISE[facing]]
          type = partner[0] - x === cw.x && partner[1] - z === cw.z ? 'left' : 'right'
        }
        // against the wall behind: a chest below is no full face, and clicking it would open it
        const back = DIRS[facing]
        const p = place({ pos: { x, y, z }, block: 'chest', state: { facing, type, waterlogged: false }, stage: 'furniture', against: { x: x - back.x, y, z: z - back.z } })
        storage.push(p.pos)
      }
    }
  }
  const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)
  chestLine(range(0, D).map(z => [0, z]), 'east')
  chestLine(range(1, D).map(z => [W - 1, z]), 'west')
  chestLine(range(1, W - 1).map(x => [x, D - 1]), 'north')

  // the north row beside the entrance: crafting table, furnaces, then the bed against the east wall
  let slot = ex + 1
  place({ pos: { x: slot, y: 0, z: 0 }, block: 'crafting_table', state: {}, stage: 'furniture', against: { x: slot, y: -1, z: 0 } })
  slot++
  for (let i = 0; i < options.furnaces; i++) {
    place({ pos: { x: slot, y: 0, z: 0 }, block: 'furnace', state: { facing: 'south', lit: false }, stage: 'furniture', against: { x: slot, y: -1, z: 0 } })
    slot++
  }
  place({ pos: { x: W - 2, y: 0, z: 0 }, block: options.bed, state: { facing: 'east', part: 'foot', occupied: false }, stage: 'furniture', against: { x: W - 2, y: -1, z: 0 } })
  place({ pos: { x: W - 1, y: 0, z: 0 }, block: options.bed, state: { facing: 'east', part: 'head', occupied: false }, stage: 'furniture', autoPlaced: true })

  // doors: a player walking in faces south at the outer door and west at the inner one
  const door = (cell: [number, number], facing: Facing): void => {
    const [x, z] = cell
    place({ pos: { x, y: 0, z }, block: options.door, state: { facing, half: 'lower', hinge: 'left', open: false, powered: false }, stage: 'furniture', against: { x, y: -1, z } })
    place({ pos: { x, y: 1, z }, block: options.door, state: { facing, half: 'upper', hinge: 'left', open: false, powered: false }, stage: 'furniture', autoPlaced: true })
  }

  // torches: wall torches added where the floor is darkest until every spawnable floor cell is lit
  // every carved cell is checked: the floor, and the tops of furnaces and crafting tables
  const floorLocal: Vec[] = [...carved.values()]
  const doorCells = new Set([innerDoor, outerDoor].flatMap(([x, z]) => [posKey(x, 0, z), posKey(x, 1, z)]))
  const torchSpots: Array<{ pos: Vec, facing: Facing }> = []
  const torchY = options.chestLayers
  for (const c of carved.values()) {
    const key = posKey(c.x, c.y, c.z)
    const inRoom = c.z >= 0
    if (doorCells.has(key) || occupied.has(key) || c.y !== (inRoom ? torchY : 1)) continue
    for (const facing of Object.keys(DIRS) as Facing[]) {
      const d = DIRS[facing]
      if (shell.has(posKey(c.x - d.x, c.y, c.z - d.z))) { torchSpots.push({ pos: c, facing }); break }
    }
  }
  const localWorld: BlockGetter = (x, y, z) => {
    const p = occupied.get(posKey(x, y, z))
    if (p != null) return { name: p.block, stateId: p.stateId }
    return null
  }
  const bounds: Bounds = boundsOf([...shell.values()])
  const torches: Placement[] = []
  for (let guard = 0; guard < 64; guard++) {
    const dark = darkSpawnCells(localWorld, floorLocal, { minLight: options.minLight, region: bounds, registry })
    if (dark.length === 0) break
    const target = dark[0]
    const free = torchSpots.filter(s => !occupied.has(posKey(s.pos.x, s.pos.y, s.pos.z)))
    if (free.length === 0) throw new Error('no wall left for torches')
    free.sort((a, b) => manhattan(a.pos, target) - manhattan(b.pos, target))
    const spot = free[0]
    const d = DIRS[spot.facing]
    torches.push(place({ pos: spot.pos, block: 'wall_torch', state: { facing: spot.facing }, stage: 'furniture', against: { x: spot.pos.x - d.x, y: spot.pos.y, z: spot.pos.z - d.z } }))
  }
  door(innerDoor, 'west')
  door(outerDoor, 'south')
  if (darkSpawnCells(localWorld, floorLocal, { minLight: options.minLight, region: bounds, registry }).length > 0) throw new Error('could not light the floor')

  // the dig list: a walk over the carved cells from the outer door in
  const dig: Vec[] = []
  const seen = new Set<string>()
  const queue: Vec[] = [{ x: outerDoor[0], y: 0, z: outerDoor[1] }, { x: outerDoor[0], y: 1, z: outerDoor[1] }]
  for (const q of queue) seen.add(posKey(q.x, q.y, q.z))
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]
    dig.push(at(c.x, c.y, c.z))
    for (const [dx, dy, dz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const key = posKey(c.x + dx, c.y + dy, c.z + dz)
      if (carved.has(key) && !seen.has(key)) {
        seen.add(key)
        queue.push(carved.get(key) as Vec)
      }
    }
  }

  const ordered = orderPlacements(placements, groundBelow(bounds.min.y + o.y), registry)
  const toWorld = (b: Bounds): Bounds => ({ min: at(b.min.x, b.min.y, b.min.z), max: at(b.max.x, b.max.y, b.max.z) })
  const worldOf = (base?: BlockGetter): BlockGetter => {
    const byPos = new Map<string, BlockInfo>()
    for (const p of placements) byPos.set(posKey(p.pos.x, p.pos.y, p.pos.z), { name: p.block, stateId: p.stateId })
    const air = new Set(dig.map(d => posKey(d.x, d.y, d.z)))
    return (x, y, z) => {
      const key = posKey(x, y, z)
      const p = byPos.get(key)
      if (p != null) return p
      if (air.has(key)) return null
      return base?.(x, y, z)
    }
  }
  return {
    options,
    interior: toWorld({ min: { x: 0, y: 0, z: 0 }, max: { x: W, y: H, z: D } }),
    bounds: toWorld(bounds),
    dig,
    placements: ordered,
    storage,
    entrance: {
      outside: at(outside[0], 0, outside[1]),
      outerDoor: at(outerDoor[0], 0, outerDoor[1]),
      innerDoor: at(innerDoor[0], 0, innerDoor[1]),
      path: path.map(([x, z]) => at(x, 0, z))
    },
    airCells: floorLocal.map(c => at(c.x, c.y, c.z)),
    world: worldOf
  }
}

function manhattan (a: Vec, b: Vec): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)
}

function boundsOf (cells: Vec[]): Bounds {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const c of cells) {
    min.x = Math.min(min.x, c.x); min.y = Math.min(min.y, c.y); min.z = Math.min(min.z, c.z)
    max.x = Math.max(max.x, c.x + 1); max.y = Math.max(max.y, c.y + 1); max.z = Math.max(max.z, c.z + 1)
  }
  return { min, max }
}

/** Flat solid ground under y `bottom`, the world the default order is made for. */
function groundBelow (bottom: number): (x: number, y: number, z: number) => boolean {
  return (_x, y) => y < bottom
}

const NEIGHBOURS: Array<[number, number, number]> = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

/**
 * Orders placements so each one has a solid (full cube) neighbour already there: placed earlier, or
 * solid in the world (its `against` block when it names one). Stages stay in order (floor, walls,
 * ceiling, furniture); inside a stage the given order is kept except that a block waits until
 * something holds it. Auto-placed halves follow their block.
 * `solidInWorld` takes the placement's own coordinates.
 */
export function orderPlacements (placements: Placement[], solidInWorld: (x: number, y: number, z: number) => boolean,
  registry: BlockRegistry = blockRegistry()): Placement[] {
  const solid = new Set<string>()
  const ordered: Placement[] = []
  const autoPlaced = new Map<string, Placement[]>()
  const isSolid = (x: number, y: number, z: number): boolean => solid.has(posKey(x, y, z)) || solidInWorld(x, y, z)
  // a door's upper half and a bed's head go right after the placement they come with
  for (const p of placements.filter(p => p.autoPlaced === true)) {
    const owner = p.block.endsWith('_door') ? posKey(p.pos.x, p.pos.y - 1, p.pos.z) : ownerOfBedHead(p)
    autoPlaced.set(owner, [...(autoPlaced.get(owner) ?? []), p])
  }
  for (const stage of STAGES) {
    const pending = placements.filter(p => p.stage === stage && p.autoPlaced !== true)
    let progress = true
    while (pending.length > 0 && progress) {
      progress = false
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i]
        const support = p.against != null ? [p.against] : NEIGHBOURS.map(([dx, dy, dz]) => ({ x: p.pos.x + dx, y: p.pos.y + dy, z: p.pos.z + dz }))
        if (!support.some(s => isSolid(s.x, s.y, s.z))) continue
        pending.splice(i--, 1)
        progress = true
        const key = posKey(p.pos.x, p.pos.y, p.pos.z)
        ordered.push(p)
        if (registry.isFullCube({ name: p.block, stateId: p.stateId })) solid.add(key)
        for (const extra of autoPlaced.get(key) ?? []) ordered.push(extra)
      }
    }
    for (const p of pending) {
      ordered.push({ ...p, unsupported: true })
      for (const extra of autoPlaced.get(posKey(p.pos.x, p.pos.y, p.pos.z)) ?? []) ordered.push(extra)
    }
  }
  return ordered
}

function ownerOfBedHead (head: Placement): string {
  const d = DIRS[head.state.facing as Facing]
  return posKey(head.pos.x - d.x, head.pos.y, head.pos.z - d.z)
}

export interface BuildPlan {
  /** carved cells that still hold a block */
  dig: Vec[]
  /** placements still to do, ordered for this world */
  placements: Placement[]
}

/**
 * What is left to build on a real site: cells to dig (carved cells that aren't air), then the
 * placements that the world doesn't already satisfy, ordered against the world as it will be after
 * digging. A shell cell already holding a full block at least as blast resistant as the material
 * (natural stone, deepslate) is kept.
 */
export function planBuild (blueprint: Blueprint, world: BlockGetter, registry: BlockRegistry = blockRegistry(blueprint.options.version)): BuildPlan {
  const dig = blueprint.dig.filter(c => !registry.isAir(world(c.x, c.y, c.z)) || registry.hasFluid(world(c.x, c.y, c.z)))
  const carved = new Set(blueprint.dig.map(c => posKey(c.x, c.y, c.z)))
  const materialResistance = registry.explosionResistance(blueprint.options.material) ?? 0
  const satisfied = (p: Placement): boolean => {
    const existing = world(p.pos.x, p.pos.y, p.pos.z)
    if (p.stage === 'furniture') return BlockRegistry.nameOf(existing) === p.block
    return registry.isFullCube(existing) && (registry.explosionResistance(existing) ?? 0) >= materialResistance && !registry.hasFluid(existing)
  }
  const placements = blueprint.placements.filter(p => !satisfied(p))
  const solidInWorld = (x: number, y: number, z: number): boolean => !carved.has(posKey(x, y, z)) && registry.isFullCube(world(x, y, z))
  return { dig, placements: orderPlacements(placements, solidInWorld, registry) }
}
