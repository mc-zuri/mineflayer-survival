// sealIn: the hostiles reflex's retreat when hurt among melee mobs: the bot shut in where it stands (a box of full
// blocks round its body: the back and the sides at the feet and the head, the roof, the front toward the mobs last,
// nookAround's), fed and healed behind the blocks, and left shut (the work's next walk digs out at full health). A
// zombie can't break a block (but a door, on hard), nor hit through one: MeleeAttackGoal needs a line of sight
// (Sensing.hasLineOfSight) and its attack box (Mob.getAttackBoundingBox) is widened sideways only. A mob in a cell to
// fill is hit back out of it (the sword's knockback, LivingEntity.knockback 0.4), the shield up toward it between the
// swings, and the block goes in once its box is out (BlockItem.canPlace: Level.isUnobstructed).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { type Entity, entityBox, eyePosition, isAlive, yawPitchOf } from './combatUtil'
import { MELEE_MOBS, lowerShield, raiseShield, swingVictim } from './fight'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
import { eat, bestFoodInInventory } from './eat'
import { placeBlock } from './placeBlock'
import { walkTo } from './navigate'
import { sealItem } from './shelter'
import { countItems, isInfested, trace, waitTicks } from './util'
import { boxInCell } from './placement'
import { nookAround, type BlazeNook } from '../nether/blazeFight'
import { placeRefused } from './spawnProtection'

/** the health the bot heals to shut in (FoodData.tick: a point every 10 ticks saturated, every 80 from food 18 up) */
export const SEAL_HEAL_TO = 18
/** ticks the box's blocks may take to go in, the mobs in its cells hit back the while; past it the box is given up */
export const SEAL_BUILD_TICKS = 300
/** ticks shut in at most */
export const SEAL_MAX_TICKS = 2400
/**
 * the most blocks a box may take for the hostiles reflex to shut in (a tunnel's two ends, a passage's corner): each
 * block is a few ticks with the shield down, and ten of them in a spawner's room took a 26.3 bot from 9 health to dead
 * with the zombies about it (tests/integration/mineZombies)
 */
export const SEAL_MAX_BLOCKS = 4

/** whether a mob's box is in the cell (the server refuses a block there: Level.isUnobstructed) */
export function mobInCell (e: { position: Vec3, width?: number, height?: number }, cell: Vec3): boolean {
  const { min, max } = entityBox(e)
  return min.x < cell.x + 1 && max.x > cell.x && min.y < cell.y + 1 && max.y > cell.y && min.z < cell.z + 1 && max.z > cell.z
}

/** the cardinal way from `feet` toward `at` */
export function cardinalToward (feet: Vec3, at: Vec3): Vec3 {
  const dx = at.x - (feet.x + 0.5)
  const dz = at.z - (feet.z + 0.5)
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(dx < 0 ? -1 : 1, 0, 0) : new Vec3(0, 0, dz < 0 ? -1 : 1)
}

/**
 * The box round the bot's feet, its front toward the nearest threat (nookAround: the back and the sides at the feet
 * and the head and the roof, with a block under a wall over nothing first, then the front's two cells); null where
 * none can be put up (a wall cell not open nor a full block: lava, water, a slab), or where a wall, the roof or the
 * floor is an infested block (infestedBox: shut in among a silverfish nest, a fight in the box wakes it)
 */
export function sealBox (bot: Bot, threats: readonly Entity[]): BlazeNook | null {
  const feet = bot.entity.position.floored()
  const nearest = threats.slice().sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  const facing = nearest != null ? cardinalToward(feet, nearest.position) : new Vec3(1, 0, 0)
  const box = nookAround(p => bot.blockAt(p) as any, feet, facing)
  if (box != null && infestedBox(p => bot.blockAt(p) as any, box) != null) {
    trace('sealBox: infested', infestedBox(p => bot.blockAt(p) as any, box)?.toString(), 'in the box round', feet.toString())
    return null
  }
  return box
}

/**
 * The first cell of a box's walls, roof, floor or front that's an infested block (isInfested), or null: a silverfish
 * comes out of one broken or hit, and a hurt one calls out the rest of the nest round it (Silverfish's
 * WakeUpFriendsGoal); a 26.3 bot walled in at y 29 among a nest was slain by 9 silverfish (f5-26.3)
 */
