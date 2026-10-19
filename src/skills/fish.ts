// fish: a rod cast into open water, the bite seen on the bobber, the line reeled in on it and the catch picked up.
// Vanilla's FishingHook (the same in 1.21.11 and 26.3): the hook flies from the eyes along the look, lands in water and
// bobs; a fish is lured (timeUntilLured 100 - 600 ticks, less 100 a level of lure), swims up (timeUntilHooked 20 - 80)
// and bites: DATA_BITING goes true for the nibble's 20 - 40 ticks, and a use of the rod then (FishingHook.retrieve)
// rolls the fishing loot table. Only open water (calculateOpenWater: the 5 x 5 round the bobber water from the layer
// under it to its own, air the two over it, every tick of the bite) rolls the treasure: the enchanted books among it.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { navigate } from './navigate'
import { pickupDrops } from './pickupDrops'
import { countsDelta, eyeHeight, inventoryCounts, inventoryItems, settleInventory, trace, waitTicks, waitUntil } from './util'
import type { TaskError } from '../core/errors'
import { metadataValue, type Entity } from './combatUtil'

export interface FishBlock {
  name: string
  boundingBox?: string
  getProperties?: () => Record<string, unknown>
}
export type FishLookup = (pos: Vec3) => FishBlock | null

/** FishingHook.OpenWaterType */
export type OpenWaterType = 'above' | 'inside' | 'invalid'

/** blocks whose fluid is a water source with no collision shape (FluidState.isSource, an empty collision shape) */
const WATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column'])
const AIRS = new Set(['air', 'cave_air', 'void_air'])

export function isWaterSource (b: FishBlock | null): boolean {
  if (b == null) return false
  if (b.name === 'water') return Number(b.getProperties?.().level ?? 0) === 0
  return WATER_PLANTS.has(b.name)
}

export function isWater (b: FishBlock | null): boolean {
  return b != null && (b.name === 'water' || WATER_PLANTS.has(b.name))
}

/** FishingHook.getOpenWaterTypeForBlock: air or a lily pad is above water, a water source without collision inside it */
export function openWaterTypeForBlock (b: FishBlock | null): OpenWaterType {
  if (b == null) return 'invalid'
  if (AIRS.has(b.name) || b.name === 'lily_pad') return 'above'
  return isWaterSource(b) ? 'inside' : 'invalid'
}

/**
 * FishingHook.calculateOpenWater at the bobber's block: the layers from the one under it to two over it, each 5 x 5 all
 * of one type, inside water first and above water after (never inside again once above)
 */
export function isOpenWater (lookup: FishLookup, pos: Vec3): boolean {
  let last: OpenWaterType = 'invalid'
  for (let dy = -1; dy <= 2; dy++) {
    let layer: OpenWaterType | null = null
    for (let dx = -2; dx <= 2 && layer !== 'invalid'; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const t = openWaterTypeForBlock(lookup(pos.offset(dx, dy, dz)))
        layer = layer == null || layer === t ? t : 'invalid'
        if (layer === 'invalid') break
      }
    }
    if (layer == null || layer === 'invalid') return false
    if (layer === 'above' && last === 'invalid') return false
    if (layer === 'inside' && last === 'above') return false
    last = layer
  }
  return true
}

/** FishingHook's motion: gravity 0.03 a tick out of water, the motion scaled by 0.92 after each move */
export const HOOK_GRAVITY = 0.03
export const HOOK_DRAG = 0.92

/**
 * Where a cast from the eyes lands (FishingHook's constructor, then its tick while FLYING): the first water block the
 * hook gets into (it bobs there), or null when it hits a block first or flies on past `maxTicks`. Yaw and pitch in
 * vanilla's degrees; the hook's random spread (triangle(0.5, 0.0103365) on each axis) left at its middle.
 */
