import type { Bot } from 'mineflayer'
import { armorUpgrades, equipArmor, equipTotem } from '../skills/armor'
import { eat, bestFoodInInventory } from '../skills/eat'
import { escapeHazard, evadeCreeper, fleeFrom, headInWater, inHazard, surface } from '../skills/escape'
import { creeperSwelling, fight } from '../skills/fight'
import { shoot } from '../skills/shoot'
import { armorPoints, botIsBrightOutside, isEnclosed, leaveShelter, nightPlan, shelter, shelterToLeave, sleepThroughNight, type NightPlan } from '../skills/shelter'
import { bestMeleeWeapon } from '../skills/weapons'
import { hasLineOfSight, type Entity } from '../skills/combatUtil'
import { GHAST_FIREBALL, deflectFireball, fireballIncoming } from '../nether/safety'
import { isSkillError } from '../skills/errors'
import type { Reflex, ReflexContext } from './types'
import { isBed } from '../core/items'
import { breakFall, landingY, shouldBreakFall } from '../skills/fall'

/** A hostile mob (minecraft-data's entity type 'hostile', vanilla's MobCategory.MONSTER) still alive. */
export function isHostile (bot: Bot, e: Entity): boolean {
  if (e === bot.entity || e.name == null) return false
  return (bot.registry.entitiesByName as any)[e.name]?.type === 'hostile'
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
    return { name: 'fireball', priority: config.fireball.priority, detail: 'deflect fireball', run: async (signal) => await deflectFireball(bot, fireball, { signal }) }
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
    return {
      name: 'hazard',
      priority: config.hazard.priority,
      run: async (signal) => await escapeHazard(bot, { signal, searchRadius: config.hazard.searchRadius, waterRadius: config.hazard.waterRadius, maxTicks: config.hazard.maxTicks })
    }
  }
}

/** Up for air when it runs low under water. */
export const drowningReflex: Reflex = {
  name: 'drowning',
  priority: 85,
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
    if (ctx.running?.name === 'hostiles' && ctx.running.detail === 'fight creeper' && hasShield(bot)) return null
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

/** the mobs that shoot (RangedBowAttackGoal's 15 blocks, RangedCrossbowAttackGoal's 8 and more, the witch's RangedAttackGoal 10) */
export const RANGED_HOSTILES = new Set(['skeleton', 'stray', 'bogged', 'parched', 'pillager', 'witch'])

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
export const hostilesReflex: Reflex = {
  name: 'hostiles',
  priority: 60,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.hostiles.enabled) return null
    const near = hostilesInRange(ctx)
    if (near.length === 0) return null
    const fightOn = near.length === 1 && armorPoints(bot) >= config.hostiles.fightOnArmor && bestMeleeWeapon(bot) != null
    const flee = (bot.health <= config.hostiles.fleeHealth && !fightOn) || near.length > config.hostiles.maxFight ||
      (config.hostiles.fleeUnarmed && bestMeleeWeapon(bot) == null)
    if (flee) {
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'flee',
        run: async (signal) => await fleeFrom(bot, () => hostilesInRange({ ...ctx, hostiles: Object.values(bot.entities).filter(e => isHostile(bot, e)) }), { signal, distance: config.hostiles.fleeDistance })
      }
    }
    // creepers: shot from a distance when there's a bow; melee only with a shield to take the blast
    const target = near.find(e => {
      if (e.name !== 'creeper') return true
      if (hasBowAndArrows(bot) && distance(bot, e) >= config.hostiles.shootCreepersFrom) return true
      return hasShield(bot)
    })
    if (target == null) {
      // only creepers it can't take on: keep away (past their follow range, Creeper's FOLLOW_RANGE 16)
      return {
        name: 'hostiles',
        priority: config.hostiles.priority,
        detail: 'flee',
        run: async (signal) => await fleeFrom(bot, () => hostilesInRange({ ...ctx, hostiles: Object.values(bot.entities).filter(e => isHostile(bot, e)) }), { signal, distance: config.hostiles.fleeDistance })
      }
    }
    const useBow = target.name === 'creeper' && hasBowAndArrows(bot) && distance(bot, target) >= config.hostiles.shootCreepersFrom
    return {
      name: 'hostiles',
      priority: config.hostiles.priority,
      detail: `${useBow ? 'shoot' : 'fight'} ${target.name ?? ''}`,
      run: async (signal) => useBow
        ? await shoot(bot, target, { signal, maxShots: 3 })
        // an enderman hit low: a look at its eyes (EnderMan.isLookingAtMe) is what angers the others
        : await fight(bot, target, { signal, maxTicks: config.hostiles.fightTicks, maxDistance: config.combat.scanRange * 2, aimHeight: target.name === 'enderman' ? 0.3 : undefined })
    }
  }
}

