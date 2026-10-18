import type { Bot } from 'mineflayer'
import { armorUpgrades, equipArmor, equipTotem } from '../skills/armor'
import { eat, bestFoodInInventory } from '../skills/eat'
import { escapeHazard, evadeCreeper, fleeFrom, headInWater, inHazard, surface } from '../skills/escape'
import { creeperSwelling, fight } from '../skills/fight'
import { shoot } from '../skills/shoot'
import { bestMeleeWeapon } from '../skills/weapons'
import type { Entity } from '../skills/combatUtil'
import { GHAST_FIREBALL, deflectFireball, fireballIncoming } from '../nether/safety'
import type { Reflex, ReflexContext } from './types'

/** A hostile mob (minecraft-data's entity type 'hostile', vanilla's MobCategory.MONSTER) still alive. */
export function isHostile (bot: Bot, e: Entity): boolean {
  if (e === bot.entity || e.name == null) return false
  return (bot.registry.entitiesByName as any)[e.name]?.type === 'hostile'
}

function distance (bot: Bot, e: Entity): number {
  return bot.entity.position.distanceTo(e.position)
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
    if (d < config.creeper.triggerDistance || (creeperSwelling(bot, e) && d < config.creeper.safeDistance)) {
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

/** The hostiles within the reflex's range, nearest first (the ignored ones left out). */
export function hostilesInRange (ctx: ReflexContext): Entity[] {
  const { bot, config } = ctx
  return ctx.hostiles.filter(e => !config.hostiles.ignore.includes(e.name ?? '') &&
    distance(bot, e) <= config.hostiles.range && Math.abs(e.position.y - bot.entity.position.y) <= config.hostiles.maxDy)
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
    const flee = bot.health <= config.hostiles.fleeHealth || near.length > config.hostiles.maxFight ||
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
      return bot.inventory.items().some(i => i.name === 'shield') || bot.inventory.slots[45]?.name === 'shield'
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
        : await fight(bot, target, { signal, maxTicks: config.hostiles.fightTicks, maxDistance: config.combat.scanRange * 2 })
    }
  }
}

/** Eat at or below the food threshold out of combat, or at low health when no hostile is in reach. */
export const eatReflex: Reflex = {
  name: 'eat',
  priority: 50,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.eat.enabled || bot.food >= 20) return null
    const hungry = bot.food <= config.eat.food && !ctx.inCombat
    const hurt = bot.health <= config.eat.health && hostilesInRange(ctx).length === 0
    if (!hungry && !hurt) return null
    if (bestFoodInInventory(bot) == null) return null
    return { name: 'eat', priority: config.eat.priority, run: async (signal) => await eat(bot, { signal }) }
  }
}

/** Wear armor better than what's worn when some comes into the inventory. */
export const armorReflex: Reflex = {
  name: 'armor',
  priority: 20,
  check (ctx) {
    const { bot, config } = ctx
    if (!config.armor.enabled || !ctx.armorChanged) return null
    if (Object.keys(armorUpgrades(bot)).length === 0) return null
    return { name: 'armor', priority: config.armor.priority, run: async (signal) => await equipArmor(bot, { signal }) }
  }
}

export const DEFAULT_REFLEXES: Reflex[] = [totemReflex, fireballReflex, hazardReflex, drowningReflex, creeperReflex, hostilesReflex, eatReflex, armorReflex]
