import type { Bot } from 'mineflayer'
import { armorUpgrades, equipArmor, equipShield, equipTotem, shieldToHold } from '../skills/armor'
import { eat, dueMeal, reserveAllows } from '../skills/eat'
import { barrierCells, burningToDouse, douseBurning, escapeHazard, evadeCreeper, fireHandled, fleeFrom, headInWater, inFireOnly, inHazard, surface, wallOffShooter } from '../skills/escape'
import { MELEE_GUARD_MARGIN, MELEE_MOBS, creeperSwelling, fight, inMobReach } from '../skills/fight'
import { shoot, sparedInLine } from '../skills/shoot'
import { armorPoints, botIsBrightOutside, isEnclosed, leaveShelter, nightPlan, shelter, shelterRunning, shelterToLeave, sleepThroughNight, ticksSinceRest, undergroundAtWork, type NightPlan } from '../skills/shelter'
import type { Vec3 } from 'vec3'
import { bestMeleeWeapon } from '../skills/weapons'
import { TaskError, hasLineOfSight, isAlive, type Entity } from '../skills/combatUtil'
import { holdOffBlazes } from '../nether/blazeFight'
import { ARCHER_BUDGET, GHAST_FIREBALL, deadlyDropBeside, deflectFireball, fireballIncoming, holdOffArcher, keepFromGhast, nearestGhast, withNetherSafety } from '../nether/safety'
import { nearbyDrops, pickupDrops } from '../skills/pickupDrops'
import { SkillError, isSkillError } from '../skills/errors'
import type { Reflex, ReflexContext, UrgentTask } from './types'
import type { ReflexConfig } from './config'
import { isBed } from '../core/items'
import { breakFall, predictLanding, shouldBreakFall } from '../skills/fall'
import { blockIdsNamed, findBlock } from '../core/findBlocks'
import { findDoorRefuge, retreatIndoors, type DoorRefuge } from '../skills/indoors'
import { clearOfWarden, darkSpawners, escapeWarden, lightSpawner, nearestWarden, spawnerLit } from '../skills/danger'
import { XP_FARM_POI } from '../skills/spawnerFarm'
import { SEAL_MAX_BLOCKS, boxRefused, openCells, sealBox, sealIn } from '../skills/sealIn'
import { sealItem } from '../skills/shelter'
import { countItems } from '../skills/util'
import { caveCells, caveOpenings, caveRuleOn, inCaveWall, leaveCave, liquidOpenings, sealCaveOpenings } from '../skills/caves'
import { noteDrowning } from '../skills/breath'
import { lavaAdvancing, watchAdvancingLava } from '../skills/lavaFlow'
import { SPEAR_GUARD, guardSpear, spearThreats } from '../skills/spear'
import { pillarFits, pillarRefuge, pillarRefugeFrom } from '../skills/pillar'

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

/**
 * Out of lava and fire, and away from lava about to flow into the bot's cells (lavaAdvancing: a flow come up to it, a
 * dig that let a pool in) before it touches the bot: in it, the fire's ticks are already on (Entity.lavaHurt). Out of
 * them still burning, the fire put out with the water bucket (burningToDouse, douseBurning)
 */
export const hazardReflex: Reflex = {
  name: 'hazard',
  priority: 90,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.hazard.enabled) return null
    watchAdvancingLava(bot)
    if (!inHazard(bot)) {
      // out of the lava and the fire, still burning: put out with the water bucket (lava's fire burns on 15 seconds,
      // a hit each 20 ticks, Entity.lavaIgnite: a 26.3 bot out of a deep lava pool at 9 health burned to death, the
      // reflex done once it stood out of the lava, a water bucket in its bag; f9-26.3, t347525)
      if (!lavaAdvancing(bot)) {
        if (!burningToDouse(bot)) return null
        return { name: 'hazard', priority: config.hazard.priority, detail: 'on fire', run: async (signal) => { await douseBurning(bot, signal) } }
      }
      return {
        name: 'hazard',
        priority: config.hazard.priority,
        detail: 'advancing lava',
        run: async (signal) => await escapeHazard(bot, { signal, searchRadius: config.hazard.searchRadius, waterRadius: config.hazard.waterRadius, maxTicks: config.hazard.maxTicks })
      }
    }
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
/** ticks since the air last fell (oxygenLevel down a step) within which it counts as falling (airFalling) */
export const AIR_FALLING_TICKS = 40
const airLooks = new WeakMap<Bot, { level: number, fellAt: number }>()

/**
 * Whether the bot's air is running down (oxygenLevel fell within AIR_FALLING_TICKS): the server takes it whenever the
 * eyes are in water as it sees them, which the client's look at the eyes' cell can miss (a pose's eyes, a cell's state
 * stale): the drowning reflex goes by it too
 */
export function airFalling (bot: Bot, tick: number): boolean {
  const level = Number(bot.oxygenLevel ?? 20)
  let look = airLooks.get(bot)
  if (look == null) airLooks.set(bot, look = { level, fellAt: -Infinity })
  if (level < look.level) look.fellAt = tick
  look.level = level
  return tick - look.fellAt >= 0 && tick - look.fellAt <= AIR_FALLING_TICKS
}

/** under water as the drowning reflex goes by it: the head in water (headInWater), or the air running down (airFalling) */
function drowningNow (ctx: ReflexContext): boolean {
  const falling = airFalling(ctx.bot, ctx.tick)
  return headInWater(ctx.bot) || falling
}

/** ticks the drowning reflex's way to the shore takes at most (its task holds the reflex from going again meanwhile) */
export const SHORE_AFTER_SURFACE_TICKS = 400

/**
 * The drowning reflex's way to the shore after its surfacing, given up as soon as the head is under water with the air
 * at `air` or under again, or after SHORE_AFTER_SURFACE_TICKS: the reflex's task done, it goes again (surface) at
 * once. A 26.3 bot surfaced once in a flooded cave at y 47, and its toShore's walks of up to 2600 ticks failed under
 * the water, the reflex's own task the whole while, and it drowned 1170 ticks on with no reflex again (f3-26.3,
 * t68857 to t70031; the reflex went again 2 ticks after the death)
 */
export async function shoreWhileBreathing (bot: Bot, air: number, signal: AbortSignal, walk: (s: AbortSignal) => Promise<unknown>): Promise<void> {
  const ctrl = new AbortController()
  const onOuter = (): void => ctrl.abort(signal.reason)
  signal.addEventListener('abort', onOuter, { once: true })
  let ticks = 0
  const watch = (): void => {
    ticks++
    if (ticks >= SHORE_AFTER_SURFACE_TICKS || (Number(bot.oxygenLevel ?? 20) <= air && headInWater(bot))) ctrl.abort(new Error('under again'))
  }
  bot.on('physicsTick', watch)
  try {
    await walk(ctrl.signal)
  } catch (err) {
    if (signal.aborted) throw err
  } finally {
    bot.off('physicsTick', watch)
    signal.removeEventListener('abort', onOuter)
  }
}

