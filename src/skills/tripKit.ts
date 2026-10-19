// A spare kit left on a trip, before its deadliest part (the End, from the stronghold's portal room): a chest put down
// with a spare weapon, part of the arrows, food and blocks and any armor beyond what's worn, and a bed by it that sets
// the respawn point (BedBlock.useWithoutItem: ServerPlayer.setRespawnPosition, by day too), so a death in the End is
// a respawn by the kit and a walk back through the portal, whose frames stay filled, not the game lost.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { isBed } from '../core/items'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { placeBlock } from './placeBlock'
import { findPlacement } from './placement'
import { retrieveItems, storeItems } from './chest'
import { trace, waitTicks } from './util'

export type ItemCount = { name: string, count: number }

/** the point of interest of a trip kit's chest */
export const TRIP_KIT = 'trip_kit'

const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato', 'cooked_cod', 'cooked_salmon', 'golden_carrot']
const BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'end_stone', 'andesite', 'diorite', 'granite', 'stone']
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'netherite_axe', 'diamond_axe', 'iron_axe']
const ARMOR = /_(helmet|chestplate|leggings|boots)$/

/**
 * What a trip kit takes from the bag (items: names and counts carried, the bag's only): the weapons but the best one,
 * a bow when there are two, half the arrows (from 32 up) and of each food (from 8 up), half the blocks up to 64, and
 * the armor carried, not worn
 */
export function tripKitItems (items: readonly ItemCount[]): ItemCount[] {
  const count = (name: string): number => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  const out: ItemCount[] = []
  const add = (name: string, n: number): void => { if (n > 0) out.push({ name, count: n }) }
  const weapons = WEAPONS.filter(w => count(w) > 0)
  // all of each weapon but one of the best
  weapons.forEach((w, i) => add(w, count(w) - (i === 0 ? 1 : 0)))
  if (count('bow') >= 2) add('bow', count('bow') - 1)
  if (count('arrow') >= 32) add('arrow', Math.floor(count('arrow') / 2))
  for (const f of FOODS) if (count(f) >= 8) add(f, Math.floor(count(f) / 2))
  let blocks = 0
  for (const b of BLOCKS) {
    const n = Math.min(Math.floor(count(b) / 2), 64 - blocks)
    if (n > 0) { add(b, n); blocks += n }
  }
  for (const i of items) if (ARMOR.test(i.name) && !out.some(o => o.name === i.name)) add(i.name, count(i.name))
  if (count('golden_apple') >= 2) add('golden_apple', 1)
  return out
}

export interface TripKitResult {
  chest: Vec3
  stored: Record<string, number>
  /** a bed put down by it set the respawn point there */
  bed: Vec3 | null
}

/**
 * Leaves the trip kit (tripKitItems) in a chest put down by the bot, and a bed beside it used to set the respawn
 * point when one is held; remembered as a TRIP_KIT point with the chest's items. Throws MISSING_ITEMS without a chest.
 */
export async function stashTripKit (bot: Bot, memory: WorldMemory, signal?: AbortSignal, opts: { chest?: Vec3 } = {}): Promise<TripKitResult> {
  throwIfAborted(signal)
  const lookup = (p: Vec3): any => bot.blockAt(p)
  // a kit's chest there already (the one a respawn emptied): filled again, no chest nor bed made
  const reuse = opts.chest != null && bot.blockAt(opts.chest)?.name === 'chest'
  let pos: Vec3
  if (reuse) {
    pos = opts.chest as Vec3
  } else {
    if (!bot.inventory.items().some(i => i.name === 'chest')) throw new SkillError('MISSING_ITEMS', 'no chest for a trip kit')
    const at = findPlacement(lookup, bot.entity.position)
    if (at == null) throw new SkillError('CANNOT_PLACE', 'no room for a chest')
    pos = at
    await placeBlock(bot, { pos, item: 'chest' }, signal)
  }
  const stored: Record<string, number> = {}
  for (const it of tripKitItems(bot.inventory.items().map(i => ({ name: i.name, count: i.count })))) {
    throwIfAborted(signal)
    try {
      const res = await storeItems(bot, { chest: pos, filter: it.name, count: it.count }, signal)
      for (const [name, n] of Object.entries(res.moved)) stored[name] = (stored[name] ?? 0) + n
    } catch (err) {
      if (isAbort(err)) throw err
      trace('stashTripKit:', it.name, (err as Error).message)
    }
  }
  memory.rememberChest(pos, stored, 'overworld')
  memory.addPoi(TRIP_KIT, pos, 'overworld', 'spare kit')
  // the respawn point by the kit
  let bed: Vec3 | null = null
  const held = bot.inventory.items().find(i => isBed(i.name))
  const bedThere = memory.getPois('spawn_bed', { dimension: 'overworld', near: pos }).find(b => new Vec3(b.x, b.y, b.z).distanceTo(pos) <= 4 && isBed(bot.blockAt(new Vec3(b.x, b.y, b.z))?.name ?? ''))
  if (bedThere != null) bed = new Vec3(bedThere.x, bedThere.y, bedThere.z)
  if (held != null && bedThere == null) {
    const at = findPlacement(lookup, pos)
    if (at != null) {
      try {
        await placeBlock(bot, { pos: at, item: held.name, facing: new Vec3(1, 0, 0) }, signal)
        const block = bot.blockAt(at)
        if (block != null && isBed(block.name)) {
          await bot.activateBlock(block as any)
          await waitTicks(bot, 10, signal)
          bed = at
          memory.addPoi('spawn_bed', at, 'overworld', 'by the trip kit')
        }
      } catch (err) {
        if (isAbort(err)) throw err
        trace('stashTripKit: the bed:', (err as Error).message)
      }
    }
  }
  trace('stashTripKit: at', pos.toString(), JSON.stringify(stored), bed != null ? `bed at ${bed.toString()}` : 'no bed')
  return { chest: pos, stored, bed }
}

/** takes everything out of the trip kit's chest (the bot by it); resolves what came out */
export async function takeTripKit (bot: Bot, memory: WorldMemory, signal?: AbortSignal): Promise<Record<string, number>> {
  const poi = memory.getPois(TRIP_KIT, { dimension: 'overworld', near: bot.entity.position })[0]
  if (poi == null) return {}
  const chest = new Vec3(poi.x, poi.y, poi.z)
  const res = await retrieveItems(bot, { chest }, signal)
  const left = { ...(memory.chestAt(chest, 'overworld')?.items ?? {}) }
  for (const [name, n] of Object.entries(res.moved)) left[name] = Math.max(0, (left[name] ?? 0) - n)
  memory.rememberChest(chest, left, 'overworld')
  return res.moved
}
