// Nether safety: pathfinder rules that keep the bot off lava edges and out of lava flows, never bridge over lava (a
// guarded bridge does that), and leave piglins' gold alone; one gold armor piece worn for the piglins; ghast fireballs
// punched back.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { MovementOptions } from '@nxg-org/mineflayer-pathfinder'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { craft } from '../skills/craft'
import { placeBlock } from '../skills/placeBlock'
import { countItems, findInventoryItem, settleInventory, trace, waitTicks } from '../skills/util'
import { type Entity, distanceToBox, entityBox, eyePosition, isAlive, yawPitchOf } from '../skills/combatUtil'
import { attackStrengthOf } from '../skills/weapons'
import { requireGoldArmor } from '../skills/armor'

export { requireGoldArmor, goldArmorRequired } from '../skills/armor'

/** the pathfinder's COST_INF: a cost this high forbids the step, break or place */
export const FORBID = 1000000

/** blocks piglins guard: PiglinAi.angerNearbyPiglins fires when a player breaks one (BlockTags.GUARDED_BY_PIGLINS) or opens a container */
export const PIGLIN_GUARDED = new Set([
  'gold_block', 'gilded_blackstone', 'nether_gold_ore', 'deepslate_gold_ore', 'gold_ore', 'raw_gold_block', 'chest', 'trapped_chest', 'barrel', 'ender_chest',
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
}

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

/**
 * The pathfinder's movement settings for the nether: exclusion areas (the pathfinder's own hook) that forbid
 * standing next to lava, breaking a block lava rests against, placing a block over lava (the pathfinder's bridges
 * have no rails: bridgeOverLava does), and breaking what piglins guard while one is near.
 */
export function netherMoveSettings (bot: Bot, opts: NetherSafetyOptions = {}): Partial<MovementOptions> {
  const gap = opts.lavaGap ?? 1
  const nearCost = opts.nearLavaCost ?? 40
  // the A* asks about every cell it considers, many times: the answers are kept, and dropped every 100 ticks (lava
  // flows slowly, a bucket's lava or a broken block shows up then)
  const lavaStates = stateRange(bot, 'lava')
  const airStates = ['air', 'cave_air', 'void_air'].map(n => stateRange(bot, n))
  const stateAt = (p: Vec3): number | null => (bot.world as any).getBlockStateId?.(p) ?? null
  const lavaCache = new Map<string, boolean>()
  const stepCache = new Map<string, number>()
  let cachedAt = -1
  const fresh = (): void => {
    const tick = (bot as any).lockstep?.ticks ?? Math.floor(Date.now() / 50)
    if (tick - cachedAt > 100 || tick < cachedAt) { lavaCache.clear(); stepCache.clear(); cachedAt = tick }
  }
  const isLava = (p: Vec3): boolean => {
    const key = `${p.x},${p.y},${p.z}`
    let v = lavaCache.get(key)
    if (v == null) {
      const s = stateAt(p)
      v = s != null && s >= lavaStates[0] && s <= lavaStates[1]
      lavaCache.set(key, v)
    }
    return v
  }
  const isAir = (p: Vec3): boolean => { const s = stateAt(p); return s != null && airStates.some(([a, b]) => s >= a && s <= b) }
  const guarded = new Set([...PIGLIN_GUARDED].map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n != null))
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
    const p = block.position
    const key = `${p.x},${p.y},${p.z}`
    const known = stepCache.get(key)
    if (known != null) return known
    let cost = 0
    if (isLava(p) || isLava(p.offset(0, 1, 0)) || isLava(p.offset(0, -1, 0)) || lavaBeside(isLava, p, gap)) cost = FORBID
    else if (nearCost > 0 && lavaBeside(isLava, p, gap + 1)) cost = nearCost
    stepCache.set(key, cost)
    return cost
  }
  const breakArea = (block: BlockInfoLike): number => {
    fresh()
    if (lavaAgainst(isLava, block.position)) return FORBID
    if (opts.piglins !== false && guarded.has(block.type) && piglinsAbout()) return FORBID
    return 0
  }
  const place = (block: BlockInfoLike): number => overLava(isLava, isAir, block.position) ? FORBID : 0
  // a drop ends on the ground: the nether's liquid is lava, no landing (MovementOptions.infiniteLiquidDropdownDistance)
  return { infiniteLiquidDropdownDistance: false, exclusionAreasStep: [step as any], exclusionAreasBreak: [breakArea as any], exclusionAreasPlace: [place as any] }
}

/** the pathfinder's settings now (a copy), to put back after */
function currentMoveSettings (bot: Bot): MovementOptions {
  return { ...(bot.pathfinder as any).defaultMoveSettings }
}

/** runs `fn` with the nether settings laid over the pathfinder's, and puts the old ones back */
export async function withNetherSafety<T> (bot: Bot, fn: () => Promise<T>, opts: NetherSafetyOptions = {}): Promise<T> {
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
 * Hits a ghast's fireball back: looks at it and swings when it's within reach (AbstractHurtingProjectile.hurt turns it
 * along the attacker's look, and it explodes on the ghast or far off). The shield is the fallback (it takes the blast
 * when raised toward it). Returns whether it was hit.
 */
export async function deflectFireball (bot: Bot, fireball: Entity, opts: { signal?: AbortSignal, maxTicks?: number, reach?: number } = {}): Promise<boolean> {
  const reach = opts.reach ?? 3
  const strength = attackStrengthOf(bot)
  for (let t = 0; t < (opts.maxTicks ?? 60); t++) {
    throwIfAborted(opts.signal)
    if (!isAlive(bot, fireball)) return false
    const point = fireball.position.offset(0, 0.5, 0)
    const { yaw, pitch } = yawPitchOf(point.minus(eyePosition(bot)))
    await bot.look(yaw, pitch, true)
    if (distanceToBox(eyePosition(bot), entityBox({ position: fireball.position, width: 1, height: 1 })) <= reach) {
      // any swing turns it: attack strength doesn't matter
      strength.attack(fireball)
      trace('deflectFireball: hit at', fireball.position.toString())
      await waitTicks(bot, 2, opts.signal)
      return true
    }
    await waitTicks(bot, 1, opts.signal)
  }
  return false
}

// ---- a guarded bridge over lava

export interface BridgeArgs {
  /** horizontal step: one of the four cardinals */
  direction: Vec3
  /** blocks to bridge */
  length: number
  /** the block to build with (default: cobblestone, netherrack or another filler the bot has most of) */
  item?: string
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
      const need = 1 + 2 + (bot.blockAt(floor)?.boundingBox === 'block' ? -1 : 0)
      if (countItems(bot, item) < need) throw new SkillError('MISSING_ITEMS', `out of ${item} after ${placed} bridge blocks`)
      for (const pos of [floor, floor.plus(left).offset(0, 1, 0), floor.minus(left).offset(0, 1, 0)]) {
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
