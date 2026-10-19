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
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { type Entity, entityBox, distanceToBox, eyePosition, hasLineOfSight, isAlive } from '../skills/combatUtil'
import { blazeCharged, lowerShield, raiseShield } from '../skills/fight'
import { aim, arrowWorld } from '../skills/shoot'
import { motionTrackerOf } from '../skills/motion'
import { attackStrengthOf, bestMeleeWeapon } from '../skills/weapons'
import { eat, bestFoodInInventory } from '../skills/eat'
import { placeBlock } from '../skills/placeBlock'
import { collectDropsNear } from '../skills/hunt'
import { nearbyDrops } from '../skills/pickupDrops'
import { moveNear } from '../skills/gridWalk'
import { countItems, trace, waitTicks } from '../skills/util'
import { fireballIncoming } from './safety'
import { dig } from '../core/actions'

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
}

const isSolidBlock = (b: NookBlock | null): boolean => b != null && b.boundingBox === 'block'
const FREE_NAMES = new Set(['air', 'cave_air', 'void_air', 'fire', 'soul_fire', 'short_grass', 'tall_grass', 'fern', 'warped_roots', 'crimson_roots', 'nether_sprouts', 'red_shrub'])
const isOpen = (b: NookBlock | null): boolean => b != null && FREE_NAMES.has(b.name)
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

/** the `n` cheapest nooks (planBlazeNook's), cheapest first, no two of them on the same stand */
export function planBlazeNooks (lookup: NookLookup, spawner: Vec3, opts: NookOptions = {}, n = 3): BlazeNook[] {
  const minD = opts.minDistance ?? 7
  const maxD = opts.maxDistance ?? 13
  const standOff = opts.standOff ?? 10
  const maxBlocks = opts.maxBlocks ?? 12
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
        if (!isOpen(lookup(stand)) || !isOpen(lookup(stand.plus(UP))) || !isFloor(lookup(stand.offset(0, -1, 0)))) continue
        // facing the spawner: the cardinal way nearest it
        const to = new Vec3(-dx, 0, -dz).scaled(1 / h)
        const facing = SIDES.reduce((a, b) => (b.dot(to) > a.dot(to) ? b : a))
        if (facing.dot(to) < Math.cos(Math.PI / 6)) continue
        const front = [stand.plus(facing), stand.plus(facing).plus(UP)]
        if (!front.every(p => isOpen(lookup(p))) || !isFloor(lookup(front[0].offset(0, -1, 0)))) continue
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
  return found.sort((a, b) => a.cost - b.cost).slice(0, n).map(f => f.nook)
}

/** the nook round a stand facing a way: its blocks in an order that has each go against a solid one, or null */
export function nookAround (lookup: NookLookup, stand: Vec3, facing: Vec3, maxBlocks = 12): BlazeNook | null {
  const side = new Vec3(facing.z, 0, -facing.x)
  const back = facing.scaled(-1)
  const walls: Vec3[] = []
  for (const dy of [0, 1]) for (const d of [back, side, side.scaled(-1)]) walls.push(stand.plus(d).offset(0, dy, 0))
  walls.push(stand.offset(0, 2, 0))
  const solid = new Set<string>()
  const isIn = (p: Vec3): boolean => solid.has(p.toString()) || isSolidBlock(lookup(p))
  const todo: Vec3[] = []
  for (const w of walls) {
    const b = lookup(w)
    if (isSolidBlock(b)) continue
    if (!isOpen(b)) return null
    todo.push(w)
  }
  // the order: each next one against a block that's solid by then (the floor, a wall put before it); when none has
  // one, a block put first where it gives one (under a wall over nothing, against the floor beside it; over a wall,
  // for the roof to go against: a roof touches no wall but across a corner)
  const build: Vec3[] = []
  const neighbours = (p: Vec3): Vec3[] => [p.offset(0, -1, 0), p.offset(0, 1, 0), ...SIDES.map(s => p.plus(s))]
  const kept = new Set([stand, stand.plus(UP), stand.plus(facing), stand.plus(facing).plus(UP)].map(p => p.toString()))
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
  return { stand, facing, build, front: [stand.plus(facing), stand.plus(facing).plus(UP)], walls }
}

