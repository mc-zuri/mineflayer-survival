import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { TaskError, type SkillOptions } from './combatUtil'

// Armor as 1.21.11's ArmorMaterials gives it (defense by piece, toughness), and the damage it lets through as
// CombatRules.getDamageAfterAbsorb and getDamageAfterMagicAbsorb work it out. The same in 26.3 (every piece's
// attribute_modifiers, CombatRules and the protection enchantments).
export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet'
export const ARMOR_SLOTS: ArmorSlot[] = ['head', 'torso', 'legs', 'feet']
const PIECES: Record<string, ArmorSlot> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

// ArmorMaterials: [boots, leggings, chestplate, helmet] defense, toughness
const MATERIALS: Record<string, { defense: Record<ArmorSlot, number>, toughness: number }> = {
  leather: { defense: { feet: 1, legs: 2, torso: 3, head: 1 }, toughness: 0 },
  copper: { defense: { feet: 1, legs: 3, torso: 4, head: 2 }, toughness: 0 },
  chainmail: { defense: { feet: 1, legs: 4, torso: 5, head: 2 }, toughness: 0 },
  iron: { defense: { feet: 2, legs: 5, torso: 6, head: 2 }, toughness: 0 },
  golden: { defense: { feet: 1, legs: 3, torso: 5, head: 2 }, toughness: 0 },
  diamond: { defense: { feet: 3, legs: 6, torso: 8, head: 3 }, toughness: 2 },
  netherite: { defense: { feet: 3, legs: 6, torso: 8, head: 3 }, toughness: 3 }
}

export interface ArmorPiece { slot: ArmorSlot, defense: number, toughness: number }

/** The slot and stats of an armor item, or null for anything else (elytra and pumpkins included: no defense). */
export function armorPiece (name: string): ArmorPiece | null {
  if (name === 'turtle_helmet') return { slot: 'head', defense: 2, toughness: 0 }
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name)
  if (m == null) return null
  const material = MATERIALS[m[1]]
  const slot = PIECES[m[2]]
  if (material == null || slot == null) return null
  return { slot, defense: material.defense[slot], toughness: material.toughness }
}

function enchantLevel (item: Item | null | undefined, name: string): number {
  return (item?.enchants ?? []).find((e: any) => e.name === name)?.lvl ?? 0
}

/** CombatRules.getDamageAfterAbsorb: the damage armor and toughness let through. */
export function damageAfterArmor (damage: number, armor: number, toughness: number): number {
  const f = 2 + toughness / 4
  const g = Math.min(Math.max(armor - damage / f, armor * 0.2), 20)
  return damage * (1 - g / 25)
}

/** CombatRules.getDamageAfterMagicAbsorb: protection's points (capped at 20) take 4% each. */
export function damageAfterProtection (damage: number, protection: number): number {
  return damage * (1 - Math.min(20, protection) / 25)
}

/** The damage a set lets through from a hit (generic, so only protection counts of the protections). */
export function damageThrough (pieces: Array<Item | null | undefined>, damage = 8): number {
  let armor = 0
  let toughness = 0
  let protection = 0
  for (const item of pieces) {
    if (item == null) continue
    const piece = armorPiece(item.name)
    if (piece == null) continue
    armor += piece.defense
    toughness += piece.toughness
    // Enchantments: protection a point a level for all damage; the others two a level for their kind, counted at a
    // quarter so they break ties (blast protection against creepers)
    protection += enchantLevel(item, 'protection') +
      0.25 * 2 * (enchantLevel(item, 'blast_protection') + enchantLevel(item, 'fire_protection') + enchantLevel(item, 'projectile_protection'))
  }
  return damageAfterProtection(damageAfterArmor(damage, armor, toughness), protection)
}

function remainingDurability (item: Item): number {
  const max = (item as any).maxDurability ?? 0
  return max - ((item as any).durabilityUsed ?? 0)
}

/** How good the piece is in its slot with the rest of the set as worn: the damage it saves from a hit, then durability. */
export function armorScore (item: Item, worn: Partial<Record<ArmorSlot, Item | null>>): number {
  const piece = armorPiece(item.name)
  if (piece == null) return -Infinity
  const others = ARMOR_SLOTS.filter(s => s !== piece.slot).map(s => worn[s])
  const saved = damageThrough(others) - damageThrough([...others, item])
  return saved * 1000 + Math.min(remainingDurability(item), 999) * 0.001 + enchantLevel(item, 'mending') * 0.5 + enchantLevel(item, 'unbreaking') * 0.1
}

/**
 * Whether `spare` is worth putting on for `current` (same protection) for its durability alone: a quarter of its
 * most more left. Every hit wears each worn piece a point (Inventory.hurtArmor), so with two of a piece (the trip's
 * spare golden boots) the worn one was always the more worn after a hit: the armor reflex swapped them at each of a
 * magma cube swarm's hits, preempting the fight back each time, and a 26.3 bot died to 18 hits with a diamond sword in
 * hand in a basalt delta.
 */
function freshEnough (spare: Item, current: Item): boolean {
  const max = (spare as any).maxDurability ?? 0
  return remainingDurability(spare) - remainingDurability(current) >= Math.max(1, max / 4)
}

export function wornArmor (bot: Bot): Record<ArmorSlot, Item | null> {
  const worn: any = {}
  for (const slot of ARMOR_SLOTS) worn[slot] = bot.inventory.slots[bot.getEquipmentDestSlot(slot)] ?? null
  return worn
}

/** Whether to wear it: no curse of binding (it can't come off), an armor piece. */
function wearable (item: Item): boolean {
  return armorPiece(item.name) != null && enchantLevel(item, 'binding_curse') === 0
}

