import { BlockGetter, BlockRegistry, Bounds, Vec, blockRegistry } from './blocks'
import { EXPLOSION_SOURCES, RAY_COUNT, RAY_DIRECTIONS, ResistanceGetter, resistanceGetter } from './explosion'

// Worst-case storage safety: a vanilla explosion (ServerExplosion.calculateExplodedPositions with every
// ray at the 1.3 maximum) at every point a mob can reach, checked against every storage block.

const f = Math.fround
const F_0_3 = f(0.3)
const F_STEP_DECAY = f(0.22500001)
const STEP = 0.30000001192092896

export interface ExplosionThreat {
  name: string
  power: number
}

export const CREEPER: ExplosionThreat = { name: 'creeper', power: EXPLOSION_SOURCES.creeper.power }
export const CHARGED_CREEPER: ExplosionThreat = { name: 'charged creeper', power: EXPLOSION_SOURCES.chargedCreeper.power }
export const DEFAULT_THREATS: ExplosionThreat[] = [CREEPER, CHARGED_CREEPER]

/**
 * Explosion centers tried inside each reachable cell, relative to its min corner. A creeper (0.6 wide)
 * explodes at its feet: its center can come within 0.3 of a wall, and stands on the floor or is
 * mid-jump or falling.
 */
export const DEFAULT_SAMPLE_OFFSETS: Vec[] = (() => {
  const offsets: Vec[] = []
  for (const y of [0, 0.5]) for (const x of [0.3, 0.5, 0.7]) for (const z of [0.3, 0.5, 0.7]) offsets.push({ x, y, z })
  return offsets
})()

export interface SafetyOptions {
  threats?: ExplosionThreat[]
  /** the design's extent; the analysis covers it and the storage, grown by the strongest threat's reach */
  bounds?: Bounds
  /** cells mobs start from; default every walkable cell on the analysis region's boundary */
  seeds?: Vec[]
  /**
   * doors a mob path may pass. An airlock keeps one of its two doors shut, so the default 1 lets a
   * creeper into the tunnel but not past the second door. A creeper may stand in a doorway it reaches.
   */
  openDoors?: number
  sampleOffsets?: Vec[]
  registry?: BlockRegistry
  minY?: number
  maxY?: number
}

export interface PathStep {
  block: string
  /** ray samples in this block */
  samples: number
  /** intensity left after the last of them */
  remaining: number
}

export interface UnsafeStorage {
  storage: Vec
  block: string
  threat: ExplosionThreat
  /** the explosion center that leaves the most intensity at this block */
  center: Vec
  /** the ray's unit direction */
  direction: Vec
  /** intensity left at the storage block after its own resistance (> 0: it is destroyed) */
  remaining: number
  /** what the ray went through, from the center to the storage block */
  path: PathStep[]
  /** the solid blocks on that path (doors and torches included) */
  shellBlocks: number
  reason: string
}

export interface SafetyReport {
  safe: boolean
  unsafe: UnsafeStorage[]
  /** per threat, the storage blocks it destroys */
  byThreat: Array<{ threat: ExplosionThreat, unsafe: Vec[] }>
  /** reachable cells close enough to a storage block to matter */
  candidateCells: number
  explosions: number
  region: Bounds
}

/** The farthest ray sample (in blocks) that can still destroy a block of this resistance, through air only. */
export function explosionReach (power: number, resistance: number): number {
  const loss = f(f(f(resistance) + F_0_3) * F_0_3)
  let remaining = f(power * f(f(0.7) + f(0.6)))
  let k = 0
  let reach = -1
  while (remaining > 0) {
    if (f(remaining - loss) > 0) reach = k
    remaining = f(remaining - F_STEP_DECAY)
    k++
  }
  return reach < 0 ? -1 : reach * STEP
}

const CELL_HALF_DIAGONAL = Math.sqrt(3) / 2
const BUCKETS = 16

// ray directions bucketed on a 16^3 grid over [-1, 1]^3, to find the rays near a direction quickly
const rayBuckets = (() => {
  const lists: number[][] = Array.from({ length: BUCKETS ** 3 }, () => [])
  for (let i = 0; i < RAY_COUNT; i++) {
    lists[bucketIndex(RAY_DIRECTIONS[i * 3]) * BUCKETS * BUCKETS + bucketIndex(RAY_DIRECTIONS[i * 3 + 1]) * BUCKETS + bucketIndex(RAY_DIRECTIONS[i * 3 + 2])].push(i)
  }
  return lists.map(l => Int32Array.from(l))
})()

