// shelter: through the night in a 1x2 hole dug into the ground and sealed over the head, for a bot with no bed and no
// gear to fight with; and the night's plan (a bed: sleep; good gear: fight; else shelter).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, isSkillError, throwIfAborted } from './errors'
import { fight } from './fight'
import { isAlive } from './combatUtil'
import { sleep } from './sleep'
import { navigate } from './navigate'
import { eat, bestFoodInInventory } from './eat'
import { armorPiece } from './armor'
import { hitDamage } from './weapons'
import { CARDINALS, countItems, trace, vecKey, waitUntil, type Block } from './util'
import { bedRoomToDig, findBedPlacement, type BlockLookup, type BlockView } from './placement'
import { SCAFFOLD_ITEMS, towerUp } from '../end/skills/world'
import { isBed } from '../core/items'
import { dig } from '../core/actions'
import { drownedNear, noteDrowning } from './breath'

/** how deep the hole goes: the feet three blocks down, the head two, the seal one (flush with the ground) */
export const SHELTER_DEPTH = 3

/** ground a hand or a shovel digs in a moment (BlockTags.MINEABLE_WITH_SHOVEL's natural blocks, sand and gravel left out: they fall) */
export const SOFT_GROUND = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'mud', 'clay', 'moss_block', 'snow_block', 'dirt_path', 'farmland', 'pale_moss_block'])
/** ground a pickaxe digs (BlockTags.MINEABLE_WITH_PICKAXE's natural stones) */
export const STONE_GROUND = new Set(['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'sandstone', 'red_sandstone', 'terracotta', 'cobblestone', 'netherrack', 'blackstone', 'basalt', 'end_stone'])
/** blocks that fall when there's air under them (FallingBlock): never a seal over the head */
const GRAVITY_BLOCKS = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding|.*_concrete_powder)$/
/** what the seal is made of, in order of preference */
const SEAL_PREFERRED = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'coarse_dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone']
const LIQUIDS = new Set(['water', 'lava', 'bubble_column'])
const PASSABLE_IN_HOLE = new Set(['air', 'cave_air', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch'])

const isSolid = (b: BlockView | null): boolean => b != null && b.boundingBox === 'block'
const isOpen = (b: BlockView | null): boolean => b != null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name) && !/fire|lava|cactus|berry|powder_snow|wither_rose/.test(b.name)

export interface ShelterSpot {
  /** the cell the bot stands in on the surface, over the column it digs */
  surface: Vec3
  /** the cell its feet end up in, SHELTER_DEPTH down */
  feet: Vec3
  /** the cell it seals over its head */
  seal: Vec3
  /** what digging the column costs (the sum of `digCost` over its blocks) */
  cost: number
}

export interface FindShelterOptions {
  /** how far to look, horizontally (default 8) */
  radius?: number
  /** how far up and down from the bot's feet (default 4) */
  dy?: number
  /** columns not to take (ones the bot couldn't get to), by their surface cell's vecKey */
  exclude?: Set<string>
  /** what a block costs to dig, Infinity for never (default: soft ground 1, stone 4 with a pickaxe, else never) */
  digCost?: (name: string) => number
  /** columns not to take, by their surface cell (a spot the bot drowned at lately: skills/breath drownedNear) */
  avoid?: (surface: Vec3) => boolean
}

/** soft ground is cheap, stone is dear and only with a pickaxe */
export function defaultDigCost (hasPickaxe: boolean): (name: string) => number {
  return (name) => SOFT_GROUND.has(name) ? 1 : STONE_GROUND.has(name) && hasPickaxe ? 4 : Infinity
}

/**
 * A column to dig the shelter in: a surface cell the bot can stand in (it and the cell over it open, natural ground
 * under), SHELTER_DEPTH blocks under it it can dig, solid ground under those, walls all round the two cells the body
 * ends up in, at least one solid side for the seal to go against, and no water or lava next to any of it. The
 * cheapest to dig and the nearest first; null if there's none.
 */
export function findShelterSpot (lookup: BlockLookup, from: Vec3, opts: FindShelterOptions = {}): ShelterSpot | null {
  const radius = opts.radius ?? 8
  const dyMax = opts.dy ?? 4
  const digCost = opts.digCost ?? defaultDigCost(false)
  const start = from.floored()
  let best: ShelterSpot | null = null
  let bestScore = Infinity
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -dyMax; dy <= dyMax; dy++) {
        const surface = start.offset(dx, dy, dz)
        if (opts.exclude?.has(vecKey(surface)) === true) continue
        if (opts.avoid?.(surface) === true) continue
        const spot = shelterAt(lookup, surface, digCost)
        if (spot == null) continue
        const score = spot.cost * 4 + Math.hypot(dx, dz) + Math.abs(dy)
        if (score < bestScore) { best = spot; bestScore = score }
      }
    }
  }
  return best
}

