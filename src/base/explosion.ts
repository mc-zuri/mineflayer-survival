import { BlockGetter, BlockRegistry, Box, Vec, blockRegistry } from './blocks'

// A port of vanilla 1.21.11 net.minecraft.world.level.ServerExplosion (checked against the 1.21.11
// bytecode): the block rays of calculateExplodedPositions, getSeenPercent and the entity damage of
// hurtEntities / ExplosionDamageCalculator.getEntityDamageAmount. Float arithmetic is kept with
// Math.fround where vanilla works in float.
// 26.3's ServerExplosion is the same but for two things the bot doesn't meet: an entity on the source's team takes no
// damage (Entity.doTeamsAllowDamage), and the push goes through Entity.pushFromExplosion (Entity.push, overridden
// nowhere). The sources' powers are the same; minecraft-data's resistances differ for three slabs (quartz, red
// sandstone and cut red sandstone: 6 then 0.8), read from the version's registry.

const f = Math.fround
const F_0_3 = f(0.3)
const F_0_6 = f(0.6)
const F_0_7 = f(0.7)
const F_STEP_DECAY = f(0.22500001)
const F_15 = f(15)
/** the 0.3F step widened to double, as vanilla multiplies the direction by it */
const STEP = 0.30000001192092896

/** Explosion powers (radius) and centers of the vanilla sources. */
export const EXPLOSION_SOURCES = {
  /** Creeper.explodeCreeper: explosionRadius 3 at the creeper's feet */
  creeper: { power: 3, yOffset: 0 },
  /** a powered creeper doubles the radius (explosionMultiplier 2) */
  chargedCreeper: { power: 6, yOffset: 0 },
  /** PrimedTnt.explode: explosionPower 4 at getY(0.0625) of the 0.98-high entity */
  tnt: { power: 4, yOffset: 0.98 * 0.0625 },
  /** BedBlock in the nether or the end: 5 at the block's center (BlockPos.getCenter) */
  bed: { power: 5, yOffset: 0.5, blockCenter: true },
  /** RespawnAnchorBlock.explode: 5 at the block's center */
  respawnAnchor: { power: 5, yOffset: 0.5, blockCenter: true },
  /** EndCrystal.hurtServer: 6 at the crystal's position */
  endCrystal: { power: 6, yOffset: 0 },
  /** LargeFireball.onHit: explosionPower 1 (the ghast's default) */
  ghastFireball: { power: 1, yOffset: 0 }
} as const

export type ExplosionSourceName = keyof typeof EXPLOSION_SOURCES

/** Java's LCG, as vanilla's LegacyRandomSource (the level random is one). */
export class LegacyRandomSource {
  private seed = 0n

  constructor (seed: number | bigint) {
    this.setSeed(seed)
  }

  setSeed (seed: number | bigint): void {
    this.seed = (BigInt(seed) ^ 0x5DEECE66Dn) & 0xFFFFFFFFFFFFn
  }

  next (bits: number): number {
    this.seed = (this.seed * 0x5DEECE66Dn + 0xBn) & 0xFFFFFFFFFFFFn
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)))
  }

  nextFloat (): number {
    return f(this.next(24) * 5.9604645e-8)
  }
}

export interface RandomLike {
  nextFloat: () => number
}

/**
 * How each ray's starting intensity `power * (0.7 + nextFloat() * 0.6)` is drawn:
 * - 'worst': nextFloat() = 1, every ray at the 1.3 maximum (destroys a superset of any real explosion)
 * - 'least': nextFloat() = 0, every ray at 0.7
 * - a number: a LegacyRandomSource seeded with it
 * - a RandomLike: draws from it, one nextFloat() per ray in vanilla's order
 */
export type ExplosionRandom = 'worst' | 'least' | number | RandomLike

export interface ExplosionOptions {
  random?: ExplosionRandom
  /** world bottom (Level.isInWorldBounds); default -64 */
  minY?: number
  /** world top, exclusive; default 320 */
  maxY?: number
  registry?: BlockRegistry
  /** resistances to use instead of reading them from the world's blocks */
  resistance?: ResistanceGetter
}

/** Explosion resistance at a block; undefined where vanilla has none (air with no fluid). */
export type ResistanceGetter = (x: number, y: number, z: number) => number | undefined

