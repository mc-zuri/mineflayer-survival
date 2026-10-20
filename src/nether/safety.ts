// Nether safety: pathfinder rules that keep the bot off lava edges, magma and ledges over deadly falls and out of lava
// flows, never bridge over lava (a guarded bridge does that), and leave piglins' gold alone; one gold armor piece worn
// for the piglins; ghast fireballs punched back.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { MovementOptions } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { craft } from '../skills/craft'
import { placeBlock } from '../skills/placeBlock'
import { walkTo } from '../skills/navigate'
import { countItems, findInventoryItem, settleInventory, trace, waitTicks } from '../skills/util'
import { type Entity, distanceToBox, entityBox, eyePosition, hasLineOfSight, isAlive, yawPitchOf } from '../skills/combatUtil'
import { attackStrengthOf, bestMeleeWeapon } from '../skills/weapons'
import { ArrowGuard, isUsingItem, lowerShield, raiseShield } from '../skills/fight'
import { shoot } from '../skills/shoot'
import { requireGoldArmor } from '../skills/armor'
import type { Pos } from '../core/memory'
import { NETHER_DEATH_COST, nearDeath } from './deaths'

export { NETHER_DEATHS_KEPT, NETHER_DEATH_COST, NETHER_DEATH_RADIUS, nearDeath, rememberNetherDeath } from './deaths'

export { requireGoldArmor, goldArmorRequired } from '../skills/armor'

/** the pathfinder's COST_INF: a cost this high forbids the step, break or place */
export const FORBID = 1000000

/**
 * blocks piglins guard: PiglinAi.angerNearbyPiglins fires when a player breaks one (BlockTags.GUARDED_BY_PIGLINS, the
 * same in 1.21.11 and 26.3) or opens a container
 */
export const PIGLIN_GUARDED = new Set([
  'gold_block', 'gilded_blackstone', 'nether_gold_ore', 'deepslate_gold_ore', 'gold_ore', 'raw_gold_block', 'chest', 'trapped_chest', 'barrel', 'ender_chest',
  ...['', 'exposed_', 'weathered_', 'oxidized_'].flatMap(age => [`${age}copper_chest`, `waxed_${age}copper_chest`]),
  'shulker_box', ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(c => `${c}_shulker_box`)
])
/** PiglinAi: a piglin within 16 blocks sees the player break or open what it guards */
export const PIGLIN_ANGER_RANGE = 16
export const PIGLINS = new Set(['piglin', 'piglin_brute'])

export interface NetherSafetyOptions {
  /** blocks between the bot and lava sideways, at its feet or head, it keeps (default 1: never next to it) */
  lavaGap?: number
  /** extra cost of a step within 2 blocks of lava (default 40 ticks) */
  nearLavaCost?: number
  /** forbid breaking piglin-guarded blocks when a piglin is near (default true) */
  piglins?: boolean
  /**
   * the pathfinder's edgeHazardCost: ticks on top for each side of a cell the path ends a move in with a deadly fall
   * beside it (default 6, a half more than the pathfinder's: the nether's falls end in the lava sea or a delta's lava
   * pockets. 16 widened the searches over the open caverns round a fortress, its bridges all edges, until they timed out
   * one after another and the bot never got to the spawner, on three 26.3 runs out of five)
   */
  edgeCost?: number
  /** a higher cost near the nether's deaths remembered (rememberNetherDeath) (default true) */
  avoidDeaths?: boolean
  /**
   * blocks under the floor a step keeps lava away from (default 0: the floor itself only): a lake's obsidian lid is a
   * floor with lava under it, and mining it from on top dropped a 26.3 bot into the lava (obsidianFromLava's 3)
   */
  lavaBelow?: number
  /**
   * ticks on top for each cell a path stands in over NETHER_HIGH_Y (default 12): up in the rock under the nether's
   * roof, where the deadly edges are none, a path tunnels along well, and the way back down to anything (a fortress's
   * decks at 48 to 70, the portal) is a drop into the caverns under it
   */
  highCost?: number
}

/** the height over which a nether path's cells cost more (highCost): the rock under the roof (bedrock from 123) */
export const NETHER_HIGH_Y = 100

interface BlockInfoLike { position: Vec3, type: number }

/** the block's state ids, first and last (minecraft-data's minStateId, maxStateId) */
function stateRange (bot: Bot, name: string): [number, number] {
  const b: any = bot.registry.blocksByName[name]
  return b == null ? [-1, -2] : [b.minStateId, b.maxStateId]
}

/** whether there's lava within `r` blocks sideways of the cell, at the cell's height and the one above (the bot's body) */
export function lavaBeside (isLava: (pos: Vec3) => boolean, cell: Vec3, r: number): boolean {
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx === 0 && dz === 0) continue
        if (isLava(cell.offset(dx, dy, dz))) return true
      }
    }
  }
  return false
}

/** whether breaking the block lets lava in: lava above it or beside it (FlowingFluid spreads into the hole) */
export function lavaAgainst (isLava: (pos: Vec3) => boolean, cell: Vec3): boolean {
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) if (isLava(cell.offset(dx, dy, dz))) return true
  return false
}