/** the shelter dug down from this surface cell, if it can be; `dug`: the column may be open already (the bot in it) */
export function shelterAt (lookup: BlockLookup, surface: Vec3, digCost: (name: string) => number, dug = false): ShelterSpot | null {
  if (!isOpen(lookup(surface)) || !isOpen(lookup(surface.offset(0, 1, 0)))) return null
  let cost = 0
  for (let d = 1; d <= SHELTER_DEPTH; d++) {
    const b = lookup(surface.offset(0, -d, 0))
    // dug already (the bot was cut off halfway)
    if (dug && isOpen(b)) continue
    if (!isSolid(b)) return null
    const c = digCost((b as BlockView).name)
    if (!Number.isFinite(c)) return null
    cost += c
  }
  // solid ground under the floor, SHELTER_GROUND_DEPTH blocks of it: no thin crust over a cave or a ravine
  for (let d = 1; d <= SHELTER_GROUND_DEPTH; d++) {
    if (!isSolid(lookup(surface.offset(0, -SHELTER_DEPTH - d, 0)))) return null
  }
  const seal = surface.offset(0, -1, 0)
  const head = surface.offset(0, -SHELTER_DEPTH + 1, 0)
  const feet = surface.offset(0, -SHELTER_DEPTH, 0)
  let sealSides = 0
  for (const side of CARDINALS) {
    const s = lookup(seal.plus(side))
    if (s == null || LIQUIDS.has(s.name)) return null
    if (isSolid(s)) sealSides++
    for (const cell of [head, feet]) {
      const wall = lookup(cell.plus(side))
      if (!isSolid(wall) || LIQUIDS.has((wall as BlockView).name)) return null
    }
  }
  if (sealSides === 0) return null
  // no water or lava within SHELTER_DRY_REACH of the column's cells, the floor's too (a dig by it lets it in; a 26.3
  // bot's night shelter at y 43 by an aquifer flooded, the bot sank to y 38 in it and drowned there after 8 drowning
  // reflexes, f1-26.3 t196613 to t200563)
  if (liquidNear(lookup, surface.offset(0, -SHELTER_DEPTH - 1, 0), surface, SHELTER_DRY_REACH)) return null
  return { surface, feet, seal, cost }
}

/**
 * the blocks of solid ground a shelter's column has under its floor (shelterAt): the floor and two under it. A 26.3
 * bot's night shelter on a mountain at t372485 ended 35 ticks on in a fall from a high place, health 15 to 0
 * (f6-26.3, at (5, 74, -4))
 */
export const SHELTER_GROUND_DEPTH = 3

/** how far from a shelter's column (across, and under its floor) no water or lava may be (shelterAt) */
export const SHELTER_DRY_REACH = 2

/** whether water or lava is within `reach` (across, and under) of the column from `bottom` up to `top` */
function liquidNear (lookup: BlockLookup, bottom: Vec3, top: Vec3, reach: number): boolean {
  for (let y = bottom.y - reach; y <= top.y; y++) {
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const b = lookup(new Vec3(top.x + dx, y, top.z + dz))
        if (b != null && LIQUIDS.has(b.name)) return true
      }
    }
  }
  return false
}

/** Shut in: the cells of the body open, solid over the head, under the feet and all round. */
export function isEnclosed (lookup: BlockLookup, feet: Vec3): boolean {
  const f = feet.floored()
  const head = f.offset(0, 1, 0)
  const open = (b: BlockView | null): boolean => b != null && PASSABLE_IN_HOLE.has(b.name)
  if (!open(lookup(f)) || !open(lookup(head))) return false
  if (!isSolid(lookup(f.offset(0, -1, 0))) || !isSolid(lookup(head.offset(0, 1, 0)))) return false
  return CARDINALS.every(side => isSolid(lookup(f.plus(side))) && isSolid(lookup(head.plus(side))))
}

/** solid blocks over the head that make the bot underground, not under a roof, a tree or an overhang */
export const UNDERGROUND_ROOF = 3
/** solid blocks over the head deep enough that the surface's monsters rarely find their way down to the bot */
export const DEEP_ROOF = 16
/** a dug passage (a staircase, a tunnel): at most this many open cells within NARROW_RADIUS of the feet; a cave has more */
export const NARROW_CELLS = 48
export const NARROW_RADIUS = 4

/** the solid blocks (leaves left out) in the column over the head, up to `max` cells up or the first unloaded one */
export function rockOverHead (lookup: BlockLookup, feet: Vec3, max = 64): number {
  const f = feet.floored()
  let n = 0
  for (let dy = 2; dy <= max; dy++) {
    const b = lookup(f.offset(0, dy, 0))
    if (b == null) break
    if (isSolid(b) && !/_leaves$/.test(b.name)) n++
  }
  return n
}

/**
 * The open cells joined to the feet within NARROW_RADIUS (a flood over the passable cells, liquids left out) number
 * NARROW_CELLS at most: a staircase or a tunnel the bot dug, not a cave the surface's monsters come down.
 */
export function inNarrowPassage (lookup: BlockLookup, feet: Vec3): boolean {
  const f = feet.floored()
  const seen = new Set<string>([vecKey(f)])
  const queue = [f]
  const open = (b: BlockView | null): boolean => b != null && b.boundingBox === 'empty' && !LIQUIDS.has(b.name)
  while (queue.length > 0) {
    const p = queue.pop() as Vec3
    for (const d of [...CARDINALS, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]) {
      const q = p.plus(d)
      if (Math.max(Math.abs(q.x - f.x), Math.abs(q.y - f.y), Math.abs(q.z - f.z)) > NARROW_RADIUS) continue
      const k = vecKey(q)
      if (seen.has(k) || !open(lookup(q))) continue
      seen.add(k)
      if (seen.size > NARROW_CELLS) return false
      queue.push(q)
    }
  }
  return true
}

/** a block light (a torch's) at the feet or the head: no monster spawns there (Monster.isDarkEnoughToSpawn, the overworld's limit 0) */
export function litAt (lookup: BlockLookup, feet: Vec3): boolean {
  const f = feet.floored()
  return [f, f.offset(0, 1, 0)].some(p => ((lookup(p) as any)?.light ?? 0) > 0)
}