export function resistanceGetter (world: BlockGetter, registry: BlockRegistry = blockRegistry()): ResistanceGetter {
  const cache = new Map<string, number | undefined>()
  return (x, y, z) => {
    const block = world(x, y, z)
    if (block == null) return undefined
    if (typeof block === 'string') {
      if (cache.has(block)) return cache.get(block)
      const resistance = registry.explosionResistance(block)
      cache.set(block, resistance)
      return resistance
    }
    return registry.explosionResistance(block)
  }
}

/** Unit ray directions of calculateExplodedPositions, in vanilla's loop order (1352 rays, xyz triples). */
export const RAY_DIRECTIONS: Float64Array = (() => {
  const dirs: number[] = []
  for (let xx = 0; xx < 16; xx++) {
    for (let yy = 0; yy < 16; yy++) {
      for (let zz = 0; zz < 16; zz++) {
        if (xx !== 0 && xx !== 15 && yy !== 0 && yy !== 15 && zz !== 0 && zz !== 15) continue
        let xd = f(f(f(xx / F_15) * 2) - 1)
        let yd = f(f(f(yy / F_15) * 2) - 1)
        let zd = f(f(f(zz / F_15) * 2) - 1)
        const d = Math.sqrt(xd * xd + yd * yd + zd * zd)
        xd /= d
        yd /= d
        zd /= d
        dirs.push(xd, yd, zd)
      }
    }
  }
  return Float64Array.from(dirs)
})()

export const RAY_COUNT = RAY_DIRECTIONS.length / 3

/** The starting intensity of each ray, drawn as vanilla draws them (one nextFloat() per ray, in order). */
export function rayPowers (radius: number, random: ExplosionRandom = 'worst'): Float32Array {
  const powers = new Float32Array(RAY_COUNT)
  const source: RandomLike | undefined = typeof random === 'number' ? new LegacyRandomSource(random) : typeof random === 'object' ? random : undefined
  for (let i = 0; i < RAY_COUNT; i++) {
    const r = source != null ? source.nextFloat() : random === 'least' ? 0 : 1
    powers[i] = f(radius * f(F_0_7 + f(r * F_0_6)))
  }
  return powers
}

/** Called at each ray step after the resistance there is taken off: return false to stop the ray. */
export type RayVisitor = (x: number, y: number, z: number, remaining: number) => unknown

/**
 * One ray of calculateExplodedPositions: steps of 0.3 from the center while the intensity is above 0;
 * at each step the block (and fluid) resistance r takes (r + 0.3) * 0.3 off, the block is blown when
 * the intensity is still above 0, then the step decay 0.225 comes off.
 */
export function traceRay (resistance: ResistanceGetter, center: Vec, dx: number, dy: number, dz: number, power: number,
  visit: RayVisitor, minY = -64, maxY = 320): void {
  let remaining = f(power)
  let xp = center.x
  let yp = center.y
  let zp = center.z
  while (remaining > 0) {
    const x = Math.floor(xp)
    const y = Math.floor(yp)
    const z = Math.floor(zp)
    // Level.isInWorldBounds
    if (y < minY || y >= maxY || x < -30000000 || z < -30000000 || x >= 30000000 || z >= 30000000) break
    const r = resistance(x, y, z)
    if (r !== undefined) remaining = f(remaining - f(f(f(r) + F_0_3) * F_0_3))
    if (remaining > 0 && visit(x, y, z, remaining) === false) break
    xp += dx * STEP
    yp += dy * STEP
    zp += dz * STEP
    remaining = f(remaining - F_STEP_DECAY)
  }
}

export interface ExplodedPositions {
  /** every position a ray reached with intensity left (vanilla's toBlow set, air included) */
  blown: Vec[]
  /** the blown positions holding a block or fluid: what the explosion removes */
  destroyed: Vec[]
}

/** ServerExplosion.calculateExplodedPositions (the creeper's, TNT's and the default calculator: every block may explode). */
export function calculateExplodedPositions (world: BlockGetter, center: Vec, radius: number,
  options: ExplosionOptions = {}): ExplodedPositions {
  const resistance = options.resistance ?? resistanceGetter(world, options.registry ?? blockRegistry())
  const powers = rayPowers(radius, options.random)
  const blown = new Map<string, Vec>()
  const destroyed: Vec[] = []
  for (let i = 0; i < RAY_COUNT; i++) {
    traceRay(resistance, center, RAY_DIRECTIONS[i * 3], RAY_DIRECTIONS[i * 3 + 1], RAY_DIRECTIONS[i * 3 + 2], powers[i], (x, y, z) => {
      const key = `${x},${y},${z}`
      if (blown.has(key)) return
      const pos = { x, y, z }
      blown.set(key, pos)
      if (resistance(x, y, z) !== undefined) destroyed.push(pos)
    }, options.minY, options.maxY)
  }
  return { blown: [...blown.values()], destroyed }
}