// ---- the fight

/** the blocks the nook is built of, the ones that don't burn first (fire on netherrack never goes out) */
export const NOOK_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'blackstone', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'basalt', 'stone_bricks', 'end_stone', 'dirt', 'netherrack']

export function nookBlock (bot: Bot): string | null {
  return NOOK_BLOCKS.find(n => countItems(bot, n) > 0) ?? null
}

export function nookBlocks (bot: Bot): number {
  return countItems(bot, NOOK_BLOCKS)
}

/** the bot's feet in the nook's cell */
export function inNook (bot: Bot, nook: BlazeNook): boolean {
  const p = bot.entity.position
  return Math.floor(p.x) === nook.stand.x && Math.floor(p.z) === nook.stand.z && Math.abs(p.y - nook.stand.y) < 0.6
}

/** a blaze's eyes */
export function blazeEye (blaze: Entity): Vec3 {
  return blaze.position.offset(0, BLAZE_EYE_HEIGHT, 0)
}

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
  /** called on each kill */
  onKill?: (blaze: Entity) => void
}

export interface NookFightResult {
  kills: number
  shots: number
  blocked: number
  ticks: number
}

const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow']

/** the melee mobs (besides the blazes) the nook's fight meets itself, with the sword once in reach */
export const NOOK_MELEE = ['magma_cube']