/**
 * Below the surface where the night is work: UNDERGROUND_ROOF solid blocks over the head, and the bot lit (a torch's
 * light), in a passage it dug (inNarrowPassage), or DEEP_ROOF down. Down there the dark is the same day and night and
 * the surface's monsters don't come: the night's mining is the schedule, and a staircase's night spent in a shelter or
 * on a bed with no room cost a 26.3 whole game some 40000 ticks (run full-26.3-f).
 */
export function undergroundAtWork (lookup: BlockLookup, feet: Vec3): boolean {
  const rock = rockOverHead(lookup, feet)
  if (rock < UNDERGROUND_ROOF) return false
  return rock >= DEEP_ROOF || litAt(lookup, feet) || inNarrowPassage(lookup, feet)
}

/**
 * Ticks without rest at which a bot below the surface sleeps all the same: Stats.TIME_SINCE_REST, which brings the
 * phantoms (PhantomSpawner: a player under the open sky at night, at or over the sea level, from 72000), less a day,
 * so a bot that sleeps when it's due at a night's start is never out at night past 72000
 */
export const REST_DUE_TICKS = 48000

const restCounts = new WeakMap<Bot, { ticks: number }>()

/**
 * Counts Stats.TIME_SINCE_REST as the server does: up each tick the bot isn't asleep (ServerPlayer.tick), back to 0
 * when it lies down (ServerPlayer.startSleeping) or dies (ServerPlayer.die). Once per bot.
 */
export function countRest (bot: Bot): void {
  if (restCounts.has(bot)) return
  const count = { ticks: 0 }
  restCounts.set(bot, count)
  bot.on('physicsTick', () => { if (bot.isSleeping !== true) count.ticks++ })
  bot.on('sleep', () => { count.ticks = 0 })
  bot.on('death', () => { count.ticks = 0 })
}

/** the bot's ticks since it last slept or died (countRest), 0 uncounted */
export function ticksSinceRest (bot: Bot): number {
  return restCounts.get(bot)?.ticks ?? 0
}

/** sets the count (a bot that joined an old world: its stat; the tests) */
export function setTicksSinceRest (bot: Bot, ticks: number): void {
  countRest(bot)
  ;(restCounts.get(bot) as { ticks: number }).ticks = ticks
}

/**
 * DimensionType.timeOfDay: the sun's place in the sky (0 noon to 1) at a time of day (the day's ticks, 0 sunrise).
 */
export function celestialAngle (timeOfDay: number): number {
  const d = ((timeOfDay / 24000 - 0.25) % 1 + 1) % 1
  const e = 0.5 - Math.cos(d * Math.PI) / 2
  return (d * 2 + e) / 3
}

/** Level.updateSkyBrightness: how dark the sky is (0 - 11), with the rain and thunder levels (0 - 1) */
export function skyDarken (timeOfDay: number, rain = 0, thunder = 0): number {
  const r = 1 - rain * 5 / 16
  const t = 1 - thunder * 5 / 16
  const f = 0.5 + 2 * Math.max(-0.25, Math.min(0.25, Math.cos(celestialAngle(timeOfDay) * Math.PI * 2)))
  return Math.floor((1 - f * r * t) * 11)
}

/**
 * Level.isBrightOutside (skyDarken under 4): zombies and skeletons burn in the open (Mob.isSunBurnTick), beds don't
 * work (BedBlock: Player.startSleepInBed's NOT_POSSIBLE_NOW); from about 23460 to 12540 in clear weather.
 */
export function isBrightOutside (timeOfDay: number, rain = 0, thunder = 0): boolean {
  return skyDarken(timeOfDay, rain, thunder) < 4
}

export function botIsBrightOutside (bot: Bot): boolean {
  const b = bot as any
  return isBrightOutside(bot.time.timeOfDay, b.rainState ?? (bot.isRaining ? 1 : 0), b.thunderState ?? 0)
}

export type NightPlan = 'sleep' | 'fight' | 'shelter'

export interface NightPlanOptions {
  /** armor points worn or carried, at least, to stay out and fight (default 10: a set of chain or gold, most of iron) */
  minArmor?: number
  /** a weapon's hit at least this (default 6: an iron sword; a stone one deals 5) */
  minDamage?: number
}

/** the armor points of the best piece per slot among the worn and carried ones */
export function armorPoints (bot: Bot): number {
  const best: Record<string, number> = {}
  const slots = [5, 6, 7, 8].map(i => bot.inventory.slots[i])
  for (const item of [...slots, ...bot.inventory.items()]) {
    if (item == null) continue
    const piece = armorPiece(item.name)
    if (piece != null) best[piece.slot] = Math.max(best[piece.slot] ?? 0, piece.defense)
  }
  return Object.values(best).reduce((a, b) => a + b, 0)
}

/** the hit of the best weapon carried */
export function bestHitDamage (bot: Bot): number {
  return Math.max(hitDamage(null), ...bot.inventory.items().map(item => hitDamage(item)))
}

/** A bed in the bag or one placed nearby: sleep; good gear: stay out and fight; else dig in. */
export function nightPlan (bot: Bot, opts: NightPlanOptions & { bedNearby?: boolean } = {}): NightPlan {
  if (opts.bedNearby === true || bot.inventory.items().some(i => isBed(i.name))) return 'sleep'
  if (armorPoints(bot) >= (opts.minArmor ?? 10) && bestHitDamage(bot) >= (opts.minDamage ?? 6) && canHoldOut(bot)) return 'fight'
  return 'shelter'
}

