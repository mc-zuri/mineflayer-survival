// A sugar cane farm by water, the paper of the enchanting's books: canes planted on the ground beside water
// (SugarCaneBlock.canSurvive: the block under a cane is a cane, or dirt or sand with water or frosted ice on a side),
// a water hole dug and filled from a bucket where there's none, and the grown canes cut above their bottom block
// (harvestSugarCane's keepBase) so they grow again.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { navigateNear } from './navigate'
import { placeBlock } from './placeBlock'
import { countItems, findInventoryItem, trace, waitUntil } from './util'

/** BlockTags.DIRT and BlockTags.SAND: the ground a cane stands on */
export const CANE_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'moss_block', 'mud', 'muddy_mangrove_roots', 'pale_moss_block', 'sand', 'red_sand', 'suspicious_sand'])
const WATERS = new Set(['water', 'frosted_ice'])
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

export type CaneLookup = (pos: Vec3) => { name: string } | null

/** whether a cane can stand on the ground block at `ground`: cane ground, water on a side of it, room over it */
export function caneSpot (lookup: CaneLookup, ground: Vec3): boolean {
  const g = lookup(ground)?.name
  if (g == null || !CANE_GROUND.has(g)) return false
  const above = lookup(ground.offset(0, 1, 0))?.name
  if (above !== 'air' && above !== 'cave_air' && above !== 'short_grass' && above !== 'sugar_cane') return false
  return SIDES.some(s => WATERS.has(lookup(ground.plus(s))?.name ?? ''))
}

/** the ground blocks within `radius` of `center` (at its height, 2 up and down) a cane can be planted on, nearest first */
export function caneSpots (lookup: CaneLookup, center: Vec3, radius = 12): Vec3[] {
  const out: Vec3[] = []
  const c = center.floored()
  for (let dy = -3; dy <= 2; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = c.offset(dx, dy, dz)
        if (caneSpot(lookup, p) && lookup(p.offset(0, 1, 0))?.name !== 'sugar_cane') out.push(p)
      }
    }
  }
  return out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c))
}

/**
 * A cell to make a water hole in for a farm: a cane ground block with the same ground on its four sides and air over
 * them, nearest first
 */
export function waterHoleSite (lookup: CaneLookup, center: Vec3, radius = 8): Vec3 | null {
  const c = center.floored()
  let best: Vec3 | null = null
  for (let dy = -2; dy <= 1; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy >= -1) continue
        const p = c.offset(dx, dy, dz)
        const ok = [p, ...SIDES.map(s => p.plus(s))].every(q => CANE_GROUND.has(lookup(q)?.name ?? '') && lookup(q.offset(0, 1, 0))?.name === 'air') &&
          lookup(p.offset(0, -1, 0))?.name !== 'air'
        if (ok && (best == null || p.distanceTo(c) < best.distanceTo(c))) best = p
      }
    }
  }
  return best
}

export interface CaneFarmResult {
  water: Vec3[]
  planted: Vec3[]
}

/**
 * Plants up to `count` canes (default 8) by water near `center` (default the bot): water holes dug and filled from the
 * water buckets held where the spots by water are too few, then a cane on each spot. Remembered as a 'cane_farm'
 * point. Throws MISSING_ITEMS without canes.
 */
export async function plantSugarCane (bot: Bot, args: { count?: number, center?: Vec3, memory?: WorldMemory } = {}, signal?: AbortSignal): Promise<CaneFarmResult> {
  const count = Math.min(args.count ?? 8, countItems(bot, 'sugar_cane'))
  if (count <= 0) throw new SkillError('MISSING_ITEMS', 'no sugar cane to plant')
  const center = args.center ?? bot.entity.position
  const lookup: CaneLookup = p => bot.blockAt(p) as any
  const water: Vec3[] = []
  // water where there's too little: a hole dug in level ground and a bucket poured in it (4 spots round each)
  while (caneSpots(lookup, center).length < count && countItems(bot, 'water_bucket') > 0) {
    throwIfAborted(signal)
    const hole = waterHoleSite(lookup, center)
    if (hole == null) break
    trace('plantSugarCane: a water hole at', hole.toString())
    await collectBlock(bot, { positions: [hole], pickup: false }, signal)
    const bucket = findInventoryItem(bot, 'water_bucket')
    if (bucket == null) break
    await navigateNear(bot, hole, 3, signal).catch(err => { if (isAbort(err)) throw err })
    await bot.equip(bucket, 'hand')
    const floor = bot.blockAt(hole.offset(0, -1, 0))
    if (floor == null) break
    await bot.lookAt(hole.offset(0.5, 0.1, 0.5), true)
    await bot.activateBlock(floor as any, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5))
    if (!await waitUntil(bot, () => bot.blockAt(hole)?.name === 'water', 20, signal)) {
      // the bucket used on nothing: poured where the crosshair is instead
      bot.activateItem()
      await waitUntil(bot, () => bot.blockAt(hole)?.name === 'water', 20, signal)
    }
    if (bot.blockAt(hole)?.name !== 'water') throw new SkillError('VERIFY_FAILED', `no water in the hole at ${hole.toString()}`)
    water.push(hole)
  }
  const planted: Vec3[] = []
  for (const spot of caneSpots(lookup, center).slice(0, count)) {
    throwIfAborted(signal)
    try {
      const res = await placeBlock(bot, { pos: spot.offset(0, 1, 0), item: 'sugar_cane', against: spot }, signal)
      if (res.placed || bot.blockAt(spot.offset(0, 1, 0))?.name === 'sugar_cane') planted.push(spot.offset(0, 1, 0))
    } catch (err) {
      if (isAbort(err)) throw err
      trace('plantSugarCane: a cane on', spot.toString(), 'failed:', (err as Error).message)
    }
  }
  if (planted.length > 0) args.memory?.addPoi('cane_farm', planted[0], 'overworld', `canes=${planted.length}`)
  trace('plantSugarCane:', planted.length, 'canes,', water.length, 'water holes')
  return { water, planted }
}