// --- entities -----------------------------------------------------------------------------------

/** Collision boxes of the block at a position, world coordinates (ClipContext.Block.COLLIDER). */
export type ShapeGetter = (x: number, y: number, z: number) => Box[]

export function shapeGetter (world: BlockGetter, registry: BlockRegistry = blockRegistry()): ShapeGetter {
  return (x, y, z) => registry.collisionBoxes(world(x, y, z))
}

/** AABB.clip's per-face test (clipPoint): the entry face a ray crosses before scale[0]. */
function clipPoint (scale: number[], hit: boolean, da: number, db: number, dc: number, point: number,
  minB: number, maxB: number, minC: number, maxC: number, fromA: number, fromB: number, fromC: number): boolean {
  const s = (point - fromA) / da
  const pb = fromB + s * db
  const pc = fromC + s * dc
  if (s > 0 && s < scale[0] && minB - 1e-7 < pb && pb < maxB + 1e-7 && minC - 1e-7 < pc && pc < maxC + 1e-7) {
    scale[0] = s
    return true
  }
  return hit
}

/** VoxelShape.clip: the segment hits the shape at block (x, y, z) (starting inside it counts). */
function clipShape (boxes: Box[], from: Vec, to: Vec, x: number, y: number, z: number): boolean {
  if (boxes.length === 0) return false
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  if (dx * dx + dy * dy + dz * dz < 1e-7) return false
  // the test point 0.001 along the segment inside a voxel of the shape (VoxelShape.findIndex / isFullWide)
  const tx = from.x + dx * 0.001 - x
  const ty = from.y + dy * 0.001 - y
  const tz = from.z + dz * 0.001 - z
  for (const b of boxes) {
    if (tx >= b[0] && tx < b[3] && ty >= b[1] && ty < b[4] && tz >= b[2] && tz < b[5]) return true
  }
  // AABB.clip over the shape's boxes moved to the block
  const scale = [1]
  let hit = false
  for (const b of boxes) {
    const minX = b[0] + x; const minY = b[1] + y; const minZ = b[2] + z
    const maxX = b[3] + x; const maxY = b[4] + y; const maxZ = b[5] + z
    if (dx > 1e-7) hit = clipPoint(scale, hit, dx, dy, dz, minX, minY, maxY, minZ, maxZ, from.x, from.y, from.z)
    else if (dx < -1e-7) hit = clipPoint(scale, hit, dx, dy, dz, maxX, minY, maxY, minZ, maxZ, from.x, from.y, from.z)
    if (dy > 1e-7) hit = clipPoint(scale, hit, dy, dz, dx, minY, minZ, maxZ, minX, maxX, from.y, from.z, from.x)
    else if (dy < -1e-7) hit = clipPoint(scale, hit, dy, dz, dx, maxY, minZ, maxZ, minX, maxX, from.y, from.z, from.x)
    if (dz > 1e-7) hit = clipPoint(scale, hit, dz, dx, dy, minZ, minX, maxX, minY, maxY, from.z, from.x, from.y)
    else if (dz < -1e-7) hit = clipPoint(scale, hit, dz, dx, dy, maxZ, minX, maxX, minY, maxY, from.z, from.x, from.y)
  }
  return hit
}

const frac = (v: number): number => v - Math.floor(v)
const lerp = (t: number, a: number, b: number): number => a + t * (b - a)

/**
 * BlockGetter.clip with ClipContext.Block.COLLIDER and ClipContext.Fluid.NONE, walking the blocks as
 * BlockGetter.traverseBlocks does. True when a collision shape is in the way.
 */