/** the health a night out is fought at no lower, when it doesn't come back (canHoldOut) */
export const NIGHT_FIGHT_HEALTH = 10

/**
 * Whether the bot holds out a night's fights: health over NIGHT_FIGHT_HEALTH, or health that comes back (the food bar
 * at 18 or more heals, FoodData.tick's naturalRegeneration, or food carried to fill it). Full iron and a diamond
 * sword went exploring for melons at 3 health, its food bar at 6 and nothing to eat, at midnight: two skeleton arrows
 * (full-26.3-fresh-l)
 */
export function canHoldOut (bot: Bot): boolean {
  if ((bot.health ?? 20) > NIGHT_FIGHT_HEALTH) return true
  if ((bot.food ?? 20) >= 18) return true
  return bestFoodInInventory(bot) != null
}

export interface ShelterOptions {
  signal?: AbortSignal
  /** how far to look for a column to dig (default 8) */
  radius?: number
  /** come out once this holds (default leaveAtDay: bright outside and no hostile within 8 blocks, or 2400 ticks of day) */
  until?: () => boolean
  /** ticks to stay at most (default 14000: a night and then some) */
  maxTicks?: number
  /** eat at or below this food level while waiting (default 14) */
  eatAt?: number
  /** put up a torch inside when there's one (default true) */
  torch?: boolean
  /** come out at the end (default true) */
  leave?: boolean
}

export interface ShelterResult {
  /** where the feet were in the hole */
  feet: Vec3
  /** a new hole dug (false: the bot was in one already) */
  dug: boolean
  /** ticks spent in the hole */
  ticks: number
  eaten: number
  /** out on the surface again */
  left: boolean
}

function blockLookup (bot: Bot): BlockLookup {
  return (pos) => bot.blockAt(pos) as BlockView | null
}

/** a full, non-falling block from the inventory to seal with, the preferred ones first */
export function sealItem (bot: Bot): string | null {
  const items = bot.inventory.items()
  for (const name of SEAL_PREFERRED) if (items.some(i => i.name === name)) return name
  const other = items.find(i => {
    const block = (bot.registry.blocksByName as any)[i.name]
    return block != null && block.boundingBox === 'block' && !GRAVITY_BLOCKS.test(i.name) && !/(table|furnace|chest|bed|_ore|tnt|shulker|barrel|log|wood|stem|hyphae|leaves|glass|ice)$/.test(i.name)
  })
  return other?.name ?? null
}

async function equipFor (bot: Bot, block: Block): Promise<void> {
  // the quickest tool in the bag (mineflayer's digTime with each in hand); the hand when nothing beats it
  let best: any = null
  let bestTime = bot.digTime(block)
  const held = bot.heldItem
  for (const item of bot.inventory.items()) {
    if (!/_(shovel|pickaxe|axe)$/.test(item.name)) continue
    const t = (block as any).digTime(item.type, false, false, false, [], [])
    if (t < bestTime) { best = item; bestTime = t }
  }
  if (best != null && held?.type !== best.type) await bot.equip(best, 'hand')
}

/** standing on leaves or a log: up a tree */
function onTree (bot: Bot): boolean {
  const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0).floored())?.name ?? ''
  return /(_leaves|_log|_wood|vine|_stem)$/.test(below) || below === 'mangrove_roots'
}

/**
 * Down from a tree to the ground: the leaves and logs under the feet dug one after the other, the bot dropping into
 * each hole (a fall of more than 3 blocks hurts: LivingEntity.calculateFallDamage); done on the first natural ground.
 */
async function climbDownTree (bot: Bot, signal?: AbortSignal): Promise<void> {
  for (let guard = 0; guard < 40 && onTree(bot); guard++) {
    throwIfAborted(signal)
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    if (below == null) break
    if (below.boundingBox === 'block' || /vine/.test(below.name)) {
      await equipFor(bot, below)
      await dig(bot, below, { signal })
    }
    await waitUntil(bot, () => bot.entity.onGround && Math.floor(bot.entity.position.y + 1e-6) < feet.y, 60, signal)
  }
}

/** onto the middle of the cell, sneaking the last of the way (slow enough to stop on it, and never off an edge) */
async function centreOn (bot: Bot, centre: Vec3, signal?: AbortSignal): Promise<void> {
  try {
    await waitUntil(bot, () => {
      const p = bot.entity.position
      const d = Math.hypot(centre.x - p.x, centre.z - p.z)
      const v = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z)
      if (d < 0.12 && v < 0.02) return true
      if (d < 0.12) {
        bot.clearControlStates()
        return false
      }
      void bot.look(Math.atan2(-(centre.x - p.x), -(centre.z - p.z)), bot.entity.pitch, true)
      bot.setControlState('forward', true)
      // (sneaking all the way: no step off an edge by the column, a cliff's)
      bot.setControlState('sneak', true)
      return false
    }, 80, signal)
  } finally {
    bot.clearControlStates()
  }
}

/**
 * Why the next dig down from `feet` in the shelter's column at `column` (x, z) to `toY` isn't safe, or null: the
 * bot's feet out of the column (a centring that fell short: the ground under them not the column's looked over), or
 * no solid ground in the column between the block to dig and the planned floor (a cave opened under it since: the dig
 * would drop the bot into it).
 */