function bucketIndex (c: number): number {
  return Math.max(0, Math.min(BUCKETS - 1, Math.floor((c + 1) / 2 * BUCKETS)))
}

const SOLID = 0
const WALKABLE = 1
const DOOR = 2

/** The analysis grid: per cell the vanilla resistance loss, what a mob can do there, and the storage index. */
class Grid {
  readonly sx: number
  readonly sy: number
  readonly sz: number
  readonly loss: Float32Array
  readonly kind: Uint8Array
  readonly storage: Int32Array

  constructor (readonly world: BlockGetter, readonly region: Bounds, storage: Vec[], registry: BlockRegistry) {
    const { min, max } = region
    this.sx = max.x - min.x
    this.sy = max.y - min.y
    this.sz = max.z - min.z
    const n = this.sx * this.sy * this.sz
    this.loss = new Float32Array(n)
    this.kind = new Uint8Array(n)
    this.storage = new Int32Array(n).fill(-1)
    const cache = new Map<string, [number, number]>()
    for (let y = min.y; y < max.y; y++) {
      for (let z = min.z; z < max.z; z++) {
        for (let x = min.x; x < max.x; x++) {
          const block = world(x, y, z)
          let entry = typeof block === 'string' || block == null ? cache.get(block ?? 'air') : undefined
          if (entry == null) {
            const r = registry.explosionResistance(block)
            const loss = r === undefined ? -1 : f(f(f(r) + F_0_3) * F_0_3)
            const kind = BlockRegistry.isDoor(block) ? DOOR : registry.hasNoCollision(block) ? WALKABLE : SOLID
            entry = [loss, kind]
            if (typeof block === 'string' || block == null) cache.set(block ?? 'air', entry)
          }
          const i = this.index(x, y, z)
          this.loss[i] = entry[0]
          this.kind[i] = entry[1]
        }
      }
    }
    storage.forEach((p, s) => {
      if (this.contains(p.x, p.y, p.z)) this.storage[this.index(p.x, p.y, p.z)] = s
    })
  }

  index (x: number, y: number, z: number): number {
    return ((y - this.region.min.y) * this.sz + (z - this.region.min.z)) * this.sx + (x - this.region.min.x)
  }

  contains (x: number, y: number, z: number): boolean {
    const { min, max } = this.region
    return x >= min.x && y >= min.y && z >= min.z && x < max.x && y < max.y && z < max.z
  }

  /**
   * Doors passed to reach each cell (255: unreachable within `openDoors`). A door counts once it is
   * left for a non-door cell, so a mob can stand in a doorway it has walked up to.
   */
  reach (seeds: Vec[], openDoors: number): Uint8Array {
    const cost = new Uint8Array(this.kind.length).fill(255)
    const deque = new Int32Array(this.kind.length * 2 + 2)
    let head = this.kind.length
    let tail = head
    for (const s of seeds) {
      if (!this.contains(s.x, s.y, s.z)) continue
      const i = this.index(s.x, s.y, s.z)
      if (this.kind[i] === SOLID || cost[i] === 0) continue
      cost[i] = 0
      deque[tail++] = i
    }
    const strideY = this.sx * this.sz
    while (head < tail) {
      const i = deque[head++]
      const c = cost[i]
      const x = i % this.sx
      const z = Math.floor(i / this.sx) % this.sz
      const y = Math.floor(i / strideY)
      const neighbours = [
        x > 0 ? i - 1 : -1, x < this.sx - 1 ? i + 1 : -1,
        z > 0 ? i - this.sx : -1, z < this.sz - 1 ? i + this.sx : -1,
        y > 0 ? i - strideY : -1, y < this.sy - 1 ? i + strideY : -1
      ]
      for (const n of neighbours) {
        if (n < 0 || this.kind[n] === SOLID) continue
        const step = this.kind[i] === DOOR && this.kind[n] !== DOOR ? 1 : 0
        const nc = c + step
        if (nc > openDoors || nc >= cost[n]) continue
        cost[n] = nc
        if (step === 0) deque[--head] = n
        else deque[tail++] = n
      }
    }
    return cost
  }
}

