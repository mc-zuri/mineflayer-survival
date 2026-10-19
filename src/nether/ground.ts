// The nether's biomes as the blocks seen tell them, for where the pearl search walks: the warped forest (its endermen:
// NetherBiomes' warped forest spawns mostly them), the crimson forest (piglins, to barter with gold), and away from the
// basalt deltas (their surface is basalt and blackstone, magma blocks round the lava pockets: magma cube swarms, and a
// floor that burns) and the soul sand valleys (skeletons and ghasts).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { findBlocks } from '../core/findBlocks'

export type NetherGround = 'delta' | 'valley' | 'warped' | 'crimson'

/** the blocks each biome's surface is made of (the biomes' SurfaceRules in NoiseGeneratorSettings.nether) */
export const NETHER_GROUND_BLOCKS: Record<NetherGround, string[]> = {
  delta: ['basalt', 'blackstone', 'magma_block'],
  valley: ['soul_sand', 'soul_soil'],
  warped: ['warped_nylium', 'warped_wart_block', 'warped_stem'],
  crimson: ['crimson_nylium', 'nether_wart_block', 'crimson_stem']
}

export type GroundCounts = Record<NetherGround, number>

/** the most blocks of each kind counted round one point */
const COUNT_CAP = 48

/** blocks of each kind within `radius` of `point` in the loaded chunks (each up to COUNT_CAP) */
export function groundAround (bot: Bot, point: Vec3, radius: number): GroundCounts {
  const out: GroundCounts = { delta: 0, valley: 0, warped: 0, crimson: 0 }
  // (a bot with no world to look in: none seen)
  if (typeof (bot.world as any)?.getColumn !== 'function' && typeof bot.findBlocks !== 'function') return out
  for (const kind of Object.keys(NETHER_GROUND_BLOCKS) as NetherGround[]) {
    const ids = NETHER_GROUND_BLOCKS[kind].map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
    if (ids.length === 0) continue
    out[kind] = findBlocks(bot, { point, matching: ids, maxDistance: radius, count: COUNT_CAP }).length
  }
  return out
}

/**
 * How good the ground is for the pearl search: the warped forest's endermen most, the crimson forest's piglins when
 * there's gold to barter (a little without), the deltas and the soul sand valleys against it
 */
export function pearlGroundScore (c: GroundCounts, gold: boolean): number {
  return 3 * c.warped + (gold ? 2 : 1) * c.crimson - 2 * c.delta - c.valley
}

/** how far out along a leg its ground is looked at (the loaded chunks reach about this far: the server's view distance) */
export const LEG_LOOK = 96

export interface PearlLeg {
  /** which of the candidates */
  index: number
  /** the leg's end (x and z; the height is the walker's) */
  point: { x: number, z: number }
  score: number
  ground: GroundCounts
}

/**
 * The next pearl leg of `candidates` (the spiral's next points, in its order): the one whose ground seen along the way
 * there (groundAround the points a third, two thirds and all of the way out, LEG_LOOK at most, 24 round each) scores
 * best (pearlGroundScore), the first among equals (as the spiral goes when nothing is seen). A 26.3 bot whose leg went
 * east from seed 2's fortress into the basalt delta there was fought down to the lava sea by a magma cube swarm and
 * died on a magma block.
 */
export function pearlLeg (bot: Bot, from: Vec3, candidates: ReadonlyArray<{ x: number, z: number }>, opts: { gold?: boolean } = {}): PearlLeg {
  let best: PearlLeg | null = null
  for (let i = 0; i < candidates.length; i++) {
    const point = candidates[i]
    const dx = point.x - from.x
    const dz = point.z - from.z
    const length = Math.hypot(dx, dz)
    const reach = Math.min(length, LEG_LOOK)
    const ground: GroundCounts = { delta: 0, valley: 0, warped: 0, crimson: 0 }
    if (length > 1e-6) {
      for (const f of [1 / 3, 2 / 3, 1]) {
        const c = groundAround(bot, new Vec3(from.x + dx / length * reach * f, from.y, from.z + dz / length * reach * f), 24)
        for (const k of Object.keys(ground) as NetherGround[]) ground[k] += c[k]
      }
    }
    const score = pearlGroundScore(ground, opts.gold === true)
    if (best == null || score > best.score) best = { index: i, point: { x: point.x, z: point.z }, score, ground }
  }
  if (best == null) throw new Error('no candidates for a pearl leg')
  return best
}