export function clipBlocks (shapes: ShapeGetter, from: Vec, to: Vec): boolean {
  if (from.x === to.x && from.y === to.y && from.z === to.z) return false
  const toX = lerp(-1e-7, to.x, from.x)
  const toY = lerp(-1e-7, to.y, from.y)
  const toZ = lerp(-1e-7, to.z, from.z)
  const fromX = lerp(-1e-7, from.x, to.x)
  const fromY = lerp(-1e-7, from.y, to.y)
  const fromZ = lerp(-1e-7, from.z, to.z)
  let bx = Math.floor(fromX)
  let by = Math.floor(fromY)
  let bz = Math.floor(fromZ)
  if (clipShape(shapes(bx, by, bz), from, to, bx, by, bz)) return true
  const dx = toX - fromX
  const dy = toY - fromY
  const dz = toZ - fromZ
  const signX = Math.sign(dx)
  const signY = Math.sign(dy)
  const signZ = Math.sign(dz)
  const tDeltaX = signX === 0 ? Number.MAX_VALUE : signX / dx
  const tDeltaY = signY === 0 ? Number.MAX_VALUE : signY / dy
  const tDeltaZ = signZ === 0 ? Number.MAX_VALUE : signZ / dz
  let tX = tDeltaX * (signX > 0 ? 1 - frac(fromX) : frac(fromX))
  let tY = tDeltaY * (signY > 0 ? 1 - frac(fromY) : frac(fromY))
  let tZ = tDeltaZ * (signZ > 0 ? 1 - frac(fromZ) : frac(fromZ))
  while (tX <= 1 || tY <= 1 || tZ <= 1) {
    if (tX < tY) {
      if (tX < tZ) {
        bx += signX
        tX += tDeltaX
      } else {
        bz += signZ
        tZ += tDeltaZ
      }
    } else if (tY < tZ) {
      by += signY
      tY += tDeltaY
    } else {
      bz += signZ
      tZ += tDeltaZ
    }
    if (clipShape(shapes(bx, by, bz), from, to, bx, by, bz)) return true
  }
  return false
}

/** An entity's bounding box, world coordinates. */
export interface EntityBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/**
 * ServerExplosion.getSeenPercent: the share of sample points spread over the entity's box that see the
 * explosion center with no block collision shape in between (fluids don't block).
 */
export function getSeenPercent (shapes: ShapeGetter, center: Vec, bb: EntityBox): number {
  const xs = 1 / ((bb.maxX - bb.minX) * 2 + 1)
  const ys = 1 / ((bb.maxY - bb.minY) * 2 + 1)
  const zs = 1 / ((bb.maxZ - bb.minZ) * 2 + 1)
  const xOffset = (1 - Math.floor(1 / xs) * xs) / 2
  const zOffset = (1 - Math.floor(1 / zs) * zs) / 2
  if (xs < 0 || ys < 0 || zs < 0) return 0
  let hits = 0
  let count = 0
  for (let xx = 0; xx <= 1; xx += xs) {
    for (let yy = 0; yy <= 1; yy += ys) {
      for (let zz = 0; zz <= 1; zz += zs) {
        const x = lerp(xx, bb.minX, bb.maxX)
        const y = lerp(yy, bb.minY, bb.maxY)
        const z = lerp(zz, bb.minZ, bb.maxZ)
        if (!clipBlocks(shapes, { x: x + xOffset, y, z: z + zOffset }, center)) hits++
        count++
      }
    }
  }
  return f(f(hits) / f(count))
}

export interface ExplosionEntity {
  /** the entity's position (feet); distances are measured from it */
  position: Vec
  width: number
  height: number
  /** eye height, for the knockback direction (PrimedTnt uses its position) */
  eyeHeight?: number
  /** EXPLOSION_KNOCKBACK_RESISTANCE of a living entity */
  knockbackResistance?: number
  /** item entities: ItemEntity's health (5) */
  health?: number
  /** anything the caller wants back with the result */
  tag?: unknown
}

/** An item entity at a position (EntityType.ITEM: 0.25 x 0.25, eye 0.2125, health 5). */
export function itemEntity (position: Vec, tag?: unknown): ExplosionEntity {
  return { position, width: 0.25, height: 0.25, eyeHeight: 0.2125, health: 5, tag }
}

/** A standing player (0.6 x 1.8, eye 1.62). */
export function playerEntity (position: Vec, tag?: unknown): ExplosionEntity {
  return { position, width: 0.6, height: 1.8, eyeHeight: 1.62, tag }
}

