// brew: potions at a brewing stand (BrewingStandBlockEntity): water bottles in its three bottle slots, blaze powder in
// its fuel slot, each ingredient in turn in its top slot, brewed for BREW_TICKS, and the potions taken out after; the
// stand one nearby, or one the bot makes (a blaze rod and 3 cobblestone) and puts down.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { craft } from './craft'
import { navigateToReach } from './navigate'
import { placeBlock } from './placeBlock'
import { findPlacementNear } from './placement'
import { potionOf } from './potion'
import { countItems, settleInventory, trace, waitUntil, type Block } from './util'
import { findBlock } from '../core/findBlocks'

/** BrewingStandBlockEntity: a brew takes 400 ticks (brewTime), a blaze powder gives 20 brews (DEFAULT_FUEL_USES) */
export const BREW_TICKS = 400
export const FUEL_USES = 20
/** BrewingStandMenu's slots: the bottles 0 to 2, the ingredient 3, the fuel 4, then the inventory 5 to 40 */
export const BOTTLE_SLOTS = [0, 1, 2] as const
export const INGREDIENT_SLOT = 3
export const FUEL_SLOT = 4
/** BrewingStandBlockEntity's data slots: the brew's ticks to go, the fuel's brews left */
const DATA_BREW_TIME = 0
const DATA_FUEL = 1

/** the potion registry's protocol ids (Potions' registration order, the same in 1.21.11 and 26.3) the brews go through */
export const POTION = { water: 0, awkward: 3, fire_resistance: 11, long_fire_resistance: 12 } as const

/** what an ingredient makes of a bottle (VanillaBrewingProvider: addMix, addStartMix) */
export const BREWS: Record<string, { from: readonly number[], to: number }> = {
  nether_wart: { from: [POTION.water], to: POTION.awkward },
  magma_cream: { from: [POTION.awkward], to: POTION.fire_resistance },
  redstone: { from: [POTION.fire_resistance], to: POTION.long_fire_resistance }
}

/** the ingredients of fire resistance, in turn: the awkward potion's nether wart, then the magma cream */
export const FIRE_RESISTANCE_BREW = ['nether_wart', 'magma_cream'] as const

/** a water bottle: a potion of water (PotionContents with Potions.WATER) */
export function isWaterBottle (item: Item | null | undefined): boolean {
  return item != null && item.name === 'potion' && potionOf(item) === POTION.water
}

/** the water bottles carried */
export function waterBottles (bot: Bot): number {
  return bot.inventory.items().filter(isWaterBottle).length
}

/**
 * The ingredients of a brew that come one after the other from the bottles the bot has: each one's `from` met by what
 * the one before made, the first's by water. Throws on a chain that doesn't go (an ingredient that makes nothing of it)
 */
export function brewChain (ingredients: readonly string[]): number[] {
  let at: number = POTION.water
  const out: number[] = []
  for (const name of ingredients) {
    const step = BREWS[name]
    if (step == null || !step.from.includes(at)) throw new SkillError('REFUSED', `${name} brews nothing of potion ${at}`)
    at = step.to
    out.push(at)
  }
  return out
}

export interface BrewArgs {
  /** the ingredients, in turn (default FIRE_RESISTANCE_BREW) */
  ingredients?: readonly string[]
  /** the stand to use (default: one within `standDistance`, else one made and put down) */
  stand?: Vec3
  standDistance?: number
  /** where to put down a stand made (default a free cell beside the bot) */
  standAt?: Vec3
  /** the stand the bot put down taken back after (default true) */
  pickUpStand?: boolean
}

export interface BrewResult {
  /** the potions made (the last ingredient's), taken into the bag */
  potions: number
  /** their potion id */
  potion: number
  stand: Vec3
  placedStand: boolean
}

async function getStand (bot: Bot, args: BrewArgs, signal?: AbortSignal): Promise<{ stand: Block, placed: boolean }> {
  const id = bot.registry.blocksByName.brewing_stand.id
  if (args.stand != null) {
    const block = bot.blockAt(args.stand)
    if (block == null || block.type !== id) throw new SkillError('NOT_FOUND', `no brewing stand at ${args.stand.toString()}`)
    return { stand: block, placed: false }
  }
  const found = findBlock(bot, { matching: [id], maxDistance: args.standDistance ?? 16 })
  if (found != null) return { stand: found, placed: false }
  // (a blaze rod and 3 cobblestone, blackstone or cobbled deepslate at a crafting table)
  if (countItems(bot, 'brewing_stand') === 0) await craft(bot, { item: 'brewing_stand' }, signal)
  const pos = args.standAt ?? findPlacementNear(p => bot.blockAt(p), bot.entity.position)
  if (pos == null) throw new SkillError('CANNOT_PLACE', 'no room next to the bot for a brewing stand')
  await placeBlock(bot, { pos, item: 'brewing_stand' }, signal)
  const stand = bot.blockAt(pos)
  if (stand == null || stand.type !== id) throw new SkillError('VERIFY_FAILED', `no brewing stand at ${pos.toString()} after placing it`)
  return { stand, placed: true }
}

/**
 * Brews the water bottles the bot has (three at most) through `ingredients` in turn at a brewing stand: a blaze powder
 * for its fuel (made from a blaze rod when there's none), the bottles in, then each ingredient one at a time, waited on
 * till the stand has used it up and the bottles are what it makes (BrewingStandBlockEntity.doBrew); the potions taken
 * out at the end, and the fuel left. Resolves how many potions came out.
 */
