// The nether's deaths remembered (where the bot died there), and kept away from on the way back: the pathfinder's nether
// settings and the grid walk charge more for a cell near one.
import type { Pos, WorldMemory } from '../core/memory'

/** the nether's last deaths a path keeps away from */
export const NETHER_DEATHS_KEPT = 8
/** a nether path's cells within this many blocks (sideways, and 12 up or down) of a death there cost more */
export const NETHER_DEATH_RADIUS = 8
/** ticks on top for each such cell: a way round is taken when there's one within a few blocks' walk */
export const NETHER_DEATH_COST = 20

/**
 * Remembers where the bot died in the nether (a 'nether_death' point), the last NETHER_DEATHS_KEPT of them: the way
 * back keeps away from them (netherMoveSettings). A 26.3 bot died five times over in one stretch of the lava sea, and
 * twice in one basalt delta, each walk back the same as the one before.
 */
export function rememberNetherDeath (memory: WorldMemory, pos: Pos): void {
  memory.addPoi('nether_death', { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, 'the_nether')
  const deaths = memory.getPois('nether_death', { dimension: 'the_nether' }).sort((a, b) => b.seen - a.seen)
  for (const old of deaths.slice(NETHER_DEATHS_KEPT)) memory.removePoi('nether_death', old, 'the_nether')
}

/** whether the cell is within NETHER_DEATH_RADIUS of one of the deaths (12 up or down) */
export function nearDeath (deaths: readonly Pos[], p: Pos): boolean {
  for (const d of deaths) if (Math.hypot(p.x - d.x, p.z - d.z) <= NETHER_DEATH_RADIUS && Math.abs(p.y - d.y) <= 12) return true
  return false
}