export function digDownHazard (lookup: BlockLookup, feet: Vec3, column: { x: number, z: number }, toY: number): string | null {
  if (feet.x !== column.x || feet.z !== column.z) return `the feet at ${feet.toString()} are out of the column at ${column.x}, ${column.z}`
  const under = feet.offset(0, -1, 0)
  // the bot lands on the first solid block under the one dug: at the floor (toY - 1) or above it
  for (let y = under.y - 1; y >= toY - 1; y--) if (isSolid(lookup(new Vec3(feet.x, y, feet.z)))) return null
  return `no ground under ${under.toString()} down to the floor at y ${toY - 1}`
}

async function digBelow (bot: Bot, toY: number, signal?: AbortSignal, column?: { x: number, z: number }): Promise<void> {
  const lookup = blockLookup(bot)
  for (let guard = 0; guard < 10 && Math.floor(bot.entity.position.y + 1e-6) > toY; guard++) {
    throwIfAborted(signal)
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    if (below == null) throw new SkillError('NOT_FOUND', 'the block below is unloaded')
    // no dig out of the column, nor one into a cave under it (the bot would fall in)
    const hazard = below.boundingBox === 'block' && column != null ? digDownHazard(lookup, feet, column, toY) : null
    if (hazard != null) { trace('shelter: no dig down at', feet.toString(), hazard); throw new SkillError('CANNOT_PLACE', `no shelter dug down here: ${hazard}`) }
    if (below.boundingBox === 'block') {
      await equipFor(bot, below)
      await dig(bot, below, { signal })
    }
    await waitUntil(bot, () => bot.entity.onGround && Math.floor(bot.entity.position.y + 1e-6) < feet.y, 20, signal)
  }
  if (Math.floor(bot.entity.position.y + 1e-6) !== toY) throw new SkillError('VERIFY_FAILED', `the feet are at y ${bot.entity.position.y.toFixed(2)}, not ${toY}`)
}

/** places a block of `item` at pos against a solid side (pos is above the head: no navigation) */
async function placeAgainstSide (bot: Bot, pos: Vec3, item: string, signal?: AbortSignal): Promise<void> {
  const lookup = blockLookup(bot)
  const sides = [new Vec3(0, 1, 0), ...CARDINALS]
  const against = sides.map(s => pos.plus(s)).find(p => isSolid(lookup(p)))
  if (against == null) throw new SkillError('CANNOT_PLACE', `nothing solid next to ${pos.toString()}`)
  const it = bot.inventory.items().find(i => i.name === item)
  if (it == null) throw new SkillError('MISSING_ITEMS', `no ${item}`)
  if (bot.heldItem?.type !== it.type) await bot.equip(it, 'hand')
  try {
    await bot.placeBlock(bot.blockAt(against) as Block, pos.minus(against))
  } catch (err) {
    if (!isSolid(lookup(pos))) throw new SkillError('CANNOT_PLACE', `sealing ${pos.toString()} failed: ${(err as Error).message}`, undefined, { cause: err })
  }
  if (!await waitUntil(bot, () => isSolid(lookup(pos)), 10, signal)) throw new SkillError('VERIFY_FAILED', `${pos.toString()} is still open`)
}

/** a torch on a wall at head height (the wall torch's cell is the head's: no collision, the server lets it in) */
async function putUpTorch (bot: Bot, head: Vec3): Promise<boolean> {
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (torch == null) return false
  const lookup = blockLookup(bot)
  const side = CARDINALS.find(s => isSolid(lookup(head.plus(s))))
  if (side == null) return false
  try {
    await bot.equip(torch, 'hand')
    await bot.placeBlock(bot.blockAt(head.plus(side)) as Block, side.scaled(-1))
    return true
  } catch {
    return /torch/.test(bot.blockAt(head)?.name ?? '')
  }
}

/** a living hostile within distance */
function hostileNear (bot: Bot, distance: number): boolean {
  const pos = bot.entity.position
  return Object.values(bot.entities).some(e => e !== bot.entity && (bot.registry.entitiesByName as any)[e.name ?? '']?.type === 'hostile' &&
    isAlive(bot, e) && e.position.distanceTo(pos) <= distance)
}

/**
 * When to come out: the sky bright (the undead burn) and no hostile within `distance`, or `maxWait` ticks of daylight
 * gone by (a creeper that sits by the hole all morning). A zombie burning on the roof still hits: one with a spear
 * (1.21.11) took the bot from 20 to 0 as it climbed out at sunrise.
 */
export function leaveAtDay (bot: Bot, opts: { distance?: number, maxWait?: number } = {}): () => boolean {
  let brightSince: number | null = null
  return () => {
    if (!botIsBrightOutside(bot)) { brightSince = null; return false }
    const now = bot.time.timeOfDay
    brightSince = brightSince ?? now
    const bright = (now - brightSince + 24000) % 24000
    return bright >= (opts.maxWait ?? 2400) || !hostileNear(bot, opts.distance ?? 8)
  }
}

/**
 * Digs a 1x2 hole into the ground near the bot (SHELTER_DEPTH blocks straight down), seals it over the head with a
 * block and puts up a torch, waits there eating as it needs until the day, and pillars back out. A bot already in a
 * hole like that just waits.
 */
export async function shelter (bot: Bot, opts: ShelterOptions = {}): Promise<ShelterResult> {
  sheltering.set(bot, (sheltering.get(bot) ?? 0) + 1)
  try {
    return await shelterOnce(bot, opts)
  } finally {
    const n = (sheltering.get(bot) ?? 1) - 1
    if (n <= 0) sheltering.delete(bot)
    else sheltering.set(bot, n)
  }
}