export function simulateCast (lookup: FishLookup, eye: Vec3, yawDeg: number, pitchDeg: number, maxTicks = 80): Vec3 | null {
  const rad = Math.PI / 180
  const h = Math.cos(-yawDeg * rad - Math.PI)
  const k = Math.sin(-yawDeg * rad - Math.PI)
  const l = -Math.cos(-pitchDeg * rad)
  const m = Math.sin(-pitchDeg * rad)
  const pos = new Vec3(eye.x - k * 0.3, eye.y, eye.z - h * 0.3)
  const dir = new Vec3(-k, Math.max(-5, Math.min(5, -(m / l))), -h)
  const scale = 0.6 / dir.norm() + 0.5
  const v = dir.scaled(scale)
  for (let t = 0; t < maxTicks; t++) {
    const cell = pos.floored()
    const b = lookup(cell)
    if (isWater(b)) {
      // it bobs on the top of the water it got into
      let top = cell
      while (isWater(lookup(top.offset(0, 1, 0)))) top = top.offset(0, 1, 0)
      return top
    }
    if (b == null || b.boundingBox === 'block') return null
    v.y -= HOOK_GRAVITY
    pos.x += v.x
    pos.y += v.y
    pos.z += v.z
    const next = lookup(pos.floored())
    if (next == null) return null
    if (next.boundingBox === 'block' && !isWater(next)) return null
    v.x *= HOOK_DRAG
    v.y *= HOOK_DRAG
    v.z *= HOOK_DRAG
  }
  return null
}

/** mineflayer's yaw and pitch (radians) as vanilla's degrees (toNotchianYaw, toNotchianPitch) */
export function toVanillaYaw (yaw: number): number {
  return 180 - yaw * 180 / Math.PI
}
export function fromVanillaYaw (deg: number): number {
  return (180 - deg) * Math.PI / 180
}

export interface CastPlan {
  /** where the bot stands (its feet's block) */
  stand: Vec3
  /** mineflayer's yaw and pitch */
  yaw: number
  pitch: number
  /** the water block the hook lands in */
  landing: Vec3
  /** whether it is open water (treasure rolls there) */
  open: boolean
}

/** the pitches tried for a cast, in vanilla's degrees (negative looks up) */
const CAST_PITCHES = Array.from({ length: 31 }, (_, i) => -45 + i * 3)

/**
 * The pitch to cast at from `eye` toward `target` (the yaw at it), and where that lands: a landing in open water
 * first, the one nearest the target after; null when no pitch lands in water
 */
export function planCast (lookup: FishLookup, eye: Vec3, target: Vec3, wantOpen = true): { yaw: number, pitch: number, landing: Vec3, open: boolean } | null {
  const dx = target.x + 0.5 - eye.x
  const dz = target.z + 0.5 - eye.z
  const yaw = Math.atan2(-dx, -dz)
  const yawDeg = toVanillaYaw(yaw)
  let best: { yaw: number, pitch: number, landing: Vec3, open: boolean, score: number } | null = null
  for (const p of CAST_PITCHES) {
    const landing = simulateCast(lookup, eye, yawDeg, p)
    if (landing == null) continue
    const open = isOpenWater(lookup, landing)
    // open water a block about the landing too, the bobber drifting a little as it bobs
    const roomy = open && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([x, z]) => isOpenWater(lookup, landing.offset(x, 0, z)))
    const score = (wantOpen && open ? 100 : 0) + (roomy ? 10 : 0) - landing.distanceTo(target)
    if (best == null || score > best.score) best = { yaw, pitch: -p * Math.PI / 180, landing, open, score }
  }
  return best == null ? null : { yaw: best.yaw, pitch: best.pitch, landing: best.landing, open: best.open }
}

/** the bot's feet stand there: a block to stand on (not water), two free blocks over it */
function standable (lookup: FishLookup, feet: Vec3): boolean {
  const floor = lookup(feet.offset(0, -1, 0))
  if (floor == null || floor.boundingBox !== 'block' || isWater(floor)) return false
  for (const dy of [0, 1]) {
    const b = lookup(feet.offset(0, dy, 0))
    if (b == null || b.boundingBox === 'block' || isWater(b) || b.name === 'lava') return false
  }
  return true
}

export interface FindFishingSpotOptions {
  /** how far from `center` to look for water (default 32) */
  radius?: number
  /** only open water (default true): none found is null */
  open?: boolean
  /** water blocks tried as targets, the nearest first (default 24) */
  targets?: number
  /** where the bot stands from the target, across (default 2 - 9) */
  minCast?: number
  maxCast?: number
}

