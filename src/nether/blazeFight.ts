// The blaze fight from cover: a nook built by the spawner (walls behind and beside the bot at its feet and head, a
// roof over it, open toward the spawner), the bot in it with its shield up while a blaze in sight is about to shoot,
// shooting them with the bow (or the sword, one come close) in between. Vanilla's blaze (Blaze.BlazeAttackGoal, the
// same in 1.21.11 and 26.3) shoots only with a line of sight to its target (Sensing.hasLineOfSight: its eyes to the
// target's), out to its follow range (48): charged (Blaze.DATA_FLAGS_ID's bit 1, which the client sees) for 60 ticks,
// then three small fireballs 6 ticks apart, then 100 ticks of rest. Within 2 blocks it hits instead (doHurtTarget,
// every 20 ticks). A small fireball sets what it hits alight for 5 s (SmallFireball.onHitEntity) unless the hit is
// blocked (hurtServer false: the fire ticks put back), and lights the block it hits (onHitBlock). The shield
// (BlocksAttacks: 0.25 s before it blocks, LivingEntity.getItemBlockingWith) blocks a hit from within 90 degrees of
// the way the head faces, across (applyItemBlocking: the source's position, its height left out). In the nook a blaze
// sees the bot only through the front, within 45 degrees of it: the shield takes every fireball that comes, and
// the bot never burns. Low, the front is shut and the bot eats and heals inside.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, isSkillError, throwIfAborted } from '../skills/errors'
import { type Entity, entityBox, distanceToBox, eyePosition, hasLineOfSight, isAlive } from '../skills/combatUtil'
import { blazeCharged, fight, lowerShield, raiseShield } from '../skills/fight'
import { aim, arrowWorld } from '../skills/shoot'
import { motionTrackerOf } from '../skills/motion'
import { attackStrengthOf, bestMeleeWeapon } from '../skills/weapons'
import { eat, dueMeal } from '../skills/eat'
import { chooseFood } from '../skills/food'
import { placeBlock } from '../skills/placeBlock'
import { collectDropsNear } from '../skills/hunt'
import { nearbyDrops } from '../skills/pickupDrops'
import { moveNear } from '../skills/gridWalk'
import { walkTo } from '../skills/navigate'
import { countItems, trace, waitTicks, waitUntil } from '../skills/util'
import { fireballIncoming } from './safety'
import { dig } from '../core/actions'
import { isOnFire } from '../skills/escape'
import { drinkPotion, findPotion, hasEffect } from '../skills/potion'

/** BlazeAttackGoal: ticks charged before the first of the volley's three fireballs */
export const BLAZE_CHARGE_TICKS = 60
/** the shield's BlocksAttacks.blockDelaySeconds (0.25 s): raised this many ticks before it blocks */
export const SHIELD_DELAY_TICKS = 5
/**
 * the shield goes up this many ticks before a charged blaze's first shot can come: its delay, and a margin for the
 * charge seen a tick late and the use's trip to the server
 */
export const SHIELD_LEAD_TICKS = SHIELD_DELAY_TICKS + 10
/**
 * and stays up this long after a volley ends (the flag clears 6 ticks after the third shot): a small fireball
 * (AbstractHurtingProjectile: 0.1 a tick at first, accelerationPower 0.1, inertia 0.95) takes about 15 ticks over 10
 * blocks and 20 over 16
 */
export const FIREBALL_FLIGHT_TICKS = 24
/** the small fireball's entity */
export const SMALL_FIREBALL = 'small_fireball'
/** a blaze's eyes over its feet (EntityType.BLAZE: 1.8 high, the default eye height 0.85 of it) */
export const BLAZE_EYE_HEIGHT = 1.53

/**
 * Each blaze's volley as the client sees it: when its charged flag came on, and when the last one went off. A blaze
 * first seen charged may have been charged for a while (out of sight it stays charged, and shoots as soon as it sees
 * the bot again): its charge is taken as old enough to shoot.
 */
export class BlazeVolleys {
  private readonly since = new Map<number, number>()
  private readonly ended = new Map<number, number>()
  private readonly known = new Set<number>()

  update (blazes: ReadonlyArray<{ id: number, charged: boolean }>, tick: number): void {
    const present = new Set<number>()
    for (const b of blazes) {
      present.add(b.id)
      const since = this.since.get(b.id)
      if (b.charged && since == null) {
        this.since.set(b.id, this.known.has(b.id) ? tick : tick - BLAZE_CHARGE_TICKS)
      } else if (!b.charged && since != null) {
        this.since.delete(b.id)
        this.ended.set(b.id, tick)
      }
      this.known.add(b.id)
    }
    for (const id of [...this.known]) {
      if (present.has(id)) continue
      this.known.delete(id)
      this.since.delete(id)
      this.ended.delete(id)
    }
  }

  /** ticks the blaze has been charged, or null when it isn't */
  chargedFor (id: number, tick: number): number | null {
    const since = this.since.get(id)
    return since == null ? null : tick - since
  }

  /** whether it may shoot within `lead` ticks, or a fireball of its last volley may still be on its way */
  dangerous (id: number, tick: number, lead = SHIELD_LEAD_TICKS): boolean {
    const charged = this.chargedFor(id, tick)
    if (charged != null) return charged >= BLAZE_CHARGE_TICKS - lead
    const ended = this.ended.get(id)
    return ended != null && tick - ended <= FIREBALL_FLIGHT_TICKS
  }

  /** whether nothing it does can reach the bot in the next `ticks`: not charged, or charged too lately to shoot by then */
  quietFor (id: number, tick: number, ticks: number): boolean {
    return !this.dangerous(id, tick, ticks + SHIELD_LEAD_TICKS)
  }
}

// ---- the nook

export interface NookBlock {
  name: string
  boundingBox: string
}

export type NookLookup = (pos: Vec3) => NookBlock | null

/** the cardinal ways, +x, -x, +z, -z */
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const UP = new Vec3(0, 1, 0)

export interface BlazeNook {
  /** the bot's feet */
  stand: Vec3
  /** the way it faces (a cardinal): the open side */
  facing: Vec3
  /** the cells to put blocks in, in an order each has something solid to go against */
  build: Vec3[]
  /** the front's two cells, filled to shut the nook */
  front: Vec3[]
  /** the walls and the roof (built or there already): what the pathfinder mustn't break */
  walls: Vec3[]
  /**
   * the floor under the stand and under the front's feet, kept from the pathfinder's breaking too: a 26.3 bot's way
   * to the nook on seed 7741's bridge came up through it from under the bridge, and the front's floor dug out left
   * the front with nothing to go against ('nothing solid to place against', every tick for 3000 ticks)
   */
  floor: Vec3[]
  /**
   * a sealed bunker's (bunkerAround): the front's foot walled (the sill), its head the slit the bot fights through
   * (`front` is the slit alone), and the block over the slit when there's one (the visor)
   */
  bunker?: { sill: Vec3, slit: Vec3, visor: Vec3 | null }
}

export interface NookOptions {
  /** nearest and furthest across from the spawner (default 7 and 13: out of the 9 across its blazes spawn in, inside its 16 of a player) */
  minDistance?: number
  maxDistance?: number
  /** the distance across the nook is best at (default 10) */
  standOff?: number
  /** where the bot is (a nearer nook is the cheaper) */
  from?: Vec3
  /** most blocks to put (default 12) */
  maxBlocks?: number
  /** the least share of the spawner's spawns the nook's eyes see (spawnView: default MIN_SPAWN_VIEW) */
  minView?: number
  /**
   * a nook by the spawn volume, for the sword (MELEE_NOOK's distances; the share of the spawns within its reach
   * counted): the blazes come out within reach of its front
   */
  melee?: boolean
}

/** BaseSpawner.spawnRange: a spawn's x and z within this of the spawner's middle */
export const SPAWN_RANGE = 4
/** BaseSpawner.requiredPlayerRange: the spawner makes blazes only with a player's feet within this of its middle */
export const SPAWNER_ACTIVATION = 16
/** the least share of the spawns a nook sees: fewer, the blazes it can shoot or hit come seldom */
export const MIN_SPAWN_VIEW = 0.25
/** a melee nook's distances from the spawner (planBlazeNooks' melee) */
export const MELEE_NOOK = { minDistance: 2, maxDistance: 5, standOff: 3 }
/** the sword's reach from the eyes, a spawn's middle within it counted as in reach */
const SWORD_REACH = 3.5

/**
 * The share of a spawner's spawns a nook's eyes see (a blaze's middle, from its eyes with the nook built), and the
 * share within the sword's reach: BaseSpawner.serverTick puts each at x and z = the spawner's + (r - r') * spawnRange
 * + 0.5 (r, r' uniform: a triangle over 4 either way) and y = its + -1 to 1, where the blaze's box has no block in it;
 * the cells weighted so
 */
export function spawnView (lookup: NookLookup, spawner: Vec3, nook: BlazeNook): { seen: number, reach: number } {
  const S = spawner.floored()
  const eye = nook.stand.offset(0.5, 1.62, 0.5)
  const built = new Set(nook.build.map(p => p.toString()))
  const view: NookLookup = p => built.has(p.toString()) ? { name: 'cobblestone', boundingBox: 'block' } : lookup(p)
  const free = (p: Vec3): boolean => { const b = lookup(p); return b != null && b.boundingBox === 'empty' }
  let all = 0
  let seen = 0
  let reach = 0
  for (let dx = -SPAWN_RANGE; dx <= SPAWN_RANGE; dx++) {
    for (let dz = -SPAWN_RANGE; dz <= SPAWN_RANGE; dz++) {
      const w = spawnWeight(dx) * spawnWeight(dz)
      for (let dy = -1; dy <= 1; dy++) {
        const c = S.offset(dx, dy, dz)
        if (!free(c) || !free(c.plus(UP))) continue
        all += w
        const middle = c.offset(0.5, 0.9, 0.5)
        if (!clearLine(view, eye, middle)) continue
        seen += w
        if (middle.distanceTo(eye) <= SWORD_REACH) reach += w
      }
    }
  }
  return all > 0 ? { seen: seen / all, reach: reach / all } : { seen: 0, reach: 0 }
}

/**
 * Whether a blaze the spawner makes may come out with its box in the bot's cells at `stand` (its feet and head): the
 * spawn's middle within SPAWN_RANGE of the spawner's across, its feet at the spawner's height or one either side, its
 * box 0.6 wide and 1.8 high (BaseSpawner.serverTick, EntityType.BLAZE). The cells 4 off take a sliver of a box only
 * (2 spawns in 100 along that axis), but the blazes hover out to them and over: in (a melee nook on seed 2's throne's
 * stairs at (-277, 76, -163), 4 off, burned a 26.3 bot with a stone sword and one in iron with a bow, BLAZE_KIT q3 and
 * gateIronBow, and the camp on those stairs one with a stone sword). `margin` more across. A nook in it is no cover: in the melee nook 2 off seed 2's throne
 * spawner at (-277, 77, -159) the blazes came out in its stand and its front, on the bot, punching it from beside and
 * behind its shield, and 26.3 bots died in it with a stone sword (BLAZE_KIT q3, gate) and in iron with a bow
 * (gateIronBow, its bow's nook STUCK), and in the one by seed 7741's throne spawner the same
 */
export function inSpawnVolume (spawner: Vec3, stand: Vec3, margin = 0): boolean {
  const S = spawner.floored()
  const dy = stand.y - S.y
  return Math.abs(stand.x - S.x) <= SPAWN_RANGE + margin && Math.abs(stand.z - S.z) <= SPAWN_RANGE + margin && dy >= -2 && dy <= 2
}

/**
 * whether the nether's paths may not step on the cell (netherMoveSettings' step: lava in it, over or under it, lava
 * beside it at its feet or head, a corner's too, or a magma block under it)
 */
export function netherStepForbidden (lookup: NookLookup, p: Vec3): boolean {
  const lava = (q: Vec3): boolean => lookup(q)?.name === 'lava'
  if (lava(p) || lava(p.offset(0, 1, 0)) || lava(p.offset(0, -1, 0)) || lookup(p.offset(0, -1, 0))?.name === 'magma_block') return true
  for (let dy = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx !== 0 || dz !== 0) && lava(p.offset(dx, dy, dz))) return true
  return false
}

/** the share of the spawns whose x (or z) is in the cell `k` off the spawner's: the triangle over (k - 0.5, k + 0.5) */
export function spawnWeight (k: number): number {
  const f = (u: number): number => Math.max(0, SPAWN_RANGE - Math.abs(u))
  return (f(k - 0.5) + 4 * f(k) + f(k + 0.5)) / 6 / (SPAWN_RANGE * SPAWN_RANGE)
}

const isSolidBlock = (b: NookBlock | null): boolean => b != null && b.boundingBox === 'block'
const FREE_NAMES = new Set(['air', 'cave_air', 'void_air', 'fire', 'soul_fire', 'short_grass', 'tall_grass', 'fern', 'warped_roots', 'crimson_roots', 'nether_sprouts', 'red_shrub'])
const isOpen = (b: NookBlock | null): boolean => b != null && FREE_NAMES.has(b.name)
/**
 * a wall or a roof of the nook: a full cube, not a fence, a wall or bars (their collision shapes are posts and
 * arms: a fireball goes between them, and a blaze sees through; a 26.3 nook on seed 7741's throne, walled by its
 * nether brick fences at the head, was fireballed through them, the bot dead in it three runs of three)
 */