/** whether the bot's feet or head are in water (its body in a lake, a river, a flooded hole) */
function inWaterNow (bot: Bot): boolean {
  if ((bot.entity as any)?.isInWater === true) return true
  const p = bot.entity.position
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-6), Math.floor(p.z))
  return [feet, feet.offset(0, 1, 0)].some(c => { const n = bot.blockAt(c)?.name; return n === 'water' || n === 'bubble_column' })
}

/** the shelter() calls running for each bot (a task's own way out isn't raced by the night reflex's) */
const sheltering = new WeakMap<Bot, number>()

/**
 * A shelter() is running for the bot: it comes out of its hole by itself. The night reflex's 'leave shelter' fired
 * at a 'wait out the night' task climbing out at sunrise, and the two climbs cut each other's digs off ('Digging
 * aborted', 26.3 full-26.3-m)
 */
export function shelterRunning (bot: Bot): boolean {
  return (sheltering.get(bot) ?? 0) > 0
}

async function shelterOnce (bot: Bot, opts: ShelterOptions): Promise<ShelterResult> {
  const signal = opts.signal
  const lookup = blockLookup(bot)
  const eatAt = opts.eatAt ?? 14
  const maxTicks = opts.maxTicks ?? 14000
  const until = opts.until ?? leaveAtDay(bot)
  throwIfAborted(signal)

  let feet = bot.entity.position.floored()
  let dug = false
  // by day there's no night to wait out: no hole dug, only the way out of one the bot is still down. A 26.3 bot's
  // 'wait out the night' task (a respawn far from its trip kit) was preempted by the night reflex and resumed by day,
  // dug a new hole each time, was preempted again as it climbed out, and spent 4 days (431 tries) in the ground, its
  // food down to 6 and its health to 4, till a pillager patrol shot it (full-26.3-m)
  if (!isEnclosed(lookup, feet) && botIsBrightOutside(bot)) {
    const left = opts.leave !== false && shelterToLeave(bot) != null
    if (left) await leaveShelter(bot, signal)
    return { feet, dug: false, ticks: 0, eaten: 0, left }
  }
  if (!isEnclosed(lookup, feet)) {
    // in the water: out onto dry ground first (toShore), the shelter's column looked for from there, not a walk to it
    // through the water that sinks the bot (a 1.21.11 bot in the water at night had the night reflex's shelter after
    // each surfacing take it under again, the drowning reflex 422 times in a game, 129 of them just after a shelter's
    // start, in turns 20 ticks apart: f5-1.21.11, t358863 to t359056)
    if (inWaterNow(bot)) {
      const { toShore } = await import('../executor/explore')
      if (!(await toShore(bot, signal))) throw new SkillError('NOT_FOUND', 'in the water with no shore near to dig a shelter by')
      feet = bot.entity.position.floored()
    }
    const hasPickaxe = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
    const digCost = defaultDigCost(hasPickaxe)
    // the hole the bot is in already (cut off before the seal went on), else the best column about
    let target: ShelterSpot | null = null
    for (let d = 0; d <= SHELTER_DEPTH && target == null; d++) target = shelterAt(lookup, feet.offset(0, d, 0), digCost, true)
    // up a tree (a spawn on a jungle's canopy): down through the leaves to the ground first
    if (target == null && onTree(bot)) await climbDownTree(bot, signal)
    const exclude = new Set<string>()
    for (let tries = 0; ; tries++) {
      // (none where the bot drowned lately: another spot 8 off and more, skills/breath drownedNear)
      target = target ?? findShelterSpot(lookup, bot.entity.position, { radius: opts.radius, digCost, exclude, avoid: p => drownedNear(bot, p) })
      if (target == null) throw new SkillError('NOT_FOUND', 'no ground to dig a shelter in nearby')
      const t = target
      const inColumn = Math.floor(bot.entity.position.x) === t.surface.x && Math.floor(bot.entity.position.z) === t.surface.z &&
        Math.floor(bot.entity.position.y + 1e-6) <= t.surface.y && Math.floor(bot.entity.position.y + 1e-6) >= t.feet.y
      if (inColumn) break
      try {
        await navigate(bot, { goal: new goals.GoalBlock(t.surface.x, t.surface.y, t.surface.z) }, signal)
        break
      } catch (err) {
        // can't get there: the next best column, three times
        if (isAbort(err) || tries >= 2) throw err
        exclude.add(vecKey(t.surface))
        target = null
      }
    }
    const centre = target.surface.offset(0.5, 0, 0.5)
    trace('shelter: the column at', target.surface.toString(), 'down to', target.feet.toString(), 'from', bot.entity.position.toString())
    // the body inside the column's cell (0.6 wide in a 1 wide hole), or it stays up on the rim
    await centreOn(bot, centre, signal)
    await digBelow(bot, target.feet.y, signal, target.surface)
    await waitUntil(bot, () => bot.entity.onGround, 20, signal)
    // the dug blocks' drops fall in with the bot (ItemEntity's 10 ticks of pickup delay)
    await waitUntil(bot, () => sealItem(bot) != null, 40, signal)
    const item = sealItem(bot)
    if (item == null) throw new SkillError('MISSING_ITEMS', 'no block to seal the shelter with')
    if (!isSolid(lookup(target.seal))) await placeAgainstSide(bot, target.seal, item, signal)
    if (opts.torch !== false) await putUpTorch(bot, target.feet.offset(0, 1, 0))
    feet = target.feet
    dug = true
    if (!isEnclosed(lookup, feet)) throw new SkillError('VERIFY_FAILED', `the hole at ${feet.toString()} isn't shut`)
    // and dry, shut: water come in (a crack to an aquifer) is no shelter, the spot kept off (drownedNear)
    if ([feet, feet.offset(0, 1, 0)].some(c => LIQUIDS.has(lookup(c)?.name ?? ''))) {
      noteDrowning(bot, feet)
      throw new SkillError('VERIFY_FAILED', `the shelter at ${feet.toString()} has water in it`)
    }
  }

  rememberShelter(bot, feet.offset(0, SHELTER_DEPTH, 0))
  let ticks = 0
  let eaten = 0
  const seal = feet.offset(0, 2, 0)
  while (!until()) {
    throwIfAborted(signal)
    if (ticks >= maxTicks) break
    if (bot.food <= eatAt && bestFoodInInventory(bot) != null) {
      await eat(bot, { signal })
      eaten++
    }
    // an enderman took the seal, or a creeper blew it off: shut it again
    if (!isSolid(lookup(seal))) {
      const item = sealItem(bot)
      if (item != null) await placeAgainstSide(bot, seal, item, signal).catch(() => {})
    }
    await waitUntil(bot, () => false, 20, signal)
    ticks += 20
  }

  let left = false
  if (opts.leave !== false) {
    await leaveShelter(bot, signal)
    left = true
  }
  return { feet, dug, ticks, eaten, left }
}