export function entityBox (entity: ExplosionEntity): EntityBox {
  const w = entity.width / 2
  const p = entity.position
  return { minX: p.x - w, minY: p.y, minZ: p.z - w, maxX: p.x + w, maxY: p.y + entity.height, maxZ: p.z + w }
}

export interface EntityHit {
  entity: ExplosionEntity
  /** distance / (2 * radius) */
  distance: number
  exposure: number
  /**
   * getEntityDamageAmount, before armor and difficulty: players take min(d / 2 + 1, d) on easy and
   * d * 1.5 on hard (DamageSource.scalesWithDifficulty).
   */
  damage: number
  knockback: Vec
  /** an item entity with `health` set: the damage takes its health to 0 */
  destroyed?: boolean
}

/** ServerExplosion.hurtEntities with the default ExplosionDamageCalculator. */
export function hurtEntities (world: BlockGetter, center: Vec, radius: number, entities: ExplosionEntity[],
  options: { registry?: BlockRegistry, shapes?: ShapeGetter } = {}): EntityHit[] {
  const hits: EntityHit[] = []
  if (radius < 1e-5) return hits
  const shapes = options.shapes ?? shapeGetter(world, options.registry)
  const doubleRadius = f(f(radius) * 2)
  const x0 = Math.floor(center.x - doubleRadius - 1)
  const x1 = Math.floor(center.x + doubleRadius + 1)
  const y0 = Math.floor(center.y - doubleRadius - 1)
  const y1 = Math.floor(center.y + doubleRadius + 1)
  const z0 = Math.floor(center.z - doubleRadius - 1)
  const z1 = Math.floor(center.z + doubleRadius + 1)
  for (const entity of entities) {
    const bb = entityBox(entity)
    // Level.getEntities: boxes that intersect the explosion's AABB
    if (!(bb.minX < x1 && bb.maxX > x0 && bb.minY < y1 && bb.maxY > y0 && bb.minZ < z1 && bb.maxZ > z0)) continue
    const p = entity.position
    const distanceToCenter = Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2 + (p.z - center.z) ** 2)
    const dist = distanceToCenter / doubleRadius
    if (dist > 1) continue
    const exposure = getSeenPercent(shapes, center, bb)
    // ExplosionDamageCalculator.getEntityDamageAmount
    const pow = (1 - dist) * exposure
    const damage = f((pow * pow + pow) / 2 * 7 * doubleRadius + 1)
    const origin = { x: p.x, y: p.y + (entity.eyeHeight ?? 0), z: p.z }
    let dx = origin.x - center.x
    let dy = origin.y - center.y
    let dz = origin.z - center.z
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (length < 1e-5) { dx = 0; dy = 0; dz = 0 } else { dx /= length; dy /= length; dz /= length }
    const knockbackPower = (1 - dist) * exposure * (1 - (entity.knockbackResistance ?? 0))
    const hit: EntityHit = { entity, distance: dist, exposure, damage, knockback: { x: dx * knockbackPower, y: dy * knockbackPower, z: dz * knockbackPower } }
    if (entity.health != null) hit.destroyed = f(entity.health - damage) <= 0
    hits.push(hit)
  }
  return hits
}

export interface ExplosionResult extends ExplodedPositions {
  center: Vec
  radius: number
  entities: EntityHit[]
}

/**
 * ServerExplosion.explode without the side effects: the blocks it removes and what it does to the
 * given entities. Vanilla hurts entities before it breaks blocks, so the drops of broken blocks
 * (chest contents) are not hurt by the same explosion.
 */
export function explode (world: BlockGetter, center: Vec, radius: number,
  options: ExplosionOptions & { entities?: ExplosionEntity[] } = {}): ExplosionResult {
  const registry = options.registry ?? blockRegistry()
  const blocks = calculateExplodedPositions(world, center, radius, { ...options, registry })
  const entities = hurtEntities(world, center, radius, options.entities ?? [], { registry })
  return { center, radius, ...blocks, entities }
}

/** The center of a vanilla source's explosion for an entity at `position` (a block position for beds and anchors). */
export function sourceCenter (source: ExplosionSourceName, position: Vec): Vec {
  const s: { yOffset: number, blockCenter?: boolean } = EXPLOSION_SOURCES[source]
  const xz = s.blockCenter === true ? 0.5 : 0
  return { x: position.x + xz, y: position.y + s.yOffset, z: position.z + xz }
}