const PART_BLOCK = /(fence|_wall|pane|bars|chain|_slab|stairs|trapdoor|_door|ladder|scaffolding)$/
const isWallBlock = (b: NookBlock | null): boolean => isSolidBlock(b) && !PART_BLOCK.test(b?.name ?? '')
/** a floor the nook goes on: a full block but magma (MagmaBlock.stepOn burns) */
const isFloor = (b: NookBlock | null): boolean => isSolidBlock(b) && b?.name !== 'magma_block'

/** whether nothing solid lies on the straight line between two points (a voxel walk over the lookup) */
export function clearLine (lookup: NookLookup, from: Vec3, to: Vec3, skip?: (p: Vec3) => boolean): boolean {
  const d = to.minus(from)
  const len = d.norm()
  const steps = Math.ceil(len / 0.1)
  let last = ''
  for (let i = 1; i < steps; i++) {
    const p = from.plus(d.scaled(i / steps)).floored()
    const key = p.toString()
    if (key === last) continue
    last = key
    if (skip?.(p) === true) continue
    if (isSolidBlock(lookup(p))) return false
  }
  return true
}

/**
 * The nook to fight the spawner's blazes from: a floor cell `minDistance` to `maxDistance` across from it, within 4 under
 * it and 2 over, open at the feet and the head, facing (the cardinal way nearest the spawner, within 30 degrees of
 * it) open cells with a floor, its eyes seeing over the spawner; the back, the two sides at the feet and the head, and
 * the roof solid already or free to fill, each with something solid to go against once the ones before it are in.
 * The cheapest: the fewest blocks, nearest the stand-off, nearest the bot. Null when there's none.
 */
export function planBlazeNook (lookup: NookLookup, spawner: Vec3, opts: NookOptions = {}): BlazeNook | null {
  return planBlazeNooks(lookup, spawner, opts, 1)[0] ?? null
}

/**
 * The `n` cheapest nooks (planBlazeNook's), cheapest first, no two of them on the same stand. Each sees at least
 * `minView` of the spawner's spawns (spawnView), its feet within the spawner's SPAWNER_ACTIVATION; one that sees under
 * half of them costs more, a melee nook's spawns within the sword's reach count for it
 */
export function planBlazeNooks (lookup: NookLookup, spawner: Vec3, opts: NookOptions = {}, n = 3): BlazeNook[] {
  const melee = opts.melee === true
  const minD = opts.minDistance ?? (melee ? MELEE_NOOK.minDistance : 7)
  const maxD = opts.maxDistance ?? (melee ? MELEE_NOOK.maxDistance : 13)
  const standOff = opts.standOff ?? (melee ? MELEE_NOOK.standOff : 10)
  const maxBlocks = opts.maxBlocks ?? 12
  const minView = opts.minView ?? MIN_SPAWN_VIEW
  const S = spawner.floored()
  // the blazes hover about it, a block or two over it
  const over = S.offset(0.5, 1.5, 0.5)
  const found: Array<{ nook: BlazeNook, cost: number }> = []
  for (let dx = -maxD; dx <= maxD; dx++) {
    for (let dz = -maxD; dz <= maxD; dz++) {
      const h = Math.hypot(dx, dz)
      if (h < minD || h > maxD) continue
      for (let dy = -4; dy <= 2; dy++) {
        const stand = S.offset(dx, dy, dz)
        if (stand.offset(0.5, 0, 0.5).distanceTo(S.offset(0.5, 0.5, 0.5)) >= SPAWNER_ACTIVATION - 1) continue
        if (inSpawnVolume(S, stand)) continue
        if (!isOpen(lookup(stand)) || !isOpen(lookup(stand.plus(UP))) || !isFloor(lookup(stand.offset(0, -1, 0)))) continue
        // no stand the nether's paths may not step on (netherMoveSettings: lava in or by it, a magma block under it):
        // the way into one by a basalt delta's lava ended 'goal inside excluded area' 13 times over 21000 ticks, the
        // fight going back to it each time, till a blaze killed the bot there (ls3-1.21.11, t263400 to t284498)
        if (netherStepForbidden(lookup, stand)) continue
        // facing the spawner: the cardinal way nearest it
        const to = new Vec3(-dx, 0, -dz).scaled(1 / h)
        const facing = SIDES.reduce((a, b) => (b.dot(to) > a.dot(to) ? b : a))
        if (facing.dot(to) < Math.cos(Math.PI / 6)) continue
        const front = [stand.plus(facing), stand.plus(facing).plus(UP)]
        if (!front.every(p => isOpen(lookup(p))) || !isFloor(lookup(front[0].offset(0, -1, 0)))) continue
        if (netherStepForbidden(lookup, front[0])) continue
        const eye = stand.offset(0.5, 1.62, 0.5)
        if (!clearLine(lookup, eye, over, p => p.equals(S))) continue
        const nook = nookAround(lookup, stand, facing, maxBlocks)
        if (nook == null) continue
        const floor = lookup(stand.offset(0, -1, 0))?.name ?? ''
        // (netherrack burns for good: a fire lit on it would stay by the bot's feet)
        const cost = nook.build.length * 3 + Math.abs(h - standOff) * 2 + (floor === 'netherrack' ? 4 : 0) +
          (opts.from != null ? stand.offset(0.5, 0, 0.5).distanceTo(opts.from) * 0.3 : 0)
        found.push({ nook, cost })
      }
    }
  }
  // the spawns seen, looked at for the cheapest (each a few hundred lines of sight)
  const out: Array<{ nook: BlazeNook, cost: number }> = []
  for (const f of found.sort((a, b) => a.cost - b.cost).slice(0, 4 * n + 12)) {
    const view = spawnView(lookup, S, f.nook)
    if (view.seen < minView) continue
    out.push({ nook: f.nook, cost: f.cost + Math.max(0, 0.5 - view.seen) * 12 - (melee ? view.reach * 12 : 0) })
  }
  return out.sort((a, b) => a.cost - b.cost).slice(0, n).map(f => f.nook)
}

/** the nook round a stand facing a way: its blocks in an order that has each go against a solid one, or null */
export function nookAround (lookup: NookLookup, stand: Vec3, facing: Vec3, maxBlocks = 12): BlazeNook | null {
  const side = new Vec3(facing.z, 0, -facing.x)
  const back = facing.scaled(-1)
  const walls: Vec3[] = []
  for (const dy of [0, 1]) for (const d of [back, side, side.scaled(-1)]) walls.push(stand.plus(d).offset(0, dy, 0))
  walls.push(stand.offset(0, 2, 0))
  const front = [stand.plus(facing), stand.plus(facing).plus(UP)]
  const build = shellBuild(lookup, walls, [stand, stand.plus(UP), ...front], maxBlocks)
  if (build == null) return null
  return { stand, facing, build, front, walls, floor: [stand.offset(0, -1, 0), stand.plus(facing).offset(0, -1, 0)] }
}

/**
 * The blocks that put up `walls` (each a full block there already, or open to fill), in an order that has each go
 * against a solid one, the `kept` cells (the bot's, the opening's) never filled for it; null when some can't be, or
 * it takes more than `maxBlocks`
 */
function shellBuild (lookup: NookLookup, walls: readonly Vec3[], keptCells: readonly Vec3[], maxBlocks: number): Vec3[] | null {
  const solid = new Set<string>()
  const isIn = (p: Vec3): boolean => solid.has(p.toString()) || isSolidBlock(lookup(p))
  const todo: Vec3[] = []
  for (const w of walls) {
    const b = lookup(w)
    if (isWallBlock(b)) continue
    if (!isOpen(b)) return null
    todo.push(w)
  }
  // the order: each next one against a block that's solid by then (the floor, a wall put before it); when none has
  // one, a block put first where it gives one (under a wall over nothing, against the floor beside it; over a wall,
  // for the roof to go against: a roof touches no wall but across a corner)
  const build: Vec3[] = []
  const neighbours = (p: Vec3): Vec3[] => [p.offset(0, -1, 0), p.offset(0, 1, 0), ...SIDES.map(s => p.plus(s))]
  const kept = new Set(keptCells.map(p => p.toString()))
  const backed = (p: Vec3): boolean => neighbours(p).some(n => !kept.has(n.toString()) && isIn(n))
  let left = todo.slice()
  for (let guard = 0; left.length > 0 && guard < 20; guard++) {
    const next = left.find(backed)
    if (next != null) {
      build.push(next)
      solid.add(next.toString())
      left = left.filter(p => p !== next)
      continue
    }
    let support: Vec3 | null = null
    for (const p of left) {
      support = neighbours(p).find(q => !kept.has(q.toString()) && !solid.has(q.toString()) && isOpen(lookup(q)) && backed(q)) ?? null
      if (support != null) break
    }
    if (support == null) return null
    build.push(support)
    solid.add(support.toString())
  }
  if (left.length > 0 || build.length > maxBlocks) return null
  return build
}

// ---- the bunker

/**
 * A bunker's distances from the spawner across: its stand just out of the spawn volume (inSpawnVolume: no blaze comes
 * out in its cells), its slit at the volume's edge, where the blazes come out within the sword's reach of it
 */
export const BUNKER = { minDistance: 5, maxDistance: 11, standOff: 7 }
/** the least share of the spawner's spawns a bunker's eyes see through its slit */
export const BUNKER_MIN_VIEW = 0.08

/**
 * The sealed bunker round a stand facing a way (the first rods' cover, with no fire resistance): the back and the two
 * sides walled at the feet and the head, a full block over the head, the front walled at the feet (the sill) and,
 * with `visor`, over the slit too, so the one way in for a blaze's sight, a fireball or a punch is the slit, the open
 * cell in front of the eyes. A small fireball aimed at the bot's middle (Blaze.BlazeAttackGoal: the target's
 * getY(0.5), from the blaze's getY(0.5) + 0.5) from a blaze about the bot's height meets the sill; one from over it comes
 * in at the slit and meets the shield, held toward the slit. Null when its walls can't all be had, or take more than
 * `maxBlocks`.
 */
export function bunkerAround (lookup: NookLookup, stand: Vec3, facing: Vec3, visor = true, maxBlocks = 12): BlazeNook | null {
  const side = new Vec3(facing.z, 0, -facing.x)
  const back = facing.scaled(-1)
  const walls: Vec3[] = []
  for (const dy of [0, 1]) for (const d of [back, side, side.scaled(-1)]) walls.push(stand.plus(d).offset(0, dy, 0))
  const sill = stand.plus(facing)
  const slit = sill.plus(UP)
  walls.push(sill, stand.offset(0, 2, 0))
  const over = visor ? slit.plus(UP) : null
  if (over != null) walls.push(over)
  if (!isOpen(lookup(slit))) return null
  const build = shellBuild(lookup, walls, [stand, stand.plus(UP), slit], maxBlocks)
  if (build == null) return null
  return { stand, facing, build, front: [slit], walls, floor: [stand.offset(0, -1, 0), sill.offset(0, -1, 0)], bunker: { sill, slit, visor: over } }
}

/** the nook or the bunker round a planned one's stand, its blocks to put looked at afresh (null when it can't be had now) */
export function shellAgain (lookup: NookLookup, nook: BlazeNook, maxBlocks = 12): BlazeNook | null {
  return nook.bunker != null
    ? bunkerAround(lookup, nook.stand, nook.facing, nook.bunker.visor != null, maxBlocks)
    : nookAround(lookup, nook.stand, nook.facing, maxBlocks)
}

export interface BunkerOptions {
  /** where the bot is (a nearer bunker is the cheaper) */
  from?: Vec3
  /** most blocks to put (default 12) */
  maxBlocks?: number
  /** the least share of the spawns its eyes see through the slit (default BUNKER_MIN_VIEW) */
  minView?: number
}

/**
 * The `n` cheapest bunkers by the spawner (bunkerAround), no two on the same stand: a floor cell BUNKER.minDistance to
 * maxDistance across from it, 3 under it to 2 over, out of its spawn volume, open at the feet and the head, none the
 * nether's paths may not step on (netherStepForbidden), facing the spawner (the cardinal way nearest it, within 35
 * degrees), its eyes seeing at least `minView` of the spawns through the slit (spawnView, the bunker built; without
 * the visor when only that way). The cheapest: the most spawns seen and within the sword's reach, the fewest blocks,
 * nearest the spawn volume, nearest the bot.
 */
export function planBlazeBunkers (lookup: NookLookup, spawner: Vec3, opts: BunkerOptions = {}, n = 3): BlazeNook[] {
  const maxBlocks = opts.maxBlocks ?? 12
  const minView = opts.minView ?? BUNKER_MIN_VIEW
  const S = spawner.floored()
  const found: Array<{ nook: BlazeNook, cost: number }> = []
  for (let dx = -BUNKER.maxDistance; dx <= BUNKER.maxDistance; dx++) {
    for (let dz = -BUNKER.maxDistance; dz <= BUNKER.maxDistance; dz++) {
      const h = Math.hypot(dx, dz)
      if (h < BUNKER.minDistance || h > BUNKER.maxDistance) continue
      const to = new Vec3(-dx, 0, -dz).scaled(1 / h)
      const facing = SIDES.reduce((a, b) => (b.dot(to) > a.dot(to) ? b : a))
      if (facing.dot(to) < Math.cos(35 * Math.PI / 180)) continue
      for (let dy = -3; dy <= 4; dy++) {
        const stand = S.offset(dx, dy, dz)
        if (inSpawnVolume(S, stand)) continue
        if (stand.offset(0.5, 0, 0.5).distanceTo(S.offset(0.5, 0.5, 0.5)) >= SPAWNER_ACTIVATION - 1) continue
        if (!isOpen(lookup(stand)) || !isOpen(lookup(stand.plus(UP))) || !isFloor(lookup(stand.offset(0, -1, 0)))) continue
        if (netherStepForbidden(lookup, stand)) continue
        let best: { nook: BlazeNook, cost: number } | null = null
        for (const visor of [true, false]) {
          const nook = bunkerAround(lookup, stand, facing, visor, maxBlocks)
          if (nook == null) continue
          const view = spawnView(lookup, S, nook)
          if (view.seen < minView) continue
          const floor = lookup(stand.offset(0, -1, 0))?.name ?? ''
          const cost = nook.build.length * 2 + Math.abs(h - BUNKER.standOff) - view.seen * 30 - view.reach * 10 + (visor ? 0 : 4) + Math.max(0, 1 - dy) * 2 +
            (floor === 'netherrack' ? 2 : 0) + (opts.from != null ? stand.offset(0.5, 0, 0.5).distanceTo(opts.from) * 0.2 : 0)
          if (best == null || cost < best.cost) best = { nook, cost }
        }
        if (best != null) found.push(best)
      }
    }
  }
  return found.sort((a, b) => a.cost - b.cost).slice(0, n).map(f => f.nook)
}