function boxDistance (p: Vec, b: Vec): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + 1))
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + 1))
  const dz = Math.max(b.z - p.z, 0, p.z - (b.z + 1))
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Segment-box slab test: the entry and exit distance of the ray through the unit cell at `b`, or undefined. */
function rayCell (c: Vec, dx: number, dy: number, dz: number, b: Vec): [number, number] | undefined {
  let t0 = -Infinity
  let t1 = Infinity
  const axes: Array<[number, number, number]> = [[c.x, dx, b.x], [c.y, dy, b.y], [c.z, dz, b.z]]
  for (const [o, d, lo] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > lo + 1) return undefined
      continue
    }
    let a = (lo - o) / d
    let e = (lo + 1 - o) / d
    if (a > e) [a, e] = [e, a]
    if (a > t0) t0 = a
    if (e < t1) t1 = e
  }
  return t0 <= t1 && t1 >= 0 ? [t0, t1] : undefined
}

/** Grows a box by `by` on every side. */
function grow (b: Bounds, by: number): Bounds {
  return { min: { x: b.min.x - by, y: b.min.y - by, z: b.min.z - by }, max: { x: b.max.x + by, y: b.max.y + by, z: b.max.z + by } }
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

function union (a: Bounds, b: Bounds): Bounds {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) }
  }
}

/**
 * Checks that no storage block (chest, barrel...) of a built design can be destroyed by one explosion
 * of each threat at any point a mob can reach: outside the shell, in the airlock up to its shut door,
 * or anywhere else the flood fill gets to. Every ray starts at the 1.3 maximum, so a safe result holds
 * for every random draw.
 */
