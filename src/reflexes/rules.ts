import type { Bot } from 'mineflayer'
import { armorUpgrades, equipArmor, equipTotem } from '../skills/armor'
import { eat, dueMeal, reserveAllows } from '../skills/eat'
import { escapeHazard, evadeCreeper, fireHandled, fleeFrom, headInWater, inFireOnly, inHazard, surface } from '../skills/escape'
import { MELEE_GUARD_MARGIN, MELEE_MOBS, creeperSwelling, fight, inMobReach } from '../skills/fight'
import { shoot, sparedInLine } from '../skills/shoot'
import { armorPoints, botIsBrightOutside, isEnclosed, leaveShelter, nightPlan, shelter, shelterRunning, shelterToLeave, sleepThroughNight, ticksSinceRest, undergroundAtWork, type NightPlan } from '../skills/shelter'
import type { Vec3 } from 'vec3'
import { bestMeleeWeapon } from '../skills/weapons'
import { hasLineOfSight, isAlive, type Entity } from '../skills/combatUtil'
import { holdOffBlazes } from '../nether/blazeFight'
import { ARCHER_BUDGET, GHAST_FIREBALL, deadlyDropBeside, deflectFireball, fireballIncoming, holdOffArcher, keepFromGhast, nearestGhast, withNetherSafety } from '../nether/safety'
import { nearbyDrops, pickupDrops } from '../skills/pickupDrops'
import { isSkillError } from '../skills/errors'
import type { Reflex, ReflexContext } from './types'
import type { ReflexConfig } from './config'
import { isBed } from '../core/items'
import { breakFall, predictLanding, shouldBreakFall } from '../skills/fall'
import { blockIdsNamed, findBlock } from '../core/findBlocks'
import { findDoorRefuge, retreatIndoors, type DoorRefuge } from '../skills/indoors'
import { clearOfWarden, darkSpawners, escapeWarden, lightSpawner, nearestWarden, spawnerLit } from '../skills/danger'
import { XP_FARM_POI } from '../skills/spawnerFarm'
import { SEAL_MAX_BLOCKS, openCells, sealBox, sealIn } from '../skills/sealIn'
import { sealItem } from '../skills/shelter'
import { countItems } from '../skills/util'

/** A hostile mob (minecraft-data's entity type 'hostile', vanilla's MobCategory.MONSTER) still alive. */
/**
 * Mobs that attack a player on sight that minecraft-data doesn't type 'hostile' (its 'mob' and 'animal': Slime and
 * MagmaCube are Mob, Phantom FlyingMob, Hoglin Animal): a slime of a slime chunk killed a 26.3 bot in a cave that
 * never hit back, 17 hits
 */
export const HOSTILE_UNTYPED = new Set(['slime', 'magma_cube', 'phantom', 'hoglin'])

export function isHostile (bot: Bot, e: Entity): boolean {
  if (e === bot.entity || e.name == null) return false
  return (bot.registry.entitiesByName as any)[e.name]?.type === 'hostile' || HOSTILE_UNTYPED.has(e.name)
}

function distance (bot: Bot, e: Entity): number {
  return bot.entity.position.distanceTo(e.position)
}

function hasShield (bot: Bot): boolean {
  return bot.inventory.slots[45]?.name === 'shield' || bot.inventory.items().some(i => i.name === 'shield')
}

function hasBowAndArrows (bot: Bot): boolean {
  const items = bot.inventory.items()
  return items.some(i => i.name === 'bow') && items.some(i => /arrow$/.test(i.name))
}

/** A totem of undying in the off hand when there's one in the inventory (and the off hand isn't holding up a shield). */
export const totemReflex: Reflex = {
  name: 'totem',
  priority: 95,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.totem.enabled || ctx.offhandLocked) return null
    if (bot.inventory.slots[45]?.name === 'totem_of_undying') return null
    if (!config.totem.always && bot.health > config.totem.health) return null
    if (!bot.inventory.items().some(i => i.name === 'totem_of_undying')) return null
    return { name: 'totem', priority: config.totem.priority, run: async () => await equipTotem(bot) }
  }
}

/** A ghast's fireball coming at the bot: punched back (AbstractHurtingProjectile.hurt turns it along the look). */
export const fireballReflex: Reflex = {
  name: 'fireball',
  priority: 92,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.fireball.enabled) return null
    const fireball = Object.values(bot.entities).find(e => e.name === GHAST_FIREBALL && fireballIncoming(bot, e, config.fireball.range))
    if (fireball == null) return null
    return { name: 'fireball', priority: config.fireball.priority, detail: 'deflect fireball', run: async (signal) => await deflectFireball(bot, fireball, { signal, range: config.fireball.range }) }
  }
}

/** the ticks each bot has held back from each ghast (ghastReflex's budget) */
const ghastHeld = new WeakMap<Bot, Map<number, number>>()

/**
 * A ghast in sight while the bot stands by a deadly drop (a bridge or a ledge over the lava sea): back to firm ground
 * and held there facing it (keepFromGhast), its fireballs hit back by the fireball reflex, till it's gone or dead, or
 * the bot has held config.ghast.budgetTicks for it. A 26.3 bot on a ledge over the lava sea was blown off it by a
 * ghast's fireball; one walking a bridge stopped for a fireball only once its pathfinder let go of it, 10 ticks on and
 * too late.
 */
export const ghastReflex: Reflex = {
  name: 'ghast',
  priority: 88,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.ghast.enabled) return null
    const ghast = nearestGhast(bot, config.ghast.range)
    if (ghast == null) return null
    let held = ghastHeld.get(bot)
    if (held == null) ghastHeld.set(bot, held = new Map())
    for (const id of held.keys()) if (bot.entities[id] == null) held.delete(id)
    const spent = held.get(ghast.id) ?? 0
    if (spent >= config.ghast.budgetTicks) return null
    if (!deadlyDropBeside(p => bot.blockAt(p) as any, bot.entity.position) || !hasLineOfSight(bot, ghast)) return null
    // (a mob come to fight first: the hostiles reflex's)
    const fightNear = (): boolean => Object.values(bot.entities).some(e => e.name !== 'ghast' && isHostile(bot, e) && isAlive(bot, e) && distance(bot, e) <= config.combat.range)
    if (fightNear()) return null
    const counts = held
    return {
      name: 'ghast',
      priority: config.ghast.priority,
      detail: 'keep from ghast',
      run: async (signal) => await keepFromGhast(bot, ghast, {
        signal,
        range: config.ghast.range,
        maxTicks: Math.min(config.ghast.holdTicks, config.ghast.budgetTicks - spent),
        onHold: () => counts.set(ghast.id, (counts.get(ghast.id) ?? 0) + 1),
        until: fightNear
      })
    }
  }
}