// ---- the fight

/** the blocks the nook is built of, the ones that don't burn first (fire on netherrack never goes out) */
export const NOOK_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'blackstone', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'basalt', 'stone_bricks', 'end_stone', 'dirt', 'netherrack']

/** the stone the nook's blocks leave in the bag while there are others (a brewing stand's 3 cobblestone, a furnace's 8) */
export const STONE_RESERVE = 8
const STONES = ['cobblestone', 'cobbled_deepslate', 'blackstone']

/**
 * The block a nook is built of: the first of NOOK_BLOCKS the bag has, the stone's last STONE_RESERVE kept while there's
 * another (a 26.3 bot's cover by the spawner used up its cobblestone, and the brew's stand went for the blackstone of the cave by
 * seed 2's open throne among 41 blazes, and burned)
 */
export function nookBlock (bot: Bot): string | null {
  const others = NOOK_BLOCKS.some(n => !STONES.includes(n) && countItems(bot, n) > 0)
  const stoneLow = countItems(bot, STONES) <= STONE_RESERVE
  return NOOK_BLOCKS.find(n => countItems(bot, n) > 0 && !(others && stoneLow && STONES.includes(n))) ?? null
}

export function nookBlocks (bot: Bot): number {
  return countItems(bot, NOOK_BLOCKS)
}

/** the bot's feet in the nook's cell */
export function inNook (bot: Bot, nook: BlazeNook): boolean {
  const p = bot.entity.position
  return Math.floor(p.x) === nook.stand.x && Math.floor(p.z) === nook.stand.z && Math.abs(p.y - nook.stand.y) < 0.6
}

/** the health the fire a small fireball lights takes (SmallFireball.onHitEntity: 5 s alight, 1 a second; on_fire passes armor by) */
export const BURN_HEALTH = 5

/**
 * The health the blaze fight goes by: the bot's, less what the fire it's alight with will take (isOnFire), so it shuts
 * itself in or backs off while that's still to come: a 26.3 bot at 10 health, alight among the blazes 4 off seed 2's
 * throne spawner at (-290, 77, -209), fought on, burned to 2, took another fireball and died (full-26.3-fresh-k)
 */
export function fightHealth (bot: Bot): number {
  return bot.health - (isOnFire(bot) && !fireProof(bot) ? BURN_HEALTH : 0)
}

/**
 * Whether the bot has fire resistance on: the blazes' fireballs and the fire they light do nothing to it then
 * (LivingEntity.hurtServer drops a damage of #is_fire, the fireball's and the burning's, with FIRE_RESISTANCE on)
 */
export function fireProof (bot: Bot): boolean {
  return hasEffect(bot, FIRE_RESISTANCE)
}

/** the potion's effect (skills/potion's name) */
export const FIRE_RESISTANCE = 'fire_resistance'
/** a fight's drinks of it that may fail (no effect after, the potion not equipped) before it stops trying */
export const DRINK_TRIES = 3

/** a blaze's eyes */
export function blazeEye (blaze: Entity): Vec3 {
  return blaze.position.offset(0, BLAZE_EYE_HEIGHT, 0)
}

/**
 * ticks with no blaze about the nook after which its spawner is taken for one that gives none (a spawner makes up to 4
 * every 200 to 800 ticks with the player within 16 of it: BaseSpawner.delay, requiredPlayerRange): a 26.3 bot sat in a
 * nook by a fortress's spawner 24000 ticks for no rod, twice over
 */
export const NOOK_IDLE_TICKS = 3000

/**
 * ticks a nook may go with no kill and no rod before it's given up for one nearer (fightFromNook's STUCK): a working
 * nook kills one in 400 to 600 (tests/integration/blaze at seed 7741's spawner, the nether stage's kit: 9 kills in 3413
 * ticks); a 26.3 whole game's sat 20861 ticks by that spawner for 2 kills and no rod, its 12 arrows gone
 */
export const NOOK_STALL_TICKS = 3000
/** the same with no bow and arrows: only a blaze come into the sword's reach is killed */
export const NOOK_STALL_UNARMED = 1000
/** the same in a bunker */
export const BUNKER_STALL_TICKS = 4000
/** a bunker's lure (its slit shut a while) after this many ticks with no kill, once each BUNKER_LURE_EVERY at most */
export const BUNKER_LURE_AFTER = 400
export const BUNKER_LURE_EVERY = 60
/** the lures for each kill at the most */
export const BUNKER_LURES = 6
/** the ticks the lure keeps the slit shut: the blazes come on 5 of them (BlazeAttackGoal's lastSeen < 5) */
export const BUNKER_LURE_TICKS = 10

export interface NookFightOptions {
  /** rods to have */
  count: number
  /** the spawner, to look toward */
  spawner: Vec3
  /** shut the front and heal at or under this health (default 10) */
  sealAt?: number
  /** heal to this before opening it again (default 18) */
  healTo?: number
  /** eat at or under this health when it's safe to (default 14), or this food level (default 14) */
  eatAt?: number
  eatFood?: number
  /** give up after this many ticks (default 24000) */
  maxTicks?: number
  /** blazes further than this aren't shot (default 28) */
  shootRange?: number
  /** give up when no blaze has been within 48 for this many ticks (default NOOK_IDLE_TICKS) */
  idleTicks?: number
  /**
   * give up (STUCK) when no blaze has been killed and no rod got for this many ticks, the ticks shut in to heal left
   * out (default NOOK_STALL_TICKS; NOOK_STALL_UNARMED once out of arrows)
   */
  stallTicks?: number
  /** called on each kill */
  onKill?: (blaze: Entity) => void
  /**
   * a bunker's errand out of it when it's quiet (its spawner's lighting: lightFromBunker), tried where its fetches are;
   * resolves whether it went
   */
  errand?: () => Promise<boolean>
}

export interface NookFightResult {
  kills: number
  shots: number
  blocked: number
  ticks: number
}

const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow']

/** with no food left to heal on, the nook's fight ends at this health (fightFromNook's MISSING_ITEMS) */
export const NOOK_LEAVE_HEALTH = 16

/**
 * Whether the bag holds a meal to heal on (chooseFood's pick for a half-empty bar at low health: a golden apple counts,
 * the harmful foods don't). FoodData.tick heals only with the bar at 18 or more.
 */
export function mealLeft (bot: Bot): boolean {
  const items = bot.inventory.items()
  const offhand = bot.inventory.slots[45]
  if (offhand != null) items.push(offhand)
  return chooseFood(items, bot.registry.foodsByName as any, { food: 10, saturation: 0, health: 1 }) != null
}

/** tries at shutting the nook's front, low, before the nook is given up (fightFromNook's CANNOT_PLACE) */
export const SEAL_FAILS = 5

/** ticks before a front that wouldn't shut against a volley (no shield) is tried again */
export const SHUT_AGAIN_TICKS = 40

/**
 * Whether a swing at the one in reach can go with the shield down: the shield back up (SHIELD_DELAY_TICKS) before any
 * other blaze that sees the bot can shoot (BlazeVolleys), and no small fireball near. The one in reach doesn't shoot
 * within 2 blocks (BlazeAttackGoal hits instead).
 */
export function meleeWindow (bot: Bot, volleys: BlazeVolleys, tick: number, seeing: readonly Entity[], close: Entity): boolean {
  const lead = SHIELD_DELAY_TICKS + 2
  const near = close.position.distanceTo(bot.entity.position) < 2
  if (seeing.some(b => (b !== close || !near) && volleys.dangerous(b.id, tick, lead))) return false
  return !Object.values(bot.entities).some(e => e.name === SMALL_FIREBALL && fireballIncoming(bot, e, 8))
}

/** the sword's reach a blaze is met in out of the nook (the eyes to its box: the player's interaction range, 3, less a margin) */
export const MELEE_REACH = 2.9

/** the melee mobs (besides the blazes) the nook's fight meets itself, with the sword once in reach */
export const NOOK_MELEE = ['magma_cube']
/**
 * and a bunker's: the fortress's skeletons too, none of which gets in at its slit (a wither skeleton 2.4 high, a
 * skeleton 1.99) nor shoots but through it, at the shield. The hostiles reflex went out of a bunker by seed 2's throne
 * at (-277, 77, -159) after a wither skeleton, fled it into the throne and fought its blazes there till they killed the
 * bot, its 9 rods with it (26.3)
 */
export const BUNKER_MELEE = [...NOOK_MELEE, 'wither_skeleton', 'skeleton']

/** the bow's draw to a full-power shot (BowItem.getPowerForTime: full from 20 ticks), a tick to spare */
const FULL_DRAW = 21
/** a draw cut short by a blaze about to shoot is loosed from this many ticks on (the power then about 0.7) */
const MIN_DRAW = 14

/** a blaze's small fireball starts this far over its feet (BlazeAttackGoal: getY(0.5) + 0.5 of its 1.8) */
export const FIREBALL_SPAWN_HEIGHT = 1.4

/**
 * Whether a small fireball from `from` aimed at the bot's middle (BlazeAttackGoal: the target's getY(0.5); its
 * spread is across only) comes to it with no block first: the projectile's move is clipped as a line
 * (ProjectileUtil.getHitResultOnMoveVector, ClipContext.Block.COLLIDER), and a bunker's sill takes the ones from about
 * the bot's height and under it
 */
export function fireballReaches (bot: Bot, from: Vec3): boolean {
  const to = bot.entity.position.offset(0, 0.9, 0)
  const d = to.minus(from)
  const len = d.norm()
  if (len < 1e-6) return true
  const hit: any = (bot.world as any).raycast(from, d.scaled(1 / len), len)
  return hit == null || (hit.intersect != null && hit.intersect.distanceTo(from) >= len - 1e-3)
}

/** whether a blaze sees the bot from where it is (its eyes to the bot's: Sensing.hasLineOfSight) */
export function blazeSeesBot (bot: Bot, blaze: Entity): boolean {
  const from = blazeEye(blaze)
  const to = eyePosition(bot)
  const d = to.minus(from)
  const len = d.norm()
  if (len < 1e-6) return true
  const hit: any = (bot.world as any).raycast(from, d.scaled(1 / len), len)
  if (hit == null) return true
  return hit.intersect != null && hit.intersect.distanceTo(from) >= len - 1e-3
}

/**
 * Fights the blazes from the nook till the bot has `count` rods: each tick, the shield up (the sword in hand, faced
 * at the nearest danger) while a blaze that sees the bot may shoot within SHIELD_LEAD_TICKS (BlazeVolleys) or a small
 * fireball comes; else a blaze within reach hit, or the one in sight shot with the bow (its draw loosed early when a
 * danger comes); the rods picked up when it's quiet; the front shut to heal when low. Throws when the bot leaves the
 * nook's dimension, dies or runs out of ticks.
 */
