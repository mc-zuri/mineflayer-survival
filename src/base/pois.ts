// The WorldMemory points of interest the base is recorded with, so the executor and the runner find its chests,
// crafting table, furnace and bed again (also after a restart, from the memory's JSON).
import type { Pos, Poi, WorldMemory } from '../core/memory'

export const BASE_POI = {
  /** the cell outside the outer door, where the bot comes and goes */
  entrance: 'base_entrance',
  table: 'base_crafting_table',
  furnace: 'base_furnace',
  bed: 'base_bed',
  /** a chest position of the blueprint not built yet (placed when the built ones fill) */
  spareChest: 'base_spare_chest',
  /** the box of the base, shell included: min corner, with the max corner in the note as "x,y,z" */
  bounds: 'base_bounds',
  /**
   * the build as it was left: at the origin, the note "missing/total/builds/doors" of the blueprint's blocks (doors:
   * those of them missing)
   */
  build: 'base_build'
} as const

/** the share of the blueprint's blocks a base may be missing and be built (the base milestone's) */
export const BASE_MISSING_SHARE = 0.2
/** the builds of one base after which it's taken as built whatever is missing (the game goes on with what there is) */
export const BASE_BUILD_TRIES = 3

/**
 * Whether the base the memory has is built: no build noted (a save from before it was), or at most BASE_MISSING_SHARE
 * of its blocks missing and its doors hung; or built BASE_BUILD_TRIES times. hunt2's runs counted 'base built: … 175
 * missing' a base reached; a 1.21.11 one 'base built: … 8 missing' with no door (its materials lost to a death), and
 * the milestone was reached (ls-1.21.11 t102744)
 */
export function baseBuilt (memory: Pick<WorldMemory, 'base' | 'getPois'>): boolean {
  if (memory.base == null) return false
  const note = memory.getPois(BASE_POI.build, { dimension: memory.base.dimension })[0]?.note
  const m = note != null ? /^(\d+)\/(\d+)(?:\/(\d+))?(?:\/(\d+))?$/.exec(note) : null
  if (m == null) return true
  if (Number(m[3] ?? 1) >= BASE_BUILD_TRIES) return true
  // (a door missing: built again, its next build's materials a door)
  if (Number(m[4] ?? 0) > 0) return false
  const total = Number(m[2])
  return total === 0 || Number(m[1]) / total <= BASE_MISSING_SHARE
}

export interface BaseRecord {
  origin: Pos
  entrance: Pos | null
  table: Pos | null
  furnaces: Pos[]
  bed: Pos | null
  chests: Pos[]
  spareChests: Pos[]
  bounds: { min: Pos, max: Pos } | null
}

const first = (pois: Poi[]): Pos | null => pois.length > 0 ? { x: pois[0].x, y: pois[0].y, z: pois[0].z } : null

/** the base as the memory has it, or null when there is none */
export function baseRecord (memory: WorldMemory): BaseRecord | null {
  const base = memory.base
  if (base == null) return null
  const dimension = base.dimension
  const near = (kind: string): Poi[] => memory.getPois(kind, { dimension, near: base })
  const boundsPoi = near(BASE_POI.bounds)[0]
  let bounds: BaseRecord['bounds'] = null
  if (boundsPoi?.note != null) {
    const [x, y, z] = boundsPoi.note.split(',').map(Number)
    bounds = { min: { x: boundsPoi.x, y: boundsPoi.y, z: boundsPoi.z }, max: { x, y, z } }
  }
  const inBase = (p: Pos): boolean => bounds == null
    ? Math.hypot(p.x - base.x, p.y - base.y, p.z - base.z) <= 24
    : p.x >= bounds.min.x && p.y >= bounds.min.y && p.z >= bounds.min.z && p.x < bounds.max.x && p.y < bounds.max.y && p.z < bounds.max.z
  return {
    origin: { x: base.x, y: base.y, z: base.z },
    entrance: first(near(BASE_POI.entrance)),
    table: first(near(BASE_POI.table)),
    furnaces: near(BASE_POI.furnace).map(p => ({ x: p.x, y: p.y, z: p.z })),
    bed: first(near(BASE_POI.bed)),
    chests: memory.knownChests(dimension).filter(inBase).map(c => ({ x: c.x, y: c.y, z: c.z })),
    spareChests: near(BASE_POI.spareChest).map(p => ({ x: p.x, y: p.y, z: p.z })),
    bounds
  }
}

/**
 * The base's entrance to go by to get to `target` from `from`: when the target is in the base's box and `from` isn't
 * (a dug-in base's roof under the hill is no way in: a 26.3 bot dug down onto it from above, every search for the
 * chest or the table in it timing out). Null when there's no need, no entrance or no box, or another dimension.
 */
export function baseWayIn (memory: WorldMemory, target: Pos, from: Pos, dimension: string): Pos | null {
  const base = baseRecord(memory)
  if (base == null || base.bounds == null || base.entrance == null || (memory.base?.dimension ?? 'overworld') !== dimension) return null
  const { min, max } = base.bounds
  const inside = (p: Pos): boolean => {
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    const z = Math.floor(p.z)
    return x >= min.x && y >= min.y && z >= min.z && x < max.x && y < max.y && z < max.z
  }
  if (!inside(target) || inside(from)) return null
  return base.entrance
}
