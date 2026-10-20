// A spare kit left on a trip, before its deadliest part (the End, from the stronghold's portal room): a chest put down
// with a spare weapon, part of the arrows, food and blocks, any armor beyond what's worn and a spare shield (made for
// it from the iron held when there are none: kitSpares), and a bed by it that sets
// the respawn point (BedBlock.useWithoutItem: ServerPlayer.setRespawnPosition, by day too), so a death in the End is
// a respawn by the kit and a walk back through the portal, whose frames stay filled, not the game lost.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { WorldMemory } from '../core/memory'
import { isBed } from '../core/items'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { placeBlock } from './placeBlock'
import { bedRoomToDig, findBedPlacementNear, findPlacement } from './placement'
import { dig } from '../core/actions'
import { steerToward } from './steer'
import { navigate } from './navigate'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { retrieveItems, storeItems } from './chest'
import { resyncInventory, trace, waitTicks, waitUntil } from './util'

export type ItemCount = { name: string, count: number }

/** the point of interest of a trip kit's chest */
export const TRIP_KIT = 'trip_kit'

const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato', 'cooked_cod', 'cooked_salmon', 'golden_carrot']
const BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'end_stone', 'andesite', 'diorite', 'granite', 'stone']
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'netherite_axe', 'diamond_axe', 'iron_axe']
const ARMOR = /_(helmet|chestplate|leggings|boots)$/
const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe']

/** the blocks of a portal: a chest or bed is kept 2 blocks off them (a bed put down in front of a nether portal in a
 * cave left the bot standing on it with 'no way to the portal', five times, 26.3) */
const PORTAL_BLOCKS = new Set(['nether_portal', 'obsidian', 'end_portal', 'end_portal_frame'])

/**
 * A bed put down within 5 blocks of `near` (findBedPlacementNear, off the portal's blocks), from the cell behind its
 * foot facing along it, and used to set the respawn point (BedBlock.useWithoutItem: ServerPlayer.setRespawnPosition, by
 * day too); its foot, or null with no room for one. A bed put down from where the bot stood, the way it happened to
 * face, failed by a 26.3 stronghold's portal room, and a death in the End was a respawn at the world's spawn, 2400
 * blocks off, and a walk back through two nights.
 */
export async function placeSpawnBed (bot: Bot, near: Vec3, item: string, signal?: AbortSignal): Promise<Vec3 | null> {
  const lookup = (p: Vec3): any => bot.blockAt(p)
  const avoid = (p: Vec3): boolean => nearPortal(lookup, p)
  const free = findBedPlacementNear(lookup, near, 5, avoid)
  const spot = free != null ? { ...free, dig: [] as Vec3[] } : roomToDigNear(lookup, bot.entity.position, near, avoid)
  trace('placeSpawnBed: near', near.toString(), 'from', bot.entity.position.floored().toString(), spot == null ? 'no room' : `foot ${spot.foot.toString()} facing ${spot.facing.toString()} dig ${spot.dig.length}`)
  if (spot == null) return null
  if (bot.entity.position.floored().distanceTo(spot.stand) > 0.5) await navigate(bot, { goal: new goals.GoalBlock(spot.stand.x, spot.stand.y, spot.stand.z) }, signal)
  // no room free: dug out (the kit's chest by the stronghold in the 1-wide tunnel the bot came by, 26.3)
  for (const cell of spot.dig) {
    const block = bot.blockAt(cell)
    if (block == null || block.boundingBox !== 'block') continue
    const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(block)
    if (tool != null && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
    await dig(bot, block as any, { signal })
  }
  // in the middle of the cell behind the foot: a body over the foot's cell keeps the bed out ('the block is still air',
  // 1.21.11 by the stronghold)
  const centre = spot.stand.offset(0.5, 0, 0.5)
  for (let t = 0; t < 40 && Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z) > 0.15; t++) {
    steerToward(bot, centre, { sprint: false })
    await waitTicks(bot, 1, signal)
  }
  bot.clearControlStates()
  await waitTicks(bot, 2, signal)
  await bot.lookAt(spot.head.offset(0.5, 0, 0.5), true)
  await placeBlock(bot, { pos: spot.foot, item, against: spot.foot.offset(0, -1, 0) }, signal)
  const block = bot.blockAt(spot.foot)
  if (block == null || !isBed(block.name)) return null
  // the respawn point is set when the server says so (ServerPlayer.setRespawnPosition: 'block.minecraft.set_spawn');
  // a bed too far, obstructed or not safe says that instead (ServerPlayer.startSleepInBed's problems), and a respawn
  // by it was taken for granted: a 1.21.11 bot that died in the End came back at the world's spawn, 2596 blocks off
  const said: string[] = []
  const onMessage = (msg: any): void => { said.push(String(msg?.translate ?? msg?.json?.translate ?? msg?.toString?.() ?? '')) }
  bot.on('message' as any, onMessage)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await bot.activateBlock(bot.blockAt(spot.foot) as any)
      if (await waitUntil(bot, () => said.some(k => k === SET_SPAWN), 20, signal)) return spot.foot
      trace('placeSpawnBed: no respawn point set by', spot.foot.toString(), 'from', bot.entity.position.toString(), 'the server said', JSON.stringify(said))
    }
  } finally {
    bot.off('message' as any, onMessage)
  }
  // no word of it: the bed is there and was used (a server that says nothing of it, the message missed)
  return said.length === 0 ? spot.foot : null
}