/** whether placing in the cell bridges over lava: lava under it, down to 4 blocks */
export function overLava (isLava: (pos: Vec3) => boolean, isAir: (pos: Vec3) => boolean, cell: Vec3, depth = 4): boolean {
  for (let dy = 1; dy <= depth; dy++) {
    const p = cell.offset(0, -dy, 0)
    if (isLava(p)) return true
    if (!isAir(p)) return false
  }
  return false
}

/** a cell's kind for the nether's rules (NetherCellKinds) */
export const CELL_LAVA = 1
export const CELL_MAGMA = 2
export const CELL_AIR = 4
const CELL_UNREAD = 0x80

/** a cell's key: x and z to 20 bits (wrapped), y to 12 */
function cellKey (x: number, y: number, z: number): number {
  return ((x & 0xfffff) * 0x100000 + (z & 0xfffff)) * 0x1000 + ((y + 2048) & 0xfff)
}

/**
 * The cells' kinds (lava, magma, air) for the nether's rules, kept by 16³ section and each cell read once from its
 * column's state id until clear(): the A* asks about each cell many times (a step's lava round it is 50 cells, its
 * neighbours' the same cells again). A cell where the world has no column is none of them, and not kept.
 */
export class NetherCellKinds {
  private readonly kindByState: Uint8Array
  private readonly sections = new Map<number, { cells: Uint8Array, column: any }>()
  private lastKey = NaN
  private last: { cells: Uint8Array, column: any } | undefined
  private readonly local = new Vec3(0, 0, 0)

  constructor (private readonly bot: Bot) {
    let max = 0
    for (const b of bot.registry.blocksArray as any[]) if (typeof b.maxStateId === 'number') max = Math.max(max, b.maxStateId)
    this.kindByState = new Uint8Array(max + 1)
    const mark = (name: string, kind: number): void => {
      const [a, b] = stateRange(bot, name)
      if (a >= 0) this.kindByState.fill(kind, a, b + 1)
    }
    mark('lava', CELL_LAVA)
    mark('magma_block', CELL_MAGMA)
    for (const n of ['air', 'cave_air', 'void_air']) mark(n, CELL_AIR)
  }

  clear (): void {
    this.sections.clear()
    this.lastKey = NaN
    this.last = undefined
  }

  kindAt (x: number, y: number, z: number): number {
    const world = this.bot.world as any
    if (typeof world?.getColumnAt !== 'function') {
      // (a world without columns, the unit tests' fake ones)
      const s = world?.getBlockStateId?.(new Vec3(x, y, z))
      return s == null ? 0 : this.kindByState[s] ?? 0
    }
    const key = (((x >> 4) & 0xfffff) * 0x100000 + ((z >> 4) & 0xfffff)) * 0x100 + (((y >> 4) + 128) & 0xff)
    let section = key === this.lastKey ? this.last : this.sections.get(key)
    if (section == null) {
      const column = world.getColumnAt(this.local.set(x, y, z))
      if (column == null) return 0
      section = { cells: new Uint8Array(4096).fill(CELL_UNREAD), column }
      this.sections.set(key, section)
    }
    this.lastKey = key
    this.last = section
    const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15)
    let kind = section.cells[i]
    if (kind === CELL_UNREAD) {
      kind = this.kindByState[section.column.getBlockStateId(this.local.set(x & 15, y, z & 15))] ?? 0
      section.cells[i] = kind
    }
    return kind
  }

  isLava (x: number, y: number, z: number): boolean {
    return this.kindAt(x, y, z) === CELL_LAVA
  }

  /** lavaBeside, by the kinds kept */
  lavaBeside (x: number, y: number, z: number, r: number): boolean {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if ((dx !== 0 || dz !== 0) && this.kindAt(x + dx, y + dy, z + dz) === CELL_LAVA) return true
        }
      }
    }
    return false
  }
}

/**
 * The pathfinder's movement settings for the nether: exclusion areas (the pathfinder's own hook) that forbid
 * standing next to lava or on magma, breaking a block lava rests against, placing a block over lava (the
 * pathfinder's bridges have no rails: bridgeOverLava does), and breaking what piglins guard while one is near; and a
 * high cost on a ledge's edge (edgeHazardCost), so that the path keeps to the inner side or tunnels, and near where
 * the bot died.
 */