const goldWanted = new WeakMap<object, boolean>()

/**
 * Keep a golden piece on (for the piglins, PiglinAi.isWearingGold): armorUpgrades leaves the last golden piece worn
 * rather than swap it for a better one.
 */
export function requireGoldArmor (bot: Bot, on = true): void {
  goldWanted.set(bot, on)
}

export function goldArmorRequired (bot: Bot): boolean {
  // in the nether only, where the piglins are: back out, the better boots go back on (the golden ones put on for the
  // nether stayed on through the End)
  return goldWanted.get(bot) === true && /nether/.test(String(bot.game?.dimension ?? ''))
}

/** bots whose armor is off on purpose for a while (at the enchanting table, the anvil): no upgrades offered */
const armorHeld = new WeakSet<object>()

/**
 * Runs `fn` with the armor reflex held off: a piece taken off for the table or the anvil isn't put back on under it
 * (the reflex put the chestplate back each time, the enchanting started over 196836 times, 26.3)
 */
export async function withArmorHeld<T> (bot: Bot, fn: () => Promise<T>): Promise<T> {
  const already = armorHeld.has(bot)
  armorHeld.add(bot)
  try {
    return await fn()
  } finally {
    if (!already) armorHeld.delete(bot)
  }
}

/** For each slot, the inventory piece better than the worn one, if any (the last golden piece kept when requireGoldArmor). */
export function armorUpgrades (bot: Bot): Partial<Record<ArmorSlot, Item>> {
  if (armorHeld.has(bot)) return {}
  const worn = wornArmor(bot)
  const golden = ARMOR_SLOTS.filter(slot => worn[slot]?.name.startsWith('golden_') === true)
  const keep = goldArmorRequired(bot) && golden.length === 1 ? golden[0] : null
  const upgrades: Partial<Record<ArmorSlot, Item>> = {}
  for (const item of bot.inventory.items()) {
    const piece = armorPiece(item.name)
    if (piece == null || !wearable(item)) continue
    const slot = piece.slot
    if (slot === keep && !item.name.startsWith('golden_')) continue
    // a carved pumpkin on the head stays on in the End (the endermen's gaze disguise, skills/pumpkin.ts)
    if (slot === 'head' && bot.inventory.slots[bot.getEquipmentDestSlot('head')]?.name === 'carved_pumpkin' && /the_end/.test(String(bot.game?.dimension ?? ''))) continue
    const current = worn[slot]
    const best = upgrades[slot] ?? current
    if (best == null || armorScore(item, worn) > armorScore(best, worn)) upgrades[slot] = item
  }
  const better: Partial<Record<ArmorSlot, Item>> = {}
  for (const slot of ARMOR_SLOTS) {
    const item = upgrades[slot]
    const current = worn[slot]
    if (item == null || item === current) continue
    // (as good but for durability: only for one much fresher)
    const guard = (i: Item): number => armorScore(i, worn) - Math.min(remainingDurability(i), 999) * 0.001
    if (current != null && Math.abs(guard(item) - guard(current)) < 1e-9 && !freshEnough(item, current)) continue
    better[slot] = item
  }
  return better
}

export interface EquipArmorResult {
  equipped: Partial<Record<ArmorSlot, string>>
}

/** Wears the best armor in the inventory in each slot; equipped is empty when nothing better is there. */
export async function equipArmor (bot: Bot, opts: SkillOptions = {}): Promise<EquipArmorResult> {
  const upgrades = armorUpgrades(bot)
  const equipped: Partial<Record<ArmorSlot, string>> = {}
  for (const slot of ARMOR_SLOTS) {
    const item = upgrades[slot]
    if (item == null) continue
    if (opts.signal?.aborted === true) throw new TaskError('ABORTED', 'aborted')
    await bot.equip(item, slot)
    equipped[slot] = item.name
  }
  return { equipped }
}

/** a shield with this much durability left or less is worn: another is held when there is one, and one made (SHIELD 336) */
export const SHIELD_WORN = 84

/** the shield's durability left */
export function shieldLeft (item: Item): number {
  return remainingDurability(item)
}

/**
 * The shield to put in the off hand now: the bag's freshest when the off hand is empty, or holds a worn shield
 * (SHIELD_WORN) and the bag a fresher one; null for none. A 1.21.11 bot carried its shield in the bag 100000 ticks, its
 * off hand empty (raiseShield put it there only when raised), and the fights' code that looks at the off hand for it
 * saw none (f6-1.21.11, seed 2528942595609174214, t413442 to t506847)
 */
export function shieldToHold (bot: Bot): Item | null {
  const held = bot.inventory.slots[45] ?? null
  if (held != null && held.name !== 'shield') return null
  const bag = bot.inventory.items().filter(i => i.name === 'shield').sort((a, b) => shieldLeft(b) - shieldLeft(a))[0]
  if (bag == null) return null
  if (held == null) return bag
  return shieldLeft(held) <= SHIELD_WORN && shieldLeft(bag) > shieldLeft(held) ? bag : null
}

/** Puts shieldToHold in the off hand; false with none to put */
export async function equipShield (bot: Bot): Promise<boolean> {
  const shield = shieldToHold(bot)
  if (shield == null) return false
  await bot.equip(shield, 'off-hand')
  return true
}

/** Puts a totem of undying in the off hand (LivingEntity.checkTotemDeathProtection checks both hands). */
export async function equipTotem (bot: Bot): Promise<boolean> {
  if (bot.inventory.slots[45]?.name === 'totem_of_undying') return true
  const totem = bot.inventory.items().find(i => i.name === 'totem_of_undying')
  if (totem == null) return false
  await bot.equip(totem, 'off-hand')
  return true
}