/**
 * Eat at or below the food threshold out of combat, or at low health when no hostile is in reach, or hurt out of
 * combat with the food level under 18 (FoodData.tick heals only from 18 up: a bot at food 15 to 17 never healed).
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
    if (bestFoodInInventory(bot) == null) return null
    return { name: 'eat', priority: config.eat.priority, run: async (signal) => await eat(bot, { signal }) }
  }
}

/** the highest feet height since the bot last stood on the ground, per bot (where a fall began) */
const fallStarts = new WeakMap<Bot, number>()

/** A long fall broken with the water bucket held, just before the landing (breakFall). */
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
    const landing = landingY(p => bot.blockAt(p) as any, bot.entity.position)
    const go = shouldBreakFall({
      y, vy: bot.entity.velocity.y, onGround: false, fallStart: start, landing,
      hasBucket: bot.inventory.items().some(i => i.name === 'water_bucket'),
      nether: /nether/.test(String(bot.game?.dimension ?? ''))
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
/** no ground to dig a shelter in found: not before this tick, and this far out next time */
const noGround = new WeakMap<Bot, { until: number, radius: number }>()

/** the night's plan, looked at again every 100 ticks (a bed nearby is a block search) */
function cachedNightPlan (ctx: ReflexContext): NightPlan {
  const { bot, config } = ctx
  const cached = planCache.get(bot)
  if (cached != null && ctx.tick - cached.tick < 100 && cached.tick <= ctx.tick) return cached.plan
  const bedNearby = config.night.sleep && typeof bot.findBlock === 'function' &&
    bot.findBlock({ matching: (b: any) => isBed(b.name), maxDistance: config.night.bedDistance }) != null
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

/**
 * At night in the overworld: a bed means sleep (the monsters that keep the bot up fought first), good gear means stay
 * out and let the hostiles reflex fight, else a shelter dug into the ground till the day. Not underground at work: the
 * dark there is the same day and night.
 */
export const nightReflex: Reflex = {
  name: 'night',
  priority: 40,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.night.enabled || bot.isSleeping === true || bot.time == null) return null
    if (bot.game?.dimension != null && !/overworld/.test(String(bot.game.dimension))) return null
    if (botIsBrightOutside(bot)) {
      // cut off on its way out of the shelter at sunrise (a fight): out the rest of the way
      if (shelterToLeave(bot) == null) return null
      return { name: 'night', priority: config.night.priority, detail: 'leave shelter', run: async (signal) => await leaveShelter(bot, signal) }
    }
    // the night's mining (the runner's schedule) is on its way down: a staircase is a roof within a few blocks
    if ((bot as any).survival?.nightWork === true) return null
    const plan = cachedNightPlan(ctx)
    if (plan === 'fight') return null
    const backoff = noGround.get(bot)
    if (backoff != null && ctx.tick < backoff.until) return null
    const dig = async (signal: AbortSignal): Promise<unknown> => {
      try {
        const result = await shelter(bot, { signal, radius: backoff?.radius ?? config.night.shelterRadius })
        noGround.delete(bot)
        return result
      } catch (err) {
        // nowhere to dig about (a swamp, the sea, bare rock without a pickaxe): look again in a while, further out
        if (isSkillError(err, 'NOT_FOUND')) noGround.set(bot, { until: ctx.tick + 200, radius: Math.min(24, (backoff?.radius ?? config.night.shelterRadius) * 2) })
        throw err
      }
    }
    if (plan === 'sleep' && config.night.sleep) {
      return {
        name: 'night',
        priority: config.night.priority,
        detail: 'sleep',
        run: async (signal) => {
          try {
            return await sleepThroughNight(bot, { signal, bedDistance: config.night.bedDistance })
          } catch (err) {
            if (signal.aborted || !config.night.shelter) throw err
            planCache.delete(bot)
            return await dig(signal)
          }
        }
      }
    }
    if (!config.night.shelter || !outInTheNight(bot)) return null
    return { name: 'night', priority: config.night.priority, detail: 'shelter', run: dig }
  }
}

export const DEFAULT_REFLEXES: Reflex[] = [totemReflex, fallReflex, fireballReflex, hazardReflex, drowningReflex, creeperReflex, emergencyEatReflex, hostilesReflex, eatReflex, nightReflex, armorReflex]