export function checkStorageSafety (world: BlockGetter, storage: Vec[], options: SafetyOptions = {}): SafetyReport {
  const registry = options.registry ?? blockRegistry()
  const threats = [...(options.threats ?? DEFAULT_THREATS)].sort((a, b) => b.power - a.power)
  const offsets = options.sampleOffsets ?? DEFAULT_SAMPLE_OFFSETS
  const minY = options.minY ?? -64
  const maxY = options.maxY ?? 320
  const storageRes = storage.map(p => registry.explosionResistance(world(p.x, p.y, p.z)) ?? 0)
  // per threat and storage block, the farthest sample that can still break it
  const reaches = threats.map(t => storageRes.map(r => explosionReach(t.power, r)))
  const maxReach = Math.max(-1, ...reaches.flat())
  const report: SafetyReport = { safe: true, unsafe: [], byThreat: threats.map(threat => ({ threat, unsafe: [] })), candidateCells: 0, explosions: 0, region: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } }
  if (storage.length === 0 || maxReach < 0) return report

  let base = boundsOf(storage)
  if (options.bounds != null) base = union(base, options.bounds)
  const region = grow(base, Math.ceil(maxReach) + 2)
  report.region = region
  const grid = new Grid(world, region, storage, registry)
  const seeds: Vec[] = options.seeds ?? boundaryCells(region)
  const cost = grid.reach(seeds, options.openDoors ?? 1)

  // worst[threat][storage] = the explosion leaving the most intensity at it
  const worst: Array<Array<{ remaining: number, center: Vec, ray: number } | undefined>> = threats.map(() => storage.map(() => undefined))
  const stamp = new Int32Array(RAY_COUNT)
  const stop = new Float64Array(RAY_COUNT)
  const marked = new Int32Array(RAY_COUNT)
  let explosionId = 0

  const { min } = region
  for (let y = min.y; y < region.max.y; y++) {
    for (let z = min.z; z < region.max.z; z++) {
      for (let x = min.x; x < region.max.x; x++) {
        const i = grid.index(x, y, z)
        if (cost[i] === 255 || grid.kind[i] === SOLID) continue
        const cell = { x: x + 0.5, y: y + 0.5, z: z + 0.5 }
        if (!storage.some((s, si) => boxDistance(cell, s) <= reaches[0][si] + CELL_HALF_DIAGONAL)) continue
        report.candidateCells++
        for (const o of offsets) {
          const center = { x: x + o.x, y: y + o.y, z: z + o.z }
          for (let t = 0; t < threats.length; t++) {
            explosionId++
            report.explosions++
            const broke = explodeAt(t, center)
            if (!broke) break // monotone: a weaker explosion breaks nothing either
          }
        }
      }
    }
  }

  function explodeAt (t: number, center: Vec): boolean {
    // the rays that pass through a storage block within reach
    let count = 0
    for (let s = 0; s < storage.length; s++) {
      const reach = reaches[t][s]
      const b = storage[s]
      if (reach < 0 || boxDistance(center, b) > reach) continue
      const vx = b.x + 0.5 - center.x
      const vy = b.y + 0.5 - center.y
      const vz = b.z + 0.5 - center.z
      const dist = Math.sqrt(vx * vx + vy * vy + vz * vz)
      let lo = [-1, -1, -1]
      let hi = [1, 1, 1]
      if (dist > CELL_HALF_DIAGONAL + 1e-9) {
        const theta = Math.asin(Math.min(1, CELL_HALF_DIAGONAL / dist))
        const chord = 2 * Math.sin(theta / 2) + 1e-6
        const a = [vx / dist, vy / dist, vz / dist]
        lo = a.map(c => c - chord)
        hi = a.map(c => c + chord)
      }
      for (let bx = bucketIndex(lo[0]); bx <= bucketIndex(hi[0]); bx++) {
        for (let by = bucketIndex(lo[1]); by <= bucketIndex(hi[1]); by++) {
          for (let bz = bucketIndex(lo[2]); bz <= bucketIndex(hi[2]); bz++) {
            for (const r of rayBuckets[(bx * BUCKETS + by) * BUCKETS + bz]) {
              const hit = rayCell(center, RAY_DIRECTIONS[r * 3], RAY_DIRECTIONS[r * 3 + 1], RAY_DIRECTIONS[r * 3 + 2], b)
              if (hit == null || hit[0] > reach + STEP) continue
              if (stamp[r] !== explosionId) {
                stamp[r] = explosionId
                stop[r] = hit[1]
                marked[count++] = r
              } else if (hit[1] > stop[r]) stop[r] = hit[1]
            }
          }
        }
      }
    }
    const power = f(threats[t].power * f(f(0.7) + f(0.6)))
    let broke = false
    for (let m = 0; m < count; m++) {
      const r = marked[m]
      const dx = RAY_DIRECTIONS[r * 3]
      const dy = RAY_DIRECTIONS[r * 3 + 1]
      const dz = RAY_DIRECTIONS[r * 3 + 2]
      const last = stop[r] + STEP
      let remaining = power
      let xp = center.x
      let yp = center.y
      let zp = center.z
      // traceRay over the grid, stopping past the last storage block on the ray
      for (let k = 0; remaining > 0 && k * STEP <= last; k++) {
        const bx = Math.floor(xp)
        const by = Math.floor(yp)
        const bz = Math.floor(zp)
        if (by < minY || by >= maxY || !grid.contains(bx, by, bz)) break
        const i = grid.index(bx, by, bz)
        const loss = grid.loss[i]
        if (loss >= 0) remaining = f(remaining - loss)
        if (remaining > 0) {
          const s = grid.storage[i]
          if (s >= 0) {
            broke = true
            const w = worst[t][s]
            if (w == null || remaining > w.remaining) worst[t][s] = { remaining, center: { ...center }, ray: r }
          }
        }
        xp += dx * STEP
        yp += dy * STEP
        zp += dz * STEP
        remaining = f(remaining - F_STEP_DECAY)
      }
    }
    return broke
  }

  const resistance = resistanceGetter(world, registry)
  threats.forEach((threat, t) => {
    storage.forEach((pos, s) => {
      const w = worst[t][s]
      if (w == null) return
      report.safe = false
      report.byThreat[t].unsafe.push(pos)
      const direction = { x: RAY_DIRECTIONS[w.ray * 3], y: RAY_DIRECTIONS[w.ray * 3 + 1], z: RAY_DIRECTIONS[w.ray * 3 + 2] }
      const path = rayPath(world, resistance, w.center, direction, f(threat.power * f(f(0.7) + f(0.6))), pos)
      const shell = path.slice(0, -1).filter(step => !registry.isAir(step.block))
      const name = BlockRegistry.nameOf(world(pos.x, pos.y, pos.z))
      const through = shell.length === 0 ? 'nothing but air' : summarize(shell.map(step => step.block))
      report.unsafe.push({
        storage: pos,
        block: name,
        threat,
        center: w.center,
        direction,
        remaining: w.remaining,
        path,
        shellBlocks: shell.length,
        reason: `${name} at ${fmt(pos)} is destroyed by a ${threat.name} (power ${threat.power}) at ${fmt(w.center, 2)}: ` +
          `the ray crosses ${through} and reaches it with ${w.remaining.toFixed(3)} intensity left`
      })
    })
  })
  return report
}