/**
 * A warden near: away from it till out of its sonic boom's reach and its follow (escapeWarden), never fought (500
 * health, a 30 hit, and the boom of 10 through shield and armor from 15 blocks off, Warden's SonicBoom). A 26.3 bot
 * digging its way up out of the deep dark was boomed twice from 16 and 18 blocks off (full-26.3-s9183-a).
 */
export const wardenReflex: Reflex = {
  name: 'warden',
  priority: 89,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.warden.enabled) return null
    const warden = nearestWarden(bot, config.warden.range)
    if (warden == null || clearOfWarden(bot, warden)) return null
    return { name: 'warden', priority: config.warden.priority, detail: 'escape warden', run: async (signal) => await escapeWarden(bot, warden, { signal, maxTicks: config.warden.maxTicks }) }
  }
}

/** Out of lava and fire. */
export const hazardReflex: Reflex = {
  name: 'hazard',
  priority: 90,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.hazard.enabled) return null
    if (!inHazard(bot)) return null
    // (the fire's cells left to a task that handles them, the blaze fight's: handleFire; lava never)
    if (fireHandled(bot) && inFireOnly(bot)) return null
    return {
      name: 'hazard',
      priority: config.hazard.priority,
      run: async (signal) => await escapeHazard(bot, { signal, searchRadius: config.hazard.searchRadius, waterRadius: config.hazard.waterRadius, maxTicks: config.hazard.maxTicks })
    }
  }
}

/** the reflexes that eat: none fires with the head under water (the drowning reflex's hold) */
const EATING_REFLEXES = new Set(['eat', 'emergency eat'])

/**
 * A hostile the drowning reflex's hold lets fight under water at low air: the bot at the hostiles' flee health or
 * under, hurt by one of those in range lately (a drowned's trident or a guardian's beam kills sooner than the water)
 */
export function lethalHostile (ctx: ReflexContext): boolean {
  const { bot, config } = ctx
  if (bot.health > config.hostiles.fleeHealth) return false
  return ctx.hostiles.some(e => {
    const at = ctx.attackers.get(e.id)
    return at != null && ctx.tick - at <= config.combat.hurtTicks && distance(bot, e) <= config.hostiles.range
  })
}

/**
 * Up for air when it runs low under water. With the head under water it holds the reflexes under it (Reflex.hold):
 * no eating there (the meal's 32 ticks are air gone, and the bot sinks while it eats), and at low air nothing but a
 * lethal fight (lethalHostile), whether the reflex is under way or waiting to go again (retryCooldownTicks 0: it goes
 * again at once). A 26.3 bot's surfacing failed, the eat reflex ate a porkchop at 0 air in the 20 ticks of the retry
 * cooldown, and the bot drowned (full-26.3-fresh-z, t95901).
 */
export const drowningReflex: Reflex = {
  name: 'drowning',
  priority: 85,
  retryCooldownTicks: 0,
  hold (ctx) {
    const { bot, config } = ctx
    if (!config.drowning.enabled || bot.entity == null || !headInWater(bot)) return null
    const airLow = bot.oxygenLevel <= config.drowning.air
    return {
      below: config.drowning.priority,
      except: (task) => airLow ? task.name === 'hostiles' && lethalHostile(ctx) : !EATING_REFLEXES.has(task.name)
    }
  },
  check (ctx) {
    const { bot, config } = ctx
    if (!config.drowning.enabled) return null
    if (bot.oxygenLevel > config.drowning.air || !headInWater(bot)) return null
    return {
      name: 'drowning',
      priority: config.drowning.priority,
      run: async (signal) => await surface(bot, { signal, recoverTo: config.drowning.recoverTo, searchRadius: config.drowning.searchRadius, maxTicks: config.drowning.maxTicks })
    }
  }
}

/** The creeper that threatens: one this close, or one swelling within the blast's reach. */
export function threateningCreeper (ctx: ReflexContext): Entity | null {
  const { bot, config } = ctx
  let best: Entity | null = null
  let bestDistance = Infinity
  for (const e of ctx.hostiles) {
    if (e.name !== 'creeper') continue
    const d = distance(bot, e)
    // one behind a wall can't start its fuse (SwellGoal stops swelling without a line of sight to the target)
    if ((d < config.creeper.triggerDistance && hasLineOfSight(bot, e)) || (creeperSwelling(bot, e) && d < config.creeper.safeDistance)) {
      if (d < bestDistance) { best = e; bestDistance = d }
    }
  }
  return best
}

/** Away from a creeper whose fuse started (Creeper.DATA_SWELL_DIR) or that came within 3 blocks; the shield if cornered. */
export const creeperReflex: Reflex = {
  name: 'creeper',
  priority: 80,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.creeper.enabled) return null
    const creeper = threateningCreeper(ctx)
    if (creeper == null) return null
    // the hostiles reflex fighting it with a shield: fight() blocks the blast itself once the fuse is along (and hits and
    // backs off); running from it each time it came within 3 blocks kept the bot from ever hitting it, 600 ticks under
    // the skeletons' arrows
    // (nor one it fights cornered, with no way to run from it: its hits keep it off)
    if (ctx.running?.name === 'hostiles' && ctx.running.detail === 'fight creeper' && (hasShield(bot) || wasCornered(bot, ctx.tick))) return null
    return {
      name: 'creeper',
      priority: config.creeper.priority,
      detail: 'evade creeper',
      run: async (signal) => await evadeCreeper(bot, creeper, {
        signal,
        safeDistance: config.creeper.safeDistance,
        blockAtSwell: config.creeper.blockAtSwell,
        blockDistance: config.creeper.blockDistance,
        maxTicks: config.creeper.maxTicks,
        swell: ctx.swell.get(creeper.id) ?? 0
      })
    }
  }
}

/**
 * A neutral mob that hurt the bot lately (an enderman it looked at, a zombified piglin it hit by mistake): fought back
 * (NeutralMob stays angry for its anger time; one let be went on hitting a stone-sword bot to death).
 */
export function provoked (ctx: ReflexContext, e: Entity): boolean {
  const { config } = ctx
  if (!config.hostiles.retaliate.includes(e.name ?? '')) return false
  const at = ctx.attackers?.get(e.id)
  return at != null && ctx.tick - at <= config.hostiles.retaliateTicks
}

