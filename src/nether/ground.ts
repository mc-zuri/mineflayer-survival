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

/** the eight ways a pearl leg can go: east, south, west, north (the spiral's order), then the diagonals */
const WAYS: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]

/** a leg's end this near where a leg went before is ground walked already */
export const LEG_WALKED_RADIUS = 48

export interface PearlLeg {
  /** the leg's end (x and z; the height is the walker's) */
  point: { x: number, z: number }
  score: number
  ground: GroundCounts
}

/**
 * The next pearl leg's end, `length` blocks from `from` one of eight ways: the one whose ground seen (groundAround the
 * points a third, two thirds and all of the way out, 24 round each) scores best (pearlGroundScore), the ends of legs
 * walked before (`walked`, within LEG_WALKED_RADIUS) left out unless every way's is one, `prefer`'s way (the spiral's
 * next) first among equals. A 26.3 bot whose leg went east from seed 2's fortress into the basalt delta there was
 * fought down to the lava sea by a magma cube swarm and died on a magma block.
 */
export function pearlLeg (bot: Bot, from: Vec3, length: number, opts: { walked?: Array<{ x: number, z: number }>, gold?: boolean, prefer?: { x: number, z: number } } = {}): PearlLeg {
  const walked = opts.walked ?? []
  const preferWay = opts.prefer == null ? -1 : bestWay(opts.prefer.x - from.x, opts.prefer.z - from.z)
  let best: (PearlLeg & { fresh: boolean, way: number }) | null = null
  for (let w = 0; w < WAYS.length; w++) {
    const [dx, dz] = WAYS[w]
    const n = Math.hypot(dx, dz)
    const ux = dx / n
    const uz = dz / n
    const ground: GroundCounts = { delta: 0, valley: 0, warped: 0, crimson: 0 }
    for (const f of [1 / 3, 2 / 3, 1]) {
      const c = groundAround(bot, new Vec3(from.x + ux * length * f, from.y, from.z + uz * length * f), 24)
      for (const k of Object.keys(ground) as NetherGround[]) ground[k] += c[k]
    }
    const point = { x: Math.floor(from.x + ux * length), z: Math.floor(from.z + uz * length) }
    const fresh = walked.every(p => Math.hypot(p.x - point.x, p.z - point.z) > LEG_WALKED_RADIUS)
    const score = pearlGroundScore(ground, opts.gold === true)
    const better = best == null ||
      (fresh && !best.fresh) ||
      (fresh === best.fresh && (score > best.score || (score === best.score && w === preferWay && best.way !== preferWay)))
    if (better) best = { point, score, ground, fresh, way: w }
  }
  const { point, score, ground } = best as PearlLeg
  return { point, score, ground }
}

/** the one of WAYS nearest the direction (dx, dz) */
function bestWay (dx: number, dz: number): number {
  let best = 0
  let bestDot = -Infinity
  for (let w = 0; w < WAYS.length; w++) {
    const [x, z] = WAYS[w]
    const dot = (x * dx + z * dz) / Math.hypot(x, z)
    if (dot > bestDot) { bestDot = dot; best = w }
  }
  return best
}
