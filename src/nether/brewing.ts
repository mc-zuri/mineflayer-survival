// Fire resistance brewed in the nether for the blaze fight: the water bottles brought from the overworld, a brewing
// stand and its fuel of the first blaze rods, nether wart from the fortress's wart rooms (NetherFortressPieces
// CastleStalkRoom: soul sand plots), magma cream from the magma cubes about (the basalt deltas' and the fortress's own
// spawns), brewed into an awkward potion and then fire resistance (VanillaBrewingProvider). With fire resistance on the
// blazes' fireballs and the fire they light do nothing (LivingEntity.hurtServer: #is_fire), and the rest of the rods
// come with no healing: 26.3 bots in iron armor with 2 potions got their 8 rods by seed 2's throne at (-277, 77, -159)
// 3 runs of 3, with none 0 of 3 (tests/integration/blaze BLAZE_KIT=runIron BLAZE_FIRE_RES=2).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from '../skills/errors'
import { brew, waterBottles, FIRE_RESISTANCE_BREW } from '../skills/brew'
import { collectBlock } from '../skills/collectBlock'
import { craft } from '../skills/craft'
import { collectDropsNear } from '../skills/hunt'
import { nearbyDrops } from '../skills/pickupDrops'
import { travel } from '../skills/travel'
import { distanceToBox, entityBox, eyePosition, hasLineOfSight, metadataValue, isAlive, type Entity } from '../skills/combatUtil'
import { shoot } from '../skills/shoot'
import { fight, lowerShield, raiseShield } from '../skills/fight'
import { attackStrengthOf, bestMeleeWeapon } from '../skills/weapons'
import { drinkPotion, findPotion, hasEffect } from '../skills/potion'
import { countItems, trace, waitTicks } from '../skills/util'
import { findBlocks } from '../core/findBlocks'
import { withNetherSafety } from './safety'
import { fillNook, planBlazeBunkers, planBlazeNooks } from './blazeFight'
import { LIGHT_TORCHES, lightBlazeSpawner } from './spawnerLight'
import { collectBlazeRods, findBlazeSpawner, healSealed, unreachableSpawners, SEAL_HEAL_TO, type BlazeRodsArgs, type BlazeRodsResult } from './fortressSkills'

export { LIGHT_TORCHES } from './spawnerLight'

/** the brew (two of BREW_TICKS in a box) is made no nearer the spawner than this: its blazes shoot from 16 off and more */
export const BREW_CLEAR = 16

/** blaze rods the brewing takes: the stand's, and the blaze powder's for its fuel (2 of a rod, 1 a brew of 20) */
export const BREW_RODS = 2
/**
 * how far nether wart is looked for in the chunks the bot has: all it's sent (a server's view distance is 10 chunks
 * by default, 160 blocks; a 6-chunk view's corners are some 110 off). Seed 2's wart room at (-170, 60, -242) is 126
 * off where the 26.3 runs come in by its fortress, out of a 96 sight: the bots walked the legs for it, one 12000 ticks
 * through the fortress's corridors to it from the leg that led away from (-290, 77, -209), and died after
 */
export const WART_SIGHT = 160
/** wart seen further than this is walked to (travel) before it's dug */
export const WART_DIG_REACH = 16
/** the legs walked to look for wart rooms, each this long (seed 2's by its fortress's spawners: 110 to 150 off) */
export const WART_LEG = 96
/** the cubes met for their cream are this far from the spawner at the least (its blazes) */
export const CUBE_SPAWNER_CLEAR = 20

/** the magma cream to make of a slime ball for the brew: 1 with none held and a slime ball, else 0 */
export function creamToMake (bot: Bot): number {
  return countItems(bot, 'magma_cream') === 0 && countItems(bot, 'slime_ball') > 0 ? 1 : 0
}

/** whether the bag holds the magma cream for the brew, or a slime ball to make it of (creamToMake) */
export function creamMakings (bot: Bot): boolean {
  return countItems(bot, 'magma_cream') > 0 || countItems(bot, 'slime_ball') > 0
}