export function infestedBox (lookup: (pos: Vec3) => { name: string } | null, box: BlazeNook): Vec3 | null {
  for (const cell of [...box.walls, ...box.build, ...box.front, ...box.floor]) {
    if (isInfested(lookup(cell)?.name)) return cell
  }
  return null
}

/** the box's cells still open, in the order they go in */
export function openCells (bot: Bot, box: BlazeNook): Vec3[] {
  return [...box.build, ...box.front].filter(p => bot.blockAt(p)?.boundingBox !== 'block')
}

/** whether the server refuses a block in one of the box's open cells (skills/spawnProtection placeRefused: the spawn's square, a claim) */
export function boxRefused (bot: Bot, box: BlazeNook): boolean {
  return openCells(bot, box).some(p => placeRefused(bot, p))
}

export interface SealInOptions {
  signal?: AbortSignal
  /** the mobs about (default: the melee mobs within 16) */
  threats?: () => Entity[]
  /** heal to this (default SEAL_HEAL_TO) */
  healTo?: number
  /** ticks shut in at most (default SEAL_MAX_TICKS) */
  maxTicks?: number
}

export interface SealInResult {
  /** blocks put */
  placed: number
  /** ticks shut in */
  ticks: number
  health: number
}

/** the bot's feet in the box's cell */
export function inBox (bot: Bot, box: BlazeNook): boolean {
  const p = bot.entity.position
  return Math.floor(p.x) === box.stand.x && Math.floor(p.z) === box.stand.z && Math.abs(p.y - box.stand.y) < 0.6
}

function meleeAbout (bot: Bot): Entity[] {
  return Object.values(bot.entities).filter(e => e !== bot.entity && MELEE_MOBS.has(e.name ?? '') && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) <= 16)
}

/**
 * Shut in where the bot stands and healed there (see the file's head). Throws CANNOT_PLACE when there's no box to be
 * had there or its blocks didn't all go in within SEAL_BUILD_TICKS, MISSING_ITEMS with too few blocks for it.
 */