export function netherMoveSettings (bot: Bot, opts: NetherSafetyOptions = {}): Partial<MovementOptions> {
  const gap = opts.lavaGap ?? 1
  const nearCost = opts.nearLavaCost ?? 40
  const highCost = opts.highCost ?? 12
  const lavaBelow = opts.lavaBelow ?? 0
  // the A* asks about every cell it considers, many times: the answers are kept, and dropped every 100 ticks (lava
  // flows slowly, a bucket's lava or a broken block shows up then)
  const cells = new NetherCellKinds(bot)
  const stepCache = new Map<number, number>()
  let cachedAt = -1
  const fresh = (): void => {
    const tick = (bot as any).lockstep?.ticks ?? Math.floor(Date.now() / 50)
    if (tick - cachedAt > 100 || tick < cachedAt) { cells.clear(); stepCache.clear(); cachedAt = tick }
  }
  const isLava = (p: Vec3): boolean => cells.isLava(p.x, p.y, p.z)
  const isAir = (p: Vec3): boolean => cells.kindAt(p.x, p.y, p.z) === CELL_AIR
  // where the bot died in the nether: kept away from (rememberNetherDeath)
  const deaths: Pos[] = opts.avoidDeaths === false ? [] : (bot.survival?.memory?.getPois('nether_death', { dimension: 'the_nether' }) ?? [])
  const guarded = new Set([...PIGLIN_GUARDED].map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n != null))
  const fortress = new Set(FORTRESS_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n != null))
  let piglinCheckTick = -1
  let piglinNear = false
  const piglinsAbout = (): boolean => {
    const tick = (bot as any).lockstep?.ticks ?? Date.now()
    if (tick !== piglinCheckTick) {
      piglinCheckTick = tick
      piglinNear = Object.values(bot.entities).some(e => PIGLINS.has(e.name ?? '') && e.position.distanceTo(bot.entity.position) <= PIGLIN_ANGER_RANGE + 16)
    }
    return piglinNear
  }
  const step = (block: BlockInfoLike): number => {
    fresh()
    const { x, y, z } = block.position
    const key = cellKey(x, y, z)
    const known = stepCache.get(key)
    if (known != null) return known
    let cost = 0
    // (a magma block hurts a player standing on it who isn't sneaking, MagmaBlock.stepOn, and lies round the basalt
    // deltas' lava pockets)
    if (cells.isLava(x, y, z) || cells.isLava(x, y + 1, z) || cells.isLava(x, y - 1, z) || cells.lavaBeside(x, y, z, gap) || cells.kindAt(x, y - 1, z) === CELL_MAGMA) cost = FORBID
    else if (lavaBelow > 0 && Array.from({ length: lavaBelow }, (_, i) => y - 2 - i).some(ly => cells.isLava(x, ly, z))) cost = FORBID
    else if (nearCost > 0 && cells.lavaBeside(x, y, z, gap + 1)) cost = nearCost
    if (cost < FORBID && deaths.length > 0 && nearDeath(deaths, block.position)) cost += NETHER_DEATH_COST
    if (cost < FORBID && y > NETHER_HIGH_Y) cost += highCost
    stepCache.set(key, cost)
    return cost
  }
  const breakArea = (block: BlockInfoLike): number => {
    fresh()
    if (lavaAgainst(isLava, block.position)) return FORBID
    if (opts.piglins !== false && guarded.has(block.type) && piglinsAbout()) return FORBID
    // a fortress walked along its corridors and bridges, not dug through: the way to a blaze spawner went under a
    // bridge and dug up through it, into the wither skeletons on it (26.3)
    if (fortress.has(block.type)) return FORTRESS_BREAK_COST
    return 0
  }
  const place = (block: BlockInfoLike): number => { fresh(); return overLava(isLava, isAir, block.position) ? FORBID : 0 }
  // a drop ends on the ground: the nether's liquid is lava, no landing (MovementOptions.infiniteLiquidDropdownDistance)
  // (marked: withNetherSafety lays them over the settings once, not again inside another)
  for (const area of [step, breakArea, place]) (area as any).survivalNether = true
  return {
    infiniteLiquidDropdownDistance: false,
    edgeHazardCost: opts.edgeCost ?? 6,
    exclusionAreasStep: [step as any],
    exclusionAreasBreak: [breakArea as any],
    exclusionAreasPlace: [place as any]
  }
}

/** the pathfinder's settings now (a copy), to put back after */
function currentMoveSettings (bot: Bot): MovementOptions {
  return { ...(bot.pathfinder as any).defaultMoveSettings }
}

/** whether the pathfinder's settings have the nether's laid over them already (netherMoveSettings' areas) */
export function hasNetherSafety (bot: Bot): boolean {
  return ((bot.pathfinder as any)?.defaultMoveSettings?.exclusionAreasStep ?? []).some((area: any) => area?.survivalNether === true)
}

/** a fortress's blocks, dug through only at FORTRESS_BREAK_COST more */
export const FORTRESS_BLOCKS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_brick_slab', 'nether_brick_wall', 'cracked_nether_bricks', 'chiseled_nether_bricks']
/** the cost a fortress block's break adds to a path (a walk's step is about 1) */
export const FORTRESS_BREAK_COST = 30

/**
 * runs `fn` with the nether settings laid over the pathfinder's, and puts the old ones back; inside another's (the
 * executor's tasks in the nether have them), as it is
 */