/** whether the bag holds a bow and an arrow for it */
function bowAndArrows (bot: Bot): boolean {
  return countItems(bot, 'bow') > 0 && countItems(bot, ['arrow', 'spectral_arrow', 'tipped_arrow']) > 0
}

/** whether a fire resistance brew is wanted: none held, water bottles to brew in the bag */
export function brewWanted (bot: Bot): boolean {
  return findPotion(bot, 'fire_resistance') == null && waterBottles(bot) > 0
}

/** the nether wart in the chunks the bot has, nearest first */
export function wartInView (bot: Bot, maxDistance = WART_SIGHT): Vec3[] {
  const id = bot.registry.blocksByName.nether_wart?.id
  if (id == null) return []
  return findBlocks(bot, { matching: [id], maxDistance, count: 16 })
}

/** the wart search's legs: WART_LEG out from `from` along each axis, the ones that lead away from the spawner first */
export function wartLegs (from: Vec3, spawner: Vec3): Vec3[] {
  const away = new Vec3(from.x - spawner.x, 0, from.z - spawner.z)
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dz]) => ({ dot: dx * away.x + dz * away.z, at: from.offset(dx * WART_LEG, 0, dz * WART_LEG).floored() }))
    .sort((a, b) => b.dot - a.dot)
    .map(l => l.at)
}

/**
 * Nether wart in the bag: the wart in view dug (any age gives one: NetherWartBlock's loot, 2 to 4 grown), else the
 * wart remembered gone to, else legs of WART_LEG walked out from `from` along the axes, the ones away from the
 * spawner first (a leg from by the spawner walked a 26.3 bot through seed 2's throne at (-277, 77, -159), its blazes
 * burning it to death), each stopped once wart comes in view; the wart remembered ('nether_wart'). Resolves the wart
 * held.
 */
export async function getNetherWart (bot: Bot, from: Vec3, spawner: Vec3, signal?: AbortSignal): Promise<number> {
  const memory = bot.survival?.memory
  const dig = async (at: Vec3[]): Promise<void> => {
    memory?.addPoi('nether_wart', at[0], 'the_nether')
    await collectBlock(bot, { positions: at.slice(0, 3), maxUnreachable: 3 }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('getNetherWart: no wart dug:', (err as Error).message)
    })
  }
  // wart in view, near or far: gone to and dug (the legs only when there's none in the chunks the bot has)
  const goDig = async (at: Vec3[]): Promise<void> => {
    if (at[0].distanceTo(bot.entity.position) > WART_DIG_REACH) {
      trace('getNetherWart: wart in view at', at[0].toString())
      memory?.addPoi('nether_wart', at[0], 'the_nether')
      await travel(bot, { target: at[0], range: 4, exactY: true, trail: false }, signal).catch(err => { if (isAbort(err)) throw err; trace('getNetherWart: the way to it:', (err as Error).message) })
      const near = wartInView(bot, WART_DIG_REACH)
      await dig(near.length > 0 ? near : at)
    } else await dig(at)
  }
  const seen = wartInView(bot)
  if (seen.length > 0) await goDig(seen)
  if (countItems(bot, 'nether_wart') > 0) return countItems(bot, 'nether_wart')
  const known = memory?.getPois('nether_wart', { dimension: 'the_nether', near: bot.entity.position })[0]
  const legs = [...(known != null ? [new Vec3(known.x, known.y, known.z)] : []), ...wartLegs(from, spawner)]
  for (const target of legs) {
    throwIfAborted(signal)
    trace('getNetherWart: looking for wart toward', target.toString())
    await travel(bot, { target, range: 8, trail: false, onHop: () => wartInView(bot).length > 0 }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('getNetherWart: the leg to', target.toString(), (err as Error).message)
    })
    const here = wartInView(bot)
    if (here.length > 0) {
      await goDig(here)
      if (countItems(bot, 'nether_wart') > 0) break
    }
  }
  return countItems(bot, 'nether_wart')
}

/** a magma cube whose death may drop cream: size 2 or more (the loot table's cubeMob sized at least 2) */
export function creamCube (bot: Bot, e: Entity): boolean {
  if (e.name !== 'magma_cube' || !isAlive(bot, e)) return false
  const size = metadataValue(bot, e, 'size')
  return typeof size !== 'number' || size >= 2
}

