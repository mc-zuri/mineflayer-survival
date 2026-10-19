// The anvil: an enchanted book (from loot) put on a piece of gear, and gear repaired with its material, through
// AnvilMenu: the two inputs in, the result and its cost (data slot 0) read, the result taken for the levels.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { ENCHANT_PREFERENCES, GEAR_ORDER, bestOfKind, itemKind, type ItemKind } from './enchant'
import { navigateToReach } from './navigate'
import { placeBlock } from './placeBlock'
import { findPlacement } from './placement'
import { experience } from './xp'
import { countItems, inventoryItems, resyncInventory, settleInventory, trace, waitTicks, waitUntil, type Block } from './util'

export const ANVIL_BLOCKS = ['anvil', 'chipped_anvil', 'damaged_anvil']

/** AnvilMenu: a cost of 40 or more is "too expensive" outside creative (the result stays empty) */
export const ANVIL_TOO_EXPENSIVE = 40

/** the item that repairs gear in an anvil (the #repairs_*_armor / tool material tags) */
export function repairMaterial (name: string): string | null {
  if (name === 'elytra') return 'phantom_membrane'
  if (name === 'turtle_helmet') return 'turtle_scute'
  if (name === 'shield') return 'oak_planks'
  if (name === 'mace') return 'breeze_rod'
  const material = name.split('_')[0]
  switch (material) {
    case 'netherite': return 'netherite_ingot'
    case 'diamond': return 'diamond'
    case 'iron': case 'chainmail': return 'iron_ingot'
    case 'golden': return 'gold_ingot'
    case 'copper': return 'copper_ingot'
    case 'stone': return 'cobblestone'
    case 'wooden': return 'oak_planks'
    case 'leather': return 'leather'
  }
  return null
}

export type ItemPick = string | ((item: Item) => boolean)

const picker = (pick: ItemPick): ((item: Item) => boolean) => typeof pick === 'string' ? (item: Item) => item.name === pick : pick

export interface AnvilArgs {
  /** the item worked on (slot 0) */
  target: ItemPick
  /** what goes with it (slot 1): an enchanted book, the repair material, a second item */
  addition: ItemPick
  /** the anvil (default: one within 16 blocks, else the one held, placed) */
  anvil?: Vec3
}

export interface AnvilResult {
  item: string
  /** levels the anvil took */
  cost: number
  enchants: Array<{ name: string | null, lvl: number }>
  /** the result's damage (durability used) */
  damage: number
  anvil: Vec3
}

async function getAnvil (bot: Bot, at: Vec3 | undefined, signal?: AbortSignal): Promise<Block> {
  const ids = ANVIL_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  if (at != null) {
    const block = bot.blockAt(at)
    if (block == null || !ids.includes(block.type)) throw new SkillError('NOT_FOUND', `no anvil at ${at.toString()}`)
    return block
  }
  const found = bot.findBlock({ matching: ids, maxDistance: 16 })
  if (found != null) return found
  if (countItems(bot, 'anvil') === 0) throw new SkillError('NOT_FOUND', 'no anvil nearby or held')
  const pos = findPlacement(p => bot.blockAt(p), bot.entity.position)
  if (pos == null) throw new SkillError('CANNOT_PLACE', 'no room for an anvil')
  await placeBlock(bot, { pos, item: 'anvil' }, signal)
  const placed = bot.blockAt(pos)
  if (placed == null || !ids.includes(placed.type)) throw new SkillError('VERIFY_FAILED', `no anvil at ${pos.toString()} after placing it`)
  return placed
}

/**
 * Works two items in an anvil (AnvilMenu.createResult): the target and the addition in, the result and its cost read
 * once the server sends them, the result taken (ResultSlot.onTake: the levels paid, the inputs used up), checked in the
 * inventory. Throws MISSING_ITEMS (with needLevels) when the levels don't cover the cost, VERIFY_FAILED when the two
 * don't combine.
 */
export async function anvilCombine (bot: Bot, args: AnvilArgs, signal?: AbortSignal): Promise<AnvilResult> {
  throwIfAborted(signal)
  const pickTarget = picker(args.target)
  const pickAddition = picker(args.addition)
  if (inventoryItems(bot).find(pickTarget) == null) throw new SkillError('MISSING_ITEMS', 'no item to work on')
  if (inventoryItems(bot).find(i => pickAddition(i) && !pickTarget(i)) == null && inventoryItems(bot).filter(pickTarget).length < 2) {
    throw new SkillError('MISSING_ITEMS', 'nothing to put with it')
  }
  const block = await getAnvil(bot, args.anvil, signal)
  await navigateToReach(bot, block.position, signal)
  await settleInventory(bot, signal)
  const levelBefore = experience(bot).level

  let cost = -1
  const window: any = await bot.openBlock(block as any)
  const onData = (packet: any): void => { if (packet.windowId === window.id && packet.property === 0) cost = packet.value }
  bot._client.on('craft_progress_bar', onData)
  let result: AnvilResult | null = null
  try {
    if (!String(window.type).includes('anvil')) throw new SkillError('VERIFY_FAILED', `opened ${String(window.type)}, not an anvil`)
    // the window's own slots (the inventory starts at 3)
    const target: Item | undefined = window.items().find(pickTarget)
    if (target == null) throw new SkillError('MISSING_ITEMS', 'no item to work on')
    await bot.moveSlotItem(target.slot, 0)
    const addition: Item | undefined = window.items().find((i: Item) => pickAddition(i) && i.slot !== target.slot)
    if (addition == null) throw new SkillError('MISSING_ITEMS', 'nothing to put with it')
    await bot.moveSlotItem(addition.slot, 1)
    // the result slot and the cost come once the server has both inputs (AnvilMenu.createResult, broadcastChanges)
    const ready = await waitUntil(bot, () => window.slots[2] != null && cost > 0, 40, signal)
    await waitTicks(bot, 1, signal)
    const out: Item | null = window.slots[2] ?? null
    trace('anvil:', target.name, '+', addition.name, '->', out?.name, 'cost', cost)
    if (!ready || out == null) {
      throw new SkillError('VERIFY_FAILED', `${target.name} and ${addition.name} don't combine${cost >= ANVIL_TOO_EXPENSIVE ? ' (too expensive)' : ''}`)
    }
    if (bot.game.gameMode !== 'creative' && levelBefore < cost) {
      throw new SkillError('MISSING_ITEMS', `the anvil asks ${cost} levels, the bot is ${levelBefore}`, { needLevels: cost })
    }
    result = { item: out.name, cost, enchants: out.enchants ?? [], damage: (out as any).durabilityUsed ?? 0, anvil: block.position }
    await bot.putAway(2)
    await waitUntil(bot, () => experience(bot).level <= levelBefore - cost || bot.game.gameMode === 'creative', 20, signal)
  } finally {
    bot._client.off('craft_progress_bar', onData)
    // what's left in the inputs comes back with the close (ItemCombinerMenu.removed)
    window.close()
    await settleInventory(bot, signal)
    await resyncInventory(bot, signal)
  }
  if (experience(bot).level > levelBefore - result.cost && bot.game.gameMode !== 'creative') {
    throw new SkillError('VERIFY_FAILED', `the anvil's ${result.cost} levels weren't taken: level ${experience(bot).level}`, result)
  }
  return result
}