export async function withNetherSafety<T> (bot: Bot, fn: () => Promise<T>, opts: NetherSafetyOptions = {}): Promise<T> {
  if (hasNetherSafety(bot)) return await fn()
  const before = currentMoveSettings(bot)
  const extra = netherMoveSettings(bot, opts)
  bot.pathfinder.setMoveOptions({
    ...before,
    ...extra,
    exclusionAreasStep: [...(before.exclusionAreasStep ?? []), ...(extra.exclusionAreasStep ?? [])],
    exclusionAreasBreak: [...(before.exclusionAreasBreak ?? []), ...(extra.exclusionAreasBreak ?? [])],
    exclusionAreasPlace: [...(before.exclusionAreasPlace ?? []), ...(extra.exclusionAreasPlace ?? [])]
  })
  try {
    return await fn()
  } finally {
    bot.pathfinder.setMoveOptions(before)
  }
}

// ---- gold armor for the piglins

const GOLD_ARMOR = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']
/** ingots each golden piece takes (its recipe) */
const GOLD_COST: Record<string, number> = { golden_boots: 4, golden_helmet: 5, golden_leggings: 7, golden_chestplate: 8 }
const SLOT_OF: Record<string, 'head' | 'torso' | 'legs' | 'feet'> = { golden_helmet: 'head', golden_chestplate: 'torso', golden_leggings: 'legs', golden_boots: 'feet' }

/** PiglinAi.isWearingGold: any armor piece made of gold (ItemTags.PIGLIN_SAFE_ARMOR: the golden ones) */
export function wearingGold (bot: Bot): boolean {
  for (const slot of [5, 6, 7, 8]) if (GOLD_ARMOR.includes(bot.inventory.slots[slot]?.name ?? '')) return true
  return false
}

/**
 * Puts on one golden armor piece (all piglins need to stay calm: PiglinAi.isWearingGold), crafting golden boots from
 * 4 ingots when there's none; keeps it on from then (requireGoldArmor) until requireGoldArmor(bot, false).
 */
export async function wearGold (bot: Bot, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  requireGoldArmor(bot, true)
  for (const slot of [5, 6, 7, 8]) {
    const name = bot.inventory.slots[slot]?.name ?? ''
    if (GOLD_ARMOR.includes(name)) return name
  }
  let piece = findInventoryItem(bot, GOLD_ARMOR)
  if (piece == null) {
    const name = Object.keys(GOLD_COST).find(n => countItems(bot, 'gold_ingot') >= GOLD_COST[n])
    if (name == null) throw new SkillError('MISSING_ITEMS', 'no golden armor and too few gold ingots to make some')
    await craft(bot, { item: name }, signal)
    piece = findInventoryItem(bot, name)
    if (piece == null) throw new SkillError('VERIFY_FAILED', `no ${name} after crafting it`)
  }
  await settleInventory(bot, signal)
  await bot.equip(piece, SLOT_OF[piece.name])
  if (!wearingGold(bot)) throw new SkillError('VERIFY_FAILED', `${piece.name} isn't worn after equipping it`)
  return piece.name
}

// ---- ghast fireballs

/** the large fireball a ghast shoots (LargeFireball), and the blaze's small one */
export const GHAST_FIREBALL = 'fireball'

/**
 * Whether a fireball is coming at the bot: within `range`, and its motion (the server's velocity, else the change of
 * position) points at the bot's box within a block or so over the next 40 ticks.
 */
export function fireballIncoming (bot: Bot, fireball: Entity, range = 12): boolean {
  const pos = fireball.position
  if (pos.distanceTo(bot.entity.position) > range) return false
  const v = fireball.velocity
  const speed = v.norm()
  if (speed < 1e-3) return pos.distanceTo(bot.entity.position) < 4
  const center = bot.entity.position.offset(0, 0.9, 0)
  const to = center.minus(pos)
  const t = Math.max(0, to.dot(v) / (speed * speed))
  if (t > 40 || to.dot(v) <= 0) return false
  const closest = pos.plus(v.scaled(t))
  return closest.distanceTo(center) < 2.5
}

/**
 * A fireball's place and motion `ticks` ticks on, as it flies (AbstractHurtingProjectile.tick, from 1.21.2: its motion
 * sped up 0.1 along itself and slowed by its inertia 0.95, then the move; mineflayer moves it so between the server's
 * updates)
 */
export function fireballAhead (fireball: Pick<Entity, 'position' | 'velocity'>, ticks: number): { position: Vec3, velocity: Vec3 } {
  const position = fireball.position.clone()
  const velocity = fireball.velocity.clone()
  for (let t = 0; t < ticks; t++) {
    const length = velocity.norm()
    if (length >= 1e-5) velocity.translate(velocity.x * 0.1 / length, velocity.y * 0.1 / length, velocity.z * 0.1 / length)
    velocity.scale(Math.fround(0.95))
    position.add(velocity)
  }
  return { position, velocity }
}

type BlockLookup = (pos: Vec3) => { name: string, boundingBox: string } | null

/**
 * Where a fireball's flight ends within `maxTicks` (fireballAhead): the first point of its way in a block with a
 * collision box (ProjectileUtil.getHitResultOnMoveVector clips its move against the blocks; LargeFireball.onHit blows
 * up there). Null when it flies on that long.
 */