/**
 * Magma cream in the bag, where it's safe to be had: one lying about picked up (a cube the hostiles reflex or the
 * nook's sword killed), else the cubes on the bot's level within 16 (they go for a player within 4 of their height,
 * Slime's target goal) met where the bot stands (holdForCubes). Not gone after into a basalt delta: two 26.3 bots
 * that did, by seed 2's deltas west of its fortress, burned to death in their lava, and the cubes they saw were in its
 * pits and on its pillars, none come within reach in 7200 ticks of holding.
 */
export async function getMagmaCream (bot: Bot, spawner: Vec3, signal?: AbortSignal, waitFor = 0): Promise<number> {
  const lying = nearbyDrops(bot, bot.entity.position, 24, ['magma_cream'])
  if (lying.length > 0) await collectDropsNear(bot, lying[0].position, { radius: 3, signal }).catch(err => { if (isAbort(err)) throw err })
  const me = bot.entity.position
  const near = Object.values(bot.entities).some(e => creamCube(bot, e) && e.position.distanceTo(me) <= 16 && Math.abs(e.position.y - me.y) <= 4 && e.position.distanceTo(spawner) >= CUBE_SPAWNER_CLEAR)
  if (countItems(bot, 'magma_cream') === 0 && near) await holdForCubes(bot, CUBE_HOLD_TICKS, signal)
  // none near: a fortress's cube in sight gone to and met there (fortressCube: by its bricks, no lava by it), waited
  // for up to `waitFor` ticks (the fortress spawns them: NetherFortressStructure's magma cubes)
  let cube = countItems(bot, 'magma_cream') === 0 && countItems(bot, 'slime_ball') === 0 ? fortressCube(bot, spawner) : null
  for (let t = 0; cube == null && t < waitFor && countItems(bot, 'magma_cream') === 0; t += 20) {
    // (not in a wall the while: a 26.3 bot put where the runs come in by seed 2's fortress, its head in the netherrack,
    // suffocated in 400 ticks of waiting)
    const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())
    if (head != null && head.boundingBox === 'block') await collectBlock(bot, { positions: [head.position], pickup: false }, signal).catch(err => { if (isAbort(err)) throw err })
    await waitTicks(bot, 20, signal)
    cube = fortressCube(bot, spawner)
  }
  if (cube != null) {
    trace('getMagmaCream: a fortress cube at', cube.position.floored().toString())
    await travel(bot, { target: cube.position.floored(), range: CUBE_MEET_RANGE, exactY: true, trail: false }, signal).catch(err => { if (isAbort(err)) throw err; trace('getMagmaCream: the way to it:', (err as Error).message) })
    // gone after with the sword where it stays off (a cube comes only within 16 and 4 up or down, Slime's target
    // goal: two 1.21.11 holds by seed 2's fortress saw none come), the split ones met where the bot stands after
    for (let i = 0; i < CUBE_FIGHTS && countItems(bot, 'magma_cream') === 0 && bot.health > CUBE_HOLD_HEALTH; i++) {
      const target = fortressCube(bot, spawner, CUBE_MEET_RANGE + 6)
      if (target == null) break
      const res = await fight(bot, target, { signal, maxTicks: 600, maxDrop: 2 }).catch(err => { if (isAbort(err)) throw err; trace('getMagmaCream: the fight:', (err as Error).message); return null })
      const at = res?.lastPosition ?? target.position
      await collectDropsNear(bot, at, { radius: 4, maxTicks: 120, signal }).catch(err => { if (isAbort(err)) throw err })
    }
    if (countItems(bot, 'magma_cream') === 0 && bot.entity.position.distanceTo(spawner) >= CUBE_SPAWNER_CLEAR) await holdForCubes(bot, CUBE_HOLD_TICKS / 2, signal)
  }
  return countItems(bot, 'magma_cream')
}