/**
 * A place to fish from: open water near `center` (its top layer, isOpenWater, the ones with open water all about
 * first), a shore cell 2 to 9 blocks off where the bot stands, and the cast from there that lands in it (planCast).
 * The water blocks come from `waters` (the bot's findBlocks), the nearest first.
 */
export function findFishingSpot (lookup: FishLookup, center: Vec3, waters: Vec3[], opts: FindFishingSpotOptions = {}): CastPlan | null {
  const wantOpen = opts.open ?? true
  const minCast = opts.minCast ?? 2
  const maxCast = opts.maxCast ?? 9
  // the top layer of the water: air over it
  const tops = waters.filter(w => isWaterSource(lookup(w)) && AIRS.has(lookup(w.offset(0, 1, 0))?.name ?? ''))
  const scored = tops.map(w => {
    const open = isOpenWater(lookup, w)
    const around = open ? [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([x, z]) => isOpenWater(lookup, w.offset(x, 0, z))).length : 0
    return { w, open, around }
  }).filter(t => !wantOpen || t.open)
    .sort((a, b) => (b.around - a.around) * 1000 + a.w.distanceTo(center) - b.w.distanceTo(center))
  for (const { w } of scored.slice(0, opts.targets ?? 24)) {
    const stands: Vec3[] = []
    for (let dx = -maxCast; dx <= maxCast; dx++) {
      for (let dz = -maxCast; dz <= maxCast; dz++) {
        const across = Math.hypot(dx, dz)
        if (across < minCast || across > maxCast) continue
        for (let dy = 1; dy <= 4; dy++) {
          const feet = w.offset(dx, dy, dz)
          if (standable(lookup, feet)) { stands.push(feet); break }
        }
      }
    }
    stands.sort((a, b) => a.distanceTo(center) - b.distanceTo(center))
    for (const stand of stands.slice(0, 24)) {
      const eye = stand.offset(0.5, 1.62, 0.5)
      const cast = planCast(lookup, eye, w, wantOpen)
      if (cast == null || (wantOpen && !cast.open)) continue
      return { stand, ...cast }
    }
  }
  return null
}

/** the bobber's DATA_BITING (FishingHook: true while a fish bites) by its entity metadata's key */
export function bobberBiting (bot: Bot, bobber: Entity): boolean {
  return metadataValue(bot, bobber, 'biting') === true
}

/** the entity the bobber has hooked (DATA_HOOKED_ENTITY: its id + 1, 0 for none) */
export function bobberHooked (bot: Bot, bobber: Entity): number | null {
  const v = metadataValue(bot, bobber, 'hooked_entity')
  return typeof v === 'number' && v > 0 ? v - 1 : null
}

/** the bot's own bobber (the spawn's data is its owner: FishingHook.getAddEntityPacket) */
export function ownBobber (bot: Bot): Entity | null {
  return Object.values(bot.entities).find(e => e.name === 'fishing_bobber' && (e as any).ownerId === bot.entity.id) ?? null
}

/** how good a rod is to fish with: luck of the sea's levels (the treasure) first, then lure's, then what's left of it */
export function rodScore (item: Item): number {
  const lvl = (name: string): number => item.enchants?.find(e => e.name === name)?.lvl ?? 0
  const left = (item.maxDurability ?? 64) - ((item as any).durabilityUsed ?? 0)
  return lvl('luck_of_the_sea') * 1000 + lvl('lure') * 100 + left / 100
}

export function bestRod (bot: Bot): Item | null {
  return inventoryItems(bot).filter(i => i.name === 'fishing_rod').sort((a, b) => rodScore(b) - rodScore(a))[0] ?? null
}

/** ticks a cast waits for a bite: the lure's 600 and the swim up's 80 at most, under the open sky, and some over */
export const BITE_TICKS = 900
/** ticks the hook may take to land and bob in the water before the cast is reeled in and tried again */
export const LAND_TICKS = 60

export type CastOutcome = 'caught' | 'missed' | 'no-bite' | 'hooked'

export interface CastResult {
  outcome: CastOutcome
  /** what came into the bag */
  items: Record<string, number>
  /** ticks from the cast to the catch picked up */
  ticks: number
  /** where the bobber bobbed */
  bobber: Vec3 | null
}