/**
 * The mobs that come many at a time, slow and melee alone: a slime or magma cube splits into 2 to 4 smaller ones as it
 * dies (Slime.remove), down to the smallest. They don't count toward the hostiles reflex's outnumbering of a bot with
 * the armor and a weapon to fight them: fleeing them about a basalt delta (they hop as fast as the bot runs) took two
 * 1.21.11 bots in diamond onto its magma blocks, hit all the way, and they died there (tests/integration/blaze, seed 2)
 */
export const SWARMERS = new Set(['slime', 'magma_cube'])

/** the mobs that shoot (BlazeAttackGoal's 48 blocks, RangedBowAttackGoal's 15, RangedCrossbowAttackGoal's 8 and more, the witch's RangedAttackGoal 10) */
export const RANGED_HOSTILES = new Set(['skeleton', 'stray', 'bogged', 'parched', 'pillager', 'witch', 'blaze'])

/**
 * The hostiles within the reflex's range that the bot can see, nearest first (the ignored ones left out): within
 * `range`, or `rangedRange` for the ones that shoot (a skeleton 12 blocks off shot the bot for 500 ticks while it stood
 * there). One without a line of sight can't hit or shoot the bot either (MeleeAttackGoal and RangedBowAttackGoal need
 * one): a zombie on the far side of a wall, or over a shelter's roof, is left alone.
 */
export function hostilesInRange (ctx: ReflexContext): Entity[] {
  const { bot, config } = ctx
  return ctx.hostiles.filter(e => (!config.hostiles.ignore.includes(e.name ?? '') || provoked(ctx, e)) &&
    distance(bot, e) <= (RANGED_HOSTILES.has(e.name ?? '') ? Math.max(config.hostiles.range, config.hostiles.rangedRange) : config.hostiles.range) &&
    Math.abs(e.position.y - bot.entity.position.y) <= config.hostiles.maxDy &&
    hasLineOfSight(bot, e))
}

/** Fight the nearest hostile, or flee when hurt, outnumbered or (if so set) unarmed. Creepers are shot, fought with a shield up, or fled. */
/**
 * blocks a step down may drop while the hostiles reflex fights slimes and magma cubes (SWARMERS): they hop after the
 * bot, so the fight keeps to its level. Chasing one down the 1 to 3 block steps of seed 2's basalt delta took a 26.3
 * bot from a fortress bridge at y 61 down to the lava sea at 32, onto a magma block by the lava, where it died
 */
export const SWARM_MAX_DROP = 1

/**
 * In the nether a fight keeps to the ground it started on (the lava sea is under every slope): within NETHER_LEASH
 * across of where the bot first fought that mob and no more than NETHER_FIGHT_DROP under it, each step down at most a
 * block; past that the mob is let be. A 26.3 bot chased a skeleton 20 blocks over a soul sand valley and 13 down, into
 * the lava sea, with its 16 pearls and 10 rods (nether-26.3-q3)
 */
export const NETHER_LEASH = 8
export const NETHER_FIGHT_DROP = 2
/** ticks a leash's anchor is kept for a mob */
export const LEASH_TICKS = 1200

export function inNether (bot: Bot): boolean {
  return /nether/.test(String(bot.game?.dimension ?? ''))
}

/**
 * In the nether a wither skeleton coming at the bot is shot while it's WITHER_SHOOT_FROM or more off (to
 * WITHER_SHOOT_RANGE, in sight, a bow and arrows carried) and nothing else is nearer, and met with the sword and the
 * shield (fight's meleeGuard) once it's within WITHER_MELEE_AT. Its 20 health is three full draws (BowItem: 6 to 9 a
 * full-power arrow), and a fortress's corridors are straight: a 26.3 bot with a bow and 28 arrows met two in melee in
 * a corridor by seed 2's throne, took four of their hits of 4.4 and the wither, and died
 * (full-26.3-fresh-u, t232814)
 */
export const WITHER_SHOOT_FROM = 6
export const WITHER_SHOOT_RANGE = 16
export const WITHER_MELEE_AT = 4

/** the wither skeleton to shoot now (WITHER_SHOOT_FROM), the nearest, or null */
export function witherToShoot (ctx: ReflexContext): Entity | null {
  const { bot, config } = ctx
  if (!inNether(bot) || !hasBowAndArrows(bot)) return null
  return ctx.hostiles.find(e => {
    if (e.name !== 'wither_skeleton') return false
    const d = distance(bot, e)
    return d >= WITHER_SHOOT_FROM && d <= WITHER_SHOOT_RANGE && Math.abs(e.position.y - bot.entity.position.y) <= config.hostiles.maxDy &&
      hasLineOfSight(bot, e) && !letBeInNether(bot, e, ctx.tick) && sparedInLine(bot, e) == null
  }) ?? null
}

/** whether `pos` is past the leash of `anchor` (NETHER_LEASH across, NETHER_FIGHT_DROP down) */
export function pastLeash (anchor: Vec3, pos: Vec3): boolean {
  return Math.hypot(pos.x - anchor.x, pos.z - anchor.z) > NETHER_LEASH || pos.y < anchor.y - NETHER_FIGHT_DROP
}

/** each bot's nether fights: where it first fought each mob, and when; and the ticks it has held off each archer */
const netherFights = new WeakMap<Bot, { anchors: Map<number, { at: Vec3, tick: number }>, archers: Map<number, number> }>()
function netherFightsOf (bot: Bot): { anchors: Map<number, { at: Vec3, tick: number }>, archers: Map<number, number> } {
  let f = netherFights.get(bot)
  if (f == null) netherFights.set(bot, f = { anchors: new Map(), archers: new Map() })
  return f
}

/** a mob the hostiles reflex lets be in the nether: an archer held off ARCHER_BUDGET ticks, one the bot is past the leash of */
export function letBeInNether (bot: Bot, e: Entity, tick: number): boolean {
  const f = netherFightsOf(bot)
  for (const [id, a] of f.anchors) if (bot.entities[id] == null || tick - a.tick > LEASH_TICKS) f.anchors.delete(id)
  for (const id of f.archers.keys()) if (bot.entities[id] == null) f.archers.delete(id)
  const a = f.anchors.get(e.id)
  if (a == null || !pastLeash(a.at, bot.entity.position)) return false
  // (past its leash an archer is held off from there with the bow, ARCHER_BUDGET ticks)
  if (RANGED_HOSTILES.has(e.name ?? '') && e.name !== 'blaze') return !hasBowAndArrows(bot) || (f.archers.get(e.id) ?? 0) >= ARCHER_BUDGET
  return true
}