export async function fightFromNook (bot: Bot, nook: BlazeNook, opts: NookFightOptions, signal?: AbortSignal): Promise<NookFightResult> {
  const sealAt = opts.sealAt ?? 10
  const healTo = opts.healTo ?? 18
  const eatAt = opts.eatAt ?? 14
  const eatFood = opts.eatFood ?? 14
  const maxTicks = opts.maxTicks ?? 24000
  const shootRange = opts.shootRange ?? 28
  const idleTicks = opts.idleTicks ?? NOOK_IDLE_TICKS
  let lastBlaze = 0
  let lastGain = 0
  let rods = countItems(bot, 'blaze_rod')
  const volleys = new BlazeVolleys()
  const world = arrowWorld(bot)
  const tracker = motionTrackerOf(bot)
  const strength = attackStrengthOf(bot)
  const result: NookFightResult = { kills: 0, shots: 0, blocked: 0, ticks: 0 }
  let tick = 0
  let drawn = 0
  let drawTarget: Entity | null = null
  let blocking = false
  let outside = 0
  let sealAgain = 0
  let shutUntil = 0
  let sealFails = 0
  let shutAgain = 0
  let drinkFails = 0
  let lastReport = 0
  let lureAgain = 0
  let fireCheck = 0
  let lures = 0
  let lureGain = 0
  let lastInSight = 0
  let turnAgain = 0
  const tracked = new Set<number>()
  const dead = new Set<number>()
  const tried = new Map<number, number>()
  const onDead = (e: Entity): void => {
    if (e.name !== 'blaze') return
    dead.add(e.id)
    lastGain = tick
    result.kills++
    opts.onKill?.(e)
  }
  const onTick = (): void => { tick++ }
  bot.on('entityDead', onDead)
  bot.on('physicsTick', onTick)
  // the magma cubes are the nook's to meet (the sword at one come into reach), not the hostiles reflex's: it went
  // after them out of the nook, about the basalt delta under the blazes' fire (26.3, seed 2's spawner: 19 times in a
  // fight of 9898 ticks)
  const melee = nook.bunker != null ? BUNKER_MELEE : NOOK_MELEE
  const leave = (bot as any).survival?.reflexes?.leaveAlone?.(melee) as (() => void) | undefined
  const sword = (): any => bestMeleeWeapon(bot, 'blaze')
  const bow = (): any => bot.inventory.items().find(i => i.name === 'bow') ?? null
  const hasArrows = (): boolean => countItems(bot, ARROWS) > 0
  const hasShield = (): boolean => countItems(bot, 'shield') > 0
  const hold = async (item: any): Promise<void> => {
    if (item != null && bot.heldItem?.type !== item.type) await bot.equip(item, 'hand')
  }
  const look = async (p: Vec3): Promise<void> => { await bot.lookAt(p, true) }
  const stopDraw = (): void => {
    if (drawn > 0) bot.deactivateItem()
    drawn = 0
    drawTarget = null
  }
  const block = async (at: Vec3): Promise<void> => {
    if (drawn > 0) stopDraw()
    if (!blocking || (bot as any).usingHeldItem !== true) {
      await hold(sword())
      blocking = await raiseShield(bot).catch(() => false)
    }
    await look(at)
  }
  const unblock = (): void => {
    if (blocking) lowerShield(bot)
    blocking = false
  }
  const blazesNow = (): Entity[] => Object.values(bot.entities)
    .filter(e => e.name === 'blaze' && !dead.has(e.id) && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= 48)
  try {
    // (a bunker's fight with its rods goes on till it's quiet to go out of it: bunkerDepartDue)
    let reached: number | null = null
    for (;;) {
      if (countItems(bot, 'blaze_rod') >= opts.count) {
        if (nook.bunker == null || !inNook(bot, nook)) break
        reached ??= tick
        if (bunkerDepartDue(bot, fightHealth(bot)) || tick - reached > BUNKER_DEPART_WAIT) break
      }
      throwIfAborted(signal)
      if (bot.health <= 0) throw new SkillError('VERIFY_FAILED', 'the bot died in the nook', { ...result, ticks: tick })
      // the fireballs' fire in the nook's cells put out here (the hazard reflex leaves it to the fight: handleFire)
      if (!fireProof(bot) && await putOutFireOnBot(bot, signal) > 0) continue
      if (tick > maxTicks) throw new SkillError('TIMEOUT', `${countItems(bot, 'blaze_rod')} of ${opts.count} blaze rods after ${tick} ticks in the nook`, { ...result, ticks: tick })
      // nothing left to heal on (no meal, the bar under 18): the fight ends while the health's still up (a 26.3 bot
      // ate its last meal in the nook by seed 7741's spawner, sat 15000 ticks shut in it at 4.9 health, then came out
      // among 12 blazes and burned)
      if (!mealLeft(bot) && bot.food < 18 && bot.health <= NOOK_LEAVE_HEALTH) throw new SkillError('MISSING_ITEMS', `no food left to heal on in the nook, health ${bot.health.toFixed(1)}`, { ...result, ticks: tick })
      const blazes = blazesNow()
      if (blazes.length > 0) lastBlaze = tick
      else if (tick - lastBlaze > idleTicks) throw new SkillError('NOT_FOUND', `no blaze came from the blaze spawner at ${opts.spawner.toString()} in ${idleTicks} ticks`, { ...result, ticks: tick })
      // blazes about but none killed for long (out of the bow's sight or reach, the arrows gone): a nook nearer
      if (countItems(bot, 'blaze_rod') > rods) { rods = countItems(bot, 'blaze_rod'); lastGain = tick }
      // (a bunker's sword meets the blazes that come to its slit: as long with no bow)
      const stall = opts.stallTicks ?? (nook.bunker != null ? BUNKER_STALL_TICKS : bow() != null && hasArrows() ? NOOK_STALL_TICKS : NOOK_STALL_UNARMED)
      if (tick - lastGain > stall) throw new SkillError('STUCK', `no blaze killed from the nook in ${tick - lastGain} ticks`, { ...result, ticks: tick })
      if (!inNook(bot, nook)) {
        // out of it (a drop fetched, a reflex's work): the shield up where it is while a blaze that sees it is about
        // to shoot, then in
        stopDraw()
        volleys.update(blazes.map(b => ({ id: b.id, charged: blazeCharged(bot, b) })), tick)
        const threat = blazes.filter(b => blazeSeesBot(bot, b) && volleys.dangerous(b.id, tick)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        if (threat != null && outside++ < 200) {
          bot.clearControlStates()
          await block(blazeEye(threat))
          await waitTicks(bot, 1, signal)
          continue
        }
        outside = 0
        unblock()
        await enterNook(bot, nook, signal)
        continue
      }
      for (const b of blazes) if (!tracked.has(b.id)) { tracked.add(b.id); tracker.track(b) }
      volleys.update(blazes.map(b => ({ id: b.id, charged: blazeCharged(bot, b) })), tick)
      const seeing = blazes.filter(b => blazeSeesBot(bot, b))
      const me = bot.entity.position
      if (tick - lastReport >= 400) {
        lastReport = tick
        const nearest = blazes.reduce((d, b) => Math.min(d, b.position.distanceTo(me)), Infinity)
        trace(`fightFromNook: tick ${tick}, ${blazes.length} blazes within 48 (nearest ${nearest.toFixed(1)}), ${seeing.length} seeing the bot, ${result.kills} kills, ${result.shots} shots, health ${bot.health.toFixed(1)}`)
      }
      const near = (a: Entity, b: Entity): number => a.position.distanceTo(me) - b.position.distanceTo(me)
      // (fire resistant, no fireball nor volley is a danger: the bow and the fetches go on through them)
      const proof = fireProof(bot)
      // (in a bunker, only the shots that reach the bot past its sill: fireballReaches. With 5 to 8 blazes about seeing
      // it, shooting at the sill, one or another was always about to shoot, and the shield held up for them let the bow
      // shoot none for 4000 ticks, by seed 2's open throne at (-290, 77, -209), 26.3)
      const reaches = (from: Vec3): boolean => nook.bunker == null || fireballReaches(bot, from)
      const fireball = proof ? undefined : Object.values(bot.entities).find(e => e.name === SMALL_FIREBALL && fireballIncoming(bot, e, 24) && reaches(e.position))
      // (a bunker's: any charged blaze whose shot's line reaches it, seen or not: the client's ray from its eyes to the
      // bot's, through a fence's cell, isn't the server's; 26.3 bots in their bunker by seed 2's throne at (-277, 77,
      // -159) took fireball after fireball with the shield down from blazes behind its fence they 'didn't see', and burned)
      const danger = proof ? [] : (nook.bunker != null ? blazes : seeing).filter(b => volleys.dangerous(b.id, tick) && reaches(b.position.offset(0, FIREBALL_SPAWN_HEIGHT, 0))).sort(near)

      // fire in the nook (a fireball's on the floor by the feet), or on a bunker's sill: out at once
      for (const p of [nook.stand, nook.stand.plus(UP), ...(nook.bunker != null ? [nook.bunker.slit] : [])]) {
        const b = bot.blockAt(p)
        if (b != null && (b.name === 'fire' || b.name === 'soul_fire')) await bot.dig(b as any, true).catch(() => {})
      }
      // and the fires the eyes see by a bunker, where its kills' rods fall (one on netherrack burns for good, and a rod
      // that falls in burns: 2 of a 26.3 bunker's by seed 2's open throne at (-290, 77, -209)), when nothing's about to
      // shoot: punched out from inside
      if (nook.bunker != null && tick >= fireCheck && danger.length === 0 && fireball == null && drawn === 0) {
        fireCheck = tick + BUNKER_FIRE_EVERY
        const fires = bunkerFires(bot, nook)
        if (fires.length > 0) {
          unblock()
          for (const f of fires) { const b = bot.blockAt(f); if (b != null) await bot.dig(b as any, true).catch(() => {}) }
          continue
        }
      }

      // one come close (in the front, hitting: BlazeAttackGoal within 2 blocks): the sword, the shield up between the
      // swings (a blaze in the front cell keeps the front from being shut: a 26.3 bot at 9 health tried to shut it
      // for 1200 ticks, the blaze punching it the while, and died). The swing goes while the others charge, as long as
      // none can shoot before the shield is up again (meleeWindow); without a shield, whenever the sword's ready
      const eye = eyePosition(bot)
      const inReach = (e: Entity): boolean => distanceToBox(eye, entityBox(e)) <= 2.9
      // (a blaze hovering in the front over the roof's edge, its eyes not seeing the bot's, is hit all the same: in the
      // front cell it kept the front from being shut, 26.3, seed 7741's bridge)
      const close = seeing.find(inReach) ?? blazes.find(b => inReach(b) && seenPoint(bot, b) != null) ??
        Object.values(bot.entities).find(e => melee.includes(e.name ?? '') && isAlive(bot, e) && inReach(e) && hasLineOfSight(bot, e))
      if (close != null && (danger.length === 0 || proof || !hasShield() || meleeWindow(bot, volleys, tick, seeing, close))) {
        stopDraw()
        await hold(sword())
        if (strength.ticksToFull() <= 0) {
          unblock()
          await look(meleeAimPoint(bot, close))
          strength.attack(close)
        } else if (strength.ticksToFull() > 1 && hasShield()) {
          await block(blazeEye(close))
        } else {
          await look(meleeAimPoint(bot, close))
        }
        await waitTicks(bot, 1, signal)
        continue
      }

      // fire resistance on with blazes about, when there's a potion of it, drunk (32 ticks) when nothing can shoot
      // before it's down, as a meal is (or shut in, sealAndHeal's): the fireballs and their burning are nothing then
      if (!proof && drinkFails < DRINK_TRIES && blazes.length > 0 && drawn === 0 && findPotion(bot, FIRE_RESISTANCE) != null && seeing.every(b => volleys.quietFor(b.id, tick, 34))) {
        unblock()
        try {
          trace('fightFromNook: fire resistance drunk, health', bot.health)
          if (!await drinkPotion(bot, FIRE_RESISTANCE, signal)) drinkFails++
        } catch (err) {
          if (isAbort(err)) throw err
          drinkFails++
          trace('fightFromNook: fire resistance:', (err as Error).message)
          await waitTicks(bot, 1, signal)
        }
        continue
      }

      // low: the front shut, fed and healed inside; healed (or back after a reflex cut the healing off), open again.
      // A front that won't shut (a blaze in it) is tried again in a while, the fight going on meanwhile
      if (fightHealth(bot) <= sealAt && tick >= sealAgain && close == null) {
        unblock()
        stopDraw()
        const shutAt = tick
        const shut = await sealAndHeal(bot, nook, healTo, signal)
        // (the ticks shut in to heal aren't the nook's to give nothing in)
        lastGain += tick - shutAt
        if (!shut) {
          sealAgain = tick + 40
          // a front that won't shut for long is no cover: the nook given up for another (a 26.3 bot low in a nook by
          // seed 2's spawner at (97, 64, -515) tried its front 50 times in 2000 ticks, 'No block has been placed', and
          // was shot dead there, twice: run mag-c)
          if (++sealFails >= SEAL_FAILS) throw new SkillError('CANNOT_PLACE', `the nook's front at ${nook.front[0].toString()} won't shut`, { ...result, ticks: tick })
        }
        continue
      }

      // no shield (broken: 6 of its 336 a blocked fireball): the front shut against what's about to come, open again
      // once it's quiet
      // (shut for a volley's length at least: behind the shut front no blaze is seen to be about to shoot). A front
      // that won't shut is tried again in a while, the bow and the sword going on meanwhile: a 26.3 bot with no shield
      // tried it every tick for 3000 ticks, standing there, 'nothing solid to place against', and was shot to 5 health
      if (!hasShield() && (danger.length > 0 || fireball != null) && tick >= shutAgain) {
        stopDraw()
        const missed = nook.front.some(p => bot.blockAt(p)?.boundingBox !== 'block') ? await fillNook(bot, nook.front, signal) : 0
        if (missed === 0) {
          shutUntil = tick + BLAZE_CHARGE_TICKS + 18 + FIREBALL_FLIGHT_TICKS
          await waitTicks(bot, 1, signal)
          continue
        }
        shutAgain = tick + SHUT_AGAIN_TICKS
      }
      if (nook.front.some(p => bot.blockAt(p)?.boundingBox === 'block') && fightHealth(bot) > sealAt && tick >= shutUntil && danger.length === 0 && fireball == null) {
        unblock()
        await openNook(bot, nook, signal)
        continue
      }

      if ((danger.length > 0 || fireball != null) && hasShield()) {
        // a full draw goes off first (the shield is up 5 ticks later all the same; the shot may be the kill)
        if (drawn >= MIN_DRAW && drawTarget != null && isAlive(bot, drawTarget)) {
          const s = aim(bot, drawTarget, { leadTicks: 1, world })
          if (s != null) await bot.look(s.yaw, s.pitch, true)
          await waitTicks(bot, 1, signal)
          bot.deactivateItem()
          drawn = 0
          drawTarget = null
          result.shots++
        }
        const at = danger[0] != null ? blazeEye(danger[0]) : (fireball as Entity).position
        await block(at)
        result.blocked++
        await waitTicks(bot, 1, signal)
        continue
      }

      // a meal, when nothing can shoot before it's eaten (32 ticks), and one that fits the bar unless the health needs
      // it (dueMeal: under 18 the bar heals nothing; at 18 and 19 a porkchop's nutrition was mostly lost over it)
      const hungry = (bot.health <= eatAt && bot.food < 20) || bot.food <= eatFood
      const meal = hungry && drawn === 0 ? dueMeal(bot, { hurtAt: eatAt }) : null
      if (meal != null && seeing.every(b => volleys.quietFor(b.id, tick, 34))) {
        unblock()
        try { await eat(bot, { signal, food: meal }) } catch (err) { if (isAbort(err)) throw err; trace('fightFromNook: eat:', (err as Error).message) }
        continue
      }

      if (nook.bunker != null && drawn === 0 && opts.errand != null && seeing.length === 0) {
        unblock()
        if (await opts.errand()) { blocking = false; continue }
      }
      if (nook.bunker != null) {
        // a rod by the sill (a blaze the sword killed at the slit drops it 2 off, out of the bot's reach in its cell): the
        // bot a step out into the sill's cell for it and back (sillPickup), when no blaze is on it there
        const bySill = drawn === 0 ? sillDrops(bot, nook).find(e => (tried.get(e.id) ?? 0) < DROP_TRIES) : undefined
        if (bySill != null && sillPickupDue(bot, nook, fightHealth(bot), () => seeing.every(b => volleys.quietFor(b.id, tick, FETCH_QUIET)))) {
          tried.set(bySill.id, (tried.get(bySill.id) ?? 0) + 1)
          unblock()
          await sillPickup(bot, nook, bySill, signal)
          blocking = false
          continue
        }
        // no blaze in its slit's sight for long, some about it behind its walls (they gather round the bot out of its
        // sight: BlazeAttackGoal takes them toward it each time they lose it): the slit turned toward the most of them
        if (seeing.length > 0) lastInSight = tick
        const way = tick - lastInSight > BUNKER_TURN_AFTER && tick >= turnAgain ? bunkerTurnWay(nook, blazes.map(b => b.position)) : null
        if (way != null) {
          turnAgain = tick + BUNKER_TURN_AFTER
          unblock()
          stopDraw()
          const turned = await turnBunker(bot, nook, way, signal)
          if (turned != null) { nook = turned; lastInSight = tick }
          continue
        }
      }

      // the rods on the floor before another shot (between draws), whenever no blaze that sees the bot can shoot for
      // FETCH_QUIET: the bow's turn came first and the fetch only with every blaze quiet for 75 ticks, which with two or
      // three about never was, and the nooks at seed 2's spawners at (97, 64, -515) and (925, 64, 123) killed blazes
      // for 20000 ticks with their rods left on the throne (26.3 runs mag-b and mag-d: 0 rods)
      // (a bunker's: with few blazes about, healed, out of it by the sill: bunkerFetchDue)
      const drop = nook.bunker != null
        ? (drawn === 0 ? bunkerDrops(bot, nook).find(e => (tried.get(e.id) ?? 0) < DROP_TRIES && bunkerFetchDue(bot, nook, fightHealth(bot), () => seeing.every(b => volleys.quietFor(b.id, tick, FETCH_QUIET)), proof, e.position)) : undefined)
        : drawn === 0 && fetchWanted(fightHealth(bot), sealAt, proof, () => seeing.every(b => volleys.quietFor(b.id, tick, FETCH_QUIET)))
          ? dropsNear(bot, nook).find(e => (tried.get(e.id) ?? 0) < DROP_TRIES)
          : undefined
      if (drop != null) {
        tried.set(drop.id, (tried.get(drop.id) ?? 0) + 1)
        unblock()
        stopDraw()
        if (nook.bunker != null) await fetchFromBunker(bot, nook, drop, { volleys, now: () => tick, sealAt }, signal)
        else await fetchDrops(bot, nook, drop, { volleys, now: () => tick, sealAt }, signal)
        blocking = false
        continue
      }

      // the bow at the nearest one in sight it has a shot at
      const b0 = bow()
      if (b0 != null && hasArrows()) {
        if (drawTarget != null && (!isAlive(bot, drawTarget) || dead.has(drawTarget.id) || !seeing.includes(drawTarget))) stopDraw()
        const target: Entity | null = drawTarget ?? seeing.filter(b => b.position.distanceTo(me) <= shootRange).sort(near).find(b => aim(bot, b, { leadTicks: FULL_DRAW, world }) != null) ?? null
        if (target != null) {
          if (drawn === 0) {
            unblock()
            await hold(b0)
            bot.activateItem()
            drawTarget = target
          }
          drawn++
          // (no shot at it for long: loosed as it is, and another one looked for)
          if (drawn > 3 * FULL_DRAW) { stopDraw(); continue }
          const s = aim(bot, target, { leadTicks: Math.max(1, FULL_DRAW - drawn + 1), world })
          if (s != null) await bot.look(s.yaw, s.pitch, true)
          if (drawn >= FULL_DRAW && s != null) {
            await waitTicks(bot, 1, signal)
            bot.deactivateItem()
            drawn = 0
            drawTarget = null
            result.shots++
            continue
          }
          await waitTicks(bot, 1, signal)
          continue
        }
      }
      stopDraw()

      // a bunker's blazes that see the bot, out of the sword's reach and the bow's shot (under its sill, by the slit's
      // edge), drawn in: the slit shut BUNKER_LURE_TICKS, out of their sight they come at the bot (Blaze.BlazeAttackGoal:
      // the target unseen under 5 ticks, the move toward it), then open again. A bunker by seed 2's throne spawners went
      // 4000 ticks with 3 to 5 blazes 4 off seeing it, shooting at its sill, and no kill (26.3)
      // (BUNKER_LURES at most for each kill: a 1.21.11 bunker by seed 2's throne at (-277, 77, -159) shut its slit on 3
      // to 5 blazes every 60 ticks for 3000, none of them coming)
      if (lureGain !== lastGain) { lureGain = lastGain; lures = 0 }
      if (nook.bunker != null && seeing.length > 0 && tick - lastGain > BUNKER_LURE_AFTER && tick >= lureAgain && lures < BUNKER_LURES && nook.front.every(p => bot.blockAt(p)?.boundingBox !== 'block')) {
        lureAgain = tick + BUNKER_LURE_EVERY
        lures++
        trace('fightFromNook: the slit shut to draw in', seeing.length, 'blazes')
        unblock()
        if (await fillNook(bot, nook.front, signal, false, false) === 0) shutUntil = tick + BUNKER_LURE_TICKS
        continue
      }

      // nothing to do: the shield up, toward the nearest blaze, else the spawner
      const watch = seeing.sort(near)[0] ?? blazes.sort(near)[0]
      await block(watch != null ? blazeEye(watch) : opts.spawner.offset(0.5, 1.5, 0.5))
      await waitTicks(bot, 1, signal)
    }
  } finally {
    leave?.()
    bot.off('entityDead', onDead)
    bot.off('physicsTick', onTick)
    for (const id of tracked) { const e = bot.entities[id]; if (e != null) tracker.untrack(e) }
    if (drawn > 0) bot.deactivateItem()
    unblock()
  }
  result.ticks = tick
  return result
}

/**
 * Where to look to hit an entity close by: the first point up its middle (half its height, then lower, then higher)
 * the eyes see without a block between (a blaze hovering in the nook's front is under its roof's edge: looked at high,
 * the crosshair met the roof and no swing went, 200 ticks, the blaze hitting the bot till it died)
 */
export function meleeAimPoint (bot: Bot, e: Entity): Vec3 {
  return seenPoint(bot, e) ?? e.position.offset(0, (e.height ?? 1) / 2, 0)
}

/** the first point up an entity's middle the eyes see with no block between (meleeAimPoint's), null when none is */
export function seenPoint (bot: Bot, e: Entity): Vec3 | null {
  const eye = eyePosition(bot)
  const h = e.height ?? 1
  for (const f of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const p = e.position.offset(0, h * f, 0)
    const d = p.minus(eye)
    const len = d.norm()
    if (len < 1e-6) return p
    const hit: any = (bot.world as any).raycast?.(eye, d.scaled(1 / len), len)
    if (hit == null || (hit.intersect != null && hit.intersect.distanceTo(eye) >= len - 1e-3)) return p
  }
  return null
}

/** drops further than this from the nook are left (a walk under the blazes' fire; the spawner's own floor is 10 off) */
export const DROP_REACH = 14

/**
 * The blaze rods lying near the nook (the kills' drops), and a magma cube's cream (fire resistance's making: the cubes
 * the nook's sword meets), on a floor no lower than 3 under it, nearest first: the rest (a wither skeleton's bones and
 * coal) is left, not worth the walk under the blazes
 */
export function dropsNear (bot: Bot, nook: BlazeNook): Entity[] {
  const at = nook.stand.offset(0.5, 0, 0.5)
  return nearbyDrops(bot, at, DROP_REACH, ['blaze_rod', 'magma_cream']).filter(e => e.position.y >= nook.stand.y - 3)
}

/** ticks with no blaze that sees the bot able to shoot that a fetch of the rods on the floor starts in */
export const FETCH_QUIET = 20
/**
 * the health a rod fetch goes at whatever the volleys: with only the quiet's fetches a 26.3 bot in iron armor picked up
 * 1 of the 10 rods its kills dropped in seed 2's throne at (-277, 77, -159), the rest burnt or despawned there, 5 left
 * lying at its death (tests/integration/blaze BLAZE_KIT=runIron)
 */
export const FETCH_BOLD_HEALTH = 18
/**
 * Whether a rod fetch goes now, by the fight's health: over `sealAt` + 4 with every blaze that sees the bot quiet for
 * FETCH_QUIET, or fire resistant, or at FETCH_BOLD_HEALTH whatever the volleys (the fetch stops behind the shield for a
 * shot coming)
 */
export function fetchWanted (health: number, sealAt: number, proof: boolean, quiet: () => boolean): boolean {
  return health > sealAt + 4 && (proof || health >= FETCH_BOLD_HEALTH || quiet())
}

/** times a rod on the floor is gone for */
export const DROP_TRIES = 4
/** the most ticks a fetch takes, its waits behind the shield too */
export const FETCH_TICKS = 400

export interface FetchWatch {
  /** the nook fight's volleys and its tick */
  volleys: BlazeVolleys
  now: () => number
  /** a fetch is given up at this health */
  sealAt: number
  /** and when this says so */
  abort?: () => boolean
}

/**
 * An item near the nook picked up, back in after: the walk to it stopped while a blaze that sees the bot may shoot
 * (BlazeVolleys, or a small fireball coming), the shield up toward it where the bot stands till the volley's by, then
 * on to the item, not back to the nook (the walks cut off by each charge went back in, and the rods stayed on the
 * floor); FETCH_TICKS at most, or till the health is down to `sealAt`
 */
/**
 * whether the bot's body is in a fire's cell (BaseFireBlock.entityInside: any cell its box is in), the cells of the
 * feet and the head at the box's corners
 */
export function inFireCell (bot: Bot): boolean {
  const p = bot.entity.position
  for (const dy of [0, 1]) {
    for (const dx of [-0.3, 0.3]) {
      for (const dz of [-0.3, 0.3]) {
        const name = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz))?.name
        if (name === 'fire' || name === 'soul_fire') return true
      }
    }
  }
  return false
}