/** Every sample of one ray from the center to `target`, grouped by block (the vanilla step loop of traceRay). */
function rayPath (world: BlockGetter, resistance: ResistanceGetter, center: Vec, d: Vec, power: number, target: Vec): PathStep[] {
  const path: Array<PathStep & { at: string }> = []
  let remaining = power
  let xp = center.x
  let yp = center.y
  let zp = center.z
  while (remaining > 0) {
    const x = Math.floor(xp)
    const y = Math.floor(yp)
    const z = Math.floor(zp)
    const r = resistance(x, y, z)
    if (r !== undefined) remaining = f(remaining - f(f(f(r) + F_0_3) * F_0_3))
    const at = `${x},${y},${z}`
    const last = path[path.length - 1]
    if (last?.at === at) {
      last.samples++
      last.remaining = remaining
    } else {
      path.push({ block: BlockRegistry.nameOf(world(x, y, z)), samples: 1, remaining, at })
    }
    if (x === target.x && y === target.y && z === target.z) break
    xp += d.x * STEP
    yp += d.y * STEP
    zp += d.z * STEP
    remaining = f(remaining - F_STEP_DECAY)
  }
  return path.map(({ block, samples, remaining }) => ({ block, samples, remaining }))
}

function summarize (blocks: string[]): string {
  const counts = new Map<string, number>()
  for (const b of blocks) counts.set(b, (counts.get(b) ?? 0) + 1)
  return [...counts].map(([b, n]) => `${n} ${b}`).join(', ')
}

function fmt (p: Vec, digits = 0): string {
  return `(${p.x.toFixed(digits)}, ${p.y.toFixed(digits)}, ${p.z.toFixed(digits)})`
}

function boundaryCells (b: Bounds): Vec[] {
  const cells: Vec[] = []
  for (let y = b.min.y; y < b.max.y; y++) {
    for (let z = b.min.z; z < b.max.z; z++) {
      for (let x = b.min.x; x < b.max.x; x++) {
        if (x === b.min.x || y === b.min.y || z === b.min.z || x === b.max.x - 1 || y === b.max.y - 1 || z === b.max.z - 1) cells.push({ x, y, z })
      }
    }
  }
  return cells
}

/**
 * The fewest layers of a material that keep a storage block intact against a threat, from a flat wall
 * of that material with the storage block right behind it and explosions anywhere in front of it.
 * Undefined when even `maxThickness` layers don't hold.
 */
export function requiredThickness (material: string, threat: ExplosionThreat, options: { storageBlock?: string, maxThickness?: number, registry?: BlockRegistry } = {}): number | undefined {
  const maxThickness = options.maxThickness ?? 8
  const storageBlock = options.storageBlock ?? 'chest'
  for (let t = 1; t <= maxThickness; t++) {
    // the wall fills x in [0, t); the chest sits at (t, 0, 0) with the wall's material all around it
    const world: BlockGetter = (x, y, z) => x < 0 ? null : (x === t && y === 0 && z === 0 ? storageBlock : material)
    const report = checkStorageSafety(world, [{ x: t, y: 0, z: 0 }], { threats: [threat], seeds: [{ x: -1, y: 0, z: 0 }], registry: options.registry })
    if (report.safe) return t
  }
  return undefined
}

export interface ThicknessTable {
  material: string
  /** per threat name: the fewest layers, undefined if none up to the maximum */
  thickness: Record<string, number | undefined>
}

/** requiredThickness for each material and threat. */
export function thicknessTable (materials: string[], threats: ExplosionThreat[] = DEFAULT_THREATS, options: { storageBlock?: string, maxThickness?: number } = {}): ThicknessTable[] {
  return materials.map(material => ({
    material,
    thickness: Object.fromEntries(threats.map(threat => [threat.name, requiredThickness(material, threat, options)]))
  }))
}

export interface DesignForThickness {
  world: BlockGetter
  storage: Vec[]
  bounds?: Bounds
  seeds?: Vec[]
}

/**
 * The thinnest shell of each material for which a whole design passes checkStorageSafety. The design
 * is rebuilt for every thickness (blueprint.generateBlueprint is the usual builder).
 */
export function minimumShellThickness (build: (thickness: number, material: string) => DesignForThickness, materials: string[],
  options: SafetyOptions & { maxThickness?: number } = {}): Array<{ material: string, thickness?: number, report?: SafetyReport }> {
  const maxThickness = options.maxThickness ?? 6
  return materials.map(material => {
    for (let t = 1; t <= maxThickness; t++) {
      const design = build(t, material)
      const report = checkStorageSafety(design.world, design.storage, { ...options, bounds: design.bounds ?? options.bounds, seeds: design.seeds ?? options.seeds })
      if (report.safe) return { material, thickness: t, report }
    }
    return { material }
  })
}