/** the hostiles reflex's melee against `target` (fight's options) */
export function meleeOptions (target: { name?: string }, config: ReflexConfig, nether = false): { maxTicks: number, maxDistance: number, aimHeight?: number, maxDrop?: number, yieldToNearer: boolean } {
  return {
    maxTicks: config.hostiles.fightTicks,
    // (another melee mob at the bot while the target is out of the sword's reach: the fight ends, and the reflex
    // fights the nearest next)
    yieldToNearer: true,
    maxDistance: config.combat.scanRange * 2,
    // an enderman hit low: a look at its eyes (EnderMan.isLookingAtMe) is what angers the others
    aimHeight: target.name === 'enderman' ? 0.3 : undefined,
    // (an enderman's fight kept on the bot's level too: its hits knock the bot back, and one after it over a warped
    // forest's ledges was knocked off one to its death, 26.3 run n2-d; another fought one by the lava sea and went in,
    // run p11)
    maxDrop: nether || SWARMERS.has(target.name ?? '') || target.name === 'enderman' ? SWARM_MAX_DROP : undefined
  }
}

/**
 * Fists only (no weapon carried, bestMeleeWeapon): fled from, not fought, when one of them shoots or there's more than
 * one (or always, with fleeUnarmed). A fist's 1 a hit takes 20 hits to kill a skeleton or 24 a pillager, under their
 * arrows and bolts all the while; a lone zombie is still fought. Three 26.3 bots back from a death with nothing fought
 * a pillager patrol, a skeleton and a spider, and a skeleton by a creeper with their fists, and died each time
 * (full-26.3-m)
 */
export function unarmedOutmatched (bot: Bot, near: Entity[], config: ReflexConfig): boolean {
  if (bestMeleeWeapon(bot) != null) return false
  return config.hostiles.fleeUnarmed || near.length > 1 || near.some(e => RANGED_HOSTILES.has(e.name ?? ''))
}

/**
 * Whether the hostiles reflex flees `near` now rather than fight (an armed bot cornered a while ago fights): at or under
 * fleeHealth with more than one about or no weapon and armor to fight on with (fightOnArmor), outnumbered (more than
 * maxFight, a split slime's cubes not counted for an armed bot: SWARMERS), or bare and outmatched (unarmedOutmatched)
 */
export function fleeDue (bot: Bot, near: Entity[], config: ReflexConfig, tick: number): boolean {
  if (near.length === 0) return false
  const armed = armorPoints(bot) >= config.hostiles.fightOnArmor && bestMeleeWeapon(bot) != null
  // (an armed and armored bot isn't outnumbered by the cubes of a split slime or magma cube: SWARMERS)
  const outnumbered = (armed ? near.filter(e => !SWARMERS.has(e.name ?? '')) : near).length > config.hostiles.maxFight
  return fightTurned(bot, near, config, tick) || (outnumbered && !wasCornered(bot, tick))
}

/**
 * Whether a fight the hostiles reflex is in is given up, to flee: fleeDue's odds but the numbers (more coming at a bot
 * already fighting with its shield up is no reason to turn its back on them: a 26.3 bot in iron fled four zombies in a
 * cave as each came into range, its fights cut off, and killed none in 2400 ticks)
 */
export function fightTurned (bot: Bot, near: Entity[], config: ReflexConfig, tick: number): boolean {
  if (near.length === 0) return false
  const armed = armorPoints(bot) >= config.hostiles.fightOnArmor && bestMeleeWeapon(bot) != null
  const fightOn = near.length === 1 && armed
  // (cornered a while ago, the flee found no way: an armed bot fights where it stands, not stands there struck)
  const cornered = wasCornered(bot, tick) && bestMeleeWeapon(bot) != null
  return !cornered && ((bot.health <= config.hostiles.fleeHealth && !fightOn) || unarmedOutmatched(bot, near, config))
}

/** a shut-in that failed (no box there, a block that wouldn't go in): not tried again for SEAL_RETRY_TICKS */
export const SEAL_RETRY_TICKS = 400
const sealFails = new WeakMap<Bot, number>()

/**
 * Whether the hostiles reflex shuts the bot in where it stands to heal (sealIn) rather than fight on or flee: hurt to
 * sealHealth with more than one about, or to fleeHealth with any; no creeper among them (its blast takes the box and
 * the bot); on its feet out of the water and the lava; a box to be had there of SEAL_MAX_BLOCKS at most (a tunnel's, a passage's)
 * and the blocks for it. Fleeing zombies in
 * a cave is a run with them as quick as the bot's walk (Zombie's movement speed 0.23) and the cave's drops on the way:
 * a 26.3 bot in iron with a diamond sword and 216 cobblestone fought four in the night's mine down to its last health,
 * fell 8 blocks in it, and died (full-26.3-fresh-l)
 */
export function sealDue (bot: Bot, near: Entity[], config: ReflexConfig, tick: number): boolean {
  const h = config.hostiles
  if (h.sealHealth <= 0 || near.length === 0 || bot.health <= 0) return false
  if (!(bot.health <= h.sealHealth && (near.length > 1 || bot.health <= h.fleeHealth))) return false
  if (near.some(e => e.name === 'creeper')) return false
  const e = bot.entity as any
  if (e.onGround !== true || e.isInWater === true || e.isInLava === true) return false
  const failed = sealFails.get(bot)
  if (failed != null && tick - failed >= 0 && tick - failed < SEAL_RETRY_TICKS) return false
  const box = sealBox(bot, near)
  if (box == null) return false
  const needed = openCells(bot, box).length
  if (needed > SEAL_MAX_BLOCKS) return false
  const item = sealItem(bot)
  return item != null && countItems(bot, item) >= needed
}

/**
 * ticks after a flee found no way (fleeFrom's 'cornered': a tunnel, a pit) the hostiles reflex fights instead, an armed
 * bot: a 26.3 bot cornered at 4.8 health underground by a skeleton 0.9 off stood there, fleeing and failing every 20
 * ticks, till it was shot dead (full-26.3-fresh-d); one in a tunnel at y 11 fled a creeper, cornered, and was blown up
 * (nether-26.3-q3)
 */
export const CORNERED_TICKS = 200
const corneredAt = new WeakMap<Bot, number>()

/** a flee's failure noted when it was cornered; rethrown */
function noteCornered (bot: Bot, tick: number, err: unknown): never {
  if (/cornered/.test(String((err as Error)?.message ?? ''))) corneredAt.set(bot, tick)
  throw err
}