export async function sealIn (bot: Bot, opts: SealInOptions = {}): Promise<SealInResult> {
  const signal = opts.signal
  const threats = opts.threats ?? (() => meleeAbout(bot))
  const healTo = opts.healTo ?? SEAL_HEAL_TO
  const maxTicks = opts.maxTicks ?? SEAL_MAX_TICKS
  let box = sealBox(bot, threats())
  if (box == null) throw new SkillError('CANNOT_PLACE', `no box to shut in at ${bot.entity.position.floored().toString()}`)
  const item = sealItem(bot)
  const needed = openCells(bot, box).length
  if (item == null || countItems(bot, item) < needed) throw new SkillError('MISSING_ITEMS', `${needed} blocks to shut in, ${item == null ? 0 : countItems(bot, item)} carried`)
  trace('sealIn: shutting in at', box.stand.toString(), 'facing', box.facing.toString(), needed, 'blocks')
  const strength = attackStrengthOf(bot)
  let blocking = false
  let placed = 0
  try {
    // (the body in the middle of its cell: half in a wall's cell, the wall's block would walk it out of the box)
    await walkTo(bot, box.stand.offset(0.5, 0, 0.5), { within: 0.15, maxTicks: 10 }, signal)
    bot.clearControlStates()
    const tried = new Map<string, number>()
    let moved = 0
    for (let t = 0; t < SEAL_BUILD_TICKS; t++) {
      throwIfAborted(signal)
      // knocked out of the box's cell (a hit's knockback): a box where the bot is now, twice at most
      if (!inBox(bot, box)) {
        const again = moved++ < 2 ? sealBox(bot, threats()) : null
        if (again == null) throw new SkillError('CANNOT_PLACE', `knocked out of the box at ${box.stand.toString()}`)
        box = again
        tried.clear()
      }
      const open = openCells(bot, box)
      if (open.length === 0) break
      // the body back in the middle of its cell when it's in one of the cells to fill: placeBlock's step off it would
      // walk the bot out of the box
      // (and on its feet: knocked up, its head is in the roof's cell)
      if (!bot.entity.onGround) { await waitTicks(bot, 1, signal); continue }
      const feetLevel = bot.entity.position.offset(0, box.stand.y - bot.entity.position.y, 0)
      if (open.some(c => boxInCell(feetLevel, c))) {
        if (blocking) { lowerShield(bot); blocking = false }
        await walkTo(bot, box.stand.offset(0.5, 0, 0.5), { within: 0.1, maxTicks: 4 }, signal)
        bot.clearControlStates()
        await waitTicks(bot, 1, signal)
        continue
      }
      const mobs = threats()
      const next = open.find(c => !mobs.some(m => mobInCell(m, c)) && (tried.get(c.toString()) ?? 0) < 3)
      if (next != null) {
        if (blocking) { lowerShield(bot); blocking = false }
        const block = sealItem(bot)
        if (block == null) throw new SkillError('MISSING_ITEMS', 'out of blocks to shut in with')
        try {
          await placeBlock(bot, { pos: next, item: block }, signal)
          placed++
        } catch (err) {
          if (isAbort(err)) throw err
          tried.set(next.toString(), (tried.get(next.toString()) ?? 0) + 1)
          trace('sealIn: no block at', next.toString(), (err as Error).message)
        }
        continue
      }
      // a mob in each cell left: hit back out of it, the shield up toward it between the swings
      const inCell = mobs.filter(m => open.some(c => mobInCell(m, c)))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (inCell == null) throw new SkillError('CANNOT_PLACE', `the box's ${open.length} open cells won't take a block`)
      const weapon = bestMeleeWeapon(bot, inCell.name)
      if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
      const { yaw, pitch } = yawPitchOf(inCell.position.offset(0, (inCell.height ?? 1.95) * 0.6, 0).minus(eyePosition(bot)))
      await bot.look(yaw, pitch, true)
      if (strength.scale(0.5) >= 1 && swingVictim(bot, inCell) != null) {
        if (blocking) { lowerShield(bot); blocking = false; await waitTicks(bot, 1, signal) }
        strength.attack(swingVictim(bot, inCell) ?? inCell)
      } else if (!blocking) {
        blocking = await raiseShield(bot).catch(() => false)
      }
      await waitTicks(bot, 1, signal)
    }
  } finally {
    if (blocking) lowerShield(bot)
  }
  const left = openCells(bot, box)
  if (left.length > 0) throw new SkillError('CANNOT_PLACE', `${left.length} of the box's cells still open`)
  if (!inBox(bot, box)) throw new SkillError('CANNOT_PLACE', `the bot is at ${bot.entity.position.toString()}, out of the box at ${box.stand.toString()}`)
  trace('sealIn: shut in, health', bot.health)

  let ticks = 0
  while (ticks < maxTicks && bot.health < healTo && bot.health > 0) {
    throwIfAborted(signal)
    if (!inBox(bot, box)) throw new SkillError('VERIFY_FAILED', `out of the box at ${box.stand.toString()}`)
    // a block gone (a creeper's blast): put back
    const hole = openCells(bot, box).find(c => !threats().some(m => mobInCell(m, c)))
    const block = sealItem(bot)
    if (hole != null && block != null) {
      await placeBlock(bot, { pos: hole, item: block }, signal).catch(err => { if (isAbort(err)) throw err })
      continue
    }
    const apple = bot.health <= 8 && bot.inventory.items().some(i => i.name === 'golden_apple') ? 'golden_apple' : undefined
    if ((bot.food < 20 || apple != null) && (apple != null || bestFoodInInventory(bot) != null)) {
      try { await eat(bot, { signal, food: apple }) } catch (err) { if (isAbort(err)) throw err }
      continue
    }
    // (FoodData.tick heals nothing under food 18 and there's nothing to eat: no use waiting)
    if (bot.food < 18) break
    await waitTicks(bot, 10, signal)
    ticks += 10
  }
  const weapon = bestMeleeWeapon(bot)
  if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand').catch(() => {})
  return { placed, ticks, health: bot.health }
}