/** a fortress's magma cube is looked for this far off (the chunks the bot has: its spawns, NetherFortressStructure's) */
export const CUBE_SEEK_RANGE = 64
/** the fortress cubes fought in turn for the cream (the split ones too) */
export const CUBE_FIGHTS = 6
/** with no bow, a fortress's cube is waited for this long for the cream (no fight without fire resistance) */
export const CUBE_WAIT_TICKS = 3600
/** and gone to this near: a cube goes for a player within 16 (Slime's target goal) */
export const CUBE_MEET_RANGE = 10

/**
 * The nearest magma cube that may drop cream (creamCube) within CUBE_SEEK_RANGE of the bot in a fortress: nether
 * bricks within 3 of it and no lava within 3 (the basalt deltas' cubes in their pits and lava burned two 26.3 bots),
 * CUBE_SPAWNER_CLEAR off the spawner; null when there's none
 */
export function fortressCube (bot: Bot, spawner: Vec3, range = CUBE_SEEK_RANGE): Entity | null {
  const bricks = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs', 'nether_brick_slab'].map(n => bot.registry.blocksByName[n]?.id).filter((i): i is number => i != null)
  const lava = bot.registry.blocksByName.lava?.id
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter(e => creamCube(bot, e) && e.position.distanceTo(me) <= range && e.position.distanceTo(spawner) >= CUBE_SPAWNER_CLEAR)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    .find(e => {
      const at = e.position.floored()
      return findBlocks(bot, { matching: bricks, point: at, maxDistance: 3, count: 1 }).length > 0 &&
        (lava == null || findBlocks(bot, { matching: [lava], point: at, maxDistance: 3, count: 1 }).length === 0)
    }) ?? null
}

/** a cube is met in this reach of the eyes (its box: the player's interaction range, 3, less a margin) */
export const CUBE_REACH = 2.9
/** the ticks the bot holds its ground for the cubes to come to it */
export const CUBE_HOLD_TICKS = 1200
/** the cubes shot at from the hold (those in sight that don't come), and the arrows it may take of the blazes' */
export const CUBE_SHOT_RANGE = 24
export const CUBE_ARROWS = 16
/** the hold ends at this health (the cubes' 3 to 6 a hit, normal difficulty: MagmaCube.getAttackDamage) */
export const CUBE_HOLD_HEALTH = 8

/**
 * The magma cubes met where the bot stands, CUBE_HOLD_TICKS at most or till there's cream: one in reach (CUBE_REACH)
 * hit when the sword's ready, the shield up toward it between (a cube's hit is a mob's melee, blocked); a cream dropped
 * within 4 picked up; nothing gone after (the hostiles reflex leaves the cubes to it). Ends low (CUBE_HOLD_HEALTH).
 */