/** the server's message for a respawn point set (ServerPlayer.setRespawnPosition) */
export const SET_SPAWN = 'block.minecraft.set_spawn'

/**
 * bedRoomToDig from where the bot stands, else from a cell to stand in within 2 of `near` (feet and head free, solid
 * under), the nearest first: the bot by its chest in a tunnel may stand where the chest takes the one way out
 */
export function roomToDigNear (lookup: (p: Vec3) => any, from: Vec3, near: Vec3, avoid: (p: Vec3) => boolean): ReturnType<typeof bedRoomToDig> {
  const here = bedRoomToDig(lookup, from, avoid)
  if (here != null) return here
  const stands: Vec3[] = []
  for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) stands.push(near.floored().offset(dx, dy, dz))
  stands.sort((a, b) => a.distanceTo(near) - b.distanceTo(near))
  for (const s of stands) {
    const open = (p: Vec3): boolean => lookup(p)?.boundingBox === 'empty' && !['lava', 'water'].includes(lookup(p)?.name)
    if (!open(s) || !open(s.offset(0, 1, 0)) || lookup(s.offset(0, -1, 0))?.boundingBox !== 'block') continue
    const room = bedRoomToDig(lookup, s, avoid)
    if (room != null) return room
  }
  return null
}

/** a chest within 4 of the bot the memory holds nothing of (one just put down, not a stronghold's nor the base's) */
export function unknownChestNear (bot: Bot, memory: WorldMemory): Vec3 | null {
  const feet = bot.entity.position.floored()
  for (let r = 1; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const p = feet.offset(dx, dy, dz)
          if (bot.blockAt(p)?.name === 'chest' && memory.chestAt(p, 'overworld') == null) return p
        }
      }
    }
  }
  return null
}

/**
 * how far from a portal's blocks a trip kit's chest and bed are put (and the bot stashes them from): the stash by the
 * portal walked the bot into it twice, and it was in the nether with no arrival portal remembered and no way back
 * (full-1.21.11-fresh-i, fresh-n)
 */
export const PORTAL_KEEP_OFF = 4

export function nearPortal (lookup: (p: Vec3) => any, pos: Vec3, radius = PORTAL_KEEP_OFF): boolean {
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -radius; dz <= radius; dz++) if (PORTAL_BLOCKS.has(lookup(pos.offset(dx, dy, dz))?.name)) return true
  return false
}

/** the nearest portal block (or frame obsidian) within `radius` of `pos`, or null */
export function portalBlockNear (lookup: (p: Vec3) => any, pos: Vec3, radius = PORTAL_KEEP_OFF + 2): Vec3 | null {
  let best: Vec3 | null = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -2; dy <= 4; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = pos.floored().offset(dx, dy, dz)
        if (!PORTAL_BLOCKS.has(lookup(p)?.name)) continue
        if (best == null || p.distanceTo(pos) < best.distanceTo(pos)) best = p
      }
    }
  }
  return best
}

/**
 * What a trip kit takes from the bag (items: names and counts carried, the bag's only): the weapons but the best one,
 * a bow when there are two, half the arrows (from 32 up) and of each food (from 8 up), half the blocks up to 64, and
 * the armor and shields carried, not worn or held
 */
/**
 * What a trip's gate keeps in the bag (TripKitKeep): the arrows and the food points the trip goes with; the kit then
 * takes what's over them, not half (the nether's kit, left after its gate is met: a respawn by it takes the spares up
 * and the gate is met again at once, not got again over 100000 ticks, seed 2)
 */
export interface TripKitKeep {
  arrows?: number
  /** food points, by `nutrition` */
  food?: number
  nutrition?: (name: string) => number
}

