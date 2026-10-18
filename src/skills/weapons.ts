import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

// Melee stats of 1.21.11's weapons and tools: the attack damage the tooltip shows (the player's 1 plus the item's
// attribute modifier) and the attack speed (the player's 4 plus the item's modifier), from Items' sword / axe /
// pickaxe / shovel / hoe / spear properties over ToolMaterial (wood, stone, copper, iron, diamond, gold, netherite).
// The same in 26.3: every item's attribute_modifiers are, and the sharpness, smite and bane bonuses.
interface MeleeStats { damage: number, speed: number }

const TIERS = ['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite'] as const
type Tier = typeof TIERS[number]
// ToolMaterial.attackDamageBonus
const TIER_BONUS: Record<Tier, number> = { wooden: 0, stone: 1, copper: 1, iron: 2, golden: 0, diamond: 3, netherite: 4 }
// Items: axe(material, damage, speed)
const AXE: Record<Tier, MeleeStats> = {
  wooden: { damage: 7, speed: 0.8 },
  stone: { damage: 9, speed: 0.8 },
  copper: { damage: 9, speed: 0.8 },
  iron: { damage: 9, speed: 0.9 },
  golden: { damage: 7, speed: 1 },
  diamond: { damage: 9, speed: 1 },
  netherite: { damage: 10, speed: 1 }
}
// Items: hoe(material, damage, speed)
const HOE_SPEED: Record<Tier, number> = { wooden: 1, stone: 2, copper: 2, iron: 3, golden: 1, diamond: 4, netherite: 4 }
// Items: spear(material, attackDuration, ...): its jab (the attack, without the charge of its kinetic_weapon), the
// material's damage bonus and an attack speed of 1 / duration: 0.65, 0.75, 0.85, 0.95, 0.95, 1.05, 1.15 seconds
const SPEAR_SECONDS: Record<Tier, number> = { wooden: 0.65, stone: 0.75, copper: 0.85, iron: 0.95, golden: 0.95, diamond: 1.05, netherite: 1.15 }

const STATS: Record<string, MeleeStats> = {
  trident: { damage: 9, speed: 1.1 },
  mace: { damage: 6, speed: 0.6 }
}
for (const tier of TIERS) {
  const bonus = TIER_BONUS[tier]
  STATS[`${tier}_sword`] = { damage: 4 + bonus, speed: 1.6 }
  STATS[`${tier}_axe`] = AXE[tier]
  STATS[`${tier}_pickaxe`] = { damage: 2 + bonus, speed: 1.2 }
  STATS[`${tier}_shovel`] = { damage: 2.5 + bonus, speed: 1 }
  STATS[`${tier}_hoe`] = { damage: 1, speed: HOE_SPEED[tier] }
  STATS[`${tier}_spear`] = { damage: 1 + bonus, speed: 1 / SPEAR_SECONDS[tier] }
}

/** Bare hands: the player's attack_damage 1 and attack_speed 4. */
export const FIST: MeleeStats = { damage: 1, speed: 4 }

export function meleeStats (name: string | undefined): MeleeStats {
  return (name != null ? STATS[name] : undefined) ?? FIST
}

/** Player.getCurrentItemAttackStrengthDelay: the ticks to a full swing, 20 over the attack speed. */
export function attackStrengthDelay (name: string | undefined): number {
  return 20 / meleeStats(name).speed
}

// The undead and the arthropods, for smite and bane of arthropods (EntityTypeTags.SENSITIVE_TO_SMITE,
// SENSITIVE_TO_BANE_OF_ARTHROPODS)
const UNDEAD = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin', 'skeleton', 'stray', 'bogged',
  'wither_skeleton', 'wither', 'phantom', 'zombie_horse', 'skeleton_horse', 'zoglin', 'camel_husk', 'zombie_nautilus', 'parched'])
const ARTHROPODS = new Set(['spider', 'cave_spider', 'silverfish', 'endermite', 'bee'])

function enchantLevel (item: Item, name: string): number {
  return (item.enchants ?? []).find((e: any) => e.name === name)?.lvl ?? 0
}

/** The damage of one fully charged hit: the item's, plus sharpness (0.5 a level plus 0.5), smite or bane (2.5 a level). */
export function hitDamage (item: Item | null, targetName?: string): number {
  if (item == null) return FIST.damage
  let damage = meleeStats(item.name).damage
  const sharpness = enchantLevel(item, 'sharpness')
  if (sharpness > 0) damage += 0.5 * sharpness + 0.5
  if (targetName != null && UNDEAD.has(targetName)) damage += 2.5 * enchantLevel(item, 'smite')
  if (targetName != null && ARTHROPODS.has(targetName)) damage += 2.5 * enchantLevel(item, 'bane_of_arthropods')
  return damage
}

/** The damage a second of fully charged hits deals. */
export function meleeDps (item: Item | null, targetName?: string): number {
  return hitDamage(item, targetName) * meleeStats(item?.name).speed
}

/** The inventory's best melee weapon for the target by damage per second, or null when bare hands beat it all. */
export function bestMeleeWeapon (bot: Bot, targetName?: string): Item | null {
  let best: Item | null = null
  let bestDps = meleeDps(null)
  for (const item of bot.inventory.items()) {
    if (!(item.name in STATS)) continue
    const dps = meleeDps(item, targetName)
    if (dps > bestDps) {
      best = item
      bestDps = dps
    }
  }
  return best
}

/**
 * Player.getAttackStrengthScale, counted on the client: the ticks since the last swing or since the main hand took
 * another item (Player.tick's attackStrengthTicker), over the held item's delay. As 26.3 counts it; 1.21.11's server
 * also starts over on any other arm swing (ServerPlayer.swing: a dig or a placement mid-fight), which this leaves out.
 */
export class AttackStrength {
  ticker = 0
  private lastHeld: number | null = null
  private readonly onTick = (): void => {
    this.ticker++
    const held = this.bot.heldItem?.type ?? null
    if (held !== this.lastHeld) {
      this.ticker = 0
      this.lastHeld = held
    }
  }

  constructor (private readonly bot: Bot) {
    bot.on('physicsTick', this.onTick)
  }

  /** the strength a swing now would have, with the adjust vanilla's Player.attack passes (0.5) */
  scale (adjust = 0.5): number {
    return Math.min(1, Math.max(0, (this.ticker + adjust) / attackStrengthDelay(this.bot.heldItem?.name)))
  }

  /** the ticks until a swing would be at full strength */
  ticksToFull (): number {
    return Math.max(0, Math.ceil(attackStrengthDelay(this.bot.heldItem?.name) - 0.5 - this.ticker))
  }

  /** swings at the entity (MultiPlayerGameMode.attack) and resets the ticker */
  attack (target: Parameters<Bot['attack']>[0]): void {
    this.bot.attack(target)
    this.ticker = 0
  }

  detach (): void {
    this.bot.off('physicsTick', this.onTick)
  }
}

const strengths = new WeakMap<Bot, AttackStrength>()
export function attackStrengthOf (bot: Bot): AttackStrength {
  let s = strengths.get(bot)
  if (s == null) strengths.set(bot, s = new AttackStrength(bot))
  return s
}