export function fireballImpact (lookup: BlockLookup, fireball: Pick<Entity, 'position' | 'velocity'>, maxTicks = 40): { at: Vec3, ticks: number } | null {
  let now = { position: fireball.position.clone(), velocity: fireball.velocity.clone() }
  for (let t = 1; t <= maxTicks; t++) {
    const next = fireballAhead(now, 1)
    const move = next.position.minus(now.position)
    const steps = Math.max(1, Math.ceil(move.norm() / 0.1))
    for (let i = 1; i <= steps; i++) {
      const p = now.position.plus(move.scaled(i / steps))
      if (lookup(p.floored())?.boundingBox === 'block') return { at: p, ticks: t }
    }
    now = next
  }
  return null
}

/** blocks from a fireball's blast the bot keeps (ServerExplosion: a ghast's power 1 reaches 2 blocks, and breaks the netherrack within one or so of it) */
export const FIREBALL_BLAST_CLEAR = 3

/**
 * Where the bot steps out of a fireball's blast at `impact` (one it can't hit back: it comes from under the bridge, or
 * hits a block by the bot first): the nearest cell within `radius` FIREBALL_BLAST_CLEAR off the blast, away from it,
 * with a floor, room for the bot, and a floor under every cell on the straight walk there (along a bridge, not off
 * its side). Null when there's none.
 */
export function dodgeCell (lookup: BlockLookup, position: Vec3, impact: Vec3, radius = 4): Vec3 | null {
  const solid = (p: Vec3): boolean => lookup(p)?.boundingBox === 'block'
  const open = (p: Vec3): boolean => {
    const b = lookup(p)
    return b != null && b.boundingBox === 'empty' && !/lava|fire|water/.test(b.name)
  }
  const stand = (p: Vec3): boolean => solid(p.offset(0, -1, 0)) && open(p) && open(p.offset(0, 1, 0))
  const feet = position.floored()
  const away = position.minus(impact)
  let best: { cell: Vec3, d: number } | null = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const cell = feet.offset(dx, 0, dz)
      const middle = cell.offset(0.5, 0, 0.5)
      if (middle.offset(0, 0.9, 0).distanceTo(impact) < FIREBALL_BLAST_CLEAR) continue
      if ((middle.x - position.x) * away.x + (middle.z - position.z) * away.z < 0) continue
      if (!stand(cell)) continue
      const d = Math.hypot(middle.x - position.x, middle.z - position.z)
      if (best != null && d >= best.d) continue
      // the walk: every cell a fifth of a block apart on the line there stood on
      let ok = true
      for (let s = 0.2; s < d && ok; s += 0.2) ok = stand(position.plus(middle.minus(position).scaled(s / d)).floored())
      if (ok) best = { cell, d }
    }
  }
  return best?.cell ?? null
}

/**
 * Whether the bot can hit a fireball back before it blows up: on one of its ticks to `ticks` (fireballAhead) it's
 * within reach of the bot's eyes with nothing in the way
 */
function hittableBefore (bot: Bot, fireball: Entity, ticks: number, reach: number): boolean {
  const eye = eyePosition(bot)
  for (let t = 0; t <= ticks; t++) {
    const { position } = fireballAhead(fireball, t)
    const box = entityBox({ position, width: 1, height: 1 })
    if (distanceToBox(eye, box) > reach) continue
    const to = position.offset(0, 0.5, 0)
    const delta = to.minus(eye)
    const dist = delta.norm()
    let clear = true
    for (let s = 0.2; s < dist - 0.5 && clear; s += 0.2) clear = bot.blockAt(eye.plus(delta.scaled(s / dist)).floored())?.boundingBox !== 'block'
    if (clear) return true
  }
  return false
}

/**
 * Hits ghasts' fireballs back while any comes at the bot (fireballIncoming), the nearest first (one let go for the first
 * kept a 26.3 bot from the next, which blew it off a bridge into the lava): a swing turns it along the attacker's look
 * (Player.attack: ProjectileDeflection.AIM_DEFLECT), the look the server has, the one the last tick's move sent. So each
 * tick the bot looks through where the fireball will be next tick (fireballAhead): at the ghast when that look goes
 * through it (one sent back kills its ghast), else at its top (an upward look sends it up, off the bridge and the
 * ground); and swings when it's within reach and in the crosshair. One that will blow up by the bot before it can be
 * hit (from under its bridge, against a block beside it) is stepped away from (dodgeCell). Returns whether one was hit.
 */