async function useRod (bot: Bot): Promise<void> {
  const rod = bestRod(bot)
  if (rod == null) throw new SkillError('MISSING_ITEMS', 'no fishing_rod')
  if (bot.heldItem?.name !== 'fishing_rod' || (bot.heldItem as any).slot !== rod.slot) await bot.equip(rod, 'hand')
  bot.activateItem()
  // (a rod is used at once, never held in use: FishingRodItem.use)
  ;(bot as any).usingHeldItem = false
}

/**
 * One cast: the look set (mineflayer's yaw and pitch), the rod used, the bobber waited for in the water, the bite
 * (bobberBiting) waited for up to BITE_TICKS, the rod used again on it, and what flew out of the water picked up.
 * 'missed' when the hook didn't land in water, 'hooked' when it caught an entity, 'no-bite' when no fish came.
 */
export async function castOnce (bot: Bot, look: { yaw: number, pitch: number }, signal?: AbortSignal): Promise<CastResult> {
  throwIfAborted(signal)
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    // an old bobber of the bot's reeled in first
    if (ownBobber(bot) != null) {
      await useRod(bot)
      await waitUntil(bot, () => ownBobber(bot) == null, 20, signal)
    }
    await bot.look(look.yaw, look.pitch, true)
    await waitTicks(bot, 1, signal)
    const before = inventoryCounts(bot)
    await useRod(bot)
    if (!(await waitUntil(bot, () => ownBobber(bot) != null, 20, signal))) {
      throw new SkillError('VERIFY_FAILED', 'no bobber came out of the cast')
    }
    const bobber = ownBobber(bot) as Entity
    const inWater = (): boolean => isWater(bot.blockAt(bobber.position.floored()) as any)
    const landed = await waitUntil(bot, () => bot.entities[bobber.id] == null || inWater() || bobberHooked(bot, bobber) != null, LAND_TICKS, signal)
    const done = async (outcome: CastOutcome): Promise<CastResult> => {
      if (bot.entities[bobber.id] != null) {
        await useRod(bot).catch(() => {})
        await waitUntil(bot, () => bot.entities[bobber.id] == null, 20, signal)
      }
      return { outcome, items: countsDelta(before, inventoryCounts(bot)), ticks, bobber: bobber.position.clone() }
    }
    if (bot.entities[bobber.id] == null) return { outcome: 'missed', items: {}, ticks, bobber: null }
    if (bobberHooked(bot, bobber) != null) return await done('hooked')
    if (!landed) return await done('missed')
    const at = bobber.position.clone()
    trace('fish: bobbing at', at.toString())
    const bit = await waitUntil(bot, () => bot.entities[bobber.id] == null || bobberBiting(bot, bobber) || bobberHooked(bot, bobber) != null, BITE_TICKS, signal)
    if (bot.entities[bobber.id] == null) return { outcome: 'missed', items: {}, ticks, bobber: at }
    if (bobberHooked(bot, bobber) != null) return await done('hooked')
    if (!bit) return await done('no-bite')
    // reeled in on the bite (FishingHook.retrieve with nibble > 0): the loot flies at the player
    await useRod(bot)
    await waitUntil(bot, () => bot.entities[bobber.id] == null, 20, signal)
    // the catch: in the bag once it flew in, else picked up where it fell
    await waitUntil(bot, () => Object.keys(countsDelta(before, inventoryCounts(bot))).some(k => k !== 'fishing_rod'), 40, signal)
    if (!Object.keys(countsDelta(before, inventoryCounts(bot))).some(k => k !== 'fishing_rod')) {
      await pickupDrops(bot, { near: bot.entity.position, radius: 10, waitTicks: 20 }, signal).catch(err => { if (isAbort(err)) throw err })
    }
    await settleInventory(bot, signal)
    const items = countsDelta(before, inventoryCounts(bot))
    delete items.fishing_rod
    return { outcome: 'caught', items, ticks, bobber: at }
  } finally {
    bot.off('physicsTick', onTick)
  }
}

export interface FishArgs {
  /** stop once this many items are caught */
  catches?: number
  /** stop once this holds (checked after each catch) */
  until?: (bot: Bot) => boolean
  /** where to look for water (default the bot) */
  center?: Vec3
  /** how far from center (default 32) */
  radius?: number
  /** open water only (default true: the treasure, the enchanted books, rolls only there) */
  open?: boolean
  /** give up after (default 24000) */
  maxTicks?: number
}

