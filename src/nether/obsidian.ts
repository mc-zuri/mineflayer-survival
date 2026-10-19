// Obsidian made from a lava pool with a water bucket, where no portal can be cast by the lava (a cave's lake, no room
// for the mould): water poured on the ground beside a lava source turns the source to obsidian as it flows into it
// (LavaFluid / FlowingFluid: a lava source a water flow reaches becomes obsidian), the water scooped back up, and the
// obsidian mined with the diamond pickaxe. The frame is then placed from the obsidian on flat ground.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { placeBlock } from '../skills/placeBlock'
import { emptyBucket, fillBucket } from '../skills/bucket'
import { aimAtFace } from '../core/actions'
import { navigateNear } from '../skills/navigate'
import { countItems, findInventoryItem, trace, waitTicks, waitUntil } from '../skills/util'
import { isLavaSource } from './portal'
import { withNetherSafety } from './safety'

/** a block as the obsidian maker reads it: its name, collision and state */
export type ObsidianLookup = (pos: Vec3) => { name: string, boundingBox: string, properties?: Record<string, any> } | null

/** the blocks a pedestal is put into the lava with */
const PEDESTAL_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'netherrack', 'dirt', 'andesite', 'diorite', 'granite', 'stone']
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const AIR = new Set(['air', 'cave_air'])

/**
 * Where to pour water for a lava source: a cell beside it at its level that is air with solid ground under it, and
 * not over or beside other lava where the bot would stand (the bot pours from beside that cell)
 */
export function pourSpot (getBlock: ObsidianLookup, source: Vec3): Vec3 | null {
  for (const s of SIDES) {
    const cell = source.plus(s)
    const b = getBlock(cell)
    const under = getBlock(cell.offset(0, -1, 0))
    if (b == null || !AIR.has(b.name) || under == null || under.boundingBox !== 'block' || under.name === 'lava') continue
    return cell
  }
  return null
}

/**
 * The source to turn and where the water goes, of some sources nearest first: the first with ground beside it (the
 * water poured there, side), else the first open to the air above (the water poured into the lava cell itself)
 */
export function pourTarget (get: ObsidianLookup, sources: readonly Vec3[], intoLava = false): { source: Vec3, spot: Vec3, side: boolean } | null {
  for (const p of sources) {
    const spot = pourSpot(get, p)
    if (spot != null) return { source: p, spot, side: true }
  }
  // (the water poured into a lava cell turns it to obsidian and is gone: a bucket an obsidian, with no water near to
  // fill it again, so only when asked)
  if (!intoLava) return null
  const open = sources.find(p => AIR.has(get(p.offset(0, 1, 0))?.name ?? ''))
  return open == null ? null : { source: open, spot: open, side: false }
}

/**
 * Obsidian from the lava sources about the bot until `count` are held: for the nearest source with a pour spot, the
 * water poured there and scooped back, then the obsidian made mined. Throws MISSING_ITEMS without a water bucket or a
 * diamond pickaxe, NOT_FOUND when no source is left to turn.
 */
export async function obsidianFromLava (bot: Bot, count: number, signal?: AbortSignal): Promise<number> {
  // the walks and the digs by the lava with the nether's lava rules (no step beside lava, no dig of a block lava
  // touches): mining the obsidian lid of a deep lake from on top of it dropped a 26.3 bot into the lava under it
  return await withNetherSafety(bot, async () => await makeObsidian(bot, count, signal))
}