export async function brew (bot: Bot, args: BrewArgs = {}, signal?: AbortSignal): Promise<BrewResult> {
  throwIfAborted(signal)
  const ingredients = args.ingredients ?? FIRE_RESISTANCE_BREW
  const chain = brewChain(ingredients)
  const wanted = chain[chain.length - 1]
  if (waterBottles(bot) === 0) throw new SkillError('MISSING_ITEMS', 'no water bottles to brew')
  for (const name of ingredients) if (countItems(bot, name) === 0) throw new SkillError('MISSING_ITEMS', `no ${name} to brew with`)
  if (countItems(bot, 'blaze_powder') === 0 && countItems(bot, 'blaze_rod') > 0) await craft(bot, { item: 'blaze_powder' }, signal)

  const { stand, placed } = await getStand(bot, args, signal)
  await navigateToReach(bot, stand.position, signal)
  await settleInventory(bot, signal)
  // the stand's data slots, as the server sends them (ClientboundContainerSetDataPacket)
  const data: Record<number, number> = {}
  const onData = (packet: { property: number, value: number }): void => { data[packet.property] = packet.value }
  bot._client.on('craft_progress_bar', onData)
  const window: any = await bot.openBlock(stand)
  let made = 0
  try {
    await settleInventory(bot, signal)
    const slot = (i: number): Item | null => window.slots[i] ?? null
    const shift = async (i: number): Promise<void> => {
      await bot.clickWindow(i, 0, 1)
      await settleInventory(bot, signal)
    }
    // the stand's own slots emptied first: what it holds isn't the bot's brew
    for (const i of [...BOTTLE_SLOTS, INGREDIENT_SLOT]) if (slot(i) != null) await shift(i)
    // the fuel: the blaze powder shift-clicked in (the stack goes to the fuel slot: FuelSlot.mayPlaceItem), its one
    // burnt at the first brew, the rest taken back at the end
    if (slot(FUEL_SLOT) == null && (data[DATA_FUEL] ?? 0) <= 0) {
      const powder = window.items().find((i: Item) => i.name === 'blaze_powder')
      if (powder == null) throw new SkillError('MISSING_ITEMS', 'no blaze powder to fuel the brewing stand')
      await shift(powder.slot)
    }
    // the bottles: each water bottle shift-clicked goes to the first empty bottle slot (PotionSlot: one a slot)
    for (let n = 0; n < BOTTLE_SLOTS.length; n++) {
      const bottle = window.items().find((i: Item) => isWaterBottle(i))
      if (bottle == null) break
      await shift(bottle.slot)
    }
    const bottles = (): Item[] => BOTTLE_SLOTS.map(slot).filter((i): i is Item => i != null)
    if (bottles().length === 0) throw new SkillError('VERIFY_FAILED', 'no bottle went into the brewing stand')
    for (let k = 0; k < ingredients.length; k++) {
      throwIfAborted(signal)
      const name = ingredients[k]
      const into = chain[k]
      const stack = window.items().find((i: Item) => i.name === name)
      if (stack == null) throw new SkillError('MISSING_ITEMS', `no ${name} left to brew with`)
      // one of it into the ingredient slot: the stack picked up, one put down with a right click, the rest back
      await bot.clickWindow(stack.slot, 0, 0)
      await bot.clickWindow(INGREDIENT_SLOT, 1, 0)
      if (window.selectedItem != null) await bot.clickWindow(stack.slot, 0, 0)
      await settleInventory(bot, signal)
      if (slot(INGREDIENT_SLOT)?.name !== name) throw new SkillError('VERIFY_FAILED', `the ${name} didn't go into the brewing stand`)
      trace('brew:', name, 'in, the bottles', bottles().map(b => potionOf(b)).join(', '), 'to', into)
      // brewed: the ingredient used up (BrewingStandBlockEntity.doBrew shrinks it) and every bottle turned
      const done = (): boolean => slot(INGREDIENT_SLOT) == null && bottles().every(b => potionOf(b) === into)
      if (!await waitUntil(bot, done, BREW_TICKS + 60, signal)) {
        throw new SkillError('TIMEOUT', `the ${name} wasn't brewed in ${BREW_TICKS + 60} ticks (brew time ${data[DATA_BREW_TIME] ?? '?'}, fuel ${data[DATA_FUEL] ?? '?'})`)
      }
    }
    made = bottles().filter(b => potionOf(b) === wanted).length
  } finally {
    // the potions and the fuel back into the bag (a failed brew's ingredient too), each slot seen empty before the
    // next (clicked one after the other, two of three potions stayed in the stand and came out of it as it was broken)
    for (const i of [...BOTTLE_SLOTS, INGREDIENT_SLOT, FUEL_SLOT]) {
      for (let tries = 0; tries < 3 && window.slots[i] != null; tries++) {
        await bot.clickWindow(i, 0, 1).catch(() => {})
        await waitUntil(bot, () => window.slots[i] == null, 20).catch(() => false)
      }
    }
    await settleInventory(bot).catch(() => {})
    bot._client.removeListener('craft_progress_bar', onData)
    bot.closeWindow(window)
  }
  if (placed && args.pickUpStand !== false) {
    await collectBlock(bot, { positions: [stand.position] }, signal).catch(err => {
      if (isAbort(err)) throw err
      trace('brew: the stand not taken back:', (err as Error).message)
    })
  }
  return { potions: made, potion: wanted, stand: stand.position, placedStand: placed }
}