export async function holdForCubes (bot: Bot, ticks: number, signal?: AbortSignal): Promise<void> {
  const leave = (bot as any).survival?.reflexes?.leaveAlone?.(['magma_cube']) as (() => void) | undefined
  const strength = attackStrengthOf(bot)
  let blocking = false
  let arrowsShot = 0
  try {
    for (let t = 0; t < ticks && countItems(bot, 'magma_cream') === 0 && bot.health > CUBE_HOLD_HEALTH; t++) {
      throwIfAborted(signal)
      const eye = eyePosition(bot)
      const close = Object.values(bot.entities)
        .filter(e => e.name === 'magma_cube' && isAlive(bot, e) && distanceToBox(eye, entityBox(e)) <= CUBE_REACH)
        .sort((a, b) => distanceToBox(eye, entityBox(a)) - distanceToBox(eye, entityBox(b)))[0]
      if (close != null) {
        const sword = bestMeleeWeapon(bot, 'magma_cube')
        if (sword != null && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand')
        if (strength.ticksToFull() <= 0) {
          if (blocking) { lowerShield(bot); blocking = false }
          await bot.lookAt(close.position.offset(0, (close.height ?? 1) / 2, 0), true)
          strength.attack(close)
        } else if (!blocking) {
          await bot.lookAt(close.position.offset(0, (close.height ?? 1) / 2, 0), true)
          blocking = await raiseShield(bot).catch(() => false)
        }
      } else {
        if (blocking) { lowerShield(bot); blocking = false }
        const cream = nearbyDrops(bot, bot.entity.position, CUBE_SHOT_RANGE, ['magma_cream'])[0]
        if (cream != null) {
          await collectDropsNear(bot, cream.position, { radius: 2, maxTicks: 200, signal }).catch(err => { if (isAbort(err)) throw err })
        } else if (t % 20 === 0 && arrowsShot < CUBE_ARROWS && countItems(bot, 'bow') > 0 && countItems(bot, ['arrow', 'spectral_arrow']) > 0) {
          // one in sight that doesn't come: shot (its split ones come, or are shot in turn)
          const far = Object.values(bot.entities)
            .filter(e => creamCube(bot, e) && e.position.distanceTo(bot.entity.position) <= CUBE_SHOT_RANGE && hasLineOfSight(bot, e))
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
          if (far != null) {
            const res = await shoot(bot, far, { maxShots: 1, signal }).catch(err => { if (isAbort(err)) throw err; return null })
            arrowsShot += res?.shots ?? 1
          }
        }
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    if (blocking) lowerShield(bot)
    leave?.()
  }
  const cubes = Object.values(bot.entities).filter(e => e.name === 'magma_cube')
  trace('holdForCubes: ended, health', bot.health, 'cream', countItems(bot, 'magma_cream'), 'arrows shot', arrowsShot, 'cubes within 16', cubes.filter(e => e.position.distanceTo(bot.entity.position) <= 16).length, 'of', cubes.length)
}

/**
 * The makings of fire resistance besides the bottles, got from `from` (where the bot came in, the spawner's blazes not
 * out yet: a spawner makes them with a player within 16, BaseSpawner.isNearPlayer): magma cream from the cubes about,
 * nether wart from the fortress's wart rooms, cream again from the cubes met on the way. Resolves whether both are
 * held.
 */
export async function getBrewMakings (bot: Bot, from: Vec3, spawner: Vec3, signal?: AbortSignal): Promise<boolean> {
  const state = brewState(bot)
  return await withNetherSafety(bot, async () => {
    // (with no bow the fight waits on the cream: a fortress's cube waited for, CUBE_WAIT_TICKS)
    if (countItems(bot, 'magma_cream') === 0 && !state.creamSought) { await getMagmaCream(bot, spawner, signal, bowAndArrows(bot) ? 0 : CUBE_WAIT_TICKS); state.creamSought = true }
    // the wart's legs (a fortress's corridors, its lava under them: a 26.3 bot fell in by seed 2's wart room and burned)
    // walked only for a brew that has its cream, or a slime ball for it (made with a blaze powder: creamToMake)
    if (countItems(bot, 'magma_cream') === 0 && countItems(bot, 'slime_ball') === 0) return false
    if (countItems(bot, 'nether_wart') === 0 && !state.wartSought) {
      await getNetherWart(bot, from, spawner, signal)
      state.wartSought = true
      await backToHeal(bot, from, spawner, signal)
    }
    return FIRE_RESISTANCE_BREW.every(name => countItems(bot, name) > 0)
  })
}

/**
 * Back from the wart's trip to where the bot came in, and shut in there to heal up to SEAL_HEAL_TO (healSealed) when
 * it's hurt, before the spawner's fight: a 26.3 bot back from seed 2's wart room along the trail at 3 health, the
 * cubes and the corridors' mobs on the way, went into the nook by its throne at (-277, 77, -159) and a wither skeleton
 * killed it there at 1.5
 */
export async function backToHeal (bot: Bot, from: Vec3, spawner: Vec3, signal?: AbortSignal): Promise<void> {
  if (bot.entity.position.distanceTo(from) > 4) {
    await travel(bot, { target: from, range: 2, exactY: true }, signal).catch(err => { if (isAbort(err)) throw err; trace('backToHeal: the way back:', (err as Error).message) })
  }
  if (bot.health < SEAL_HEAL_TO && !(await healSealed(bot, spawner, signal))) trace('backToHeal: no box to heal in at', bot.entity.position.floored().toString(), 'health', bot.health)
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

/**
 * The blocks that shut a box round the bot's cell and the one beside it toward `dir` (the brewing stand's): a floor
 * under each where there's none, the walls round both cells two high, the roof over both. `solid` tells the blocks
 * there already.
 */
export function brewingBoxCells (feet: Vec3, dir: Vec3, solid: (p: Vec3) => boolean): Vec3[] {
  const cells = [feet, feet.plus(dir)]
  const inside = new Set(cells.flatMap(c => [c, c.offset(0, 1, 0)]).map(c => c.toString()))
  const out: Vec3[] = []
  const add = (p: Vec3): void => { if (!inside.has(p.toString()) && !solid(p) && !out.some(q => q.equals(p))) out.push(p) }
  for (const c of cells) add(c.offset(0, -1, 0))
  for (const c of cells) for (const dy of [0, 1]) for (const s of SIDES) add(c.plus(s).offset(0, dy, 0))
  for (const c of cells) add(c.offset(0, 2, 0))
  return out
}

/**
 * A box shut round the bot and the cell beside it for the brewing stand (the brew takes two of BREW_TICKS at it, out
 * of the blazes' and the cubes' reach): the cell beside the feet on a side with room and a floor, then its blocks put
 * in (brewingBoxCells, fillNook). Resolves the stand's cell, null when there's no side with room.
 */
export async function brewingBox (bot: Bot, signal?: AbortSignal): Promise<Vec3 | null> {
  const feet = bot.entity.position.floored()
  const solid = (p: Vec3): boolean => bot.blockAt(p)?.boundingBox === 'block'
  const open = (p: Vec3): boolean => { const b = bot.blockAt(p); return b != null && b.boundingBox === 'empty' && b.name !== 'lava' && b.name !== 'fire' }
  const dir = SIDES.find(d => open(feet.plus(d)) && open(feet.plus(d).offset(0, 1, 0)) && solid(feet.plus(d).offset(0, -1, 0)))
  if (dir == null) return null
  const shut = brewingBoxCells(feet, dir, solid)
  const missed = await fillNook(bot, shut, signal, false)
  trace('brewingBox: at', feet.toString(), 'the stand to', feet.plus(dir).toString(), shut.length, 'blocks,', missed, 'not put')
  return feet.plus(dir)
}

/** the brews a bot tries to their end (the makings looked for, the rods got a rod at a time, brewed or given up) */
export const BREW_TRIES = 2
/**
 * a bot's brew so far: the tries ended, and whether the wart and the cubes were looked for (the task begun again after
 * a reflex cut it off goes on from there, not off on the wart's legs again: 26.3 seed 2's every restart looked anew)
 */
interface BrewState { tries: number, wartSought: boolean, creamSought: boolean, said: boolean, lit: boolean }
const brewStates = new WeakMap<Bot, BrewState>()
function brewState (bot: Bot): BrewState {
  let s = brewStates.get(bot)
  if (s == null) brewStates.set(bot, s = { tries: 0, wartSought: false, creamSought: false, said: false, lit: false })
  return s
}

/** the brew's tries counted from none again (a new trip to the fortress) */
export function resetBrewTries (bot: Bot): void {
  brewStates.delete(bot)
}

/**
 * The blaze rods with fire resistance brewed as soon as it can be (brewWanted: water bottles carried, no potion of
 * it): the cream (one held, lying about, or of the cubes that come) and then the wart got from `away` (getBrewMakings)
 * before the spawner's woken, no cream no wart sought; then the rods a rod at a time
 * while the brew waits on its makings (the cream of a cube the nook's sword meets: dropsNear) and BREW_RODS rods (the
 * stand's and the fuel's), and once it has them back to `away`, shut in a box there (brewingBox) and brewed; then
 * the rest (collectBlazeRods drinks the potions as it fights). Makings not to be had, or a brew that fails, leave the
 * fight to go on without it, with a bow; with no bow and no fire resistance (none held, on, or brewed) there's no
 * fight: a SkillError MISSING_ITEMS marked noFireResistance (the milestone goes back for the cream's slime ball). A
 * 1.21.11 bot with no bow, its bottles and no cream went in, the brew skipped, and fought seed 2's other throne at
 * (-290, 77, -209) with its sword alone and burned (full-1.21.11-fresh-e). Each decision goes to `log` too.
 */
export async function blazeRodsWithBrew (bot: Bot, args: BlazeRodsArgs & { count: number, away?: Vec3, log?: (line: string) => void }, signal?: AbortSignal): Promise<BlazeRodsResult> {
  const say = (line: string): void => { trace('blazeRodsWithBrew:', line); args.log?.(`fire resistance: ${line}`) }
  // (BREW_TRIES at most: the task begun again after a reflex looked for the makings again each time, 6 times in a run)
  const state = brewState(bot)
  // (once a trip: the task begun again after each reflex said it again, 20 times in a 1.21.11 run)
  if (!state.said) {
    state.said = true
    if (findPotion(bot, 'fire_resistance') != null) say('a potion of it held')
    else if (waterBottles(bot) === 0) say('no water bottles to brew it in')
    else if (state.tries >= BREW_TRIES) say(`${BREW_TRIES} brews tried`)
    else say(countItems(bot, 'magma_cream') > 0 ? 'brewing it: the magma cream held' : countItems(bot, 'slime_ball') > 0 ? 'brewing it: a slime ball for the cream' : 'no magma cream or slime ball: the cubes about looked for')
  }
  // a bunker to be had by the spawner (planBlazeBunkers): the rods from it, no wart nor cream sought and no brew. Its
  // walls take the fireballs; the brew's trips out of it cost the bots: 26.3 bots out of their bunkers by seed 2's
  // throne spawners at (-277, 77, -159) and (-290, 77, -209) for the brew with their first rods were held off by the
  // hostiles reflex among the blazes at the door, or found no way back to where they came in, and burned, 4 runs of 6,
  // where the bunker's fight alone took all 8 rods in the others
  if (brewWanted(bot) && state.tries < BREW_TRIES) {
    const at = args.spawner ?? await findBlazeSpawner(bot, { exclude: args.exclude ?? unreachableSpawners(bot) }, signal).catch(err => { if (isAbort(err)) throw err; return null })
    if (at != null) {
      const spawner = new Vec3(at.x, at.y, at.z)
      args = { ...args, spawner }
      if (planBlazeBunkers(p => bot.blockAt(p) as any, spawner).length > 0) {
        say('a bunker to be had by the spawner: the rods from it, no brew')
        state.tries = BREW_TRIES
      }
    }
  }
  if (brewWanted(bot) && state.tries < BREW_TRIES) {
    const away = args.away ?? bot.entity.position.clone()
    try {
      // (the spawner looked for first when none's given: the makings are got out of its way)
      const at = args.spawner ?? await findBlazeSpawner(bot, { exclude: args.exclude ?? unreachableSpawners(bot) }, signal)
      const spawner = new Vec3(at.x, at.y, at.z)
      args = { ...args, spawner }
      const hadWart = countItems(bot, 'nether_wart') > 0
      await getBrewMakings(bot, away, spawner, signal)
      if (!creamMakings(bot)) say('no magma cream and no slime ball for it: no wart sought, no brew')
      else if (!hadWart) say(countItems(bot, 'nether_wart') > 0 ? `${countItems(bot, 'nether_wart')} nether wart got` : 'no nether wart found')
      const rodsFor = (): number => Math.max(0, BREW_RODS - (countItems(bot, 'brewing_stand') > 0 ? 1 : 0) - (countItems(bot, 'blaze_powder') > 0 ? 1 : 0))
      // (a slime ball counts for the cream: a rod's 2 powder are the fuel's and the cream's)
      const makings = (): boolean => countItems(bot, 'nether_wart') > 0 && (countItems(bot, 'magma_cream') > 0 || countItems(bot, 'slime_ball') > 0)
      if (countItems(bot, 'nether_wart') === 0) trace('blazeRodsWithBrew: no nether wart for fire resistance')
      // the spawner lit but for a patch by the nook first (spawnerLight: its blazes come one at a time, there)
      // (not with a bunker to be had by it: the bunker lights it itself, once it's built, when it's quiet)
      if (countItems(bot, 'nether_wart') > 0 && countItems(bot, 'torch') >= LIGHT_TORCHES && !state.lit && planBlazeBunkers(p => bot.blockAt(p) as any, spawner).length === 0) {
        state.lit = true
        const nook = planBlazeNooks(p => bot.blockAt(p) as any, spawner, { from: away })[0]
        const eye = nook != null ? nook.stand.offset(0.5, 1.62, 0.5) : away
        const put = await withNetherSafety(bot, async () => await lightBlazeSpawner(bot, spawner, eye, signal))
        say(`${put.length} torches by the spawner, its spawns but a patch by the nook lit`)
      }
      // a rod at a time till the brew has its rods and its cream (the wart got, the count short of the whole)
      while (countItems(bot, 'nether_wart') > 0 && countItems(bot, 'blaze_rod') < args.count && (!makings() || countItems(bot, 'blaze_rod') < rodsFor())) {
        throwIfAborted(signal)
        await collectBlazeRods(bot, { ...args, count: countItems(bot, 'blaze_rod') + 1 }, signal)
      }
      if (makings() && countItems(bot, 'blaze_rod') >= rodsFor()) {
        // (to its height too: a 26.3 bot's trip ended over where it came in, 3 off the nook under seed 2's throne, and it
        // brewed there in the blazes' fire and burned)
        if (bot.entity.position.distanceTo(away) > 4) await travel(bot, { target: away, range: 2, exactY: true, trail: false }, signal)
        if (bot.entity.position.distanceTo(spawner) < BREW_CLEAR) throw new SkillError('NO_PATH', `no way back to ${away.floored().toString()} to brew at, ${bot.entity.position.distanceTo(spawner).toFixed(0)} off the spawner`)
        // the stand and the powder made before the box (its blocks would take the stand's cobblestone: 'can't craft 1
        // brewing_stand', 26.3)
        if (countItems(bot, 'blaze_powder') < creamToMake(bot) + 1) await craft(bot, { item: 'blaze_powder' }, signal)
        // the cream of a slime ball and a blaze powder (the shapeless recipe), the fuel's powder left
        if (creamToMake(bot) > 0) await craft(bot, { item: 'magma_cream' }, signal)
        if (countItems(bot, 'brewing_stand') === 0) await craft(bot, { item: 'brewing_stand' }, signal)
        const standAt = await brewingBox(bot, signal)
        const brewed = await brew(bot, { ingredients: FIRE_RESISTANCE_BREW, standAt: standAt ?? undefined }, signal)
        say(`${brewed.potions} potions brewed`)
        // the first one drunk at once, shut in still (the nook's fight drinks one only when no blaze is about to shoot:
        // back in it with 3 potions a 26.3 bot never had that quiet, and the blazes killed it)
        if (findPotion(bot, 'fire_resistance') != null) await drinkPotion(bot, 'fire_resistance', signal).catch(err => { if (isAbort(err)) throw err })
      } else {
        say(`not brewed, short of ${[...FIRE_RESISTANCE_BREW.filter(n => countItems(bot, n) === 0 && !(n === 'magma_cream' && countItems(bot, 'slime_ball') > 0)), ...(countItems(bot, 'blaze_rod') < rodsFor() ? ['blaze rods'] : [])].join(', ')}`)
      }
      state.tries++
    } catch (err) {
      if (isAbort(err) || bot.health <= 0) throw err
      state.tries++
      say(`not brewed: ${(err as Error).message}`)
    }
  }
  // no bow and no fire resistance: no fight in the open (the blazes' throne fought with a sword alone burned the bots),
  // but from a bunker by the spawner (its sword meets the blazes at its slit; no nook nor camp after it: bunkerOnly,
  // which throws the noFireResistance MISSING_ITEMS itself when none can be had there). Judged here only from where
  // the bot came in, the spawner's chunks too far to see, a 1.21.11 game's bot with a sword alone gave its fortress up
  // for the overworld's slime ball (ls3-1.21.11 resumed from its enchanting, t675854)
  if (countItems(bot, 'blaze_rod') < args.count && !bowAndArrows(bot) && findPotion(bot, 'fire_resistance') == null && !hasEffect(bot, 'fire_resistance')) {
    say('no bow and none of it: the sword from a bunker only')
    return await collectBlazeRods(bot, { ...args, bunkerOnly: true }, signal)
  }
  return await collectBlazeRods(bot, args, signal)
}