export async function deflectFireball (bot: Bot, fireball: Entity, opts: { signal?: AbortSignal, maxTicks?: number, reach?: number, range?: number } = {}): Promise<boolean> {
  const reach = opts.reach ?? 3
  const strength = attackStrengthOf(bot)
  let hit = false
  let target: Entity | null = fireball
  for (let t = 0; t < (opts.maxTicks ?? 100); t++) {
    throwIfAborted(opts.signal)
    // the one coming nearest (the first, till it's gone or turned)
    const incoming = Object.values(bot.entities).filter(e => e.name === GHAST_FIREBALL && isAlive(bot, e) && fireballIncoming(bot, e, opts.range ?? 12))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (target == null || !isAlive(bot, target) || !incoming.includes(target)) target = incoming[0] ?? null
    if (target == null) return hit
    // one that blows up by the bot before it can be hit (from under the bridge it stands on, against a block beside
    // it): out of its blast (tests/integration/ghast's bot had its bridge blown from under it into the lava)
    const impact = fireballImpact(p => bot.blockAt(p) as any, target)
    if (impact != null && impact.at.distanceTo(bot.entity.position.offset(0, 0.9, 0)) < FIREBALL_BLAST_CLEAR && !hittableBefore(bot, target, impact.ticks, reach)) {
      const to = dodgeCell(p => bot.blockAt(p) as any, bot.entity.position, impact.at)
      if (to != null) {
        trace('deflectFireball: out of the blast at', impact.at.toString(), 'in', impact.ticks, 'ticks, to', to.toString())
        bot.setControlState('sprint', true)
        await walkTo(bot, to.offset(0.5, 0, 0.5), { within: 0.3, maxTicks: Math.max(4, impact.ticks + 2) }, opts.signal)
        continue
      }
    }
    const box = entityBox({ position: target.position, width: 1, height: 1 })
    // the look the last tick sent is on it now: the swing
    if (distanceToBox(eyePosition(bot), box) <= reach) {
      // any swing turns it: attack strength doesn't matter (none sent when a block is in the way)
      if (strength.attack(target)) {
        trace('deflectFireball: hit at', target.position.toString(), 'from', bot.entity.position.toString())
        hit = true
        target = null
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      trace('deflectFireball: not in the crosshair at', target.position.toString(), 'from', bot.entity.position.toString())
    }
    // the look for the next tick's swing, through where it will be then: at the ghast when that look goes through it
    // (sent back at it: a ghast's own fireball kills it), else at the top of its box
    const ahead = fireballAhead(target, 1).position
    const eye = eyePosition(bot)
    const ghast = nearestGhast(bot)
    const atGhast = ghast?.position.offset(0, 2, 0).minus(eye)
    const look = atGhast != null && rayHitsBox(eye, atGhast, entityBox({ position: ahead, width: 1, height: 1 })) ? atGhast : ahead.offset(0, 0.85, 0).minus(eye)
    const { yaw, pitch } = yawPitchOf(look)
    await bot.look(yaw, pitch, true)
    await waitTicks(bot, 1, opts.signal)
  }
  return hit
}

/** whether a ray from `origin` along `dir` goes through a box (the slab test) */
export function rayHitsBox (origin: Vec3, dir: Vec3, box: { min: Vec3, max: Vec3 }): boolean {
  let near = 0
  let far = Infinity
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(dir[axis]) < 1e-9) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return false
      continue
    }
    const a = (box.min[axis] - origin[axis]) / dir[axis]
    const b = (box.max[axis] - origin[axis]) / dir[axis]
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
  }
  return near <= far
}

/** the ghast nearest the bot within `range`, alive */
export function nearestGhast (bot: Bot, range = 64): Entity | null {
  let best: Entity | null = null
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'ghast' || !isAlive(bot, e)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d <= range && (best == null || d < best.position.distanceTo(bot.entity.position))) best = e
  }
  return best
}

/** blocks a fall may be and not kill or hurt much: deeper (or onto lava) is a deadly one */
export const SAFE_DROP = 4

/**
 * Whether one of the 8 cells about `feet` (at its level) is a deadly drop: no floor under it, and lava, or no ground
 * within SAFE_DROP blocks, below. A blast pushes a bot standing by one over the edge (ServerExplosion knocks it 1 - d /
 * 2 blocks a tick from 2 off, the shield or not).
 */
export function deadlyDropBeside (lookup: BlockLookup, feet: Vec3): boolean {
  const f = feet.floored()
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      const cell = f.offset(dx, 0, dz)
      if (lookup(cell)?.boundingBox === 'block') continue
      for (let dy = 1; dy <= SAFE_DROP + 1; dy++) {
        const b = lookup(cell.offset(0, -dy, 0))
        if (b == null) break
        if (b.name === 'lava') return true
        if (b.boundingBox === 'block') break
        if (dy === SAFE_DROP + 1) return true
      }
    }
  }
  return false
}

/**
 * The nearest cell within `radius` with no deadly drop beside it (deadlyDropBeside), room for the bot and a floor, walked
 * to straight on with a floor under every cell on the way (off a bridge onto the ground it starts from). Null for none.
 */