/**
 * The fire in the cells of the bot's body put out (a fire's block broken at once, punched), so it doesn't stand in
 * it: the hazard reflex leaves the fire's cells to the blaze fight (handleFire). Resolves how many
 */
export async function putOutFireOnBot (bot: Bot, signal?: AbortSignal): Promise<number> {
  if (!inFireCell(bot)) return 0
  const p = bot.entity.position
  const cells: Vec3[] = []
  for (const dy of [0, 1]) for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) {
    const c = new Vec3(p.x + dx, p.y + dy, p.z + dz).floored()
    if (!cells.some(q => q.equals(c))) cells.push(c)
  }
  let out = 0
  for (const c of cells) {
    throwIfAborted(signal)
    const b = bot.blockAt(c)
    if (b == null || (b.name !== 'fire' && b.name !== 'soul_fire')) continue
    await bot.dig(b as any, true).then(() => { out++ }, () => {})
  }
  if (out > 0) trace('fightFromNook: put out', out, 'fires where the bot stands')
  return out
}

export async function fetchDrops (bot: Bot, nook: BlazeNook, item: Entity, watch: FetchWatch, signal?: AbortSignal): Promise<void> {
  const start = watch.now()
  let blocking = false
  let walks = 0
  const threat = (): Entity | null => {
    const blazes = Object.values(bot.entities).filter(e => e.name === 'blaze' && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= 48)
    watch.volleys.update(blazes.map(b => ({ id: b.id, charged: blazeCharged(bot, b) })), watch.now())
    // (fire resistant, the fireballs are nothing to stop for)
    if (fireProof(bot)) return null
    const danger = blazes.filter(b => blazeSeesBot(bot, b) && watch.volleys.dangerous(b.id, watch.now()))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    return danger ?? Object.values(bot.entities).find(e => e.name === SMALL_FIREBALL && fireballIncoming(bot, e, 24)) ?? null
  }
  // a blaze in the sword's reach (BlazeAttackGoal: one within 2 hits instead of shooting, every 20 ticks): met with the
  // sword, the shield up toward it between the swings. The rods lie in the throne the bow's nook shoots into, and a
  // fetch there walked on with the throne's blazes punching it, 6 hits in 50 ticks, and a 26.3 bot in iron died there
  // with its rods round it (tests/integration/blaze BLAZE_AT=s2fortress BLAZE_KIT=gateIronBow)
  const strength = attackStrengthOf(bot)
  const closeBlaze = (): Entity | null => {
    const eye = eyePosition(bot)
    return Object.values(bot.entities)
      .filter(e => e.name === 'blaze' && isAlive(bot, e) && distanceToBox(eye, entityBox(e)) <= MELEE_REACH && seenPoint(bot, e) != null)
      .sort((a, b) => distanceToBox(eye, entityBox(a)) - distanceToBox(eye, entityBox(b)))[0] ?? null
  }
  trace('fightFromNook: drops at', item.position.toString())
  try {
    while (bot.entities[item.id] === item && watch.now() - start < FETCH_TICKS && fightHealth(bot) > watch.sealAt && watch.abort?.() !== true) {
      throwIfAborted(signal)
      // in a fire's cell, not fire resistant: back to the nook, never held there behind the shield (a 26.3 bot whose
      // fetch stopped for a charged blaze in seed 2's throne at (-277, 77, -159) stood in the fireballs' fire with its
      // shield up, 17.9 health to 2 in 80 ticks, and the blazes finished it with its 2 rods for the brew)
      if (!fireProof(bot) && inFireCell(bot)) { trace('fightFromNook: drops: in fire, back to the nook'); break }
      const t = threat()
      if (t != null) {
        // the shield up where the bot stands, at it
        bot.clearControlStates()
        if (!blocking || (bot as any).usingHeldItem !== true) {
          const sword = bestMeleeWeapon(bot, 'blaze')
          if (sword != null && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand')
          blocking = await raiseShield(bot).catch(() => false)
        }
        await bot.lookAt(t.name === 'blaze' ? blazeEye(t) : t.position, true)
        await waitTicks(bot, 1, signal)
        continue
      }
      const close = closeBlaze()
      if (close != null) {
        bot.clearControlStates()
        const sword = bestMeleeWeapon(bot, 'blaze')
        if (sword != null && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand')
        if (strength.ticksToFull() <= 0) {
          if (blocking) { lowerShield(bot); blocking = false }
          await bot.lookAt(meleeAimPoint(bot, close), true)
          strength.attack(close)
        } else {
          if (!blocking || (bot as any).usingHeldItem !== true) blocking = await raiseShield(bot).catch(() => false)
          await bot.lookAt(blazeEye(close), true)
        }
        await waitTicks(bot, 1, signal)
        continue
      }
      if (blocking) { lowerShield(bot); blocking = false }
      const cut = new AbortController()
      const onParent = (): void => cut.abort(signal?.reason)
      signal?.addEventListener('abort', onParent, { once: true })
      const onTick = (): void => { if (threat() != null || closeBlaze() != null || watch.abort?.() === true) cut.abort(new Error('a blaze about to shoot or in reach')) }
      bot.on('physicsTick', onTick)
      try {
        await collectDropsNear(bot, item.position.clone(), { signal: cut.signal, radius: 3, maxTicks: 120 })
      } catch (err) {
        if (signal?.aborted === true) throw err
        if (!isAbort(err)) { trace('fightFromNook: drops:', (err as Error).message); break }
      } finally {
        bot.off('physicsTick', onTick)
        signal?.removeEventListener('abort', onParent)
      }
      // (a walk that ended with the item still there and nothing about: twice more, then left)
      if (!cut.signal.aborted && ++walks >= 3) break
      await waitTicks(bot, 1, signal)
    }
  } finally {
    if (blocking) lowerShield(bot)
    bot.clearControlStates()
  }
  await enterNook(bot, nook, signal)
}

/**
 * into the nook's cell (by the open front: the walls are kept from the pathfinder's breaking); a bunker's by its sill
 * (bunker: enterBunker), shut again after unless `reseal` is false
 */
export async function enterNook (bot: Bot, nook: BlazeNook, signal?: AbortSignal, reseal = true): Promise<void> {
  if (nook.bunker != null) { await enterBunker(bot, nook, signal, reseal); return }
  if (inNook(bot, nook)) return
  // the fireballs' fire in its front or round the bot puts out first when the walk finds no way (the grid walk keeps
  // out of fire's cells): a 26.3 bot 1 off its nook under seed 2's throne at (-277, 77, -159), fire burning in the
  // nook's front, found 'no grid path' in, took the nook for one it couldn't have, and gave the spawner up
  await withNookKept(bot, nook, async () => await moveNear(bot, nook.stand, 0, signal)).catch(async err => {
    if (isAbort(err) || !isSkillError(err, 'NO_PATH')) throw err
    if (await putOutNookFires(bot, nook, signal) === 0) throw err
    await withNookKept(bot, nook, async () => await moveNear(bot, nook.stand, 0, signal))
  })
  // the walk ended on its cell's edge, a hair into the next (at (-276.009, 74, -168.4) for the nook at (-276, 74,
  // -169), 26.3 seed 2's throne at (-277, 77, -159)): stepped into its middle, not the nook given up as not got to
  const p = bot.entity.position
  if (!inNook(bot, nook) && Math.abs(p.y - nook.stand.y) < 0.6 && Math.hypot(p.x - nook.stand.x - 0.5, p.z - nook.stand.z - 0.5) <= 1.2) {
    await walkTo(bot, nook.stand.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal).catch(err => { if (isAbort(err)) throw err })
  }
}

/**
 * Into the bunker's cell: by its sill when it's open (the walls but the sill kept from the pathfinder's breaking),
 * else through whichever of its walls the pathfinder breaks (the floor kept); then its open walls filled again from
 * inside (shellAgain: the blocks dug on the way in, a sill opened for a fetch), unless `reseal` is false
 */
export async function enterBunker (bot: Bot, nook: BlazeNook, signal?: AbortSignal, reseal = true): Promise<void> {
  const b = nook.bunker
  if (b == null) return await enterNook(bot, nook, signal, reseal)
  if (!inNook(bot, nook)) {
    const go = async (kept: Vec3[]): Promise<void> => { await withBlocksKept(bot, kept, async () => await moveNear(bot, nook.stand, 0, signal)) }
    await go(bunkerKept(nook)).catch(async err => {
      if (isAbort(err) || !(isSkillError(err, 'NO_PATH') || isSkillError(err, 'STUCK'))) throw err
      trace('enterBunker: no way in by the sill:', (err as Error).message)
      await putOutNookFires(bot, nook, signal)
      await go(nook.floor)
    })
    const p = bot.entity.position
    if (!inNook(bot, nook) && Math.abs(p.y - nook.stand.y) < 0.6 && Math.hypot(p.x - nook.stand.x - 0.5, p.z - nook.stand.z - 0.5) <= 1.2) {
      await walkTo(bot, nook.stand.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal).catch(err => { if (isAbort(err)) throw err })
    }
  }
  if (!reseal || !inNook(bot, nook)) return
  const again = shellAgain(p => bot.blockAt(p) as NookBlock | null, nook)
  if (again == null || again.build.length === 0) return
  trace('enterBunker: shut again,', again.build.length, 'blocks')
  await walkTo(bot, nook.stand.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal).catch(err => { if (isAbort(err)) throw err })
  await fillNook(bot, again.build, signal, false, false)
}

/**
 * Whether an item lying at `item` is in the pickup reach of a player whose feet are at `feet` (Player.aiStep: the
 * items touching its box inflated by 1 across and 0.5 up and down; the player's box 0.6 wide and 1.8 high, the item's
 * 0.25): its middle within 1.425 across either way, its feet 0.75 under the player's to 2.3 over
 */
export function inPickupReach (feet: Vec3, item: Vec3): boolean {
  const across = 0.3 + 1 + 0.125
  return Math.abs(item.x - feet.x) < across && Math.abs(item.z - feet.z) < across && item.y > feet.y - 0.75 && item.y < feet.y + 2.3
}

/** the most a bunker's fetch goes from it for a drop (a throne's floor 5 to 9 off its slit) */
export const BUNKER_DROP_REACH = 12
/** the blazes counted about the bot for a bunker's fetch (a fireball's flight, the spawner's 16) */
export const BUNKER_CLEAR = 16
/**
 * a bunker's fight with its rods is left (the bot out of it for the brew, or the next work) once it's quiet
 * (bunkerDepartDue), or after this many ticks: a 26.3 bot out of its bunker for the brew with 5 blazes about it, at
 * seed 2's open throne at (-290, 77, -209), was held off at its door by the hostiles reflex and burned there
 */
export const BUNKER_DEPART_WAIT = 2400

/** whether the bot goes out of its bunker now: BUNKER_FETCH_BLAZES or fewer blazes about, no fireball near, healed */
export function bunkerDepartDue (bot: Bot, health: number): boolean {
  return health >= BUNKER_FETCH_HEALTH && blazesAbout(bot) <= BUNKER_FETCH_BLAZES && !fireballNear(bot)
}

/** a bunker's fetch goes with at most this many living blazes within BUNKER_CLEAR (fire resistant, the second) */
export const BUNKER_FETCH_BLAZES = 2
export const BUNKER_FETCH_PROOF_BLAZES = 5
/**
 * a bunker's fetch goes at this health at the least (the bot heals to it inside: at 18 a bot left at 17.6, its bar
 * under 18, fetched none of the rods of 12 kills with no blaze about), and is given up for the bunker at
 * BUNKER_FETCH_LEAVE: out of it among the blazes a fetch at 10 burned
 */
export const BUNKER_FETCH_HEALTH = 16
export const BUNKER_FETCH_LEAVE = 12

/**
 * The blaze rods (and a magma cube's cream) by the bunker its kills dropped, out of the bot's pickup reach from its
 * cell (one in the slit, on the sill, comes to it by itself: inPickupReach), on a floor no lower than 3 under it,
 * within BUNKER_DROP_REACH, nearest first
 */
export function bunkerDrops (bot: Bot, nook: BlazeNook): Entity[] {
  const feet = nook.stand.offset(0.5, 0, 0.5)
  return nearbyDrops(bot, feet, BUNKER_DROP_REACH, ['blaze_rod', 'magma_cream'])
    .filter(e => e.position.y >= nook.stand.y - 3 && !inPickupReach(feet, e.position))
}

/** the living blazes within BUNKER_CLEAR of the bot */
export function blazesAbout (bot: Bot): number {
  const me = bot.entity.position
  return Object.values(bot.entities).filter(e => e.name === 'blaze' && isAlive(bot, e) && e.position.distanceTo(me) <= BUNKER_CLEAR).length
}

/** whether no living blaze is within BUNKER_CLEAR of the bot, nor a small fireball within 24 */
export function bunkerClear (bot: Bot): boolean {
  return blazesAbout(bot) === 0 && !fireballNear(bot)
}

function fireballNear (bot: Bot): boolean {
  const me = bot.entity.position
  return Object.values(bot.entities).some(e => e.name === SMALL_FIREBALL && e.position.distanceTo(me) <= 24)
}

/** the bunker's sill dug from inside (the way out by its front), with the tool for it; none but a full block there */
export async function openSill (bot: Bot, nook: BlazeNook, signal?: AbortSignal): Promise<void> {
  if (nook.bunker == null) return
  const sill = bot.blockAt(nook.bunker.sill)
  if (sill == null || sill.boundingBox !== 'block' || sill.name === 'spawner' || sill.name === 'bedrock') return
  const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(sill)
  if (tool != null && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
  await dig(bot, sill as any, { signal }).catch(err => { if (isAbort(err)) throw err; trace('fightFromNook: the sill:', (err as Error).message) })
}

/** the bunker's walls but its sill, and its floor: what the walks out of it and back mustn't break */
export function bunkerKept (nook: BlazeNook): Vec3[] {
  const sill = nook.bunker?.sill
  return [...nook.walls.filter(w => sill == null || !w.equals(sill)), ...nook.floor]
}

/** the most blazes that would see the bot at a drop (fetchThreats) for a bunker's fetch to go to it */
export const BUNKER_FETCH_SEEN = 1
/** and the most about at all (hidden ones come round), and none this near the drop (BlazeAttackGoal hits within 2) */
export const BUNKER_FETCH_CROWD = 8
export const DROP_CLEAR = 4

/** whether nothing solid is on the line between two points (the world's raycast) */
function rayClear (bot: Bot, from: Vec3, to: Vec3): boolean {
  const d = to.minus(from)
  const len = d.norm()
  if (len < 1e-6) return true
  const hit: any = (bot.world as any).raycast?.(from, d.scaled(1 / len), len)
  return hit == null || (hit.intersect != null && hit.intersect.distanceTo(from) >= len - 1e-3)
}

/**
 * The living blazes within 24 whose eyes see one of `points` (Sensing.hasLineOfSight, the eyes to the eyes): the ones
 * that would shoot at the bot there. Those about it behind walls, a floor or a rise see nothing of a fetch, and a count
 * of all within 16 (BUNKER_FETCH_BLAZES) kept the bunkers by seed 2's throne spawners in with their rods lying out, 14
 * to 19 kills a run for 0 to 4 rods (26.3)
 */
export function fetchThreats (bot: Bot, points: readonly Vec3[]): Entity[] {
  const me = bot.entity.position
  return Object.values(bot.entities).filter(e => e.name === 'blaze' && isAlive(bot, e) && e.position.distanceTo(me) <= 24 &&
    points.some(p => rayClear(bot, blazeEye(e), p)))
}

/**
 * Whether the bunker's fetch goes now, to the drop at `drop` (the cell by it when none is given: the sill's): at
 * BUNKER_FETCH_HEALTH, no small fireball near, the blazes that see the bot `quiet`, and no more than BUNKER_FETCH_SEEN
 * blazes that see the bot or the drop (fetchThreats), none within DROP_CLEAR of the drop, BUNKER_FETCH_CROWD about at
 * the most. Fire resistant, BUNKER_FETCH_PROOF_BLAZES that see it (only their punches hurt then).
 */
export function bunkerFetchDue (bot: Bot, nook: BlazeNook, health: number, quiet: () => boolean = () => true, proof = false, drop?: Vec3): boolean {
  const b = nook.bunker
  if (b == null || health < BUNKER_FETCH_HEALTH) return false
  const at = drop ?? b.sill.offset(0.5, 0, 0.5)
  const seen = fetchThreats(bot, [eyePosition(bot), at.offset(0, 1.62, 0), b.sill.offset(0.5, 1.62, 0.5)]).length
  const close = Object.values(bot.entities).some(e => e.name === 'blaze' && isAlive(bot, e) && e.position.distanceTo(at) <= DROP_CLEAR)
  if (close || blazesAbout(bot) > BUNKER_FETCH_CROWD) return false
  if (proof) return seen <= BUNKER_FETCH_PROOF_BLAZES
  return seen <= BUNKER_FETCH_SEEN && !fireballNear(bot) && quiet()
}

/**
 * A drop by the bunker fetched: the sill dug (the way out the cell's front), then the nook's fetch (fetchDrops: the
 * walk stopped behind the shield while a blaze that sees the bot may shoot, the sword at one in reach, out of a fire's
 * cell back in), the bunker's walls but the sill kept from the pathfinder's breaking, given up at BUNKER_FETCH_LEAVE or
 * once more than BUNKER_FETCH_BLAZES + 1 blazes are about; then back in and the bunker shut again (enterBunker)
 */
export async function fetchFromBunker (bot: Bot, nook: BlazeNook, item: Entity, watch: FetchWatch, signal?: AbortSignal): Promise<void> {
  if (nook.bunker == null) return await fetchDrops(bot, nook, item, watch, signal)
  trace('fightFromNook: out of the bunker for the drops at', item.position.toString())
  await openSill(bot, nook, signal)
  // (given up once more see the bot than the fetch went with, one more)
  const bunkerWatch: FetchWatch = { ...watch, sealAt: Math.max(watch.sealAt, BUNKER_FETCH_LEAVE), abort: () => fetchThreats(bot, [eyePosition(bot)]).length > (fireProof(bot) ? BUNKER_FETCH_PROOF_BLAZES : BUNKER_FETCH_SEEN) + 1 }
  await withBlocksKept(bot, bunkerKept(nook), async () => await fetchDrops(bot, nook, item, bunkerWatch, signal))
}

/** a bunker looks for the fires by it each so many ticks (bunkerFires) */
export const BUNKER_FIRE_EVERY = 20
/** the reach its fires are punched out in, from the eyes (the player's block interaction range, 4.5, less a margin) */
export const BUNKER_FIRE_REACH = 4.2

/**
 * The fire blocks within BUNKER_FIRE_REACH of the bunker's eyes that they see (a clear line to the cell's middle):
 * the fireballs' fires on the floor its kills drop their rods on
 */
export function bunkerFires (bot: Bot, nook: BlazeNook): Vec3[] {
  const eye = nook.stand.offset(0.5, 1.62, 0.5)
  const out: Vec3[] = []
  const r = Math.ceil(BUNKER_FIRE_REACH)
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = nook.stand.offset(dx, dy + 1, dz)
        const name = bot.blockAt(p)?.name
        if (name !== 'fire' && name !== 'soul_fire') continue
        const mid = p.offset(0.5, 0.5, 0.5)
        if (mid.distanceTo(eye) > BUNKER_FIRE_REACH || !rayClear(bot, eye, mid)) continue
        out.push(p)
      }
    }
  }
  return out.sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(eye) - b.offset(0.5, 0.5, 0.5).distanceTo(eye))
}