async function makeObsidian (bot: Bot, count: number, signal?: AbortSignal): Promise<number> {
  await refillWater(bot, signal)
  if (countItems(bot, 'water_bucket') === 0) throw new SkillError('MISSING_ITEMS', 'no water bucket to make obsidian with')
  if (countItems(bot, ['diamond_pickaxe', 'netherite_pickaxe']) === 0) throw new SkillError('MISSING_ITEMS', 'no diamond pickaxe to mine obsidian with')
  const get: ObsidianLookup = p => {
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z)) as any
    return b == null ? null : { name: b.name, boundingBox: b.boundingBox, properties: b.getProperties?.() }
  }
  const lavaId = bot.registry.blocksByName.lava.id
  const obsidianId = bot.registry.blocksByName.obsidian.id
  for (let round = 0; countItems(bot, 'obsidian') < count && round < count * 3; round++) {
    throwIfAborted(signal)
    // obsidian made already about: mined first
    // (not one with lava against it, a deep lake's lid, nor the one under the bot: mined, the lava takes the bot)
    const feet = bot.entity.position.floored().offset(0, -1, 0)
    const lavaNext = (p: Vec3): boolean => [...SIDES, new Vec3(0, -1, 0), new Vec3(0, 1, 0)].some(d => get(p.plus(d))?.name === 'lava')
    const made = bot.findBlocks({ matching: obsidianId, maxDistance: 8, count: 64 })
      .filter(p => !p.equals(feet) && !lavaNext(p))
      .slice(0, count - countItems(bot, 'obsidian'))
    if (made.length > 0) {
      try {
        await collectBlock(bot, { positions: made, pickup: true }, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('obsidianFromLava: mining', (err as Error).message)
      }
      continue
    }
    // a source with ground beside it to pour on, else one open to the air above (the bucket's ray goes through the
    // lava, and the water it pours there flows into the sources about it: a lake's sources are lava on every side,
    // and none had ground beside it on 26.3 seed 2)
    const all = bot.findBlocks({ matching: lavaId, maxDistance: 16, count: 256 })
      .filter(p => isLavaSource(get(p)))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    let target = pourTarget(get, all, false)
    // a lake with no shore: a block put into the source nearest the bot (the lava replaced), the water poured on it
    // flows down into the sources about it and turns them, and is scooped back off the block (the water poured into
    // the lava was lost, and the source stayed lava: 26.3 seed 2)
    if (target == null) {
      // a source open above with a block to put the pedestal against: its floor, else a solid side (a deep lake's
      // floor is more lava: 'nothing solid to place against', 26.3)
      const solidAt = (p: Vec3): boolean => get(p)?.boundingBox === 'block' && get(p)?.name !== 'lava'
      const against = (p: Vec3): Vec3 | null => [new Vec3(0, -1, 0), ...SIDES].map(d => p.plus(d)).find(solidAt) ?? null
      const open = all.find(p => AIR.has(get(p.offset(0, 1, 0))?.name ?? '') && against(p) != null)
      const filler = PEDESTAL_BLOCKS.find(n => countItems(bot, n) > 0)
      if (open != null && filler != null) {
        await navigateNear(bot, open, 3, signal).catch(err => { if (isAbort(err)) throw err })
        await placeBlock(bot, { pos: open, item: filler, against: against(open) as Vec3, intoFluid: true }, signal).catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the pedestal:', (err as Error).message) })
        if (bot.blockAt(open)?.boundingBox === 'block') target = { source: open, spot: open.offset(0, 1, 0), side: false }
      }
    }
    if (target == null) throw new SkillError('NOT_FOUND', `no lava source left to turn to obsidian (${countItems(bot, 'obsidian')} of ${count})`)
    const { source, side } = target
    let spot = target.spot
    trace('obsidianFromLava: water at', spot.toString(), 'for the lava at', source.toString())
    await navigateNear(bot, spot, side ? 2 : 3, signal).catch(err => { if (isAbort(err)) throw err })
    await refillWater(bot, signal)
    const bucket = findInventoryItem(bot, 'water_bucket')
    if (bucket == null) throw new SkillError('MISSING_ITEMS', 'the water bucket is gone')
    // the bucket skill's pour (a face in sight to pour against, approached to a spot that sees it), else the
    // crosshair on the top of the block under the spot (the bucket goes where the look hits: in a cave the rock round
    // the bot can be in the way), from closer when it isn't in sight
    const poured = await emptyBucket(bot, { pos: spot, fluid: 'water' }, signal).then(() => true, err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the pour:', (err as Error).message); return false })
    if (!poured && findInventoryItem(bot, 'water_bucket') != null) {
      await bot.equip(findInventoryItem(bot, 'water_bucket')!, 'hand')
      const floor = bot.blockAt(spot.offset(0, -1, 0))
      let aimed = floor != null && await aimAtFace(bot, floor as any, new Vec3(0, 1, 0)) != null
      if (!aimed && floor != null) {
        await navigateNear(bot, spot, 1, signal).catch(err => { if (isAbort(err)) throw err })
        aimed = await aimAtFace(bot, floor as any, new Vec3(0, 1, 0)) != null
      }
      if (!aimed) await bot.lookAt(spot.offset(0.5, 0.02, 0.5), true)
      bot.activateItem()
    }
    // poured beside a source it turns the source; poured on the pedestal it turns the sources about it
    const turned = (): boolean => side ? bot.blockAt(source)?.name === 'obsidian' : bot.findBlocks({ matching: obsidianId, point: spot, maxDistance: 2, count: 1 }).length > 0
    await waitUntil(bot, turned, 40, signal)
    await waitTicks(bot, 5, signal)
    // the water back up
    const empty = findInventoryItem(bot, 'bucket')
    // the water where it went: at the spot, else a water source it made about it (the look may have hit a block by it)
    const waterId = bot.registry.blocksByName.water.id
    const placed = bot.blockAt(spot)?.name === 'water'
      ? spot
      : bot.findBlocks({ matching: waterId, point: spot, maxDistance: 4, count: 16 }).find(p => Number((bot.blockAt(p) as any)?.getProperties?.()?.level ?? 1) === 0) ?? null
    if (placed == null) trace('obsidianFromLava: no water source left about', spot.toString())
    if (empty != null && placed != null) {
      spot = placed
      const lavaBefore = countItems(bot, 'lava_bucket')
      const waterBefore = countItems(bot, 'water_bucket')
      // the bucket skill's scoop (a point of the source in sight), else a look at its middle
      const scooped = await fillBucket(bot, { fluid: 'water', pos: spot }, signal).then(() => true, err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the scoop:', (err as Error).message); return false })
      if (!scooped && countItems(bot, 'water_bucket') === waterBefore && findInventoryItem(bot, 'bucket') != null) {
        await bot.equip(findInventoryItem(bot, 'bucket')!, 'hand')
        await bot.lookAt(spot.offset(0.5, 0.5, 0.5), true)
        bot.activateItem()
        await waitUntil(bot, () => countItems(bot, 'water_bucket') > waterBefore || countItems(bot, 'lava_bucket') > lavaBefore, 20, signal)
      }
      // lava scooped instead (a source on the ray before the water): poured back where it came from
      if (countItems(bot, 'lava_bucket') > lavaBefore) {
        const lavaBucket = findInventoryItem(bot, 'lava_bucket')
        if (lavaBucket != null) { await bot.equip(lavaBucket, 'hand'); bot.activateItem(); await waitTicks(bot, 5, signal) }
      }
    }
    if (countItems(bot, 'water_bucket') === 0) trace('obsidianFromLava: the water was lost')
  }
  return countItems(bot, 'obsidian')
}

/** how far a water source is looked for to fill an empty bucket from */
export const REFILL_RANGE = 48

/**
 * With no water bucket and an empty one held, one filled from the nearest water source within REFILL_RANGE (a pour
 * lost in a cave lake was the end of the obsidian on 26.3 seed 2, with a river by): no source, nothing done.
 */
export async function refillWater (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  if (countItems(bot, 'water_bucket') > 0 || findInventoryItem(bot, 'bucket') == null) return false
  try {
    await fillBucket(bot, { fluid: 'water', maxDistance: REFILL_RANGE }, signal)
    trace('refillWater: a water bucket filled')
    return true
  } catch (err) {
    if (isAbort(err)) throw err
    trace('refillWater:', (err as Error).message)
    return false
  }
}