export function tripKitItems (items: readonly ItemCount[], keep: TripKitKeep = {}): ItemCount[] {
  const count = (name: string): number => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  const out: ItemCount[] = []
  const add = (name: string, n: number): void => { if (n > 0) out.push({ name, count: n }) }
  const weapons = WEAPONS.filter(w => count(w) > 0)
  // all of each weapon but one of the best
  weapons.forEach((w, i) => add(w, count(w) - (i === 0 ? 1 : 0)))
  // a spare pickaxe: the pickaxes but the best (after a death in the nether the bot came back with an axe alone and
  // stood 20000 ticks where the netherrack in its way couldn't be dug, 26.3), and but the best spare too when there
  // are three or more: the trip carries a spare of its own (the staircase down to the deep lava broke two, 26.3)
  const picks = PICKAXES.flatMap(p => new Array<string>(count(p)).fill(p))
  for (const p of PICKAXES) add(p, picks.slice(picks.length >= 3 ? 2 : 1).filter(q => q === p).length)
  if (count('bow') >= 2) add('bow', count('bow') - 1)
  if (keep.arrows != null) add('arrow', count('arrow') - keep.arrows)
  else if (count('arrow') >= 32) add('arrow', Math.floor(count('arrow') / 2))
  if (keep.food != null && keep.nutrition != null) {
    // the food over the points kept, the least nourishing first (the trip goes with the best)
    const value = keep.nutrition
    let spare = FOODS.reduce((n, f) => n + count(f) * value(f), 0) - keep.food
    for (const f of [...FOODS].sort((a, b) => value(a) - value(b))) {
      const each = value(f)
      if (each <= 0 || spare < each) continue
      const n = Math.min(count(f), Math.floor(spare / each))
      add(f, n)
      spare -= n * each
    }
  } else {
    for (const f of FOODS) if (count(f) >= 8) add(f, Math.floor(count(f) / 2))
  }
  let blocks = 0
  for (const b of BLOCKS) {
    const n = Math.min(Math.floor(count(b) / 2), 64 - blocks)
    if (n > 0) { add(b, n); blocks += n }
  }
  // (the gate's golden piece stays for the piglins, one of it, with a gate kept: the nether's kit took the golden boots
  // the gate had just made, and the gate made them again, full-1.21.11-fresh-k)
  const gate = keep.arrows != null || keep.food != null
  for (const i of items) {
    if (!ARMOR.test(i.name) || out.some(o => o.name === i.name)) continue
    add(i.name, count(i.name) - (gate && i.name.startsWith('golden_') ? 1 : 0))
  }
  // a shield carried (the one held is in the off hand, not the bag)
  add('shield', count('shield'))
  if (count('golden_apple') >= 2) add('golden_apple', 1)
  return out
}

/** the iron a spare chestplate and leggings take (8 and 7) */
export const SPARE_ARMOR_IRON = 15
/** the iron a spare iron pickaxe takes */
export const SPARE_PICKAXE_IRON = 3
/** the gold spare golden boots take */
export const SPARE_BOOTS_GOLD = 4
const GOLDEN_ARMOR = /^golden_(helmet|chestplate|leggings|boots)$/

/**
 * The spare gear to make for a trip kit from what the bot holds, as obtain requests in groups (`owned`: every item the
 * bot has, worn and held too; `carried`: the bag's): an iron chestplate and leggings, when no armor piece is carried
 * spare and the iron for both is (a respawn by the kit had none to put on, and a 26.3 bot went back into the nether
 * bare and died there three more times); then a shield, when none is carried spare and an ingot is left (the
 * blazes' fireballs, the creepers' blasts and the skeletons' arrows on the way back); golden boots for the
 * piglins, from 4 of the gold held; and an iron pickaxe when the bag has one or two, from 3 of the iron left (the kit
 * takes the worst, the trip goes on with a spare: tripKitItems)
 */