export function wasCornered (bot: Bot, tick: number): boolean {
  const at = corneredAt.get(bot)
  return at != null && tick - at >= 0 && tick - at <= CORNERED_TICKS
}

/** each bot's door to get in behind (findDoorRefuge), kept till the tick `until` (REFUGE_TICKS, or REFUGE_RETRY_TICKS of none after a way in failed) */
const refuges = new WeakMap<Bot, { until: number, refuge: DoorRefuge | null }>()
export const REFUGE_TICKS = 40
export const REFUGE_RETRY_TICKS = 600

function cachedRefuge (ctx: ReflexContext, near: Entity[]): DoorRefuge | null {
  const { bot, config } = ctx
  if (config.hostiles.indoorsDistance <= 0) return null
  if (bot.game?.dimension != null && !/overworld/.test(String(bot.game.dimension))) return null
  const cached = refuges.get(bot)
  if (cached != null && ctx.tick < cached.until && cached.until - ctx.tick <= REFUGE_RETRY_TICKS) return cached.refuge
  const refuge = findDoorRefuge(bot, near, config.hostiles.indoorsDistance)
  refuges.set(bot, { until: ctx.tick + REFUGE_TICKS, refuge })
  return refuge
}

export const hostilesReflex: Reflex = {
  name: 'hostiles',
  priority: 60,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.hostiles.enabled) return null
    const nether = inNether(bot)
    const near = hostilesInRange(ctx).filter(e => !nether || !letBeInNether(bot, e, ctx.tick))
    const wither = witherToShoot(ctx)
    if (near.length === 0 && wither == null) return null
    const cornered = wasCornered(bot, ctx.tick) && bestMeleeWeapon(bot) != null
    if (sealDue(bot, near, config, ctx.tick)) {
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'seal in',
        run: async (signal) => await sealIn(bot, {
          signal,
          threats: () => Object.values(bot.entities).filter(e => isHostile(bot, e) && isAlive(bot, e) && distance(bot, e) <= config.combat.scanRange)
        }).catch(err => {
          if (!signal.aborted) sealFails.set(bot, ctx.tick)
          throw err
        })
      }
    }
    if (fleeDue(bot, near, config, ctx.tick)) {
      // a door near to get in behind (a house, the base's airlock): in there and shut, not a run in the open under
      // the bolts and arrows
      const refuge = cachedRefuge(ctx, near)
      if (refuge != null) {
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: 'retreat indoors',
          run: async (signal) => await retreatIndoors(bot, refuge, {
            signal,
            threats: () => Object.values(bot.entities).filter(e => isHostile(bot, e) && isAlive(bot, e)),
            maxTicks: config.hostiles.indoorsTicks
          }).catch(err => {
            // no way in: not tried again for a while (the flee next time)
            refuges.set(bot, { until: ctx.tick + REFUGE_RETRY_TICKS, refuge: null })
            throw err
          })
        }
      }
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'flee',
        run: async (signal) => await fleeFrom(bot, () => hostilesInRange({ ...ctx, hostiles: Object.values(bot.entities).filter(e => isHostile(bot, e)) }), { signal, distance: config.hostiles.fleeDistance }).catch(err => noteCornered(bot, ctx.tick, err))
      }
    }
    // a wither skeleton coming from afar, nothing nearer: shot till it's within WITHER_MELEE_AT (witherToShoot)
    if (wither != null && !near.some(e => e.id !== wither.id && distance(bot, e) < WITHER_SHOOT_FROM)) {
      // (or a melee mob at the bot: the reflex looks again; the blazes a skill fights itself aren't one, nor a calm
      // zombified piglin, the hostiles' ignored kinds unless provoked: a piglin by the bot cut each draw off at once,
      // the reflex firing again every few ticks)
      const fought = new Set(hostilesInRange(ctx).map(e => e.id))
      const stop = (): boolean => !isAlive(bot, wither) || distance(bot, wither) < WITHER_MELEE_AT ||
        Object.values(bot.entities).some(e => e.id !== wither.id && MELEE_MOBS.has(e.name ?? '') && isHostile(bot, e) && isAlive(bot, e) &&
          (!config.hostiles.ignore.includes(e.name ?? '') || fought.has(e.id)) && inMobReach(e, bot.entity.position, MELEE_GUARD_MARGIN))
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'shoot wither_skeleton',
        run: async (signal) => await shoot(bot, wither, { signal, maxShots: 3, until: stop })
      }
    }
    if (near.length === 0) return null
    // creepers: shot from a distance when there's a bow; melee only with a shield to take the blast
    const target = near.find(e => {
      if (e.name !== 'creeper') return true
      if (hasBowAndArrows(bot) && distance(bot, e) >= config.hostiles.shootCreepersFrom) return true
      // (and cornered, no way to run: hit, its knockback keeps it from the 3 blocks its fuse starts at, SwellGoal)
      return hasShield(bot) || cornered
    })
    if (target == null) {
      // only creepers it can't take on: keep away (past their follow range, Creeper's FOLLOW_RANGE 16)
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'flee',
        run: async (signal) => await fleeFrom(bot, () => hostilesInRange({ ...ctx, hostiles: Object.values(bot.entities).filter(e => isHostile(bot, e)) }), { signal, distance: config.hostiles.fleeDistance }).catch(err => noteCornered(bot, ctx.tick, err))
      }
    }
    const useBow = target.name === 'creeper' && hasBowAndArrows(bot) && distance(bot, target) >= config.hostiles.shootCreepersFrom
    // a blaze, with a shield: held off where the bot stands (holdOffBlazes: the shield up before its shots, the bow
    // between), not closed in on: fight() chased them over a fortress's throne under the others' fireballs
    if (target.name === 'blaze' && hasShield(bot)) {
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'hold off blaze',
        run: async (signal) => await holdOffBlazes(bot, { signal, maxTicks: config.hostiles.fightTicks })
      }
    }
    // the odds looked at again each tick of the fight (a skeleton come into sight while the bare bot fought a spider
    // shot it dead from 6 blocks, 1.21.11): turned, the fight is given up and the reflex flees next. The health's too
    // (fightTurned): the fight went on with one zombie while others hit the bot, 20 health to 1, and the reflex fired
    // twice in its last 200 ticks, each a new fight (full-26.3-fresh-l, a 26.3 bot in iron in the night's mine)
    let elapsed = 0
    const turned = (): boolean => {
      const now = hostilesInRange({ ...ctx, hostiles: Object.values(bot.entities).filter(e => isHostile(bot, e) && isAlive(bot, e) && distance(bot, e) <= config.combat.scanRange) })
      const tick = ctx.tick + elapsed++
      return now.length > 0 && (fightTurned(bot, now, config, tick) || sealDue(bot, now, config, tick))
    }
    if (nether && !useBow) {
      const f = netherFightsOf(bot)
      const anchor = f.anchors.get(target.id)?.at ?? bot.entity.position.clone()
      f.anchors.set(target.id, { at: anchor, tick: ctx.tick })
      // an archer past the leash: held off from where the bot stands with the bow, never chased on (holdOffArcher),
      // ARCHER_BUDGET ticks at most
      if (RANGED_HOSTILES.has(target.name ?? '') && target.name !== 'blaze' && pastLeash(anchor, bot.entity.position)) {
        const spent = f.archers.get(target.id) ?? 0
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: `hold off ${target.name ?? ''}`,
          run: async (signal) => await holdOffArcher(bot, target, { signal, maxTicks: Math.min(config.hostiles.fightTicks, ARCHER_BUDGET - spent), onHold: t => f.archers.set(target.id, spent + t), until: turned })
        }
      }
      // a fight on its leash
      if (!(target.name === 'blaze' && hasShield(bot))) {
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: `fight ${target.name ?? ''}`,
          run: async (signal) => await fight(bot, target, { signal, ...meleeOptions(target, config, true), until: () => turned() || pastLeash(anchor, bot.entity.position) })
        }
      }
    }
    return {
      name: 'hostiles',
      priority: config.hostiles.priority,
      detail: `${useBow ? 'shoot' : 'fight'} ${target.name ?? ''}`,
      run: async (signal) => useBow
        ? await shoot(bot, target, { signal, maxShots: 3 })
        : await fight(bot, target, { signal, ...meleeOptions(target, config), until: turned })
    }
  }
}