/** an anvil repair: the item and its material (or a second one of it) */
export async function repairItem (bot: Bot, args: { item: string, anvil?: Vec3 }, signal?: AbortSignal): Promise<AnvilResult> {
  const damaged = (i: Item): boolean => i.name === args.item && ((i as any).durabilityUsed ?? 0) > 0
  if (inventoryItems(bot).find(damaged) == null) throw new SkillError('MISSING_ITEMS', `no damaged ${args.item}`)
  const material = repairMaterial(args.item)
  const addition: ItemPick = material != null && countItems(bot, material) > 0 ? material : args.item
  // (with a second one of the item, anvilCombine takes the addition from another slot than the target's)
  return await anvilCombine(bot, { target: damaged, addition, anvil: args.anvil }, signal)
}

/** where each kind of armor is worn */
const WORN_SLOTS: Partial<Record<ItemKind, 'head' | 'torso' | 'legs' | 'feet'>> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

/**
 * The kinds of gear an enchantment is wanted on (ENCHANT_PREFERENCES), the gear's own order (GEAR_ORDER: the
 * pickaxe, the sword, the armor...), the kinds not in it left out: a book of unbreaking went on a wooden hoe, whose
 * list has it first, on 26.3
 */
export function kindsFor (enchantment: string): ItemKind[] {
  return GEAR_ORDER.filter(kind => ENCHANT_PREFERENCES[kind]?.includes(enchantment))
}

/**
 * Puts the enchanted books the bot holds on its gear: each book on the best item of the kind its enchantment is most
 * wanted on that doesn't have it yet (and takes it: AnvilMenu refuses incompatible ones), as the levels allow.
 */
export async function applyBooks (bot: Bot, opts: { anvil?: Vec3 } = {}, signal?: AbortSignal): Promise<AnvilResult[]> {
  const done: AnvilResult[] = []
  const tried = new Set<string>()
  for (;;) {
    throwIfAborted(signal)
    const book = inventoryItems(bot).find(i => i.name === 'enchanted_book' && !tried.has(JSON.stringify(i.enchants)))
    if (book == null) break
    const key = JSON.stringify(book.enchants)
    tried.add(key)
    const enchantment = book.enchants[0]?.name
    if (enchantment == null) continue
    for (const kind of kindsFor(enchantment)) {
      const has = (i: Item): boolean => (i.enchants ?? []).some(e => e.name === enchantment)
      // the armor worn counts: taken off for the anvil and worn again after (the book of protection found only the
      // bag, and the armor worn took none: 'nothing took a book', 26.3)
      const dest = WORN_SLOTS[kind]
      const worn = dest != null ? bot.inventory.slots[bot.getEquipmentDestSlot(dest)] : null
      const candidates = [...inventoryItems(bot), ...(worn != null && itemKind(worn.name) === kind ? [worn] : [])].filter(i => itemKind(i.name) === kind && !has(i))
      const best = bestOfKind(candidates)
      if (best == null) continue
      const takeOff = worn != null && best === worn && dest != null
      try {
        if (takeOff) {
          await settleInventory(bot, signal)
          await bot.unequip(dest)
          await settleInventory(bot, signal)
        }
        done.push(await anvilCombine(bot, {
          target: i => i.name === best.name && !has(i),
          addition: i => i.name === 'enchanted_book' && JSON.stringify(i.enchants) === key,
          anvil: opts.anvil
        }, signal))
        break
      } catch (err) {
        if ((err as SkillError).reason === 'MISSING_ITEMS' && (err as any).partial?.needLevels != null) return done
        if ((err as SkillError).reason !== 'VERIFY_FAILED') throw err
      } finally {
        if (takeOff) {
          const piece = inventoryItems(bot).filter(i => i.name === best.name).sort((a, b) => (b.enchants?.length ?? 0) - (a.enchants?.length ?? 0))[0]
          if (piece != null) await bot.equip(piece, dest).catch(() => {})
        }
      }
    }
  }
  return done
}