/** the bow's draw to a full-power shot (BowItem.getPowerForTime: full from 20 ticks), a tick to spare */
const FULL_DRAW = 21
/** a draw cut short by a blaze about to shoot is loosed from this many ticks on (the power then about 0.7) */
const MIN_DRAW = 14

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
  const tracked = new Set<number>()
  const dead = new Set<number>()
  const tried = new Set<number>()
  const onDead = (e: Entity): void => {
    if (e.name !== 'blaze') return
    dead.add(e.id)
    result.kills++
    opts.onKill?.(e)
  }
  const onTick = (): void => { tick++ }
  bot.on('entityDead', onDead)
  bot.on('physicsTick', onTick)
  // the magma cubes are the nook's to meet (the sword at one come into reach), not the hostiles reflex's: it went
  // after them out of the nook, about the basalt delta under the blazes' fire (26.3, seed 2's spawner: 19 times in a
  // fight of 9898 ticks)
  const leave = (bot as any).survival?.reflexes?.leaveAlone?.(NOOK_MELEE) as (() => void) | undefined
  const sword = (): any => bestMeleeWeapon(bot, 'blaze')
  const bow = (): any => bot.inventory.items().find(i => i.name === 'bow') ?? null
  const hasArrows = (): boolean => countItems(bot, ARROWS) > 0
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
    while (countItems(bot, 'blaze_rod') < opts.count) {
      throwIfAborted(signal)
      if (bot.health <= 0) throw new SkillError('VERIFY_FAILED', 'the bot died in the nook', { ...result, ticks: tick })
      if (tick > maxTicks) throw new SkillError('TIMEOUT', `${countItems(bot, 'blaze_rod')} of ${opts.count} blaze rods after ${tick} ticks in the nook`, { ...result, ticks: tick })
      const blazes = blazesNow()
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
      const near = (a: Entity, b: Entity): number => a.position.distanceTo(me) - b.position.distanceTo(me)
      const fireball = Object.values(bot.entities).find(e => e.name === SMALL_FIREBALL && fireballIncoming(bot, e, 24))
      const danger = seeing.filter(b => volleys.dangerous(b.id, tick)).sort(near)

      // fire in the nook (a fireball's on the floor by the feet): out at once
      for (const p of [nook.stand, nook.stand.plus(UP)]) {
        const b = bot.blockAt(p)
        if (b != null && (b.name === 'fire' || b.name === 'soul_fire')) await bot.dig(b as any, true).catch(() => {})
      }

      // one come close (in the front, hitting: BlazeAttackGoal within 2 blocks): the sword, the shield up between the
      // swings (a blaze in the front cell keeps the front from being shut: a 26.3 bot at 9 health tried to shut it
      // for 1200 ticks, the blaze punching it the while, and died)
      const eye = eyePosition(bot)
      const inReach = (e: Entity): boolean => distanceToBox(eye, entityBox(e)) <= 2.9
      const close = seeing.find(inReach) ?? Object.values(bot.entities).find(e => NOOK_MELEE.includes(e.name ?? '') && isAlive(bot, e) && inReach(e) && hasLineOfSight(bot, e))
      if (close != null && danger.length === 0) {
        stopDraw()
        await hold(sword())
        if (strength.ticksToFull() <= 0) {
          unblock()
          await look(close.position.offset(0, 1.2, 0))
          strength.attack(close)
        } else if (strength.ticksToFull() > 1) {
          await block(blazeEye(close))
        }
        await waitTicks(bot, 1, signal)
        continue
      }

      // low: the front shut, fed and healed inside; healed (or back after a reflex cut the healing off), open again.
      // A front that won't shut (a blaze in it) is tried again in a while, the fight going on meanwhile
      if (bot.health <= sealAt && tick >= sealAgain && close == null) {
        unblock()
        stopDraw()
        if (!await sealAndHeal(bot, nook, healTo, signal)) sealAgain = tick + 40
        continue
      }
      if (nook.front.some(p => bot.blockAt(p)?.boundingBox === 'block') && bot.health > sealAt) {
        unblock()
        await openNook(bot, nook, signal)
        continue
      }

      if (danger.length > 0 || fireball != null) {
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

      // a meal, when nothing can shoot before it's eaten (32 ticks)
      const hungry = (bot.health <= eatAt && bot.food < 20) || bot.food <= eatFood
      if (hungry && drawn === 0 && bestFoodInInventory(bot) != null && seeing.every(b => volleys.quietFor(b.id, tick, 34))) {
        unblock()
        try { await eat(bot, { signal }) } catch (err) { if (isAbort(err)) throw err; trace('fightFromNook: eat:', (err as Error).message) }
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

      // the drops of the kills, while it's quiet: off the floor near the nook, each item tried once
      const quiet = seeing.every(b => volleys.quietFor(b.id, tick, 60))
      const drop = quiet ? dropsNear(bot, nook).find(e => !tried.has(e.id)) : undefined
      if (drop != null) {
        tried.add(drop.id)
        await fetchDrops(bot, nook, drop, signal)
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

/** drops further than this from the nook are left (a walk under the blazes' fire; the spawner's own floor is 10 off) */
export const DROP_REACH = 14

/**
 * The blaze rods lying near the nook (the kills' drops), on a floor no lower than 3 under it, nearest first: the rest
 * (a wither skeleton's bones and coal) is left, not worth the walk under the blazes
 */
export function dropsNear (bot: Bot, nook: BlazeNook): Entity[] {
  const at = nook.stand.offset(0.5, 0, 0.5)
  return nearbyDrops(bot, at, DROP_REACH, ['blaze_rod']).filter(e => e.position.y >= nook.stand.y - 3)
}

/** an item near the nook picked up (a walk cut off when a blaze that sees the bot is charged), back in after */
async function fetchDrops (bot: Bot, nook: BlazeNook, item: Entity, signal?: AbortSignal): Promise<void> {
  const cut = new AbortController()
  const onParent = (): void => cut.abort(signal?.reason)
  signal?.addEventListener('abort', onParent, { once: true })
  const watch = (): void => {
    if (Object.values(bot.entities).some(e => e.name === 'blaze' && isAlive(bot, e) && blazeCharged(bot, e) && blazeSeesBot(bot, e))) cut.abort(new Error('a blaze charged'))
  }
  bot.on('physicsTick', watch)
  try {
    trace('fightFromNook: drops at', item.position.toString())
    await collectDropsNear(bot, item.position.clone(), { signal: cut.signal, radius: 3, maxTicks: 120 })
  } catch (err) {
    if (signal?.aborted === true) throw err
    if (!isAbort(err)) trace('fightFromNook: drops:', (err as Error).message)
  } finally {
    bot.off('physicsTick', watch)
    signal?.removeEventListener('abort', onParent)
  }
  await enterNook(bot, nook, signal)
}

/** into the nook's cell (by the open front: the walls are kept from the pathfinder's breaking) */
export async function enterNook (bot: Bot, nook: BlazeNook, signal?: AbortSignal): Promise<void> {
  if (inNook(bot, nook)) return
  await withNookKept(bot, nook, async () => await moveNear(bot, nook.stand, 0, signal))
}

/** the pathfinder kept from breaking the nook's walls and roof while `fn` runs */
export async function withNookKept<T> (bot: Bot, nook: BlazeNook, fn: () => Promise<T>): Promise<T> {
  const pathfinder: any = (bot as any).pathfinder
  const settings = pathfinder?.defaultMoveSettings
  if (settings == null || typeof pathfinder.setMoveOptions !== 'function') return await fn()
  const kept = new Set(nook.walls.map(p => p.toString()))
  const brk = (block: any): number => kept.has(new Vec3(block.position.x, block.position.y, block.position.z).toString()) ? 1e9 : 0
  const before = { ...settings }
  pathfinder.setMoveOptions({ ...settings, exclusionAreasBreak: [...(settings.exclusionAreasBreak ?? []), brk] })
  try {
    return await fn()
  } finally {
    pathfinder.setMoveOptions({ ...pathfinder.defaultMoveSettings, exclusionAreasBreak: before.exclusionAreasBreak ?? [] })
  }
}

/** the nook's open cells filled from inside it; resolves how many couldn't be */
export async function fillNook (bot: Bot, cells: readonly Vec3[], signal?: AbortSignal): Promise<number> {
  let missed = 0
  for (const cell of cells) {
    throwIfAborted(signal)
    const b = bot.blockAt(cell)
    if (b == null || b.boundingBox === 'block') continue
    const item = nookBlock(bot)
    if (item == null) throw new SkillError('MISSING_ITEMS', 'out of blocks for the nook')
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

/** to the nook's cell and its walls and roof put up; throws when they can't all be */
export async function buildNook (bot: Bot, nook: BlazeNook, signal?: AbortSignal): Promise<void> {
  await enterNook(bot, nook, signal)
  if (!inNook(bot, nook)) throw new SkillError('VERIFY_FAILED', `the bot is at ${bot.entity.position.toString()}, not in the nook at ${nook.stand.toString()}`)
  const missed = await fillNook(bot, nook.build, signal)
  if (missed > 0) throw new SkillError('CANNOT_PLACE', `${missed} of the nook's ${nook.build.length} blocks not put`)
}

/**
 * The front shut, the bot fed (a golden apple when low) and healed to `healTo` inside (FoodData.tick: a point every
 * 10 ticks while saturated, every 80 from food 18 up), or 1200 ticks. The front stays shut (openNook). False, and
 * no waiting, when it couldn't be shut (a blaze in it).
 */
export async function sealAndHeal (bot: Bot, nook: BlazeNook, healTo: number, signal?: AbortSignal): Promise<boolean> {
  trace('fightFromNook: health', bot.health, 'shutting the nook')
  await fillNook(bot, nook.front, signal)
  const shut = (): boolean => nook.front.every(p => bot.blockAt(p)?.boundingBox === 'block')
  if (!shut()) { trace('fightFromNook: the front not shut'); return false }
  for (let t = 0; t < 1200 && bot.health < healTo; t += 10) {
    throwIfAborted(signal)
    if (bot.health <= 0 || !shut()) return true
    const apple = bot.health <= 8 && bot.inventory.items().some(i => i.name === 'golden_apple') ? 'golden_apple' : undefined
    if ((bot.food < 20 || apple != null) && (apple != null || bestFoodInInventory(bot) != null)) {
      try { await eat(bot, { signal, food: apple }) } catch (err) { if (isAbort(err)) throw err }
      continue
    }
    await waitTicks(bot, 10, signal)
  }
  return true
}

/** the front opened, the head's block first (the view), then the feet's, with the tool for them */
export async function openNook (bot: Bot, nook: BlazeNook, signal?: AbortSignal): Promise<void> {
  for (const p of [nook.front[1], nook.front[0]]) {
    const b = bot.blockAt(p)
    if (b == null || b.boundingBox !== 'block') continue
    const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(b)
    if (tool != null && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
    await dig(bot, b as any, { signal }).catch(err => { if (isAbort(err)) throw err; trace('fightFromNook: open:', (err as Error).message) })
  }
}