/** the rods (and cream) a step out of the bunker into its sill's cell takes: in reach there (inPickupReach), not from its cell */
export function sillDrops (bot: Bot, nook: BlazeNook): Entity[] {
  if (nook.bunker == null) return []
  const feet = nook.stand.offset(0.5, 0, 0.5)
  const out = nook.bunker.sill.offset(0.5, 0, 0.5)
  return nearbyDrops(bot, out, 2.5, ['blaze_rod', 'magma_cream']).filter(e => inPickupReach(out, e.position) && !inPickupReach(feet, e.position))
}

/** a blaze this near the sill's cell keeps the bot in its bunker (BlazeAttackGoal hits within 2) */
export const SILL_CLEAR = 3

/**
 * whether the step out for a rod by the sill goes: over BUNKER_FETCH_LEAVE, no living blaze within SILL_CLEAR of the
 * sill's cell nor a small fireball near, the blazes that see the bot `quiet`
 */
export function sillPickupDue (bot: Bot, nook: BlazeNook, health: number, quiet: () => boolean = () => true): boolean {
  if (nook.bunker == null || health <= BUNKER_FETCH_LEAVE || fireballNear(bot)) return false
  const out = nook.bunker.sill.offset(0.5, 0.9, 0.5)
  return !Object.values(bot.entities).some(e => e.name === 'blaze' && isAlive(bot, e) && e.position.offset(0, 0.9, 0).distanceTo(out) <= SILL_CLEAR) && quiet()
}