/**
 * Eat at or below the food threshold out of combat, or at low health when no hostile is in reach, or hurt out of
 * combat with the food level under 18 (FoodData.tick heals only from 18 up: a bot at food 15 to 17 never healed); a
 * meal that doesn't fit the bar whole only when the health needs it (dueMeal: at fitHealth or under with the bar under
 * 18, or at the reflex's health).
 */
export const eatReflex: Reflex = {
  name: 'eat',
  priority: 50,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.eat.enabled || bot.food >= 20) return null
    const hungry = bot.food <= config.eat.food && !ctx.inCombat
    const hurt = bot.health <= config.eat.health && hostilesInRange(ctx).length === 0
    const regen = bot.health < 20 && bot.food < config.eat.regenFood && !ctx.inCombat
    // starving: eaten in a fight too (a hostile kept in range by a wall kept a 26.3 bot out of its 16 bread until it
    // starved to 1 health, at food 0, for 30000 ticks)
    const starving = bot.food <= config.eat.starving
    if (!hungry && !hurt && !regen && !starving) return null
    // a meal that doesn't fit the bar waits till it does, unless the health needs it (dueMeal)
    const food = dueMeal(bot, { hurtAt: config.eat.fitHealth, urgentAt: config.eat.health, starving: config.eat.starving })
    if (food == null) return null
    // the food kept for a trip is eaten into only in need: starving, or hurt (the reflex's health)
    if (!starving && bot.health > config.eat.health && !reserveAllows(bot, food)) return null
    return { name: 'eat', priority: config.eat.priority, run: async (signal) => await eat(bot, { signal, food }) }
  }
}

/** the highest feet height since the bot last stood on the ground, per bot (where a fall began) */
const fallStarts = new WeakMap<Bot, number>()

/** A long fall (or one that would kill at the health left) broken with the water bucket held (breakFall). */
export const fallReflex: Reflex = {
  name: 'fall',
  priority: 93,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.fall.enabled || bot.entity == null) return null
    const y = bot.entity.position.y
    if (bot.entity.onGround || (bot.entity as any).isInWater === true) { fallStarts.set(bot, y); return null }
    const start = Math.max(fallStarts.get(bot) ?? y, y)
    fallStarts.set(bot, start)
    // (where the fall comes down, its drift across counted, as far as LANDING_DEPTH under: taken in hand at once)
    const landing = predictLanding(p => bot.blockAt(p) as any, bot.entity.position, bot.entity.velocity)?.y ?? null
    const go = shouldBreakFall({
      y, vy: bot.entity.velocity.y, onGround: false, fallStart: start, landing,
      hasBucket: bot.inventory.items().some(i => i.name === 'water_bucket'),
      nether: /nether/.test(String(bot.game?.dimension ?? '')),
      health: bot.health
    })
    if (!go || landing == null) return null
    return { name: 'fall', priority: config.fall.priority, detail: `water at ${landing}`, run: async (signal) => await breakFall(bot, landing, signal) }
  }
}

/** the golden apples, best first: eaten whatever the food bar (Consumable, the ALWAYS_EDIBLE foods) */
export const GOLDEN_APPLES = ['enchanted_golden_apple', 'golden_apple']

/**
 * Low on health in a fight with a golden apple held: eaten there and then, the fight or not (its absorption and
 * regeneration outlast the 32 ticks of eating): the eat reflex waits for a fight to end, and in the End two angry
 * endermen took a 1.21.11 bot from 16 health to 2 while it pillared to a crystal, then the dragon's breath killed it
 */
export const emergencyEatReflex: Reflex = {
  name: 'emergency eat',
  priority: 75,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.eat.enabled || bot.health > config.eat.emergencyHealth) return null
    const apple = GOLDEN_APPLES.find(n => bot.inventory.items().some(i => i.name === n))
    if (apple == null) return null
    return { name: 'emergency eat', priority: 75, detail: apple, run: async (signal) => await eat(bot, { signal, food: apple }) }
  }
}

/** Wear armor better than what's worn when some comes into the inventory, a fight or not (it's a few clicks). */
export const armorReflex: Reflex = {
  name: 'armor',
  priority: 70,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.armor.enabled || !ctx.armorChanged) return null
    if (Object.keys(armorUpgrades(bot)).length === 0) return null
    return { name: 'armor', priority: config.armor.priority, run: async (signal) => await equipArmor(bot, { signal }) }
  }
}

const planCache = new WeakMap<Bot, { tick: number, plan: NightPlan }>()
/** no ground to dig a shelter in found: not before this tick (`wait` after the last try), and this far out next time */
const noGround = new WeakMap<Bot, { until: number, wait: number, radius: number }>()

