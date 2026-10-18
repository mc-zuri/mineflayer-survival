import minecraftData from 'minecraft-data'

/** A block position or a point in the world. */
export interface Vec {
  x: number
  y: number
  z: number
}

/** A box of block positions. */
export interface Bounds {
  /** inclusive */
  min: Vec
  /** exclusive */
  max: Vec
}

/** Block state properties, as minecraft-data names them (`{ facing: 'north', open: false }`). */
export type BlockProperties = Record<string, string | number | boolean>

export interface BlockInfo {
  name: string
  /** the exact state; the block's default state when absent */
  stateId?: number
  /** the state's properties, used when `stateId` is absent */
  properties?: BlockProperties
  /** a fluid in the block (a waterlogged state), when the properties don't say so */
  waterlogged?: boolean
}

/** What a block getter returns: a block name, a block with its state, or null/undefined for air. */
export type BlockLike = string | BlockInfo | null | undefined

/** The world as these modules read it: block coordinates in, the block there out. */
export type BlockGetter = (x: number, y: number, z: number) => BlockLike

/** A box in block-local or world coordinates: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type Box = [number, number, number, number, number, number]

export const DEFAULT_VERSION = '1.21.11'

// Blocks.AIR, CAVE_AIR and VOID_AIR: BlockState.isAir()
const AIR = new Set(['air', 'cave_air', 'void_air'])
// blocks whose fluid state is always water (kelp, seagrass, bubble columns): FluidState.isEmpty() is false
const ALWAYS_WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
// FlowingFluid.getExplosionResistance: WaterFluid and LavaFluid both return 100.0F
export const FLUID_EXPLOSION_RESISTANCE = 100

const FULL_CUBE: Box = [0, 0, 0, 1, 1, 1]

/**
 * The block facts the base modules need, read from minecraft-data for one version: explosion
 * resistance, fluids, collision shapes, light, and state ids from properties.
 */
export class BlockRegistry {
  readonly data: minecraftData.IndexedData
  private readonly shapeCache = new Map<string, Box[]>()

  constructor (readonly version: string = DEFAULT_VERSION) {
    this.data = minecraftData(version)
    if (this.data == null) throw new Error(`minecraft-data has no data for ${version}`)
  }

  block (name: string): minecraftData.IndexedBlock {
    const block = this.data.blocksByName[name]
    if (block == null) throw new Error(`unknown block ${name} in ${this.version}`)
    return block
  }

  static nameOf (block: BlockLike): string {
    if (block == null) return 'air'
    return typeof block === 'string' ? block : block.name
  }

  isAir (block: BlockLike): boolean {
    return AIR.has(BlockRegistry.nameOf(block))
  }

  /** The state's properties: the given ones, else decoded from the state id, else the defaults. */
  properties (block: BlockLike): BlockProperties {
    if (block == null || typeof block === 'string') return this.decodeState(BlockRegistry.nameOf(block))
    if (block.properties != null) return { ...this.decodeState(block.name), ...block.properties }
    return this.decodeState(block.name, block.stateId)
  }

  /** The state id of a block with these properties (prismarine-block's fromProperties order). */
  stateId (name: string, properties: BlockProperties = {}): number {
    const block = this.block(name)
    const states = (block.states ?? []) as Array<{ name: string, type: string, num_values: number, values?: string[] }>
    const defaults = this.decodeState(name)
    let id = 0
    for (const state of states) {
      const value = properties[state.name] ?? defaults[state.name]
      let index: number
      if (state.type === 'bool') index = value === true || value === 'true' ? 0 : 1
      else if (state.values != null) index = state.values.indexOf(String(value))
      else index = Number(value)
      if (index < 0 || index >= state.num_values) throw new Error(`${name}: bad value ${String(value)} for ${state.name}`)
      id = id * state.num_values + index
    }
    return block.minStateId + id
  }