/**
 * A rod by the sill taken: the sill dug, the bot a step out into its cell (the shield up toward the slit's way) till
 * the rod comes to it (Player.aiStep's touch) or 20 ticks, then back in its cell and the sill put again
 */
export async function sillPickup (bot: Bot, nook: BlazeNook, item: Entity, signal?: AbortSignal): Promise<void> {
  const b = nook.bunker
  if (b == null) return
  trace('fightFromNook: a step out of the bunker for the drop at', item.position.toString())
  await openSill(bot, nook, signal)
  try {
    if (bot.blockAt(b.sill)?.boundingBox === 'block') return
    // (a fireball's fire on the sill's floor put out first)
    for (const p of [b.sill, b.slit]) {
      const f = bot.blockAt(p)
      if (f != null && (f.name === 'fire' || f.name === 'soul_fire')) await bot.dig(f as any, true).catch(() => {})
    }
    await walkTo(bot, b.sill.offset(0.5, 0, 0.5), { within: 0.25, maxTicks: 20 }, signal).catch(err => { if (isAbort(err)) throw err })
    await waitUntil(bot, () => bot.entities[item.id] !== item, 20, signal)
  } finally {
    await walkTo(bot, nook.stand.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal).catch(err => { if (isAbort(err)) throw err })
    await enterBunker(bot, nook, signal)
  }
}

/** a bunker's slit turned after this many ticks with no blaze in its sight (one turn each so many ticks at most) */
export const BUNKER_TURN_AFTER = 300
/** the blazes a turn counts: within this of the bunker's stand */
export const BUNKER_TURN_NEAR = 8

/**
 * The way to turn the bunker's slit (a cardinal way but the one it faces): the one most of the blazes within
 * BUNKER_TURN_NEAR of its stand are, across; null for none
 */
export function bunkerTurnWay (nook: BlazeNook, blazes: readonly Vec3[]): Vec3 | null {
  const centre = nook.stand.offset(0.5, 0, 0.5)
  const counts = SIDES.map(() => 0)
  for (const p of blazes) {
    const d = new Vec3(p.x - centre.x, 0, p.z - centre.z)
    if (d.norm() > BUNKER_TURN_NEAR || d.norm() < 1e-6) continue
    const i = SIDES.reduce((best, s, k) => (s.dot(d) > SIDES[best].dot(d) ? k : best), 0)
    counts[i]++
  }
  let best = -1
  for (let i = 0; i < SIDES.length; i++) {
    if (SIDES[i].equals(nook.facing) || counts[i] === 0) continue
    if (best < 0 || counts[i] > counts[best]) best = i
  }
  return best < 0 ? null : SIDES[best]
}

/**
 * The bunker turned to face `way`: its head wall that way dug (the new slit: a block of the bunker's, or the rock,
 * never the spawner), then the walls of the bunker facing it put (bunkerAround: the old slit walled, a visor over the
 * new one when it can have one). Resolves the turned bunker, null when it can't be turned there.
 */
export async function turnBunker (bot: Bot, nook: BlazeNook, way: Vec3, signal?: AbortSignal): Promise<BlazeNook | null> {
  const slit = nook.stand.plus(way).plus(UP)
  const lookup: NookLookup = p => bot.blockAt(p) as NookBlock | null
  const view: NookLookup = p => p.equals(slit) ? { name: 'air', boundingBox: 'empty' } : lookup(p)
  const turned = bunkerAround(view, nook.stand, way, true) ?? bunkerAround(view, nook.stand, way, false)
  const wall = bot.blockAt(slit)
  if (turned == null || wall == null || wall.name === 'spawner' || wall.name === 'bedrock' || (wall.boundingBox === 'block' && !isWallBlock(wall as NookBlock))) return null
  if (nookBlocks(bot) < turned.build.length) return null
  trace('fightFromNook: the bunker turned to', way.toString(), turned.build.length, 'blocks')
  if (wall.boundingBox === 'block') {
    const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(wall)
    if (tool != null && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
    await dig(bot, wall as any, { signal }).catch(err => { if (isAbort(err)) throw err; trace('fightFromNook: turn:', (err as Error).message) })
    if (bot.blockAt(slit)?.boundingBox === 'block') return null
  }
  await fillNook(bot, turned.build, signal, false, false)
  return shellAgain(lookup, turned) ?? turned
}

/** the cells whose fire stands in the way into the nook: its stand and front, and the cells round the bot's feet */
export function nookFireCells (bot: Bot, nook: BlazeNook): Vec3[] {
  const feet = bot.entity.position.floored()
  const cells = [nook.stand, nook.stand.offset(0, 1, 0), ...nook.front]
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [-1, 0, 1]) cells.push(feet.offset(dx, dy, dz))
  return cells.filter(p => { const n = bot.blockAt(p)?.name; return n === 'fire' || n === 'soul_fire' })
}

/** the fire in nookFireCells put out (a fire's block is broken at once, punched); resolves how many */
export async function putOutNookFires (bot: Bot, nook: BlazeNook, signal?: AbortSignal): Promise<number> {
  let out = 0
  for (const p of nookFireCells(bot, nook)) {
    throwIfAborted(signal)
    const block = bot.blockAt(p)
    if (block == null || (block.name !== 'fire' && block.name !== 'soul_fire')) continue
    await bot.dig(block as any, true).then(() => { out++ }, () => {})
  }
  trace('enterNook: put out', out, 'fires on the way in')
  return out
}

/** the pathfinder kept from breaking the nook's walls, roof and floor while `fn` runs */
export async function withNookKept<T> (bot: Bot, nook: BlazeNook, fn: () => Promise<T>): Promise<T> {
  return await withBlocksKept(bot, [...nook.walls, ...(nook.floor ?? [])], fn)
}

/** the pathfinder kept from breaking the blocks at `cells` while `fn` runs (the settings it had put back after) */
export async function withBlocksKept<T> (bot: Bot, cells: readonly Vec3[], fn: () => Promise<T>): Promise<T> {
  const pathfinder: any = (bot as any).pathfinder
  const settings = pathfinder?.defaultMoveSettings
  if (settings == null || typeof pathfinder.setMoveOptions !== 'function') return await fn()
  const kept = new Set(cells.map(p => p.floored().toString()))
  const brk = (block: any): number => kept.has(new Vec3(block.position.x, block.position.y, block.position.z).toString()) ? 1e9 : 0
  const before = { ...settings }
  pathfinder.setMoveOptions({ ...settings, exclusionAreasBreak: [...(settings.exclusionAreasBreak ?? []), brk] })
  try {
    return await fn()
  } finally {
    pathfinder.setMoveOptions({ ...pathfinder.defaultMoveSettings, exclusionAreasBreak: before.exclusionAreasBreak ?? [] })
  }
}

/**
 * The nook's open cells filled from inside it; resolves how many couldn't be. A cell with nothing solid beside it to
 * go against has the open cell under it filled first (the front's floor dug out: the walk there came up through it)
 */