/** the night's plan, looked at again every 100 ticks (a bed nearby is a block search) */
function cachedNightPlan (ctx: ReflexContext): NightPlan {
  const { bot, config } = ctx
  const cached = planCache.get(bot)
  if (cached != null && ctx.tick - cached.tick < 100 && cached.tick <= ctx.tick) return cached.plan
  const bedNearby = config.night.sleep && typeof bot.findBlock === 'function' &&
    findBlock(bot, { matching: blockIdsNamed(bot, isBed), maxDistance: config.night.bedDistance }) != null
  const plan = nightPlan(bot, { minArmor: config.night.minArmor, minDamage: config.night.minDamage, bedNearby })
  planCache.set(bot, { tick: ctx.tick, plan })
  return plan
}

/**
 * Under the open sky (no solid block but leaves over the head, the way Level.canSeeSky goes by the heightmap; the sky
 * light the client has goes stale as blocks change), or in a shelter dug already.
 */
export function outInTheNight (bot: Bot): boolean {
  const feet = bot.entity.position.floored()
  if (isEnclosed((pos) => bot.blockAt(pos) as any, feet)) return true
  for (let dy = 2; dy <= 64; dy++) {
    const b = bot.blockAt(feet.offset(0, dy, 0))
    if (b == null) break
    if (b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false
  }
  return true
}

const undergroundCache = new WeakMap<Bot, { tick: number, feet: string, underground: boolean }>()

/** undergroundAtWork where the feet are, looked at again every 20 ticks or as the feet go to another cell */
function cachedUnderground (ctx: ReflexContext): boolean {
  const { bot } = ctx
  const feet = bot.entity.position.floored()
  const key = feet.toString()
  const cached = undergroundCache.get(bot)
  if (cached != null && cached.feet === key && ctx.tick - cached.tick < 20 && cached.tick <= ctx.tick) return cached.underground
  const underground = undergroundAtWork((p: Vec3) => bot.blockAt(p) as any, feet)
  undergroundCache.set(bot, { tick: ctx.tick, feet: key, underground })
  return underground
}

/** what the night reflex does with the night now */
export type NightChoice = 'sleep' | 'shelter' | 'work'

export interface NightChoiceInputs {
  plan: NightPlan
  /** the config's sleep and shelter */
  sleep: boolean
  shelter: boolean
  /** below the surface at work (undergroundAtWork) */
  underground: boolean
  /** the rest due (ticksSinceRest past restTicks: the phantoms) */
  restDue: boolean
  /** the bed failed this night already */
  sleepFailed: boolean
  /** out in the night (outInTheNight: the open sky over the head, or in a shelter) */
  out: boolean
  /** the weapon and armor the progress has had are on hand (planner/schedule's nightGeared; default true) */
  geared?: boolean
}

/**
 * The night's choice: good gear works on (the hostiles reflex fights); below the surface the night is work, a bed
 * only when the rest is due; a bed sleeps, once a night (a bed that failed isn't tried again till the day: tried every
 * 200 ticks in a 1-wide staircase, each try cut off the 300-tick dig of a block by hand, and the night went by with
 * nothing dug, run full-26.3-f); else out in the night, a shelter. Below the surface without the gear its progress had
 * (a bot back bare from a death) the night is no work: a bed, else a shelter dug where it is.
 */
export function nightChoice (i: NightChoiceInputs): NightChoice {
  if (i.plan === 'fight') return 'work'
  const bare = i.geared === false
  if (i.underground && !bare && !(i.plan === 'sleep' && i.sleep && i.restDue)) return 'work'
  if (i.plan === 'sleep' && i.sleep && !i.sleepFailed) return 'sleep'
  if (i.shelter && (i.out || (i.underground && bare))) return 'shelter'
  return 'work'
}

/** the bots whose bed failed this night (cleared at the day) */
const sleepFailed = new WeakSet<Bot>()
/** ticks the shelter's search for ground waits after it found none, at first; doubled each time after, to SHELTER_BACKOFF_MAX */
export const SHELTER_BACKOFF = 200
export const SHELTER_BACKOFF_MAX = 3200

/**
 * At night in the overworld (nightChoice): a bed means sleep (the monsters that keep the bot up fought first), good
 * gear means stay out and let the hostiles reflex fight, else a shelter dug into the ground till the day. Not below the
 * surface at work (undergroundAtWork): the dark there is the same day and night, and the night's mining is the
 * schedule; there the bed only when the rest is due (the phantoms), its room dug beside the bot.
 */
export const nightReflex: Reflex = {
  name: 'night',
  priority: 40,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.night.enabled || bot.isSleeping === true || bot.time == null) return null
    if (bot.game?.dimension != null && !/overworld/.test(String(bot.game.dimension))) return null
    if (botIsBrightOutside(bot)) {
      sleepFailed.delete(bot)
      // cut off on its way out of the shelter at sunrise (a fight): out the rest of the way; not while a shelter()
      // task is running, which climbs out by itself (shelterRunning)
      if (shelterToLeave(bot) == null || shelterRunning(bot)) return null
      return { name: 'night', priority: config.night.priority, detail: 'leave shelter', run: async (signal) => await leaveShelter(bot, signal) }
    }
    // the night's mining (the runner's schedule) is on its way down: a staircase is a roof within a few blocks; and a
    // shelter() task (the runner's wait for the day) is the night's shelter already
    if ((bot as any).survival?.nightWork === true || shelterRunning(bot)) return null
    const plan = cachedNightPlan(ctx)
    if (plan === 'fight') return null
    const underground = cachedUnderground(ctx)
    const choice = nightChoice({
      plan,
      sleep: config.night.sleep,
      shelter: config.night.shelter,
      underground,
      restDue: ticksSinceRest(bot) >= config.night.restTicks,
      sleepFailed: sleepFailed.has(bot),
      out: outInTheNight(bot),
      // (the runner's, from its milestones: none without one)
      geared: (bot as any).survival?.nightGeared?.() ?? true
    })
    if (choice === 'work') return null
    const backoff = noGround.get(bot)
    if (choice === 'shelter' && backoff != null && ctx.tick < backoff.until) return null
    const dig = async (signal: AbortSignal): Promise<unknown> => {
      try {
        const result = await shelter(bot, { signal, radius: backoff?.radius ?? config.night.shelterRadius })
        noGround.delete(bot)
        return result
      } catch (err) {
        // nowhere to dig about (a swamp, the sea, bare rock without a pickaxe): look again in a while, further out,
        // and twice as long each time
        if (isSkillError(err, 'NOT_FOUND')) {
          const wait = Math.min(SHELTER_BACKOFF_MAX, backoff == null ? SHELTER_BACKOFF : backoff.wait * 2)
          noGround.set(bot, { until: ctx.tick + wait, wait, radius: Math.min(24, (backoff?.radius ?? config.night.shelterRadius) * 2) })
        }
        throw err
      }
    }
    if (choice === 'sleep') {
      return {
        name: 'night',
        priority: config.night.priority,
        detail: 'sleep',
        run: async (signal) => {
          try {
            return await sleepThroughNight(bot, { signal, bedDistance: config.night.bedDistance, digRoom: underground })
          } catch (err) {
            if (signal.aborted) throw err
            // once a night: not again till the day
            sleepFailed.add(bot)
            planCache.delete(bot)
            if (!config.night.shelter || underground || !outInTheNight(bot)) throw err
            return await dig(signal)
          }
        }
      }
    }
    return { name: 'night', priority: config.night.priority, detail: 'shelter', run: dig }
  }
}