export function firmCell (lookup: BlockLookup, position: Vec3, radius = 6): Vec3 | null {
  const solid = (p: Vec3): boolean => lookup(p)?.boundingBox === 'block'
  const open = (p: Vec3): boolean => {
    const b = lookup(p)
    return b != null && b.boundingBox === 'empty' && !/lava|fire|water/.test(b.name)
  }
  const stand = (p: Vec3): boolean => solid(p.offset(0, -1, 0)) && open(p) && open(p.offset(0, 1, 0))
  const feet = position.floored()
  let best: { cell: Vec3, d: number } | null = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const cell = feet.offset(dx, 0, dz)
      const middle = cell.offset(0.5, 0, 0.5)
      const d = Math.hypot(middle.x - position.x, middle.z - position.z)
      if (d > radius || (best != null && d >= best.d)) continue
      if (!stand(cell) || deadlyDropBeside(lookup, cell)) continue
      let ok = true
      for (let s = 0.2; s < d && ok; s += 0.2) ok = stand(position.plus(middle.minus(position).scaled(s / d)).floored())
      if (ok) best = { cell, d }
    }
  }
  return best?.cell ?? null
}

/**
 * A ghast about while the bot stands by a deadly drop (a bridge or a ledge over the lava sea): back to firm ground near
 * (firmCell) and held there facing it while it's in sight, `maxTicks` at most, its fireballs hit back meanwhile (the
 * fireball reflex: one sent back kills it). A 26.3 bot stood on a ledge 58 blocks over the lava sea when a ghast's
 * fireball came, and its blast knocked it off. Held till `until` too (another mob come to fight). Resolves the ticks held.
 */
export async function keepFromGhast (bot: Bot, ghast: Entity, opts: { signal?: AbortSignal, maxTicks?: number, range?: number, onHold?: () => void, until?: () => boolean } = {}): Promise<number> {
  const lookup: BlockLookup = p => bot.blockAt(p) as any
  if (deadlyDropBeside(lookup, bot.entity.position)) {
    const to = firmCell(lookup, bot.entity.position)
    if (to != null) {
      trace('keepFromGhast: off the edge to', to.toString(), 'from', bot.entity.position.toString(), 'the ghast at', ghast.position.toString())
      await walkTo(bot, to.offset(0.5, 0, 0.5), { within: 0.25, maxTicks: 40 }, opts.signal)
    }
  }
  let held = 0
  for (; held < (opts.maxTicks ?? 200); held++) {
    throwIfAborted(opts.signal)
    if (!isAlive(bot, ghast) || ghast.position.distanceTo(bot.entity.position) > (opts.range ?? 48) || !hasLineOfSight(bot, ghast) || opts.until?.() === true) break
    const { yaw, pitch } = yawPitchOf(ghast.position.offset(0, 2, 0).minus(eyePosition(bot)))
    await bot.look(yaw, pitch, true)
    await waitTicks(bot, 1, opts.signal)
    opts.onHold?.()
  }
  return held
}

/** ticks the hostiles reflex holds off one archer in the nether in all, before it's let be and the bot walks on */
export const ARCHER_BUDGET = 600
/** ticks an archer out of sight is still held off for */
export const ARCHER_SIGHT = 40
/** an archer this near is hit with the sword, not shot (the bow's draw is 20 ticks) */
export const ARCHER_MELEE = 3.5

/**
 * An archer in the nether (a soul sand valley's skeletons on its ledges) held off from where the bot stands, never
 * chased: off a deadly edge first and again whenever the arrows knock it to one (firmCell: no lava or long drop beside
 * the feet), the shield up toward it while it draws and its arrow flies (ArrowGuard), the bow's shots between, and the
 * sword only at one come within reach. A 26.3 bot walking the nether's trail back to its portal with 16 pearls and 10
 * rods chased a skeleton 20 blocks over a soul sand valley and 13 down, into the lava sea, and burned with them
 * (nether-26.3-q3). Ends when the archer is dead, out of sight or past `range`, after maxTicks, or once `until` holds;
 * resolves the ticks held and the arrows shot.
 */
