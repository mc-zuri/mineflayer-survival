// Obsidian made from a lava pool with a water bucket, where no portal can be cast by the lava (a cave's lake, no room
// for the mould): water poured on the ground beside a lava source turns the source to obsidian as it flows into it
// (LavaFluid / FlowingFluid: a lava source a water flow reaches becomes obsidian), the water scooped back up, and the
// obsidian mined with the diamond pickaxe. The frame is then placed from the obsidian on flat ground.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { placeBlock } from '../skills/placeBlock'
import { emptyBucket, fillBucket, isSource } from '../skills/bucket'
import { aimAtFace } from '../core/actions'
import { navigateNear } from '../skills/navigate'
import { countItems, findInventoryItem, trace, waitTicks, waitUntil } from '../skills/util'
import { isLavaSource } from './portal'
import { withNetherSafety } from './safety'
import { findBlocks } from '../core/findBlocks'

/** a block as the obsidian maker reads it: its name, collision and state */
export type ObsidianLookup = (pos: Vec3) => { name: string, boundingBox: string, properties?: Record<string, any> } | null

/** runs `fn` with the pathfinder's paths digging nothing (canDig off), as before after */
export async function withoutDigging<T> (bot: Bot, fn: () => Promise<T>): Promise<T> {
  const before = { ...((bot.pathfinder as any)?.defaultMoveSettings ?? {}) }
  bot.pathfinder?.setMoveOptions?.({ ...before, canDig: false })
  try {
    return await fn()
  } finally {
    bot.pathfinder?.setMoveOptions?.(before)
  }
}

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
  // (nor a step onto the lake's lid: a floor with lava under it, the lid's cells mined from the shore, their drops
  // there left when they lie on the lid)
  return await withNetherSafety(bot, async () => await makeObsidian(bot, count, signal), { lavaBelow: 3 })
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
  let pitFailed = false
  for (let round = 0; countItems(bot, 'obsidian') < count && round < count * 3; round++) {
    throwIfAborted(signal)
    // obsidian made already about: mined first
    // (not one with lava against it, a deep lake's lid, nor the one under the bot: mined, the lava takes the bot)
    const feet = bot.entity.position.floored().offset(0, -1, 0)
    const lavaNext = (p: Vec3): boolean => [...SIDES, new Vec3(0, -1, 0), new Vec3(0, 1, 0)].some(d => get(p.plus(d))?.name === 'lava')
    const made = findBlocks(bot, { matching: obsidianId, maxDistance: 8, count: 64 })
      .filter(p => !p.equals(feet) && !lavaNext(p))
      .slice(0, count - countItems(bot, 'obsidian'))
    if (made.length > 0) {
      try {
        // (each passed over once lava touches it: the obsidian mined before it opened a cell for the lake's lava to
        // flow along, and a 26.3 bot broke the next block into its flow and down the pit it stood in)
        // the walks to them and their drops dig nothing (a pickup's walk dug down beside the lake, the lava came in
        // and the bot burned, 26.3)
        await withoutDigging(bot, async () => await collectBlock(bot, { positions: made, pickup: true, avoidLava: true }, signal))
      } catch (err) {
        if (isAbort(err)) throw err
        trace('obsidianFromLava: mining', (err as Error).message)
      }
      continue
    }
    // a source with ground beside it to pour on, else one open to the air above (the bucket's ray goes through the
    // lava, and the water it pours there flows into the sources about it: a lake's sources are lava on every side,
    // and none had ground beside it on 26.3 seed 2)
    const all = findBlocks(bot, { matching: lavaId, maxDistance: 16, count: 256 })
      .filter(p => isLavaSource(get(p)))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    // a deep lake (lava under its top sources): its lava carried a bucket at a time to a pit dug in the stone by it and
    // set there, over stone, so no drop falls into lava. The water poured on such a lake turns its top layer to a lid
    // over more lava, and every block of the lid mined burned in the lava under it (a 26.3 whole game's table
    // obsidian took 48000 ticks over 6 pools, 'broke 2 blocks but no item came into the inventory')
    const deep = all.slice(0, 8).some(p => get(p.offset(0, -1, 0))?.name === 'lava')
    if (deep && findInventoryItem(bot, 'bucket') != null && !pitFailed) {
      const before = countItems(bot, 'obsidian')
      const made = await obsidianInPit(bot, get, all, signal).catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the pit:', (err as Error).message); return false })
      if (made && countItems(bot, 'obsidian') > before) continue
      pitFailed = true
    }
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
    // a deep lake's lid: the top layer the water turned, more lava under it that no water gets to. Its cells with lava
    // only under them are mined from the shore (the lava under a broken cell doesn't come up into it: FlowingFluid
    // spreads down and sideways, and the walks' lava rules keep the bot off the lid), opening the sources under them to
    // the next pour, which turns that layer over the stone under it. Their drops aren't gone after: they fall into the
    // lava and burn (ItemEntity.lavaHurt; the layer turned makes up for them), or lie on the lid where no step goes.
    // A 2-deep lake's sources were all under its lid: 'no lava source left' (26.3)
    if (target == null) {
      const lavaOver = (p: Vec3): boolean => [...SIDES, new Vec3(0, 1, 0)].some(d => get(p.plus(d))?.name === 'lava')
      const lid = findBlocks(bot, { matching: obsidianId, maxDistance: 8, count: 64 })
        .filter(p => !p.equals(feet) && get(p.offset(0, -1, 0))?.name === 'lava' && !lavaOver(p))
      if (lid.length > 0) {
        trace('obsidianFromLava: opening the lid over', lid.length, 'sources')
        await withoutDigging(bot, async () => await collectBlock(bot, { positions: lid, pickup: false, avoidLava: true, lavaUnder: true }, signal))
          .catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the lid:', (err as Error).message) })
        if (lid.some(p => get(p)?.name !== 'obsidian')) continue
      }
    }
    // none to pour on in place (no shore, no pedestal, no lid): its lava carried a bucket at a time to a pit by it, as a
    // deep lake's (obsidianInPit). A 1.21.11 bot's frame stopped at 8 of 10 by three pools in turn, 'no lava source
    // left to turn to obsidian (8 of 10)' at each (f3-1.21.11, t261483 to t277444)
    if (target == null && !pitFailed && findInventoryItem(bot, ['bucket', 'lava_bucket']) != null && all.length > 0) {
      const before = countItems(bot, 'obsidian')
      const made = await obsidianInPit(bot, get, all, signal).catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the pit:', (err as Error).message); return false })
      if (made && countItems(bot, 'obsidian') > before) continue
      pitFailed = true
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
    const turned = (): boolean => side ? bot.blockAt(source)?.name === 'obsidian' : findBlocks(bot, { matching: obsidianId, point: spot, maxDistance: 2, count: 1 }).length > 0
    await waitUntil(bot, turned, 40, signal)
    await waitTicks(bot, 5, signal)
    // the water back up
    const empty = findInventoryItem(bot, 'bucket')
    // the water where it went: at the spot, else a water source it made about it (the look may have hit a block by it)
    const waterId = bot.registry.blocksByName.water.id
    const placed = bot.blockAt(spot)?.name === 'water'
      ? spot
      : findBlocks(bot, { matching: waterId, point: spot, maxDistance: 4, count: 16 }).find(p => Number((bot.blockAt(p) as any)?.getProperties?.()?.level ?? 1) === 0) ?? null
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

/** the lake's sources a pit's bucket tries to fill from before it gives up */
export const PIT_FILL_TRIES = 6
/** how far from the bot a pit for a deep lake's lava is looked for */
export const PIT_RADIUS = 6
/** the least distance, along x or z, from a pit to the lake's lava (the pour's water spreads on the floor about it) */
export const PIT_CLEARANCE = 3

const solidBlock = (b: { name: string, boundingBox: string } | null): boolean => b != null && b.boundingBox === 'block' && b.name !== 'lava' && b.name !== 'water'

/**
 * A cell of the floor by the bot to dig a 1-deep pit in for a deep lake's lava: solid under it and on its 4 sides,
 * two cells of air over it (the water poured there, the bot reaching in), PIT_CLEARANCE off any lava; nearest first.
 * A pit dug already (air over solid, walled) does too.
 */
export function pitSite (get: ObsidianLookup, feet: Vec3, lava: readonly Vec3[]): Vec3 | null {
  const out: Vec3[] = []
  for (let dx = -PIT_RADIUS; dx <= PIT_RADIUS; dx++) {
    for (let dz = -PIT_RADIUS; dz <= PIT_RADIUS; dz++) {
      for (const dy of [-1, -2, 0]) {
        const p = feet.offset(dx, dy, dz)
        if (dx === 0 && dz === 0) continue
        const here = get(p)
        if (here == null || (!solidBlock(here) && !AIR.has(here.name))) continue
        if (!solidBlock(get(p.offset(0, -1, 0))) || !SIDES.every(s => solidBlock(get(p.plus(s))))) continue
        if (!AIR.has(get(p.offset(0, 1, 0))?.name ?? '') || !AIR.has(get(p.offset(0, 2, 0))?.name ?? '')) continue
        if (lava.some(l => Math.max(Math.abs(l.x - p.x), Math.abs(l.z - p.z)) < PIT_CLEARANCE + 1 && Math.abs(l.y - p.y) < 4)) continue
        out.push(p)
      }
    }
  }
  out.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet))
  return out[0] ?? null
}