/** ticks between the spawner reflex's looks for dark spawners about (a block search) */
export const SPAWNER_LOOK_TICKS = 40
/** ticks a spawner whose torch didn't go in (no way to it, no room by it) is let be */
export const SPAWNER_GIVE_UP_TICKS = 6000

/** each bot's spawner looks: the tick of the last, the dark spawners it found, and the ones let be till a tick */
const spawnerLooks = new WeakMap<Bot, { at: number, dark: Vec3[], letBe: Map<string, number> }>()

/**
 * A dark monster spawner the bot sees within range, out of a fight, with a torch carried: lit (lightSpawner). The xp
 * farm's spawners are left dark (the memory's xp farms; the farm's epoch holds the reflex while it builds one). A 26.3
 * bot in iron was set on by four zombies at once in the night's mine and died (full-26.3-fresh-l); by a dungeon's
 * spawner they come four at a go every 10 to 40 seconds, as long as the bot's within 16 (tests/integration/mineZombies)
 */
export const spawnerReflex: Reflex = {
  name: 'spawner',
  priority: 45,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.spawner.enabled || ctx.inCombat || countItems(bot, 'torch') === 0) return null
    let look = spawnerLooks.get(bot)
    if (look == null) spawnerLooks.set(bot, look = { at: -Infinity, dark: [], letBe: new Map() })
    if (ctx.tick - look.at >= SPAWNER_LOOK_TICKS || ctx.tick < look.at) {
      look.at = ctx.tick
      look.dark = darkSpawners(bot, config.spawner.range)
    }
    const farms: Array<{ x: number, y: number, z: number }> = (bot as any).survival?.memory?.getPois?.(XP_FARM_POI) ?? []
    const l = look
    const spawner = l.dark.find(p => (l.letBe.get(p.toString()) ?? -Infinity) <= ctx.tick && !farms.some(f => f.x === p.x && f.y === p.y && f.z === p.z) && !spawnerLit(bot, p))
    if (spawner == null) return null
    return {
      name: 'spawner',
      priority: config.spawner.priority,
      detail: 'light spawner',
      run: async (signal) => {
        try {
          await lightSpawner(bot, spawner, signal)
        } catch (err) {
          if (!signal.aborted) l.letBe.set(spawner.toString(), ctx.tick + SPAWNER_GIVE_UP_TICKS)
          throw err
        } finally {
          l.at = -Infinity
        }
      }
    }
  }
}

/**
 * The drops a fight leaves that the bag wants and nothing else picks up, while short of them: slime balls and magma
 * cream, the magma cream of the nether's fire resistance (a slime ball and a blaze powder make one). Only a size 1
 * slime drops slime balls (a slime splits into smaller ones on its death, Slime.remove, the hostiles reflex fighting
 * each), the magma cubes of a fortress (NetherFortressStructure's spawns) and of the basalt deltas the cream; the
 * hostiles reflex killed them and left their drops lying: 26.3 bots fought 4 to 18 magma cubes by seed 2's fortress a
 * run and went into the blaze fight with no cream for the brew (tests/integration/blaze BLAZE_BREW=1)
 */
export const WANTED_DROPS = ['slime_ball', 'magma_cream']
/** the wanted drops are picked up while the bag holds fewer than this of them */
export const WANTED_DROPS_KEEP = 4
/** how far off a wanted drop is gone for (and no further over or under than 3) */
export const WANTED_DROPS_RANGE = 10
/** a drop not got is let be this long */
export const WANTED_DROPS_RETRY_TICKS = 600

const dropTries = new WeakMap<Bot, Map<number, number>>()

/** the nearest wanted drop to go for now, or null */
export function wantedDrop (bot: Bot, tick: number): Entity | null {
  if (countItems(bot, WANTED_DROPS) >= WANTED_DROPS_KEEP) return null
  const tried = dropTries.get(bot)
  const me = bot.entity.position
  return nearbyDrops(bot, me, WANTED_DROPS_RANGE, WANTED_DROPS)
    .find(e => Math.abs(e.position.y - me.y) <= 3 && (tried?.get(e.id) ?? -Infinity) <= tick) ?? null
}

export const dropsReflex: Reflex = {
  name: 'drops',
  priority: 46,
  check (ctx) {
    const { bot } = ctx
    if (ctx.inCombat || bot.entity == null) return null
    // (not in a blaze fight: the nook's own fetch picks up what lies by it, and a walk out of it is a walk into fire)
    if (Object.values(bot.entities).some(e => e.name === 'blaze' && e.position.distanceTo(bot.entity.position) <= 32)) return null
    const drop = wantedDrop(bot, ctx.tick)
    if (drop == null) return null
    return {
      name: 'drops',
      priority: 46,
      detail: 'pick up the wanted drops',
      run: async (signal) => {
        let tried = dropTries.get(bot)
        if (tried == null) dropTries.set(bot, tried = new Map())
        tried.set(drop.id, ctx.tick + WANTED_DROPS_RETRY_TICKS)
        const go = async (): Promise<unknown> => await pickupDrops(bot, { near: drop.position.clone(), radius: 4, names: WANTED_DROPS, waitTicks: 15 }, signal)
        return /nether/.test(String(bot.game?.dimension ?? '')) ? await withNetherSafety(bot, go) : await go()
      }
    }
  }
}

export const DEFAULT_REFLEXES: Reflex[] = [totemReflex, fallReflex, fireballReflex, hazardReflex, wardenReflex, ghastReflex, drowningReflex, creeperReflex, emergencyEatReflex, hostilesReflex, eatReflex, dropsReflex, spawnerReflex, nightReflex, armorReflex]