/** the surface cell of the shelter each bot is in (or was cut off climbing out of) */
const sheltered = new WeakMap<Bot, Vec3>()

/** the shelter the bot is in, by the surface cell over its column */
export function rememberShelter (bot: Bot, surface: Vec3): void {
  sheltered.set(bot, surface.floored())
}

/** The surface cell over the bot when it's still down its shelter's column (a fight cut it off on its way out), else null. */
export function shelterToLeave (bot: Bot): Vec3 | null {
  const surface = sheltered.get(bot)
  if (surface == null) return null
  const p = bot.entity.position
  if (Math.floor(p.x) !== surface.x || Math.floor(p.z) !== surface.z || Math.floor(p.y + 1e-6) >= surface.y) {
    sheltered.delete(bot)
    return null
  }
  return surface
}

/** Out of the shelter's column up to the surface (pillared on the dug blocks, else the pathfinder's way). */
export async function leaveShelter (bot: Bot, signal?: AbortSignal): Promise<void> {
  const surface = shelterToLeave(bot)
  if (surface == null) return
  await climbOut(bot, surface, signal)
  sheltered.delete(bot)
}

/** out of the hole to its surface cell: pillared up on the dug blocks (the seal's among them), else the pathfinder's way (it digs stairs) */
async function climbOut (bot: Bot, surface: Vec3, signal?: AbortSignal): Promise<void> {
  const seal = bot.blockAt(surface.offset(0, -1, 0))?.name ?? ''
  const blocks = countItems(bot, SCAFFOLD_ITEMS) + (SCAFFOLD_ITEMS.includes(seal) ? 1 : 0)
  const needed = surface.y - Math.floor(bot.entity.position.y + 1e-6)
  // the torch back first: a block can't go up into its cell (it isn't replaceable, BlockBehaviour.canBeReplaced)
  for (let dy = 0; dy <= 1; dy++) {
    const cell = bot.blockAt(bot.entity.position.floored().offset(0, dy, 0))
    if (cell != null && /torch/.test(cell.name)) await dig(bot, cell, { signal }).catch(() => {})
  }
  if (blocks >= needed) {
    try {
      // the seal first: its block is one to pillar with (towerUp counts the bag's)
      const over = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0))
      if (over != null && over.boundingBox === 'block') {
        const had = countItems(bot, SCAFFOLD_ITEMS)
        await equipFor(bot, over)
        await dig(bot, over, { signal })
        await waitUntil(bot, () => countItems(bot, SCAFFOLD_ITEMS) > had, 40, signal)
      }
      await towerUp(bot, surface.y, { signal })
      return
    } catch (err) {
      trace('shelter: no pillar out:', (err as Error).message)
      throwIfAborted(signal)
    }
  }
  // a few blocks off the hole, on the surface
  await navigate(bot, { goal: new goals.GoalNear(surface.x + 3, surface.y, surface.z, 2), reached: () => bot.entity.position.y >= surface.y - 1.01 }, signal)
}

/** The nearest cell within radius to stand in with room for a bed beside it (findBedPlacement), or null. */
export function roomForBed (lookup: BlockLookup, from: Vec3, radius: number): Vec3 | null {
  const start = from.floored()
  let best: Vec3 | null = null
  let bestD = Infinity
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const pos = start.offset(dx, dy, dz)
        const d = Math.hypot(dx, dz) + Math.abs(dy)
        if (d >= bestD) continue
        if (!isOpen(lookup(pos)) || !isOpen(lookup(pos.offset(0, 1, 0))) || !isSolid(lookup(pos.offset(0, -1, 0)))) continue
        if (findBedPlacement(lookup, pos.offset(0.5, 0, 0.5)) == null) continue
        best = pos
        bestD = d
      }
    }
  }
  return best
}