  private decodeState (name: string, stateId?: number): BlockProperties {
    const block = this.data.blocksByName[name]
    if (block == null) return {}
    const states = (block.states ?? []) as Array<{ name: string, type: string, num_values: number, values?: string[] }>
    let offset = (stateId ?? block.defaultState) - block.minStateId
    const result: BlockProperties = {}
    for (let i = states.length - 1; i >= 0; i--) {
      const state = states[i]
      const index = offset % state.num_values
      offset = Math.floor(offset / state.num_values)
      if (state.type === 'bool') result[state.name] = index === 0
      else if (state.values != null) result[state.name] = state.values[index]
      else result[state.name] = index
    }
    return result
  }

  private stateIndex (block: BlockLike): number {
    const name = BlockRegistry.nameOf(block)
    const data = this.data.blocksByName[name]
    if (data == null) return 0
    if (block != null && typeof block !== 'string') {
      if (block.stateId != null) return block.stateId - data.minStateId
      if (block.properties != null) return this.stateId(name, block.properties) - data.minStateId
    }
    return data.defaultState - data.minStateId
  }

  /** The block holds a fluid: water, lava, an always-water plant, or a waterlogged state. */
  hasFluid (block: BlockLike): boolean {
    const name = BlockRegistry.nameOf(block)
    if (ALWAYS_WATER.has(name) || name === 'lava') return true
    if (block == null || typeof block === 'string') return false
    if (block.waterlogged != null) return block.waterlogged
    return this.properties(block).waterlogged === true
  }

  /**
   * ExplosionDamageCalculator.getBlockExplosionResistance: empty (undefined) for air with no fluid,
   * else max(block resistance, fluid resistance). Non-air blocks of resistance 0 (torches) still count.
   */
  explosionResistance (block: BlockLike): number | undefined {
    const name = BlockRegistry.nameOf(block)
    const fluid = this.hasFluid(block)
    if (AIR.has(name) && !fluid) return undefined
    const resistance = this.data.blocksByName[name]?.resistance ?? 0
    return Math.max(resistance, fluid ? FLUID_EXPLOSION_RESISTANCE : 0)
  }

  /** The state's collision boxes in block-local coordinates (BlockState.getCollisionShape). */
  collisionBoxes (block: BlockLike): Box[] {
    const name = BlockRegistry.nameOf(block)
    const index = this.stateIndex(block)
    const key = `${name}:${index}`
    let boxes = this.shapeCache.get(key)
    if (boxes == null) {
      const shapes = this.data.blockCollisionShapes
      const entry = shapes.blocks[name]
      const shapeId = Array.isArray(entry) ? entry[index] ?? entry[0] : entry
      boxes = shapeId == null ? [] : ((shapes.shapes[String(shapeId)] ?? []) as unknown as Box[])
      this.shapeCache.set(key, boxes)
    }
    return boxes
  }

  /** The collision shape is the whole cube (Block.isCollisionShapeFullBlock). */
  isFullCube (block: BlockLike): boolean {
    const boxes = this.collisionBoxes(block)
    return boxes.length === 1 && boxes[0].every((v, i) => v === FULL_CUBE[i])
  }

  /** No collision at all: a mob can stand in it (air, torches, water, open doorways). */
  hasNoCollision (block: BlockLike): boolean {
    return this.collisionBoxes(block).length === 0
  }

  /** BlockState.getLightBlock as minecraft-data has it (0 for air and glass, 15 for opaque cubes). */
  filterLight (block: BlockLike): number {
    return this.data.blocksByName[BlockRegistry.nameOf(block)]?.filterLight ?? 0
  }

  /** BlockState.getLightEmission (per block, not per state). */
  emitLight (block: BlockLike): number {
    return this.data.blocksByName[BlockRegistry.nameOf(block)]?.emitLight ?? 0
  }

  /** A door, trapdoor or fence gate: a mob path stops at it while it's closed. */
  static isDoor (block: BlockLike): boolean {
    const name = BlockRegistry.nameOf(block)
    return name.endsWith('_door') || name.endsWith('_trapdoor') || name.endsWith('_fence_gate')
  }
}

const registries = new Map<string, BlockRegistry>()

export function blockRegistry (version: string = DEFAULT_VERSION): BlockRegistry {
  let registry = registries.get(version)
  if (registry == null) {
    registry = new BlockRegistry(version)
    registries.set(version, registry)
  }
  return registry
}

export function posKey (x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}
