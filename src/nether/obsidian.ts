// Obsidian made from a lava pool with a water bucket, where no portal can be cast by the lava (a cave's lake, no room
// for the mould): water poured on the ground beside a lava source turns the source to obsidian as it flows into it
// (LavaFluid / FlowingFluid: a lava source a water flow reaches becomes obsidian), the water scooped back up, and the
// obsidian mined with the diamond pickaxe. The frame is then placed from the obsidian on flat ground.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { navigateNear } from '../skills/navigate'
import { countItems, findInventoryItem, trace, waitTicks, waitUntil } from '../skills/util'
import { isLavaSource } from './portal'

/** a block as the obsidian maker reads it: its name, collision and state */
export type ObsidianLookup = (pos: Vec3) => { name: string, boundingBox: string, properties?: Record<string, any> } | null

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
    const made = bot.findBlocks({ matching: obsidianId, maxDistance: 8, count: count - countItems(bot, 'obsidian') })
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
    const target = pourTarget(get, all)
    if (target == null) throw new SkillError('NOT_FOUND', `no lava source left to turn to obsidian (${countItems(bot, 'obsidian')} of ${count})`)
    const { source, spot, side } = target
    trace('obsidianFromLava: water at', spot.toString(), 'for the lava at', source.toString())
    await navigateNear(bot, spot, side ? 2 : 3, signal).catch(err => { if (isAbort(err)) throw err })
    const bucket = findInventoryItem(bot, 'water_bucket')
    if (bucket == null) throw new SkillError('MISSING_ITEMS', 'the water bucket is gone')
    await bot.equip(bucket, 'hand')
    await bot.lookAt(spot.offset(0.5, 0.02, 0.5), true)
    bot.activateItem()
    await waitUntil(bot, () => bot.blockAt(source)?.name === 'obsidian', 40, signal)
    await waitTicks(bot, 5, signal)
    // the water back up
    const empty = findInventoryItem(bot, 'bucket')
    if (empty != null && bot.blockAt(spot)?.name === 'water') {
      await bot.equip(empty, 'hand')
      await bot.lookAt(spot.offset(0.5, 0.5, 0.5), true)
      bot.activateItem()
      await waitUntil(bot, () => countItems(bot, 'water_bucket') > 0, 20, signal)
    }
  }
  return countItems(bot, 'obsidian')
}