export function kitSpares (owned: readonly ItemCount[], carried: readonly ItemCount[]): Array<Array<{ item: string, count: number }>> {
  const has = (list: readonly ItemCount[], name: string): number => list.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  let iron = has(owned, 'iron_ingot')
  const out: Array<Array<{ item: string, count: number }>> = []
  if (!carried.some(i => ARMOR.test(i.name)) && iron >= SPARE_ARMOR_IRON) {
    out.push([{ item: 'iron_chestplate', count: has(owned, 'iron_chestplate') + 1 }, { item: 'iron_leggings', count: has(owned, 'iron_leggings') + 1 }])
    iron -= SPARE_ARMOR_IRON
  }
  if (has(carried, 'shield') === 0 && iron >= 1) {
    out.push([{ item: 'shield', count: has(owned, 'shield') + 1 }])
    iron -= 1
  }
  // golden boots when no golden piece is carried spare and the gold is held: a respawn back into the nether bare had the
  // piglins at it by the portal (PiglinAi.isWearingGold; a 26.3 bot was slain so by the arrival portal)
  if (!carried.some(i => GOLDEN_ARMOR.test(i.name)) && has(owned, 'gold_ingot') >= SPARE_BOOTS_GOLD) out.push([{ item: 'golden_boots', count: has(owned, 'golden_boots') + 1 }])
  // an iron pickaxe when the bag has fewer than 3 (the kit takes one, the trip carries a spare: tripKitItems) and the
  // iron for it is left
  const picks = PICKAXES.reduce((n, p) => n + has(carried, p), 0)
  if (picks >= 1 && picks < 3 && iron >= SPARE_PICKAXE_IRON) out.push([{ item: 'iron_pickaxe', count: has(owned, 'iron_pickaxe') + 1 }])
  return out
}

export interface TripKitResult {
  chest: Vec3
  stored: Record<string, number>
  /** a bed put down by it set the respawn point there */
  bed: Vec3 | null
  /** why no bed was put down by it, when none is */
  noBed?: string
}

/**
 * Leaves the trip kit (tripKitItems) in a chest put down by the bot, and a bed beside it used to set the respawn
 * point when one is held; remembered as a TRIP_KIT point with the chest's items. Throws MISSING_ITEMS without a chest.
 */
export async function stashTripKit (bot: Bot, memory: WorldMemory, signal?: AbortSignal, opts: { chest?: Vec3, keep?: TripKitKeep } = {}): Promise<TripKitResult> {
  throwIfAborted(signal)
  const lookup = (p: Vec3): any => bot.blockAt(p)
  // a kit's chest there already (the one a respawn emptied): filled again, no chest nor bed made
  const reuse = opts.chest != null && bot.blockAt(opts.chest)?.name === 'chest'
  // or the one this put down before it was cut off (a fight's reflex: the task runs again, and the chest is down)
  const placed = !reuse && !bot.inventory.items().some(i => i.name === 'chest') ? unknownChestNear(bot, memory) : null
  let pos: Vec3
  if (reuse) {
    pos = opts.chest as Vec3
  } else if (placed != null) {
    pos = placed
  } else {
    if (!bot.inventory.items().some(i => i.name === 'chest')) throw new SkillError('MISSING_ITEMS', 'no chest for a trip kit')
    // off the portal first, out of PORTAL_KEEP_OFF of its blocks and never through them (awayFromPortals): the chest
    // and the bed go round the bot there
    const portal = portalBlockNear(lookup, bot.entity.position)
    if (portal != null) {
      await awayFromPortals(bot, async () => await navigate(bot, { goal: new goals.GoalInvert(new goals.GoalNear(portal.x, portal.y, portal.z, PORTAL_KEEP_OFF + 3)) as any }, signal)).catch(err => {
        if (isAbort(err)) throw err
        trace('stashTripKit: no way off the portal:', (err as Error).message)
      })
    }
    // (room over it: a chest under a block doesn't open, ChestBlock.isChestBlockedAt, and each item's store waited
    // 20 s for the window, 58000 ticks gone in a 26.3 cave)
    const at = findPlacement(lookup, bot.entity.position, { radius: 3, freeAbove: true, avoid: p => nearPortal(lookup, p) })
    if (at == null) throw new SkillError('CANNOT_PLACE', 'no room for a chest')
    pos = at
    await placeBlock(bot, { pos, item: 'chest' }, signal)
  }
  const stored: Record<string, number> = {}
  for (const it of tripKitItems(bot.inventory.items().map(i => ({ name: i.name, count: i.count })), opts.keep)) {
    throwIfAborted(signal)
    try {
      const res = await storeItems(bot, { chest: pos, filter: it.name, count: it.count, memory }, signal)
      for (const [name, n] of Object.entries(res.moved)) stored[name] = (stored[name] ?? 0) + n
    } catch (err) {
      if (isAbort(err)) throw err
      trace('stashTripKit:', it.name, (err as Error).message)
      // a chest that won't open won't for the next item either
      if (/windowOpen|did not fire|won't open|blocked/i.test((err as Error).message)) break
    }
  }
  // (each store remembered the chest's contents: chest.ts rememberContents)
  if (memory.chestAt(pos, 'overworld') == null) memory.rememberChest(pos, stored, 'overworld')
  memory.addPoi(TRIP_KIT, pos, 'overworld', 'spare kit')
  // the respawn point by the kit
  let bed: Vec3 | null = null
  let noBed: string | undefined
  const held = bot.inventory.items().find(i => isBed(i.name))
  if (held == null) noBed = 'no bed held'
  const bedThere = memory.getPois('spawn_bed', { dimension: 'overworld', near: pos }).find(b => new Vec3(b.x, b.y, b.z).distanceTo(pos) <= 4 && isBed(bot.blockAt(new Vec3(b.x, b.y, b.z))?.name ?? ''))
  if (bedThere != null) bed = new Vec3(bedThere.x, bedThere.y, bedThere.z)
  if (held != null && bedThere == null) {
    try {
      bed = await placeSpawnBed(bot, pos, held.name, signal)
      if (bed != null) memory.addPoi('spawn_bed', bed, 'overworld', 'by the trip kit')
      else noBed = `no room for a bed by ${pos.toString()} (the bot at ${bot.entity.position.floored().toString()})`
    } catch (err) {
      if (isAbort(err)) throw err
      noBed = (err as Error).message
      trace('stashTripKit: the bed:', noBed)
      // the server's inventory again: a placement the server didn't take leaves the client's hand and slots its own guess
      await resyncInventory(bot, signal).catch(() => {})
    }
  }
  // neither broken by a path from here on: the walk to the portal room dug through the bed (and picked it up), and a
  // 1.21.11 bot that died in the End came back at the world's spawn, 2596 blocks off
  const kept = [pos]
  if (bed != null) {
    kept.push(bed)
    for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) if (isBed(bot.blockAt(bed.plus(d))?.name ?? '')) kept.push(bed.plus(d))
  }
  keepUnbroken(bot, kept)
  trace('stashTripKit: at', pos.toString(), JSON.stringify(stored), bed != null ? `bed at ${bed.toString()}` : 'no bed')
  return { chest: pos, stored, bed, noBed }
}