export async function holdOffArcher (bot: Bot, archer: Entity, opts: { signal?: AbortSignal, maxTicks?: number, range?: number, onHold?: (ticks: number) => void, until?: () => boolean } = {}): Promise<{ ticks: number, shots: number }> {
  const lookup: BlockLookup = p => bot.blockAt(p) as any
  const guard = new ArrowGuard()
  const strength = attackStrengthOf(bot)
  const shield = (): boolean => bot.inventory.slots[45]?.name === 'shield' || countItems(bot, 'shield') > 0
  const bowReady = (): boolean => countItems(bot, 'bow') > 0 && countItems(bot, ['arrow', 'spectral_arrow', 'tipped_arrow']) > 0
  let blocking = false
  let shots = 0
  let ticks = 0
  let noArc = -100
  let lastSeen = 0
  // (the ticks gone by, a shot's draw and flight among them)
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  const firm = async (): Promise<void> => {
    if (!deadlyDropBeside(lookup, bot.entity.position)) return
    const to = firmCell(lookup, bot.entity.position)
    if (to == null) return
    trace('holdOffArcher: off the edge to', to.toString(), 'from', bot.entity.position.toString(), 'the', archer.name, 'at', archer.position.toString())
    if (blocking) { lowerShield(bot); blocking = false }
    await walkTo(bot, to.offset(0.5, 0, 0.5), { within: 0.25, maxTicks: 40 }, opts.signal)
  }
  try {
    while (ticks < (opts.maxTicks ?? 400)) {
      throwIfAborted(opts.signal)
      const d = archer.position.distanceTo(bot.entity.position)
      if (hasLineOfSight(bot, archer)) lastSeen = ticks
      // (out of sight ARCHER_SIGHT ticks: it went off; a moment behind a rise isn't)
      if (!isAlive(bot, archer) || d > (opts.range ?? 24) || ticks - lastSeen > ARCHER_SIGHT || opts.until?.() === true) break
      opts.onHold?.(ticks)
      bot.clearControlStates()
      await firm()
      const middle = archer.position.offset(0, (archer.height ?? 1.99) * 0.6, 0)
      const { yaw, pitch } = yawPitchOf(middle.minus(eyePosition(bot)))
      if (guard.update(isUsingItem(bot, archer), d, ticks) && shield()) {
        await bot.look(yaw, pitch, true)
        if (!blocking) blocking = await raiseShield(bot)
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      if (blocking) { lowerShield(bot); blocking = false }
      if (distanceToBox(eyePosition(bot), entityBox(archer)) <= 2.9) {
        const sword = bestMeleeWeapon(bot, archer.name)
        if (sword != null && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand')
        await bot.look(yaw, pitch, true)
        if (strength.scale(0.5) >= 1) strength.attack(archer as any)
        await waitTicks(bot, 1, opts.signal)
        continue
      }
      if (bowReady() && d > ARCHER_MELEE && ticks - noArc > 40) {
        try {
          const res = await shoot(bot, archer, { signal: opts.signal, maxShots: 1 })
          shots += res.shots
        } catch (err) {
          if (isAbort(err)) throw err
          noArc = ticks
          trace('holdOffArcher:', (err as Error).message)
        }
        continue
      }
      await bot.look(yaw, pitch, true)
      await waitTicks(bot, 1, opts.signal)
    }
  } finally {
    bot.off('physicsTick', onTick)
    if (blocking) lowerShield(bot)
    bot.clearControlStates()
  }
  return { ticks, shots }
}

// ---- a guarded bridge over lava

export interface BridgeArgs {
  /** horizontal step: one of the four cardinals */
  direction: Vec3
  /** blocks to bridge */
  length: number
  /** the block to build with (default: cobblestone, netherrack or another filler the bot has most of) */
  item?: string
  /**
   * a rail block either side at the feet (default true); over the void there's nothing to put one against (the cell
   * under it is air too), and the sneak alone keeps the bot on
   */
  rails?: boolean
}

/**
 * Bridges straight on over lava as players do it safely: sneaking (no falling off the edge), each new floor block
 * with a rail block either side of it at the feet so a knockback can't push the bot off, and walked onto only once
 * it's down.
 */
export async function bridgeOverLava (bot: Bot, args: BridgeArgs, signal?: AbortSignal): Promise<{ placed: number }> {
  const dir = args.direction.normalize().floored()
  const item = args.item ?? (['cobblestone', 'netherrack', 'cobbled_deepslate', 'blackstone', 'dirt'].sort((a, b) => countItems(bot, b) - countItems(bot, a))[0])
  const left = new Vec3(-dir.z, 0, dir.x)
  let placed = 0
  try {
    bot.setControlState('sneak', true)
    for (let i = 0; i < args.length; i++) {
      throwIfAborted(signal)
      const feet = bot.entity.position.floored()
      const floor = feet.plus(dir).offset(0, -1, 0)
      const rails = args.rails !== false
      const need = 1 + (rails ? 2 : 0) + (bot.blockAt(floor)?.boundingBox === 'block' ? -1 : 0)
      if (countItems(bot, item) < need) throw new SkillError('MISSING_ITEMS', `out of ${item} after ${placed} bridge blocks`)
      for (const pos of rails ? [floor, floor.plus(left).offset(0, 1, 0), floor.minus(left).offset(0, 1, 0)] : [floor]) {
        const b = bot.blockAt(pos)
        if (b == null || b.boundingBox === 'block') continue
        // the rails stand on lava or air: placed against the new floor's sides
        await placeBlock(bot, { pos, item, against: pos.equals(floor) ? feet.offset(0, -1, 0) : floor }, signal)
        placed++
      }
      // a sneaking step onto it
      const target = feet.plus(dir).offset(0.5, 0, 0.5)
      for (let t = 0; t < 40 && bot.entity.position.distanceTo(target) > 0.35; t++) {
        const { yaw } = yawPitchOf(target.minus(bot.entity.position))
        await bot.look(yaw, 0.6, true)
        bot.setControlState('forward', true)
        await waitTicks(bot, 1, signal)
      }
      bot.setControlState('forward', false)
    }
  } catch (err) {
    if (!isAbort(err)) trace('bridgeOverLava:', (err as Error).message)
    throw err
  } finally {
    bot.clearControlStates()
  }
  return { placed }
}