export interface FishResult {
  /** items caught, by name */
  caught: Record<string, number>
  catches: number
  casts: number
  ticks: number
  spot: CastPlan
  /** whether `until` held at the end */
  done: boolean
}

/** the bot's best guess at where to fish from: findFishingSpot over the water blocks within `radius` */
export function fishingSpotFor (bot: Bot, center: Vec3, radius = 32, open = true): CastPlan | null {
  const water = bot.registry.blocksByName.water?.id
  if (water == null) return null
  const waters = bot.findBlocks({ matching: water, maxDistance: radius, count: 2048, point: center })
  return findFishingSpot(pos => bot.blockAt(pos) as any, center, waters, { open })
}

/**
 * Fishes until `catches` items are caught or `until` holds: a spot found (fishingSpotFor), walked to, and cast from
 * again and again (castOnce). A cast that misses the water three times in a row looks for another spot. Throws
 * MISSING_ITEMS without a rod (one that broke: the partial result says what came in), NOT_FOUND without water to
 * fish, TIMEOUT after maxTicks.
 */
export async function fish (bot: Bot, args: FishArgs = {}, signal?: AbortSignal): Promise<FishResult> {
  const maxTicks = args.maxTicks ?? 24000
  const center = args.center ?? bot.entity.position.clone()
  const open = args.open ?? true
  let ticks = 0
  const onTick = (): void => { ticks++ }
  const caught: Record<string, number> = {}
  let catches = 0
  let casts = 0
  let spot: CastPlan | null = null
  const result = (): FishResult => ({ caught: { ...caught }, catches, casts, ticks, spot: spot as CastPlan, done: args.until?.(bot) ?? false })
  const enough = (): boolean => (args.catches != null && catches >= args.catches) || (args.until?.(bot) ?? false)
  bot.on('physicsTick', onTick)
  try {
    let misses = 0
    while (!enough()) {
      throwIfAborted(signal, result())
      if (ticks >= maxTicks) throw new SkillError('TIMEOUT', `${catches} caught in ${casts} casts, ${ticks} ticks`, result())
      if (bestRod(bot) == null) throw new SkillError('MISSING_ITEMS', 'no fishing_rod', result())
      if (spot == null || misses >= 3) {
        spot = fishingSpotFor(bot, misses >= 3 && spot != null ? spot.landing : center, args.radius ?? 32, open)
        misses = 0
        if (spot == null) throw new SkillError('NOT_FOUND', `no ${open ? 'open ' : ''}water to fish within ${args.radius ?? 32} blocks`, result())
        trace('fish: standing at', spot.stand.toString(), 'to cast into', spot.landing.toString(), spot.open ? '(open water)' : '')
        const goal = new goals.GoalBlock(spot.stand.x, spot.stand.y, spot.stand.z)
        await navigate(bot, { goal }, signal)
      }
      // the cast planned again from where the bot stands now (the stand's middle, or near it)
      const eye = bot.entity.position.offset(0, eyeHeight(bot), 0)
      const look = planCast(pos => bot.blockAt(pos) as any, eye, spot.landing, open) ?? spot
      casts++
      const res = await castOnce(bot, look, signal)
      trace('fish: cast', casts, res.outcome, JSON.stringify(res.items), 'in', res.ticks, 'ticks')
      if (res.outcome === 'missed' || res.outcome === 'hooked') misses++
      else misses = 0
      for (const [name, n] of Object.entries(res.items)) {
        if (n <= 0) continue
        caught[name] = (caught[name] ?? 0) + n
        catches += n
      }
    }
  } catch (err) {
    if (isAbort(err)) throw (err as TaskError).withPartial?.(result()) ?? err
    throw err
  } finally {
    bot.off('physicsTick', onTick)
    if (ownBobber(bot) != null) await useRod(bot).catch(() => {})
  }
  return result()
}

/** whether an item carries an enchantment (an enchanted book's stored ones too) */
export function hasEnchant (item: Item | null | undefined, name: string): boolean {
  return (item?.enchants ?? []).some(e => e.name === name)
}

/** the enchanted books with mending the bot holds */
export function mendingBooks (bot: Bot): Item[] {
  return inventoryItems(bot).filter(i => i.name === 'enchanted_book' && hasEnchant(i, 'mending'))
}