export const drowningReflex: Reflex = {
  name: 'drowning',
  priority: 85,
  retryCooldownTicks: 0,
  hold (ctx) {
    const { bot, config } = ctx
    if (!config.drowning.enabled || bot.entity == null || !drowningNow(ctx)) return null
    const airLow = bot.oxygenLevel <= config.drowning.air
    // (a fight that presses, air left: the creeper's and the hostiles' reflexes let by, combatPressing; a creeper's
    // fuse at any air, creeperPressing)
    const pressing = creeperPressing(bot) || (bot.oxygenLevel > DROWNING_CRITICAL_AIR && combatPressing(bot, ctx.attackers, ctx.tick))
    return {
      below: config.drowning.priority,
      except: (task) => (pressing && (task.name === 'creeper' || task.name === 'hostiles')) || (airLow ? task.name === 'hostiles' && lethalHostile(ctx) : !EATING_REFLEXES.has(task.name))
    }
  },
  check (ctx) {
    const { bot, config } = ctx
    if (!config.drowning.enabled) return null
    if (bot.oxygenLevel > config.drowning.air || !drowningNow(ctx)) return null
    // air left over DROWNING_CRITICAL_AIR and a fight pressing (a creeper's fuse, a mob's hits): the fight's reflexes
    // first, the air after
    // (and a creeper's fuse first at any air, creeperPressing: its blast at 2 is death at once, the water's 2 a second
    // only once the air is out)
    if (creeperPressing(bot) || (bot.oxygenLevel > DROWNING_CRITICAL_AIR && combatPressing(bot, ctx.attackers, ctx.tick))) return null
    return {
      name: 'drowning',
      priority: config.drowning.priority,
      run: async (signal) => {
        // the spot kept off a while (its targets, the ways under there: skills/breath drownedNear)
        noteDrowning(bot, bot.entity.position)
        // (given up for the fight's reflexes once one presses, air over DROWNING_CRITICAL_AIR left: watched each tick)
        const yielded = new AbortController()
        const onAbort = (): void => yielded.abort(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        let tick = ctx.tick
        const watch = (): void => {
          tick++
          if (creeperPressing(bot) || (bot.oxygenLevel > DROWNING_CRITICAL_AIR && combatPressing(bot, ctx.attackers, tick))) yielded.abort(new SkillError('ABORTED', 'the fight presses: the air waits'))
        }
        bot.on('physicsTick', watch)
        try {
          return await surface(bot, { signal: yielded.signal, recoverTo: config.drowning.recoverTo, searchRadius: config.drowning.searchRadius, maxTicks: config.drowning.maxTicks })
        } finally {
          bot.off('physicsTick', watch)
          signal.removeEventListener('abort', onAbort)
          // and out of the water once the head's out of it, not left there for the work to sink back (a 1.21.11 bot's
          // smelt in a lake took it down three times after its surfacings, and it drowned: grimls-2, t83874 to
          // t85228); not with the head still under (a surfacing that found no air: toShore's walk of up to 1200 ticks
          // under the water, the reflex not going again meanwhile)
          const { inWater, toShore } = await import('../executor/explore')
          if (!signal.aborted && !yielded.signal.aborted && bot.health > 0 && inWater(bot) && !headInWater(bot)) await shoreWhileBreathing(bot, config.drowning.air, signal, async (s) => await toShore(bot, s))
        }
      }
    }
  }
}

/**
 * the air (bot.oxygenLevel, 15 ticks a point) under which the drowning reflex goes whatever presses; over it, a fight
 * that presses (combatPressing) goes first
 */
export const DROWNING_CRITICAL_AIR = 2
/** ticks a mob's hit counts as pressing (combatPressing), and how near it must be */
export const PRESS_HIT_TICKS = 40
export const PRESS_REACH = 3.5

/**
 * A creeper whose fuse runs within 7.5 of the bot (swelling), or one within 3 in sight (its fuse about to start): the
 * creeper's reflex goes before the drowning one at any air. A 26.3 bot under water in full iron at 8.9 health had its
 * evade cut off by the drowning reflex going again a tick after it gave way (its air, it seems, at the critical mark),
 * and was blown up 2.1 off (f7-26.3, t598161 at (-46, 99, 339))
 */
export function creeperPressing (bot: Bot): boolean {
  if (bot.entity == null) return false
  return Object.values(bot.entities).some(e => e !== bot.entity && e.name === 'creeper' && isAlive(bot, e) &&
    ((creeperSwelling(bot, e) && distance(bot, e) < 7.5) || (distance(bot, e) < 3 && hasLineOfSight(bot, e))))
}

/**
 * Whether a fight presses on the bot now: a creeper within 3 in sight or swelling within 7.5 (its fuse runs out in
 * 30 ticks), or a hostile on dry ground within PRESS_REACH that hurt it within PRESS_HIT_TICKS. In the water the drowning reflex
 * (85) outranked them: a 1.21.11 bot in iron surfacing at a pond's edge was hit to death by three zombies over its
 * 165 ticks (f5-1.21.11, t263143), and another's creeper evade was cut off by it twice till the blast (t663576)
 */
export function combatPressing (bot: Bot, attackers: ReadonlyMap<number, number> | undefined, tick: number): boolean {
  if (bot.entity == null) return false
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !isHostile(bot, e) || !isAlive(bot, e)) continue
    const d = distance(bot, e)
    if (e.name === 'creeper') {
      if ((d < 3 && hasLineOfSight(bot, e)) || (d < 7.5 && creeperSwelling(bot, e))) return true
      continue
    }
    // (a mob on dry ground: one in the water with the bot, a drowned, is the water's fight, lethalHostile's)
    const at = attackers?.get(e.id)
    if (at != null && tick - at >= 0 && tick - at <= PRESS_HIT_TICKS && d <= PRESS_REACH && !bodyInWater(bot, e.position)) return true
  }
  return false
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

/**
 * ticks a creeper the creeper reflex ran from stays one the hostiles reflex sees to before the work goes on
 * (chasingCreeper), and how far off: Creeper's FOLLOW_RANGE 16, past which it lets its target go
 * (TargetGoal.canContinueToUse)
 */
export const CREEPER_CHASE_TICKS = 600
export const CREEPER_FOLLOW_RANGE = 16
const evadedCreepers = new WeakMap<Bot, Map<number, number>>()

/** the creeper reflex ran from this creeper at this tick (chasingCreeper) */
export function noteEvaded (bot: Bot, creeper: Entity, tick: number): void {
  let m = evadedCreepers.get(bot)
  if (m == null) evadedCreepers.set(bot, m = new Map())
  m.set(creeper.id, tick)
  for (const [id, at] of m) if (bot.entities[id] == null || tick - at > CREEPER_CHASE_TICKS) m.delete(id)
}

/**
 * The nearest creeper the creeper reflex ran from within CREEPER_CHASE_TICKS, alive within CREEPER_FOLLOW_RANGE in the
 * bot's sight: after it, not let be. The evade ends 7.5 off, and the work went on toward it, the hostiles reflex fought
 * a zombie by it, and it came on again, seven times in 280 ticks till it blew a 1.21.11 bot in iron up (f9-1.21.11,
 * t305885)
 */