export async function fillNook (bot: Bot, cells: readonly Vec3[], signal?: AbortSignal, guard = true, clear = true): Promise<number> {
  let missed = 0
  // (the blazes come out of the spawner within its 4 of a melee nook: one on the bot is fought off first; not with
  // `clear` false, a bunker shut again from inside: the fight's sword meets them through its slit)
  if (clear) await clearBlazesNear(bot, signal, guard)
  const solidAt = (p: Vec3): boolean => bot.blockAt(p)?.boundingBox === 'block'
  const backed = (p: Vec3): boolean => [p.offset(0, -1, 0), p.offset(0, 1, 0), ...SIDES.map(s => p.plus(s))].some(solidAt)
  for (const cell of cells) {
    throwIfAborted(signal)
    const b = bot.blockAt(cell)
    if (b == null || b.boundingBox === 'block') continue
    const item = nookBlock(bot)
    if (item == null) throw new SkillError('MISSING_ITEMS', 'out of blocks for the nook')
    const under = cell.offset(0, -1, 0)
    if (!backed(cell) && isOpen(bot.blockAt(under) as NookBlock | null) && backed(under)) {
      try {
        await placeBlock(bot, { pos: under, item }, signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('blaze nook: no block under', cell.toString(), (err as Error).message)
      }
    }
    if (clear) await clearBlazesNear(bot, signal, guard)
    try {
      await placeBlock(bot, { pos: cell, item }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      missed++
      trace('blaze nook: no block at', cell.toString(), (err as Error).message)
    }
  }
  return missed
}

/** the most ticks a nook's next block waits behind the shield for the blazes about to hit the bot (clearBlazesNear) */
export const NOOK_GUARD_TICKS = 200

/** a blaze this near the bot (in its melee reach soon: BlazeAttackGoal hits within 2) is fought before a nook's next block */
export const NOOK_BLAZE_CLEAR = 3

/**
 * The blazes on the bot (within NOOK_BLAZE_CLEAR, in sight) fought off with the sword, each for 200 ticks at most,
 * before a nook's next block goes in: a 26.3 bot building its melee nook 2 off seed 2's spawner stood stepping in and out
 * of a wall's cell with two blazes come out on it punching, 5 a hit, and died there twice (nether-26.3-q3,
 * full-26.3-fresh-d's spot). Resolves the ones fought.
 */
export async function clearBlazesNear (bot: Bot, signal?: AbortSignal, guard = true): Promise<number> {
  // with a shield: held off where the bot stands till nothing's about to hit it (holdOffBlazes untilSafe: the shield
  // up toward a blaze about to shoot or a fireball coming, the sword at one in reach): a 26.3 bot with a stone sword
  // putting up its melee nook 2 off seed 2's throne spawner at (-277, 77, -159) fought the one on it with its back to
  // the rest, their fireballs unblocked, and burned there, the nook not built, two runs of two (BLAZE_KIT=q3)
  // (not when shutting in low: each block waited on the volleys, up to 200 ticks, with the bot burning and shot from
  // its sides the while; a 26.3 bot at 13 health alight took 600 ticks over its box by seed 2's open throne at
  // (-290, 77, -209) and burned to death in it, BLAZE_AT=s2fortress2 BLAZE_KIT=freshK)
  if (guard && countItems(bot, 'shield') > 0) return (await holdOffBlazes(bot, { signal, maxTicks: NOOK_GUARD_TICKS, untilSafe: true })).kills
  let fought = 0
  for (let i = 0; i < 4; i++) {
    const blaze = Object.values(bot.entities)
      .filter(e => e.name === 'blaze' && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= NOOK_BLAZE_CLEAR && hasLineOfSight(bot, e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (blaze == null) break
    trace('blaze nook: a blaze on the bot at', blaze.position.distanceTo(bot.entity.position).toFixed(1), ': fought first')
    fought++
    await fight(bot, blaze, { signal, maxTicks: 200, maxDistance: 8, maxDrop: 0, crits: false }).catch(err => { if (isAbort(err)) throw err; trace('blaze nook:', (err as Error).message) })
  }
  return fought
}

/** to the nook's cell and its walls and roof put up; throws when they can't all be */
export async function buildNook (bot: Bot, nook: BlazeNook, signal?: AbortSignal, guard = true): Promise<void> {
  await enterNook(bot, nook, signal, false)
  if (!inNook(bot, nook)) throw new SkillError('VERIFY_FAILED', `the bot is at ${bot.entity.position.toString()}, not in the nook at ${nook.stand.toString()}`)
  // (in the middle of its cell: half in a wall's, the wall's block walked the bot out and back three times, 26.3)
  await walkTo(bot, nook.stand.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 20 }, signal)
  // (a bunker's looked at afresh: the way in may have been dug through one of its walls)
  const build = nook.bunker != null ? (shellAgain(p => bot.blockAt(p) as NookBlock | null, nook)?.build ?? nook.build) : nook.build
  const missed = await fillNook(bot, build, signal, guard)
  if (missed > 0) throw new SkillError('CANNOT_PLACE', `${missed} of the nook's ${build.length} blocks not put`)
}

/**
 * The front shut, the bot fed (a golden apple when low) and healed to `healTo` inside (FoodData.tick: a point every
 * 10 ticks while saturated, every 80 from food 18 up), or 1200 ticks. The front stays shut (openNook). False, and
 * no waiting, when it couldn't be shut (a blaze in it).
 */
export async function sealAndHeal (bot: Bot, nook: BlazeNook, healTo: number, signal?: AbortSignal): Promise<boolean> {
  trace('fightFromNook: health', bot.health, 'shutting the nook')
  await fillNook(bot, nook.front, signal, false)
  const shut = (): boolean => nook.front.every(p => bot.blockAt(p)?.boundingBox === 'block')
  if (!shut()) { trace('fightFromNook: the front not shut'); return false }
  // fire resistance on in here, out of their sight, when there's a potion of it and it's off
  if (!fireProof(bot) && findPotion(bot, FIRE_RESISTANCE) != null) {
    try { await drinkPotion(bot, FIRE_RESISTANCE, signal) } catch (err) { if (isAbort(err)) throw err; trace('fightFromNook: fire resistance:', (err as Error).message) }
  }
  for (let t = 0; t < 1200 && bot.health < healTo; t += 10) {
    throwIfAborted(signal)
    if (bot.health <= 0 || !shut()) return true
    // the fire in its cells put out (a fireball's, in at the front before it was shut): shut in with it at its feet, a
    // 1.21.11 bot in its bunker by seed 2's throne at (-277, 77, -159) burned from 14.6 health to nothing healing
    if (!fireProof(bot) && await putOutFireOnBot(bot, signal) > 0) continue
    const apple = bot.health <= 8 && bot.inventory.items().some(i => i.name === 'golden_apple') ? 'golden_apple' : undefined
    // (a meal that fits the bar, or one the health needs: dueMeal; at 18 and 19 the bar heals, a meal's mostly lost)
    const meal = apple ?? dueMeal(bot, { hurtAt: healTo })
    if (meal != null) {
      try { await eat(bot, { signal, food: meal }) } catch (err) { if (isAbort(err)) throw err }
      continue
    }
    await waitTicks(bot, 10, signal)
  }
  return true
}

/**
 * the front opened, the head's block first (the view), then the feet's, with the tool for them: only a block the nook
 * is shut with (NOOK_BLOCKS), never what was there (the camp's box shut round a 26.3 bot 1 off seed 2's throne spawner
 * at (-277, 77, -159), facing it, took the spawner for its front, and opened it after the healing: mined, gone for good,
 * BLAZE_KIT=q3)
 */
export async function openNook (bot: Bot, nook: BlazeNook, signal?: AbortSignal): Promise<void> {
  for (const p of [...nook.front].reverse()) {
    const b = bot.blockAt(p)
    if (b == null || b.boundingBox !== 'block' || !NOOK_BLOCKS.includes(b.name)) continue
    const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(b)
    if (tool != null && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
    await dig(bot, b as any, { signal }).catch(err => { if (isAbort(err)) throw err; trace('fightFromNook: open:', (err as Error).message) })
  }
}

export interface HoldOffOptions {
  signal?: AbortSignal
  /** give up after this many ticks (default 600) */
  maxTicks?: number
  /** done once no blaze has seen the bot for this many ticks (default 40) */
  quietTicks?: number
  /** blazes further than this aren't shot (default 24) */
  shootRange?: number
  /**
   * done as soon as nothing is about to hit the bot (no blaze that sees it about to shoot, no small fireball coming,
   * none in the sword's reach), the bow left be: a nook's next block goes in then (fillNook)
   */
  untilSafe?: boolean
}

/**
 * The blazes that see the bot met where it stands, out of a nook (the hostiles reflex's way with them): the shield up,
 * the sword in hand, faced at the danger while one is about to shoot (BlazeVolleys); the sword at one come into reach,
 * the shield up between the swings; else the bow at the nearest it has an arc to, the draw loosed early when a danger
 * comes; else the shield up toward the nearest. It never chases one: closing in on a blaze over a fortress's throne
 * took the bots under the others' fireballs (fight: every blaze death of the 26.3 runs as to av, and one more on the
 * way out of the fortress with the rods). Resolves the kills once none has seen the bot for `quietTicks`.
 */
export async function holdOffBlazes (bot: Bot, opts: HoldOffOptions = {}): Promise<{ kills: number, ticks: number }> {
  const signal = opts.signal
  const maxTicks = opts.maxTicks ?? 600
  const quietTicks = opts.quietTicks ?? 40
  const shootRange = opts.shootRange ?? 24
  const volleys = new BlazeVolleys()
  const world = arrowWorld(bot)
  const tracker = motionTrackerOf(bot)
  const strength = attackStrengthOf(bot)
  const tracked = new Set<number>()
  let kills = 0
  let tick = 0
  let lastSeen = 0
  let drawn = 0
  let drawTarget: Entity | null = null
  let blocking = false
  const onDead = (e: Entity): void => { if (e.name === 'blaze') kills++ }
  bot.on('entityDead', onDead)
  const hold = async (item: any): Promise<void> => { if (item != null && bot.heldItem?.type !== item.type) await bot.equip(item, 'hand') }
  const release = (): void => { if (drawn > 0) bot.deactivateItem(); drawn = 0; drawTarget = null }
  const block = async (at: Vec3): Promise<void> => {
    release()
    if (!blocking || (bot as any).usingHeldItem !== true) {
      await hold(bestMeleeWeapon(bot, 'blaze'))
      blocking = await raiseShield(bot).catch(() => false)
    }
    await bot.lookAt(at, true)
  }
  const unblock = (): void => { if (blocking) lowerShield(bot); blocking = false }
  try {
    bot.clearControlStates()
    for (; tick < maxTicks; tick++) {
      throwIfAborted(signal)
      if (bot.health <= 0) break
      // the fire in its cells put out first, not stood in behind the shield (a 26.3 bot shutting itself in by seed 2's
      // open throne at (-290, 77, -209) held its shield up at a blaze for 180 ticks in a fireball's fire, and burned)
      if (!fireProof(bot) && inFireCell(bot)) {
        release()
        unblock()
        await putOutFireOnBot(bot, signal)
      }
      const me = bot.entity.position
      const blazes = Object.values(bot.entities).filter(e => e.name === 'blaze' && isAlive(bot, e) && e.position.distanceTo(me) <= 48)
      for (const b of blazes) if (!tracked.has(b.id)) { tracked.add(b.id); tracker.track(b) }
      volleys.update(blazes.map(b => ({ id: b.id, charged: blazeCharged(bot, b) })), tick)
      const near = (a: Entity, b: Entity): number => a.position.distanceTo(me) - b.position.distanceTo(me)
      const seeing = blazes.filter(b => blazeSeesBot(bot, b)).sort(near)
      if (seeing.length > 0) lastSeen = tick
      else if (tick - lastSeen >= quietTicks) break
      const danger = seeing.filter(b => volleys.dangerous(b.id, tick))
      const fireball = Object.values(bot.entities).find(e => e.name === SMALL_FIREBALL && fireballIncoming(bot, e, 24))
      if (danger.length > 0 || fireball != null) {
        if (drawn >= MIN_DRAW && drawTarget != null && isAlive(bot, drawTarget)) {
          const s = aim(bot, drawTarget, { leadTicks: 1, world })
          if (s != null) await bot.look(s.yaw, s.pitch, true)
          await waitTicks(bot, 1, signal)
          release()
        }
        await block(danger[0] != null ? blazeEye(danger[0]) : (fireball as Entity).position)
        await waitTicks(bot, 1, signal)
        continue
      }
      const eye = eyePosition(bot)
      const close = seeing.find(b => distanceToBox(eye, entityBox(b)) <= 2.9)
      if (opts.untilSafe === true && close == null && danger.length === 0 && fireball == null) break
      if (close != null) {
        release()
        await hold(bestMeleeWeapon(bot, 'blaze'))
        if (strength.ticksToFull() <= 0) {
          unblock()
          await bot.lookAt(meleeAimPoint(bot, close), true)
          strength.attack(close)
        } else if (strength.ticksToFull() > 1) {
          await block(blazeEye(close))
        }
        await waitTicks(bot, 1, signal)
        continue
      }
      const bow = opts.untilSafe === true ? undefined : bot.inventory.items().find(i => i.name === 'bow')
      if (bow != null && countItems(bot, ARROWS) > 0) {
        if (drawTarget != null && (!isAlive(bot, drawTarget) || !seeing.includes(drawTarget))) release()
        const target: Entity | null = drawTarget ?? seeing.filter(b => b.position.distanceTo(me) <= shootRange).find(b => aim(bot, b, { leadTicks: FULL_DRAW, world }) != null) ?? null
        if (target != null) {
          if (drawn === 0) {
            unblock()
            await hold(bow)
            bot.activateItem()
            drawTarget = target
          }
          drawn++
          const s = aim(bot, target, { leadTicks: Math.max(1, FULL_DRAW - drawn + 1), world })
          if (s != null) await bot.look(s.yaw, s.pitch, true)
          if ((drawn >= FULL_DRAW && s != null) || drawn > 3 * FULL_DRAW) {
            await waitTicks(bot, 1, signal)
            release()
            continue
          }
          await waitTicks(bot, 1, signal)
          continue
        }
      }
      release()
      if (seeing[0] != null) await block(blazeEye(seeing[0]))
      await waitTicks(bot, 1, signal)
    }
  } finally {
    bot.off('entityDead', onDead)
    for (const id of tracked) { const e = bot.entities[id]; if (e != null) tracker.untrack(e) }
    release()
    unblock()
  }
  return { kills, ticks: tick }
}