/** Player.startSleepInBed's check: the monsters (Monster.isPreventingPlayerRest) within 8 blocks across and 5 up or down of the bed, nearest first */
export function monstersPreventingRest (bot: Bot, bed: Vec3): Array<Bot['entities'][string]> {
  const c = bed.offset(0.5, 0, 0.5)
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && (bot.registry.entitiesByName as any)[e.name ?? '']?.type === 'hostile' && isAlive(bot, e) &&
      Math.abs(e.position.x - c.x) <= 8 && Math.abs(e.position.z - c.z) <= 8 && Math.abs(e.position.y - c.y) <= 5)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

export interface SleepThroughNightOptions {
  signal?: AbortSignal
  bedDistance?: number
  /** tries before giving up on the monsters (default 6) */
  tries?: number
  /**
   * with no room for the bed about, dig it out beside the bot (bedRoomToDig: the bed's two cells and the head room
   * over them), as below the surface, where the cells about a 1-wide staircase or tunnel are rock (default false)
   */
  digRoom?: boolean
  /**
   * the monsters that keep the bot from resting fought (default true); false, the sleep refused (REFUSED) at the first
   * of them: a bot with its fists only, which loses to a zombie (the hostiles reflex's unarmedOutmatched)
   */
  fight?: boolean
}

/**
 * Digs the room for a bed out beside the bot (bedRoomToDig), each block with the quickest tool carried; whether there
 * was a way to.
 */
export async function digBedRoom (bot: Bot, signal?: AbortSignal): Promise<boolean> {
  const room = bedRoomToDig(blockLookup(bot), bot.entity.position)
  trace('digBedRoom: from', bot.entity.position.floored().toString(), room == null ? 'no room to dig' : `foot ${room.foot.toString()} facing ${room.facing.toString()} dig ${room.dig.length}`)
  if (room == null) return false
  for (const cell of room.dig) {
    throwIfAborted(signal)
    const block = bot.blockAt(cell)
    if (block == null || block.boundingBox !== 'block') continue
    await equipFor(bot, block)
    await dig(bot, block, { signal })
  }
  return room.dig.every(cell => bot.blockAt(cell)?.boundingBox !== 'block')
}

/**
 * Sleeps through the night (a bed nearby or from the bag, taken back after), handling the monsters that keep it from
 * resting first ("You may not rest now; there are monsters nearby"): the nearest of them fought, then the bed again.
 */
export async function sleepThroughNight (bot: Bot, opts: SleepThroughNightOptions = {}): Promise<{ slept: boolean, fought: number }> {
  const signal = opts.signal
  let fought = 0
  let last: unknown = null
  let moved = false
  let ownBed = false
  const fightOff = async (monster: Bot['entities'][string]): Promise<void> => {
    if (opts.fight === false) throw new SkillError('REFUSED', `a ${monster.name ?? 'monster'} by the bed, not fought`)
    await fight(bot, monster, { signal, maxTicks: 600 }).catch((e) => { if (isAbort(e)) throw e })
    fought++
  }
  for (let attempt = 0; attempt < (opts.tries ?? 6); attempt++) {
    throwIfAborted(signal)
    // the ones the server will see first (the bed goes next to the bot), fought before the bed goes down rather than
    // after bot.sleep rejects with the server's refusal ("You may not rest now")
    const near = monstersPreventingRest(bot, bot.entity.position.floored())[0]
    if (near != null) {
      await fightOff(near)
      continue
    }
    // on the ground first: the bed goes beside the feet (a crit jump of the fight before left them in the air)
    await waitUntil(bot, () => bot.entity.onGround, 40, signal)
    try {
      await sleep(bot, { pickUpBed: true, bedDistance: opts.bedDistance, nearby: !ownBed }, signal)
      return { slept: true, fought }
    } catch (err) {
      trace('sleepThroughNight: try', attempt, (err as Error).message)
      // no room for the bed here (up a tree, in a corner): down to the ground, or a few steps to where there is, once;
      // below the surface (digRoom), dug out beside the bot
      if (isSkillError(err, 'CANNOT_PLACE') && !moved) {
        moved = true
        if (onTree(bot)) {
          await climbDownTree(bot, signal)
        } else if (opts.digRoom === true && await digBedRoom(bot, signal)) {
          // (the bed goes into the room from where the bot stands)
        } else {
          const room = roomForBed((pos) => bot.blockAt(pos) as BlockView | null, bot.entity.position, 8)
          if (room == null) throw err
          await navigate(bot, { goal: new goals.GoalBlock(room.x, room.y, room.z) }, signal)
        }
        continue
      }
      // a bed standing nearby that won't do (one it can't get to, one it can't click): its own from the bag, once
      if (!ownBed && !/monsters|not sleeping/i.test((err as Error).message) && bot.inventory.items().some(i => isBed(i.name))) {
        ownBed = true
        continue
      }
      if (!isSkillError(err, 'REFUSED')) throw err
      last = err
      const bed = (err.partial as any)?.bed as Vec3 | undefined
      const monster = bed != null ? monstersPreventingRest(bot, bed)[0] : undefined
      if (monster != null) {
        await fightOff(monster)
      } else if (/monsters|not sleeping/i.test((err as Error).message)) {
        // the server sees one the bot doesn't (in a cave under the bed): give it a moment
        await waitUntil(bot, () => false, 60, signal)
      } else {
        throw err
      }
    }
  }
  throw new SkillError('REFUSED', `monsters kept the bot from sleeping: ${(last as Error)?.message ?? ''}`)
}