/**
 * Blocks the pathfinder never breaks from now on (its break exclusion, 1e9 a block): the trip kit's chest and the bed
 * of the respawn point. Added to the ones kept before.
 */
export function keepUnbroken (bot: Bot, cells: Vec3[]): void {
  const pathfinder: any = (bot as any).pathfinder
  const settings = pathfinder?.defaultMoveSettings
  if (settings?.exclusionAreasBreak == null || typeof pathfinder.setMoveOptions !== 'function') return
  const old = (settings.exclusionAreasBreak as any[]).find(f => f.survivalKept != null)
  const keys = new Set<string>(old?.survivalKept ?? [])
  for (const c of cells) keys.add(`${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)}`)
  const keep = (block: any): number => keys.has(`${block.position.x},${block.position.y},${block.position.z}`) ? 1e9 : 0
  ;(keep as any).survivalKept = keys
  pathfinder.setMoveOptions({ ...settings, exclusionAreasBreak: [...(settings.exclusionAreasBreak as any[]).filter(f => f.survivalKept == null), keep] })
}

/**
 * Runs `fn` with the portal blocks kept out of the pathfinder's steps (a step exclusion, 1e9 a cell), and the settings
 * put back after: the trip kit's stash by the nether portal walked the bot into it, and it was in the nether with no
 * arrival portal remembered and no way back (full-1.21.11-fresh-n)
 */
export async function awayFromPortals<T> (bot: Bot, fn: () => Promise<T>): Promise<T> {
  const pf = (bot as any).pathfinder
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null) return await fn()
  const before = { ...pf.defaultMoveSettings }
  const portal = (block: any): number => bot.blockAt(block.position)?.name === 'nether_portal' ? 1e9 : 0
  pf.setMoveOptions({ ...before, exclusionAreasStep: [...(before.exclusionAreasStep ?? []), portal] })
  try {
    return await fn()
  } finally {
    pf.setMoveOptions({ ...pf.defaultMoveSettings, exclusionAreasStep: (pf.defaultMoveSettings.exclusionAreasStep ?? []).filter((f: unknown) => f !== portal) })
  }
}

/** takes everything out of the trip kit's chest (the bot by it); resolves what came out */
export async function takeTripKit (bot: Bot, memory: WorldMemory, signal?: AbortSignal): Promise<Record<string, number>> {
  const poi = memory.getPois(TRIP_KIT, { dimension: 'overworld', near: bot.entity.position })[0]
  if (poi == null) return {}
  const chest = new Vec3(poi.x, poi.y, poi.z)
  // (what's left remembered as the window shows it: chest.ts rememberContents)
  const res = await retrieveItems(bot, { chest, memory }, signal)
  return res.moved
}