/**
 * One obsidian from a deep lake by a pit: the pit dug (PIT: pitSite), a bucket of the lake's lava poured in it, water
 * over it till it sets, the water scooped back, the obsidian mined (its drop on the pit's stone floor). True when one
 * came into the bag.
 */
/** the bot's world as obsidianFromLava's and obsidianInPit's lookups see it (the block's name, box and state) */
export function obsidianLookup (bot: Bot): ObsidianLookup {
  return p => {
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z)) as any
    return b == null ? null : { name: b.name, boundingBox: b.boundingBox, properties: b.getProperties?.() }
  }
}

export async function obsidianInPit (bot: Bot, get: ObsidianLookup, lava: readonly Vec3[], signal?: AbortSignal): Promise<boolean> {
  const before = countItems(bot, 'obsidian')
  const pit = pitSite(get, bot.entity.position.floored(), lava)
  if (pit == null) { trace('obsidianFromLava: no pit site by the lake'); return false }
  trace('obsidianFromLava: a pit at', pit.toString(), 'for the lava of the deep lake')
  if (solidBlock(get(pit))) await collectBlock(bot, { positions: [pit], pickup: true }, signal)
  if (!AIR.has(get(pit)?.name ?? '')) return false
  if (countItems(bot, 'lava_bucket') === 0) {
    // the lake's sources nearest the pit first, one with no spot to reach it from passed over (a deep lake's under a
    // ledge: 'no spot found to see' it, 26.3)
    // (those open to the air above first, by the pit: one under the lake's top layer or a ledge isn't reached)
    const open = (p: Vec3): number => AIR.has(get(p.offset(0, 1, 0))?.name ?? '') ? 0 : 1
    const sources = lava.filter(p => isLavaSource(get(p)) && get(p.offset(0, 1, 0))?.name !== 'lava')
      .sort((a, b) => open(a) - open(b) || a.distanceTo(pit) - b.distanceTo(pit))
    let filled = false
    for (const source of sources.slice(0, PIT_FILL_TRIES)) {
      try {
        await fillBucket(bot, { fluid: 'lava', pos: source }, signal)
        filled = true
        break
      } catch (err) {
        if (isAbort(err)) throw err
        trace('obsidianFromLava: the lava at', source.toString(), 'out of reach:', (err as Error).message)
      }
    }
    if (!filled) return false
  }
  await emptyBucket(bot, { pos: pit, fluid: 'lava' }, signal)
  await refillWater(bot, signal)
  // the water on the floor beside the pit (over the lava there's no face to pour against), flowing over its lip and
  // down onto the lava
  const spot = SIDES.map(s => pit.plus(s).offset(0, 1, 0)).find(c => AIR.has(get(c)?.name ?? '') && solidBlock(get(c.offset(0, -1, 0)))) ?? pit.offset(0, 1, 0)
  await emptyBucket(bot, { pos: spot, fluid: 'water' }, signal)
  await waitUntil(bot, () => bot.blockAt(pit)?.name === 'obsidian', 40, signal)
  await waitTicks(bot, 5, signal)
  await waterBack(bot, spot, signal)
  // the lava not set (the water ran off elsewhere): the water poured again straight over it, once
  if (isLavaSource(get(pit)) && countItems(bot, 'water_bucket') > 0 && AIR.has(get(pit.offset(0, 1, 0))?.name ?? '')) {
    trace('obsidianFromLava: the pit still lava: the water over it')
    await emptyBucket(bot, { pos: pit.offset(0, 1, 0), fluid: 'water' }, signal).catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the water over the pit:', (err as Error).message) })
    await waitUntil(bot, () => bot.blockAt(pit)?.name === 'obsidian', 40, signal)
    await waitTicks(bot, 5, signal)
    await waterBack(bot, pit.offset(0, 1, 0), signal)
  }
  if (bot.blockAt(pit)?.name !== 'obsidian') {
    // none set: the lava taken back up (no lava left in a pit by home, the bucket's lava not lost)
    if (isLavaSource(get(pit)) && findInventoryItem(bot, 'bucket') != null) {
      await fillBucket(bot, { fluid: 'lava', pos: pit }, signal).catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the lava back from the pit:', (err as Error).message) })
    }
    return false
  }
  // mined from the floor beside it, again from there when the first dig didn't hold the crosshair (26.3)
  await collectBlock(bot, { positions: [pit], pickup: true }, signal).catch(async err => {
    if (isAbort(err)) throw err
    trace('obsidianFromLava: the pit obsidian:', (err as Error).message, '- from beside it')
    await navigateNear(bot, spot, 1, signal).catch(e => { if (isAbort(e)) throw e })
    await collectBlock(bot, { positions: [pit], pickup: true }, signal)
  })
  return countItems(bot, 'obsidian') > before
}

/**
 * The water poured for a cast got back: from where it was poured, else the nearest source (refillWater). A 1.21.11
 * bot's cast at home lost its water bucket (the lava poured, no obsidian, the water not got back) and went on to the
 * deep pools with none (f3-1.21.11, t203692).
 */
async function waterBack (bot: Bot, poured: Vec3, signal?: AbortSignal): Promise<void> {
  if (countItems(bot, 'water_bucket') > 0 || findInventoryItem(bot, 'bucket') == null) return
  if (isSource(bot.blockAt(poured) as any, 'water')) {
    await fillBucket(bot, { fluid: 'water', pos: poured }, signal).catch(err => { if (isAbort(err)) throw err; trace('obsidianFromLava: the water by the pit:', (err as Error).message) })
  }
  if (countItems(bot, 'water_bucket') === 0) await refillWater(bot, signal)
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