export function chasingCreeper (ctx: ReflexContext): Entity | null {
  const { bot } = ctx
  const evaded = evadedCreepers.get(bot)
  if (evaded == null || evaded.size === 0) return null
  let best: Entity | null = null
  for (const [id, at] of evaded) {
    const e = bot.entities[id]
    if (e == null || ctx.tick - at < 0 || ctx.tick - at > CREEPER_CHASE_TICKS || !isAlive(bot, e)) continue
    const d = distance(bot, e)
    if (d > CREEPER_FOLLOW_RANGE || Math.abs(e.position.y - bot.entity.position.y) > ctx.config.hostiles.maxDy || !hasLineOfSight(bot, e)) continue
    if (best == null || d < distance(bot, best)) best = e
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
      // (seen to after the run by the hostiles reflex while it follows: chasingCreeper)
      run: async (signal) => { noteEvaded(bot, creeper, ctx.tick); return await evadeCreeper(bot, creeper, {
        signal,
        safeDistance: config.creeper.safeDistance,
        blockAtSwell: config.creeper.blockAtSwell,
        blockDistance: config.creeper.blockDistance,
        maxTicks: config.creeper.maxTicks,
        swell: ctx.swell.get(creeper.id) ?? 0
      }) }
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

/** whether a mob holds a trident (a drowned's: DrownedTridentAttackGoal, a RangedAttackGoal of 10 blocks every 40 ticks) */
export function holdsTrident (e: Entity): boolean {
  const held = (e as any).heldItem ?? (e as any).equipment?.[0]
  return held?.name === 'trident'
}

/** whether a body at `pos` is in the water: its feet's cell or the one half a block up water (or waterlogged, kelp, seagrass) */
export function bodyInWater (bot: Bot, pos: Vec3): boolean {
  for (const dy of [0, 0.5]) {
    const b: any = bot.blockAt(pos.offset(0, dy, 0))
    if (b == null) continue
    if (b.name === 'water' || b.name === 'bubble_column' || /kelp|seagrass/.test(b.name) || b.getProperties?.()?.waterlogged === true) return true
  }
  return false
}

/**
 * how near a mob in the water must be for the hostiles reflex to fight it from dry ground (the sword's reach and a
 * step): one further off is let be, never chased into the water. A 1.21.11 bot at 6 health fought a drowned off the
 * shore into the sea, under the water till the drowning reflex took it up, and a trident drowned there killed it
 * (ls3b-1.21.11, t401692 at (51, 63, -4))
 */
export const WATER_FIGHT_REACH = 4
/**
 * blocks from a trident drowned in the water the hostiles reflex keeps, in sight, past the reflexes' scan (16): a 26.3
 * drowned's tridents hit a bot from 19 to 24 off, three of them, while its keep-off at 14 had let the work walk it
 * back and the eat reflex eat there (f2-26.3, t165443 at (-185, 61, -716))
 */
export const TRIDENT_KEEP_OFF = 24
/** ticks a way to dry ground that failed (toShore) waits before the hostiles reflex tries it again */
export const SHORE_RETRY_TICKS = 200

/** a mob the hostiles reflex lets be: in the water past WATER_FIGHT_REACH while the bot is on dry ground */
export function leftInWater (bot: Bot, e: Entity): boolean {
  return bodyInWater(bot, e.position) && !bodyInWater(bot, bot.entity.position) && distance(bot, e) > WATER_FIGHT_REACH
}

/** ticks between the hostiles reflex's walls off a trident drowned (wallOffShooter) */
export const WALL_OFF_RETRY_TICKS = 100
const wallOffs = new WeakMap<Bot, number>()

/** a trident drowned in the water: kept off, not fought (TRIDENT_KEEP_OFF) */
export function tridentInWater (bot: Bot, e: Entity): boolean {
  return e.name === 'drowned' && holdsTrident(e) && bodyInWater(bot, e.position)
}

/** the trident drowned in the water within TRIDENT_KEEP_OFF that see the bot, nearest first (bot.entities: past the scan) */
export function tridentsInSight (bot: Bot): Entity[] {
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && tridentInWater(bot, e) && isAlive(bot, e) && distance(bot, e) < TRIDENT_KEEP_OFF && hasLineOfSight(bot, e))
    .sort((a, b) => distance(bot, a) - distance(bot, b))
}

/** how near a mob that shoots in sight keeps the eat reflex from a meal (rangedInSight), and the health it eats at all the same */
export const EAT_RANGED_CLEAR = 20
export const EAT_UNDER_FIRE_HEALTH = 4

/**
 * the mobs that shoot (RANGED_HOSTILES, a trident drowned) within `range` that see the bot: a meal's 32 ticks under
 * them is three tridents' or arrows' time (f2-26.3, t165364: eaten at 8.5 health, a trident at 1.2)
 */
export function rangedInSight (bot: Bot, range = EAT_RANGED_CLEAR): Entity[] {
  return Object.values(bot.entities).filter(e => e !== bot.entity && isHostile(bot, e) && isAlive(bot, e) &&
    (RANGED_HOSTILES.has(e.name ?? '') || (e.name === 'drowned' && holdsTrident(e))) && distance(bot, e) <= range && hasLineOfSight(bot, e))
}

/**
 * The hostiles within the reflex's range that the bot can see, nearest first (the ignored ones left out): within
 * `range`, or `rangedRange` for the ones that shoot (a skeleton 12 blocks off shot the bot for 500 ticks while it stood
 * there). One without a line of sight can't hit or shoot the bot either (MeleeAttackGoal and RangedBowAttackGoal need
 * one): a zombie on the far side of a wall, or over a shelter's roof, is left alone.
 */
export function hostilesInRange (ctx: ReflexContext): Entity[] {
  const { bot, config } = ctx
  return ctx.hostiles.filter(e => (!config.hostiles.ignore.includes(e.name ?? '') || provoked(ctx, e)) &&
    distance(bot, e) <= (RANGED_HOSTILES.has(e.name ?? '') || (e.name === 'drowned' && holdsTrident(e)) ? Math.max(config.hostiles.range, config.hostiles.rangedRange) : config.hostiles.range) &&
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

/** a mob the hostiles reflex's fight couldn't kill in its fightTicks is let be this long (unkilledLetBe) */
export const UNKILLED_TICKS = 2400
/** unless it's this near the bot (on it, in the way) */
export const UNKILLED_NEAR = 2.5
const unkilledMaps = new WeakMap<Bot, Map<number, number>>()

/** the mob a fight of the hostiles reflex ran out of ticks on (TIMEOUT: out of the sword's reach for all of them) */
export function noteUnkilled (bot: Bot, e: Entity, tick: number): void {
  let m = unkilledMaps.get(bot)
  if (m == null) unkilledMaps.set(bot, m = new Map())
  m.set(e.id, tick)
}

/**
 * Whether the hostiles reflex lets a mob be: its last fight ran out of ticks with it alive (noteUnkilled) within
 * UNKILLED_TICKS, and it's no nearer the bot than UNKILLED_NEAR. A 1.21.11 bot on its way into its bunker by seed 2's
 * open throne at (-290, 77, -209) fought a magma cube it couldn't reach 600 ticks at a time, again and again, 86 fights,
 * the blazes shooting it the while, till it died there
 */
export function unkilledLetBe (bot: Bot, e: Entity, tick: number): boolean {
  const at = unkilledMaps.get(bot)?.get(e.id)
  if (at == null || tick - at > UNKILLED_TICKS) return false
  return e.position.distanceTo(bot.entity.position) > UNKILLED_NEAR
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
 * The mobs a bot with its fists only still fights alone: the weak (a silverfish's or an endermite's 8 health, a slime
 * split small), the spiders (16 health, 2 a hit on normal: the fist's 1 every 5 ticks wins it) and the ones no run gets
 * away from (a phantom, a vex: they fly)
 */
export const FIST_FIGHTS = new Set(['spider', 'cave_spider', 'silverfish', 'endermite', 'slime', 'magma_cube', 'phantom', 'vex'])

/**
 * Fists only (no weapon carried, bestMeleeWeapon): fled from, not fought, when one of them shoots or there's more than
 * one (or always, with fleeUnarmed), and alone too but for FIST_FIGHTS. A fist's 1 a hit takes 20 hits to kill a
 * skeleton or 24 a pillager, under their arrows and bolts all the while; and 20 a zombie (Zombie: 20 health, 3 a hit on
 * normal), which loses the bot that fight more often than not, where a sprint (some 5.6 blocks a second) outruns its
 * walk (some 2.3). Three 26.3 bots back from a death with nothing fought a pillager patrol, a skeleton and a spider,
 * and a skeleton by a creeper with their fists, and died each time (full-26.3-m); a 1.21.11 bot respawned bare by its
 * base at night fought a lone zombie with its fists, 20 health to 4 in 140 ticks, and died to it (full-1.21.11-fresh-m,
 * t134158 to t134432). Cornered (fightTurned), it fights all the same: its fists are the only way left. (A creeper
 * alone is the reflex's own: shot, met with a shield, or fled.)
 */
export function unarmedOutmatched (bot: Bot, near: Entity[], config: ReflexConfig): boolean {
  if (bestMeleeWeapon(bot) != null) return false
  return config.hostiles.fleeUnarmed || near.length > 1 || near.some(e => RANGED_HOSTILES.has(e.name ?? '') || (e.name !== 'creeper' && !FIST_FIGHTS.has(e.name ?? '')))
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
  // (cornered a while ago, the flee found no way: an armed bot fights where it stands, not stands there struck; a bare
  // one too, its fists the only way left)
  const cornered = wasCornered(bot, tick)
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
  // (none the server refuses the blocks of: boxRefused)
  const box = sealBox(bot, near)
  if (box == null || boxRefused(bot, box)) return false
  const needed = openCells(bot, box).length
  if (needed > SEAL_MAX_BLOCKS) return false
  const item = sealItem(bot)
  return item != null && countItems(bot, item) >= needed
}

/** how far the nearest of them must be for a pillar to go up (its three jumps' some 36 ticks before they're at it) */
export const PILLAR_CLEAR = 2.5
/** ticks after a pillar at a cell the hostiles reflex puts up no other there (it came down and they were back) */
export const PILLAR_RETRY_TICKS = 600
const pillars = new WeakMap<Bot, { feet: string, tick: number }>()

/**
 * Whether the mobs about press the bot hard enough for a refuge (a pillar, a wall-in under the rock): in the
 * overworld, hurt to sealHealth, or more of them than the reflex fights at any health (a flee from zombies in a cave
 * is a run as quick as their walk, cornered at its end); no creeper among them (its blast takes the box)
 */
export function refugeHard (bot: Bot, near: Entity[], config: ReflexConfig): boolean {
  if (inNether(bot) || near.length === 0 || bot.health <= 0) return false
  if (near.some(e => e.name === 'creeper')) return false
  return bot.health <= config.hostiles.sealHealth || near.length > config.hostiles.maxFight
}

/**
 * Whether the hostiles reflex walls the bot in where it stands under the rock (pillarWallIn), pressed hard (refugeHard)
 * by two or more, the ones that shoot among them too (no arrow nor sight through the blocks), or cornered; not again
 * at the cell within PILLAR_RETRY_TICKS
 */
export function caveWallInDue (bot: Bot, near: Entity[], config: ReflexConfig, tick: number): boolean {
  if (!refugeHard(bot, near, config)) return false
  if (near.length < 2 && !wasCornered(bot, tick)) return false
  const at = pillars.get(bot)
  const feet = bot.entity.position.floored().toString()
  if (at != null && at.feet === feet && tick - at.tick >= 0 && tick - at.tick < PILLAR_RETRY_TICKS) return false
  return pillarWallIn(bot, near)
}

/** how far a mob that shoots in sight keeps the bot off a pillar or brings it down from one (pillarRanged) */
export const PILLAR_RANGED_CLEAR = 24
/** and how near one out of sight does (it comes round the corner) */
export const PILLAR_RANGED_NEAR = 16
/** the most blocks the hostiles reflex walls the bot in with under the rock, rather than a pillar (pillarWallIn) */
export const PILLAR_SEAL_MAX = 10

/**
 * A mob that shoots (RANGED_HOSTILES: a bogged's, a skeleton's arrows) alive in sight within PILLAR_RANGED_CLEAR, or
 * within PILLAR_RANGED_NEAR out of sight, of all the loaded ones: a pillar is no refuge from it. A 26.3 bot pillared up
 * in a cave from melee mobs, two bogged and a skeleton about it shot it on its top from 4 to 7 off, and it died
 * (f4-26.3, t92144 at (568, 21, 167))
 */
export function pillarRanged (bot: Bot): boolean {
  return Object.values(bot.entities).some(e => e !== bot.entity && RANGED_HOSTILES.has(e.name ?? '') && isHostile(bot, e) && isAlive(bot, e) &&
    (distance(bot, e) <= PILLAR_RANGED_NEAR || (distance(bot, e) <= PILLAR_RANGED_CLEAR && hasLineOfSight(bot, e))))
}

/**
 * Under the rock (caveCells' roofed: a cave's, a mine's), the bot walls itself in where it stands rather than pillar
 * up: a box of PILLAR_SEAL_MAX blocks at most (sealBox) and the blocks for it. The cave's other mobs come into sight
 * of a pillar (its skeletons, its bogged); behind the blocks none sees it
 */
export function pillarWallIn (bot: Bot, near: Entity[]): boolean {
  const feet = bot.entity.position.floored()
  if (!caveCells(bot).roofed(feet)) return false
  // (none the server refuses the blocks of: boxRefused)
  const box = sealBox(bot, near)
  if (box == null || boxRefused(bot, box)) return false
  const needed = openCells(bot, box).length
  if (needed > PILLAR_SEAL_MAX) return false
  const item = sealItem(bot)
  return item != null && countItems(bot, item) >= needed
}

/**
 * Whether the hostiles reflex goes up a pillar where the bot stands (pillarRefuge) rather than flee or fight on: in the
 * overworld, hurt to sealHealth with two melee mobs or more about (or cornered, wasCornered), or more than maxFight of
 * them at any health, every one about a melee
 * mob that doesn't climb (MELEE_MOBS, a drowned on land; no spider, nothing that shoots, no creeper), no box of
 * SEAL_MAX_BLOCKS to shut in there (sealDue: an open floor), none within PILLAR_CLEAR, the pillar's cells open and its blocks carried
 * (pillarFits), and not up one at that cell within PILLAR_RETRY_TICKS. A 26.3 bot in an iron chestplate with an iron
 * sword and 337 cobblestone, four zombies about it on a cave's floor at y -58, fled them, cornered, and was slain
 * (ls4-26.3, t386611): a box there was more than SEAL_MAX_BLOCKS
 */
export function pillarDue (bot: Bot, near: Entity[], config: ReflexConfig, tick: number): boolean {
  if (!refugeHard(bot, near, config)) return false
  const melee = (e: Entity): boolean => MELEE_MOBS.has(e.name ?? '') || (e.name === 'drowned' && !holdsTrident(e) && !bodyInWater(bot, e.position))
  if (!near.every(melee) || !pillarRefugeFrom(near)) return false
  if (near.length < 2 && !wasCornered(bot, tick)) return false
  // none at the bot yet: a pillar begun with them at it was knocked off its blocks by their hits, the zombies up the
  // blocks it left (tests/integration/zombieFloor); the fight's hits put them back first (its until: pillarDue)
  if (near.some(e => distance(bot, e) < PILLAR_CLEAR)) return false
  // and no mob that shoots about (pillarRanged): up there it's a mark
  if (pillarRanged(bot)) return false
  const at = pillars.get(bot)
  const feet = bot.entity.position.floored().toString()
  if (at != null && at.feet === feet && tick - at.tick >= 0 && tick - at.tick < PILLAR_RETRY_TICKS) return false
  return pillarFits(bot)
}

/** ticks after a wall-in at a cell the hostiles reflex fights there instead (walled in, dug out, and they were back) */
export const WALL_IN_RETRY_TICKS = 600
const wallIns = new WeakMap<Bot, { feet: string, tick: number }>()

/**
 * Whether the hostiles reflex walls the bot in where it stands (sealIn) rather than fight: a bot not fit for the caves
 * (caveRuleOn) in its own tunnel under the rock (its feet's and head's cells no cave's, CAVE_ROOF of rock over them),
 * on its feet out of the water and the lava, no creeper within 4 (the creeper reflex's), a box of SEAL_MAX_BLOCKS at
 * most there (a tunnel's two ends) and the blocks for it, and not walled in at that cell within WALL_IN_RETRY_TICKS.
 * Behind the blocks no zombie hits nor skeleton shoots (MeleeAttackGoal and RangedBowAttackGoal need a line of sight),
 * and the work's next dig goes on the way it was going. The 26.3 bot fought zombies and cave spiders in the dark with
 * a stone sword, and in plain iron with a diamond one, and was killed both times at y 20 (ls-26.3, t34384 and t100061).
 */
export function wallInDue (bot: Bot, near: Entity[], config: ReflexConfig, tick: number): boolean {
  if (!config.hostiles.wallIn || near.length === 0 || bot.health <= 0) return false
  if (!caveRuleOn(bot)) return false
  if (near.some(e => e.name === 'creeper' && distance(bot, e) < 4)) return false
  const e = bot.entity as any
  if (e.onGround !== true || e.isInWater === true || e.isInLava === true) return false
  const feet = bot.entity.position.floored()
  const cells = caveCells(bot)
  if (cells.isCave(feet) || cells.isCave(feet.offset(0, 1, 0)) || !cells.roofed(feet)) return false
  const last = wallIns.get(bot)
  if (last != null && last.feet === feet.toString() && tick - last.tick >= 0 && tick - last.tick < WALL_IN_RETRY_TICKS) return false
  const failed = sealFails.get(bot)
  if (failed != null && tick - failed >= 0 && tick - failed < SEAL_RETRY_TICKS) return false
  // (none the server refuses the blocks of: boxRefused)
  const box = sealBox(bot, near)
  if (box == null || boxRefused(bot, box)) return false
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
/** each bot's last failed way out of the water (the hostiles reflex's toShore) */
const shoreFails = new WeakMap<Bot, number>()

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

/** each bot's tick its flight from a silverfish nest failed (fleeNest), and the ticks the fight is let be after */
const nestFails = new WeakMap<Bot, number>()
export const NEST_RETRY_TICKS = 300

/** ticks a mob's hit holds the hostiles reflex on it (attackingNow), and how near it must still be */
export const ATTACK_HOLD_TICKS = 60
export const ATTACKER_RANGE = 6
/** the neutrals that hit hard (a polar bear's 6 on normal, an iron golem's 7 to 21): fled from hurt, not traded with */
export const STRONG_NEUTRALS = new Set(['polar_bear', 'iron_golem'])
/** at or under this health a strong neutral's fight is a flee (or more than one of them at any health) */
export const STRONG_FIGHT_HEALTH = 12

/** ticks of fighting a mob with no damage done to it before it's let be (fruitlessLetBe) */
export const FRUITLESS_TICKS = 200
/** ticks with no fight with a mob after which its fight's count starts over */
export const FRUITLESS_IDLE = 600
/** how near a let-be mob still hitting the bot is fought all the same */
export const FRUITLESS_NEAR = 2.5

interface FightLedger { tick: number, since: Map<number, number>, last: Map<number, number>, damaged: Map<number, number>, hitBy: Map<number, number> }
const ledgers = new WeakMap<Bot, FightLedger>()

/** each bot's fights: when each mob's began (since), was last fought (last), last took the bot's damage (damaged) */
function ledgerOf (bot: Bot): FightLedger {
  let l = ledgers.get(bot)
  if (l != null) return l
  const ledger: FightLedger = { tick: 0, since: new Map(), last: new Map(), damaged: new Map(), hitBy: new Map() }
  ledgers.set(bot, ledger)
  ;(bot as any).on?.('physicsTick', () => { ledger.tick++ })
  ;(bot as any).on?.('entityHurt', (e: Entity, source?: Entity) => {
    if (e == null || source == null) return
    if (source === bot.entity) ledger.damaged.set(e.id, ledger.tick)
    else if (e === bot.entity) ledger.hitBy.set(source.id, ledger.tick)
  })
  return ledger
}

/** a fight of the hostiles reflex with `e` noted (its start, unless it was fought within FRUITLESS_IDLE) */
export function noteFight (bot: Bot, e: Entity): void {
  const l = ledgerOf(bot)
  const last = l.last.get(e.id)
  if (last == null || l.tick - last > FRUITLESS_IDLE) l.since.set(e.id, l.tick)
  l.last.set(e.id, l.tick)
}

/**
 * Whether the hostiles reflex lets a mob be: fought FRUITLESS_TICKS or more with no damage done to it in the last
 * FRUITLESS_TICKS (a magma cube's or a slime's small splits, hard to hit; one out of reach a level down), unless it's
 * hitting the bot from within FRUITLESS_NEAR; never a strong neutral (STRONG_NEUTRALS: fled when it's the worse). The
 * 'never let be while it hits' rule kept 1.21.11 bots in 600-tick fights with magma cubes in the nether, over and over
 */
export function fruitlessLetBe (ctx: ReflexContext, e: Entity): boolean {
  if (STRONG_NEUTRALS.has(e.name ?? '')) return false
  const l = ledgerOf(ctx.bot)
  const since = l.since.get(e.id)
  const last = l.last.get(e.id)
  if (since == null || last == null || l.tick - last > FRUITLESS_IDLE || l.tick - since < FRUITLESS_TICKS) return false
  const dmg = l.damaged.get(e.id)
  if (dmg != null && dmg >= since && l.tick - dmg < FRUITLESS_TICKS) return false
  const hit = l.hitBy.get(e.id)
  return !(hit != null && l.tick - hit <= ATTACK_HOLD_TICKS && distance(ctx.bot, e) <= FRUITLESS_NEAR)
}

/**
 * The mobs attacking the bot now: alive, a hostile or one of the retaliate list (a neutral angered), that hurt it
 * within ATTACK_HOLD_TICKS and are within ATTACKER_RANGE; the nearest first. While there is one the hostiles reflex
 * never lets the work go on: a 1.21.11 bot in iron with a diamond sword fought a polar bear 12 ticks, then the cane's
 * exploring went on with the bear (and its family) hitting it, 10.6 to 0 health (f6-1.21.11, t179279)
 */
export function attackingNow (ctx: ReflexContext): Entity[] {
  const { bot, config } = ctx
  return Object.values(bot.entities).filter(e => {
    if (e === bot.entity || !isAlive(bot, e)) return false
    if (!isHostile(bot, e) && !config.hostiles.retaliate.includes(e.name ?? '') && !STRONG_NEUTRALS.has(e.name ?? '')) return false
    const at = ctx.attackers?.get(e.id)
    return at != null && ctx.tick - at >= 0 && ctx.tick - at <= ATTACK_HOLD_TICKS && distance(bot, e) <= ATTACKER_RANGE && !fruitlessLetBe(ctx, e)
  }).sort((a, b) => distance(bot, a) - distance(bot, b))
}

/** ticks a mob's hit makes it one to fight back in the water (hitInReach), and how near it must be */
export const HIT_BACK_TICKS = 40
export const HIT_BACK_REACH = 3.5

/**
 * Whether a mob (a hostile, or a neutral of the retaliate list) that hit the bot within HIT_BACK_TICKS is within
 * HIT_BACK_REACH: the hostiles reflex's way to the shore gives way to its fight (unless the air's low under water).
 * A 26.3 bot in iron with a diamond sword and a shield walked 285 ticks for the shore at night while a zombie hit it 11
 * times, 13.6 to 0 health (f7-26.3, seed 1912499065551014666)
 */
export function hitInReach (bot: Bot, attackers: ReadonlyMap<number, number> | undefined, tick: number): boolean {
  if (attackers == null || bot.entity == null) return false
  for (const [id, at] of attackers) {
    if (tick - at < 0 || tick - at > HIT_BACK_TICKS) continue
    const e = bot.entities[id]
    if (e == null || e === bot.entity || !isAlive(bot, e)) continue
    if (distance(bot, e) <= HIT_BACK_REACH) return true
  }
  return false
}

/** the head under water with the air at the drowning reflex's mark or under */
export function airLowUnderWater (bot: Bot, config: ReflexConfig): boolean {
  return headInWater(bot) && bot.oxygenLevel <= config.drowning.air
}

/** whether the strong neutrals attacking the bot (STRONG_NEUTRALS) are fled from: hurt to STRONG_FIGHT_HEALTH, or more than one */
export function strongNeutralFleeDue (bot: Bot, attacking: readonly Entity[]): boolean {
  const strong = attacking.filter(e => STRONG_NEUTRALS.has(e.name ?? ''))
  return strong.length > 0 && (bot.health <= STRONG_FIGHT_HEALTH || strong.length > 1)
}

export const hostilesReflex: Reflex = {
  name: 'hostiles',
  priority: 60,
  // (a hit after a fight or a flee failed: at it again at once, not the work's 20 ticks under the hits)
  hitEndsCooldown: true,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.hostiles.enabled) return null
    const nether = inNether(bot)
    const near = hostilesInRange(ctx).filter(e => !nether || !letBeInNether(bot, e, ctx.tick))
    const wither = witherToShoot(ctx)
    // (the trident drowned in sight within TRIDENT_KEEP_OFF, past the scan's 16 too)
    const tridents = nether ? [] : tridentsInSight(bot)
    // (a spear holder in sight within SPEAR_GUARD and 4, past the reflex's range too: guardSpear's)
    const spear = nether ? undefined : spearThreats(bot).find(e => distance(bot, e) <= SPEAR_GUARD + 4 && hasLineOfSight(bot, e))
    // (a creeper the creeper reflex ran from, after the bot past the reflex's range: chasingCreeper)
    const chasing = nether ? null : chasingCreeper(ctx)
    if (near.length === 0 && wither == null && tridents.length === 0 && spear == null && chasing == null) return null
    const cornered = wasCornered(bot, ctx.tick) && bestMeleeWeapon(bot) != null
    // in the water with hostiles about: to dry ground first (toShore), the fight after: a 1.21.11 bot fought a drowned
    // off the shore into the sea, and drowned and was impaled there (ls3b-1.21.11, t401692)
    // (not with a mob hitting the bot in reach and air enough: fought back where it is, hitInReach)
    if (!nether && (near.length > 0 || tridents.length > 0) && bodyInWater(bot, bot.entity.position) && ctx.tick - (shoreFails.get(bot) ?? -Infinity) > SHORE_RETRY_TICKS &&
      !(hitInReach(bot, ctx.attackers, ctx.tick) && !airLowUnderWater(bot, config))) {
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'to shore',
        run: async (signal) => {
          const { toShore } = await import('../executor/explore')
          // (given up once a mob hits it in reach, air enough: the reflex fights it next, watched each tick)
          const pressed = new AbortController()
          const onAbort = (): void => pressed.abort(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          let tick = ctx.tick
          const watch = (): void => {
            tick++
            if (hitInReach(bot, ctx.attackers, tick) && !airLowUnderWater(bot, config)) pressed.abort(new SkillError('ABORTED', 'a mob at the bot: fought back first'))
          }
          bot.on('physicsTick', watch)
          try {
            const out = await toShore(bot, pressed.signal).catch(err => { if (pressed.signal.aborted) throw err; return false })
            if (!out) {
              shoreFails.set(bot, ctx.tick)
              throw new SkillError('NO_PATH', 'no way out of the water to dry ground')
            }
          } finally {
            bot.off('physicsTick', watch)
            signal.removeEventListener('abort', onAbort)
          }
        }
      }
    }
    // a trident drowned in the water, the bot on dry ground: kept off, out of its range or its sight (never fought
    // from the shore: it throws from 10 blocks every 40 ticks, 8 a hit on normal); cornered, the shield up to it
    if (tridents.length > 0 && !bodyInWater(bot, bot.entity.position)) {
      if (!wasCornered(bot, ctx.tick)) {
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: 'keep off drowned',
          run: async (signal) => await fleeFrom(bot, () => tridentsInSight(bot), { signal, distance: TRIDENT_KEEP_OFF }).catch(err => noteCornered(bot, ctx.tick, err))
        }
      }
      // cornered: walled off where it stands (wallOffShooter: a block on each open line from its eyes), once a while;
      // held off with the shield in its sight a 26.3 bot at 4.5 health took a trident through it at 9.5 off, and the
      // next one at 16.7 (f6-26.3, t232374 at (125, 62, -72))
      const wallFrom = tridents[0]
      if (sealItem(bot) != null && ctx.tick - (wallOffs.get(bot) ?? -Infinity) > WALL_OFF_RETRY_TICKS &&
        barrierCells(bot, wallFrom.position.offset(0, (wallFrom.height ?? 1.95) * 0.85, 0), wallFrom).length > 0) {
        wallOffs.set(bot, ctx.tick)
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: 'wall off drowned',
          run: async (signal) => await wallOffShooter(bot, wallFrom, signal)
        }
      }
      if (hasShield(bot)) {
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: 'hold off drowned',
          run: async (signal) => await holdOffArcher(bot, tridents[0], { signal, maxTicks: config.hostiles.fightTicks, range: TRIDENT_KEEP_OFF })
        }
      }
    }
    // (the mobs attacking it now: none let go on with the work, attackingNow)
    const attacking = nether ? [] : attackingNow(ctx)
    const fleeAttackers = (detail: string): UrgentTask => ({
      name: 'hostiles',
      priority: config.hostiles.priority,
      detail,
      run: async (signal: AbortSignal) => await fleeFrom(bot, () => Object.values(bot.entities).filter(e => attacking.some(a => a.id === e.id) && isAlive(bot, e)), { signal, distance: config.hostiles.fleeDistance }).catch(err => noteCornered(bot, ctx.tick, err))
    })
    // a strong neutral (a polar bear, an iron golem) hitting the bot hurt, or more than one: away, not a trade of
    // hits; cornered, fought (its swings on the shield, fight's meleeGuard)
    // a mob with a spear in sight within SPEAR_GUARD and 4 (a mounted one's charge, 26.x): met before the rest, the
    // shield up to it and the swings as it passes, or a block on its line, or a step aside (guardSpear)
    if (spear != null) {
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: `${hasShield(bot) ? 'shield' : 'dodge'} spear ${spear.name ?? ''}`,
        run: async (signal) => await guardSpear(bot, spear, { signal })
      }
    }
    if (strongNeutralFleeDue(bot, attacking) && !wasCornered(bot, ctx.tick)) return fleeAttackers(`flee ${attacking.find(e => STRONG_NEUTRALS.has(e.name ?? ''))?.name ?? 'attacker'}`)
    // a creeper shot from where the bot is, the draw put away once it comes within a block of the shot's distance or
    // its fuse starts (the bot free to run: a drawn bow slows it to a fifth)
    const shootCreeper = (creeper: Entity): UrgentTask => {
      const tooNear = (): boolean => !isAlive(bot, creeper) || distance(bot, creeper) < config.hostiles.shootCreepersFrom - 1 || creeperSwelling(bot, creeper)
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'shoot creeper',
        run: async (signal) => await shoot(bot, creeper, { signal, maxShots: 3, until: tooNear, cutDraw: tooNear })
      }
    }
    // a creeper the creeper reflex ran from, still after the bot out of the reflex's range (chasingCreeper): seen to
    // before the work and the other mobs, shot with a bow, else kept off past its follow range; with a shield and no
    // bow it's met when it comes in range (fought with the shield up)
    if (chasing != null && !near.some(e => e.name === 'creeper')) {
      if (hasBowAndArrows(bot) && distance(bot, chasing) >= config.hostiles.shootCreepersFrom) return shootCreeper(chasing)
      if (!hasShield(bot) && !wasCornered(bot, ctx.tick)) {
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: 'keep off creeper',
          run: async (signal) => await fleeFrom(bot, () => isAlive(bot, chasing) ? [chasing] : [], { signal, distance: CREEPER_FOLLOW_RANGE }).catch(err => noteCornered(bot, ctx.tick, err))
        }
      }
    }
    if (near.length === 0 && wither == null) return attacking.length > 0 ? fleeAttackers('flee attacker') : null
    // silverfish: away from their nest (fleeNest), not walled in nor fought among its infested blocks, a hurt one
    // calling the rest out (f5-26.3: slain by 9 in iron); cornered, or the flight failed lately, fought where it stands
    if (!nether && near.some(e => e.name === 'silverfish') && !cornered && ctx.tick - (nestFails.get(bot) ?? -Infinity) > NEST_RETRY_TICKS) {
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'flee the silverfish nest',
        run: async (signal) => {
          const { fleeNest } = await import('../skills/silverfish')
          await fleeNest(bot, { signal }).catch(err => {
            if (!signal.aborted) nestFails.set(bot, ctx.tick)
            noteCornered(bot, ctx.tick, err)
          })
        }
      }
    }
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
    // a bot not fit for the caves in its tunnel: walled in, not a fight in the dark (wallInDue)
    if (wallInDue(bot, near, config, ctx.tick)) {
      wallIns.set(bot, { feet: bot.entity.position.floored().toString(), tick: ctx.tick })
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'wall in',
        run: async (signal) => await sealIn(bot, {
          signal,
          threats: () => Object.values(bot.entities).filter(e => isHostile(bot, e) && isAlive(bot, e) && distance(bot, e) <= config.combat.scanRange)
        }).catch(err => {
          if (!signal.aborted) sealFails.set(bot, ctx.tick)
          throw err
        })
      }
    }
    // hurt among melee mobs on an open floor (no box to shut in): up a pillar out of their reach (pillarDue)
    // under the rock: walled in where it stands (caveWallInDue), a pillar only where no box is to be had
    if (!nether && caveWallInDue(bot, near, config, ctx.tick)) {
      pillars.set(bot, { feet: bot.entity.position.floored().toString(), tick: ctx.tick })
      {
        return {
          name: 'hostiles',
          priority: config.hostiles.priority,
          detail: 'wall in',
          run: async (signal) => await sealIn(bot, {
            signal,
            threats: () => Object.values(bot.entities).filter(e => isHostile(bot, e) && isAlive(bot, e) && distance(bot, e) <= config.combat.scanRange)
          }).catch(err => {
            if (!signal.aborted) sealFails.set(bot, ctx.tick)
            throw err
          })
        }
      }
    }
    if (pillarDue(bot, near, config, ctx.tick)) {
      pillars.set(bot, { feet: bot.entity.position.floored().toString(), tick: ctx.tick })
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'pillar up',
        // (down off it, the hold given up, once a mob that shoots is about: pillarRanged)
        run: async (signal) => await pillarRefuge(bot, () => Object.values(bot.entities).filter(e => isHostile(bot, e) && isAlive(bot, e) && distance(bot, e) <= config.combat.scanRange), { signal, giveUp: () => pillarRanged(bot) })
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
    // the ones in the water off dry ground let be (leftInWater, tridentInWater), never chased into it
    // (and a mob its last fight couldn't kill in fightTicks let be a while unless it's on the bot: unkilledLetBe)
    // (one attacking it now never let be: attackingNow)
    const hitting = (e: Entity): boolean => attacking.some(a => a.id === e.id)
    const fightable = (nether ? near : near.filter(e => hitting(e) || (!leftInWater(bot, e) && !tridentInWater(bot, e)))).filter(e => hitting(e) || !unkilledLetBe(bot, e, ctx.tick))
      // (one fought FRUITLESS_TICKS with no damage done let be, but at the bot: fruitlessLetBe)
      .filter(e => !fruitlessLetBe(ctx, e))
    if (fightable.length === 0) return attacking.length > 0 ? fleeAttackers('flee attacker') : null
    // creepers: shot from a distance when there's a bow; melee only with a shield to take the blast
    // (and cornered, no way to run: hit, its knockback keeps it from the 3 blocks its fuse starts at, SwellGoal)
    const takeOn = (e: Entity): boolean => (hasBowAndArrows(bot) && distance(bot, e) >= config.hostiles.shootCreepersFrom) || hasShield(bot) || cornered
    // a creeper in range goes first, before any other mob: none is fought within its blast's reach. A zombie's fight
    // took a 1.21.11 bot back to the creeper it had just run from, seven times in 280 ticks, till it blew up 2.9 off
    // (f9-1.21.11, t305885)
    const creeperInRange = fightable.find(e => e.name === 'creeper')
    const target = creeperInRange != null ? (takeOn(creeperInRange) ? creeperInRange : undefined) : fightable[0]
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
    if (useBow) return shootCreeper(target)
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
      const now = hostilesInRange({ ...ctx, hostiles: Object.values(bot.entities).filter(e => (isHostile(bot, e) || provoked(ctx, e)) && isAlive(bot, e) && distance(bot, e) <= config.combat.scanRange) })
      const tick = ctx.tick + elapsed++
      // (a strong neutral's fight turned once the bot is hurt to STRONG_FIGHT_HEALTH: the flee next)
      // (and another mob's once a creeper comes in range: the creeper first)
      return (now.length > 0 && (fightTurned(bot, now, config, tick) || sealDue(bot, now, config, tick) || caveWallInDue(bot, now, config, tick) || pillarDue(bot, now, config, tick))) ||
        strongNeutralFleeDue(bot, attackingNow({ ...ctx, tick })) || (target.name !== 'creeper' && now.some(e => e.name === 'creeper'))
    }
    if (nether) {
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
          run: async (signal) => { noteFight(bot, target); return await fight(bot, target, { signal, ...meleeOptions(target, config, true), until: () => turned() || pastLeash(anchor, bot.entity.position) || fruitlessLetBe(ctx, target) }) }
        }
      }
    }
    // (a fight begun on dry ground keeps out of the water, and ends with the bot's feet in it: never after a mob into it)
    const dry = !bodyInWater(bot, bot.entity.position)
    return {
      name: 'hostiles',
      priority: config.hostiles.priority,
      detail: `fight ${target.name ?? ''}`,
      run: async (signal) => (noteFight(bot, target), await fight(bot, target, { signal, ...meleeOptions(target, config), dry, until: () => turned() || (dry && bodyInWater(bot, bot.entity.position)) || fruitlessLetBe(ctx, target) }).catch(err => {
        if (TaskError.is(err, 'TIMEOUT')) noteUnkilled(bot, target, ctx.tick)
        throw err
      }))
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
    // not under fire: a mob that shoots in sight within EAT_RANGED_CLEAR (the hostiles reflex keeps off it first), but
    // at EAT_UNDER_FIRE_HEALTH or under
    if (bot.health > EAT_UNDER_FIRE_HEALTH && rangedInSight(bot).length > 0) return null
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

/**
 * A shield in the off hand whenever the bag has one and the off hand is empty, or holds a worn one and the bag a
 * fresher (shieldToHold), not while a held item is in use: the off hand is where the fights and the blaze bunker raise it
 * from, and a 1.21.11 bot carried its one shield in the bag 100000 ticks with the off hand empty (f6-1.21.11). Under
 * the armor reflex's priority: a click or two
 */
export const shieldReflex: Reflex = {
  name: 'shield',
  priority: 69,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.armor.enabled || ctx.offhandLocked || (bot as any).usingHeldItem === true) return null
    if (shieldToHold(bot) == null) return null
    return { name: 'shield', priority: config.armor.priority - 1, run: async () => { await equipShield(bot) } }
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
    // (not one in a cave, a dungeon's or a mineshaft's, for a bot not fit for the caves: the walk to it is into the cave,
    // where its spiders are; the cave rule keeps it out, inCaveWall)
    const spawner = l.dark.find(p => (l.letBe.get(p.toString()) ?? -Infinity) <= ctx.tick && !farms.some(f => f.x === p.x && f.y === p.y && f.z === p.z) && !spawnerLit(bot, p) && !inCaveWall(bot, p))
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

/**
 * ticks the caves reflex lets be once a hole it sealed is open again (the work dug it out: its way goes into the cave,
 * the pathfinder's last resort; sealed each step, the bot would dig itself a walled way through)
 */
export const CAVE_RESEAL_TICKS = 2400
/** ticks between the caves reflex's looks for holes while the feet stay in their cell */
export const CAVE_LOOK_TICKS = 10

/**
 * ticks a bot under the cave rule may stay in a cave within CAVE_LINGER_DISTANCE of where it came in before the caves
 * reflex takes it out (a way through goes on: it moves)
 */
export const CAVE_LINGER_TICKS = 100
export const CAVE_LINGER_DISTANCE = 4
/** ticks a hole that took no block (a mob in it, no face to put one against) is let be by the caves reflex */
export const CAVE_HOLE_RETRY_TICKS = 600
/** ticks the caves reflex waits after a way out of a cave failed */
export const CAVE_LEAVE_RETRY_TICKS = 600

const caveLooks = new WeakMap<Bot, { at: number, feet: string, sealed: Map<string, { cell: Vec3, tick: number }>, letBeUntil: number, inCave: { since: number, at: Vec3 } | null, leaveAfter: number, failed: Map<string, number> }>()

/**
 * The holes from the bot's tunnel into a cave (caveOpenings: a cave's cells against its feet's or head's cells, the bot
 * in the rock) sealed with a block each, for a bot not fit for the caves (skills/caves caveReady): a tunnel or a
 * pathfinder's dig that broke into a cave, the way the cave's mobs came in shut. Once a hole it sealed is open again the
 * work's way goes through it: the holes are let be CAVE_RESEAL_TICKS. The 26.3 bot's mines opened into mineshafts and caves, and their cave
 * spiders and zombies came along the tunnels and killed it twice at y 20 (ls-26.3).
 */
export const cavesReflex: Reflex = {
  name: 'caves',
  priority: 55,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.caves.enabled || bot.entity == null) return null
    const e = bot.entity as any
    if (e.onGround !== true || e.isInWater === true || e.isInLava === true) return null
    let look = caveLooks.get(bot)
    if (look == null) caveLooks.set(bot, look = { at: -Infinity, feet: '', sealed: new Map(), letBeUntil: -Infinity, inCave: null, leaveAfter: -Infinity, failed: new Map() })
    const feet = bot.entity.position.floored().toString()
    if (feet === look.feet && ctx.tick - look.at < CAVE_LOOK_TICKS && ctx.tick >= look.at) return null
    look.at = ctx.tick
    look.feet = feet
    const l = look
    // a block it put in a hole gone again (the work dug it out): its way is into the cave, let be a while
    for (const [k, s] of l.sealed) {
      if (ctx.tick - s.tick < 0 || ctx.tick - s.tick >= CAVE_RESEAL_TICKS) { l.sealed.delete(k); continue }
      if (bot.blockAt(s.cell)?.boundingBox !== 'block') {
        l.sealed.delete(k)
        l.letBeUntil = ctx.tick + CAVE_RESEAL_TICKS
      }
    }
    if (ctx.tick < l.letBeUntil && l.letBeUntil - ctx.tick <= CAVE_RESEAL_TICKS) return null
    // lingering in a cave (a fight took it there, a fall, a station by its edge), out of a fight: back to the rock's
    // cells, its holes sealed after. A 1.21.11 bot smelted its salmon in a cave at y -20 after a skeleton's fight took it
    // in, 1400 ticks in and out of it (grimls-2)
    const pos = bot.entity.position
    if (caveRuleOn(bot) && caveCells(bot).isCave(pos.floored())) {
      if (l.inCave == null || pos.distanceTo(l.inCave.at) >= CAVE_LINGER_DISTANCE) l.inCave = { since: ctx.tick, at: pos.clone() }
      if (!ctx.inCombat && ctx.tick - l.inCave.since >= CAVE_LINGER_TICKS && ctx.tick >= l.leaveAfter) {
        return {
          name: 'caves',
          priority: config.caves.priority,
          detail: 'leave the cave',
          run: async (signal) => {
            l.inCave = null
            const out = await leaveCave(bot, signal)
            if (!out) l.leaveAfter = ctx.tick + CAVE_LEAVE_RETRY_TICKS
            return out
          }
        }
      }
      return null
    }
    l.inCave = null
    // (a hole that took no block lately let be: the reflex went again every few ticks for it, the work cut off each time)
    const tried = (h: Vec3): boolean => { const at = l.failed.get(h.toString()); return at != null && ctx.tick - at >= 0 && ctx.tick - at < CAVE_HOLE_RETRY_TICKS }
    const holes = caveOpenings(bot).filter(h => !tried(h))
    // (and the water or lava a dig of its tunnel opened onto)
    const wet = liquidOpenings(bot).filter(h => !tried(h))
    if (holes.length + wet.length === 0 || sealItem(bot) == null) return null
    return {
      name: 'caves',
      priority: config.caves.priority,
      detail: holes.length > 0 ? `seal ${holes.length} into a cave` : `seal ${wet.length} against ${bot.blockAt(wet[0])?.name ?? 'liquid'}`,
      run: async (signal) => await sealCaveOpenings(bot, signal, { skip: tried, sealed: hole => l.sealed.set(hole.toString(), { cell: hole, tick: ctx.tick }), failed: hole => l.failed.set(hole.toString(), ctx.tick) })
    }
  }
}

export const DEFAULT_REFLEXES: Reflex[] = [totemReflex, fallReflex, fireballReflex, hazardReflex, wardenReflex, ghastReflex, drowningReflex, creeperReflex, emergencyEatReflex, hostilesReflex, cavesReflex, eatReflex, dropsReflex, spawnerReflex, nightReflex, armorReflex, shieldReflex]
