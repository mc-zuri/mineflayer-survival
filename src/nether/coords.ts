import { normalizeDimension, type Dimension, type Pos } from '../core/memory'

/** DimensionType.coordinateScale of the vanilla dimensions */
export const COORDINATE_SCALE: Record<string, number> = { overworld: 1, the_nether: 8, the_end: 1 }
/** WorldBorder's default bounds (half of 59999968) */
export const WORLD_BORDER = 29999984
/** PortalForcer.findClosestPortalPosition: the square searched for an existing portal */
export const PORTAL_SEARCH_RADIUS = { the_nether: 16, overworld: 128 }

/** DimensionType.getTeleportationScale */
export function teleportationScale (from: Dimension, to: Dimension): number {
  return (COORDINATE_SCALE[normalizeDimension(from)] ?? 1) / (COORDINATE_SCALE[normalizeDimension(to)] ?? 1)
}

/** a position scaled from one dimension to another (x and z only), unrounded */
export function convertPosition (pos: Pos, from: Dimension, to: Dimension): Pos {
  const d = teleportationScale(from, to)
  return { x: pos.x * d, y: pos.y, z: pos.z * d }
}

export function overworldToNether (pos: Pos): Pos {
  return convertPosition(pos, 'overworld', 'the_nether')
}

export function netherToOverworld (pos: Pos): Pos {
  return convertPosition(pos, 'the_nether', 'overworld')
}

/**
 * NetherPortalBlock.getPortalDestination: where a portal sends an entity standing at `pos`,
 * before the portal search: the scaled position clamped to the world border, as a block
 * (WorldBorder.clampToBounds → BlockPos.containing), and the square PortalForcer looks for
 * an existing portal in (16 blocks into the nether, 128 into the overworld).
 */
export function portalDestination (pos: Pos, from: Dimension, to: Dimension): { block: Pos, searchRadius: number } {
  const p = convertPosition(pos, from, to)
  const clamp = (v: number): number => Math.min(Math.max(v, -WORLD_BORDER), WORLD_BORDER - 1)
  const block = { x: Math.floor(clamp(p.x)), y: Math.floor(p.y), z: Math.floor(clamp(p.z)) }
  return { block, searchRadius: normalizeDimension(to) === 'the_nether' ? PORTAL_SEARCH_RADIUS.the_nether : PORTAL_SEARCH_RADIUS.overworld }
}

/**
 * Where to build a nether portal so it links to a given portal on the other side: the scaled
 * position, which is within the search radius of the other portal by construction.
 */
export function linkedPortalSite (portal: Pos, portalDimension: Dimension, buildIn: Dimension): Pos {
  const p = convertPosition(portal, portalDimension, buildIn)
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}
