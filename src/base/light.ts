import { BlockGetter, BlockRegistry, Bounds, Vec, blockRegistry, posKey } from './blocks'

/**
 * Block light inside a region, spread from every light source as the vanilla light engine does
 * (BlockLightEngine): a neighbour gets level - max(1, its light block), opaque blocks (15) stop it.
 * Face occlusion of partial blocks (slabs, stairs) is not modelled; light passes them as their
 * light-block value says.
 */
export function blockLight (world: BlockGetter, region: Bounds, registry: BlockRegistry = blockRegistry()): (x: number, y: number, z: number) => number {
  const { min, max } = region
  const sx = max.x - min.x
  const sy = max.y - min.y
  const sz = max.z - min.z
  const light = new Uint8Array(sx * sy * sz)
  const filter = new Uint8Array(sx * sy * sz)
  const index = (x: number, y: number, z: number): number => ((y - min.y) * sz + (z - min.z)) * sx + (x - min.x)
  const queue: number[] = []
  for (let y = min.y; y < max.y; y++) {
    for (let z = min.z; z < max.z; z++) {
      for (let x = min.x; x < max.x; x++) {
        const block = world(x, y, z)
        const i = index(x, y, z)
        filter[i] = registry.filterLight(block)
        const emit = registry.emitLight(block)
        if (emit > 0) {
          light[i] = emit
          queue.push(i)
        }
      }
    }
  }
  const strideY = sx * sz
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]
    const level = light[i]
    const x = i % sx
    const z = Math.floor(i / sx) % sz
    const y = Math.floor(i / strideY)
    const neighbours = [
      x > 0 ? i - 1 : -1, x < sx - 1 ? i + 1 : -1,
      z > 0 ? i - sx : -1, z < sz - 1 ? i + sx : -1,
      y > 0 ? i - strideY : -1, y < sy - 1 ? i + strideY : -1
    ]
    for (const n of neighbours) {
      if (n < 0 || filter[n] >= 15) continue
      const next = level - Math.max(1, filter[n])
      if (next > light[n]) {
        light[n] = next
        queue.push(n)
      }
    }
  }
  return (x, y, z) => x < min.x || y < min.y || z < min.z || x >= max.x || y >= max.y || z >= max.z ? 0 : light[index(x, y, z)]
}

/**
 * Cells where a hostile mob could spawn by the block shapes alone (NaturalSpawner.isValidEmptySpawnBlock
 * for the cell and the one above, and a sturdy top on the block below, as BlockBehaviour.isValidSpawn).
 */
export function spawnableCells (world: BlockGetter, cells: Vec[], registry: BlockRegistry = blockRegistry()): Vec[] {
  const emptyForSpawn = (x: number, y: number, z: number): boolean => {
    const block = world(x, y, z)
    return !registry.isFullCube(block) && !registry.hasFluid(block) && registry.hasNoCollision(block)
  }
  return cells.filter(c => emptyForSpawn(c.x, c.y, c.z) && emptyForSpawn(c.x, c.y + 1, c.z) &&
    registry.isFullCube(world(c.x, c.y - 1, c.z)) && registry.emitLight(world(c.x, c.y - 1, c.z)) < 14)
}

/**
 * The spawnable cells among `cells` with block light below `minLight`. Since 1.18 hostile mobs spawn
 * only at block light 0 (monster_spawn_block_light_limit), so the default 1 means "no spawning".
 */
export function darkSpawnCells (world: BlockGetter, cells: Vec[], options: { minLight?: number, region?: Bounds, registry?: BlockRegistry } = {}): Vec[] {
  const registry = options.registry ?? blockRegistry()
  const minLight = options.minLight ?? 1
  const region = options.region ?? boundsAround(cells, 15)
  const light = blockLight(world, region, registry)
  const seen = new Set<string>()
  return spawnableCells(world, cells, registry).filter(c => {
    const key = posKey(c.x, c.y, c.z)
    if (seen.has(key)) return false
    seen.add(key)
    return light(c.x, c.y, c.z) < minLight
  })
}

function boundsAround (cells: Vec[], margin: number): Bounds {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const c of cells) {
    min.x = Math.min(min.x, c.x - margin); min.y = Math.min(min.y, c.y - margin); min.z = Math.min(min.z, c.z - margin)
    max.x = Math.max(max.x, c.x + margin + 1); max.y = Math.max(max.y, c.y + margin + 1); max.z = Math.max(max.z, c.z + margin + 1)
  }
  return { min, max }
}
