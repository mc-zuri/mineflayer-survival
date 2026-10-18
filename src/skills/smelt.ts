// smelt: items through a furnace (one nearby, or one the bot places), fuelled from the inventory, waiting on the
// furnace's own progress, counted in ticks so the wait keeps working when the server runs in lockstep.
import type { Bot, Furnace } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { craft } from './craft'
import { navigateToReach } from './navigate'
import { placeBlock } from './placeBlock'
import { findPlacementNear } from './placement'
import { countItems, countsDelta, inventoryCounts, itemId, settleInventory, waitUntil, type Block, type ItemCounts } from './util'

/** AbstractFurnaceBlockEntity: a furnace's smelt takes 200 ticks (the recipe's cooking time) */
export const SMELT_TICKS = 200

/**
 * Burn ticks of the fuels the bot burns, as FuelValues.vanillaBurnTimes gives them (1.21.2+; the same values as
 * AbstractFurnaceBlockEntity.getFuel before). The nether woods (crimson, warped) don't burn.
 */
export function burnTicks (name: string): number {
  if (/^(crimson|warped)_/.test(name)) return 0
  switch (name) {
    case 'lava_bucket': return 20000
    case 'coal_block': return 16000
    case 'dried_kelp_block': return 4001
    case 'blaze_rod': return 2400
    case 'coal': case 'charcoal': return 1600
    case 'stick': case 'bowl': case 'dead_bush': case 'azalea': case 'flowering_azalea': return 100
    case 'bamboo': case 'scaffolding': return 50
    case 'crafting_table': case 'chest': case 'trapped_chest': case 'barrel': case 'bookshelf': case 'ladder': return 300
  }
  if (/_(log|wood|planks|stem|hyphae)$/.test(name) || name === 'bamboo_block' || name === 'stripped_bamboo_block' || name === 'bamboo_mosaic') return 300
  if (/_(stairs|fence|fence_gate|pressure_plate|trapdoor)$/.test(name) && /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_/.test(name)) return 300
  if (/_slab$/.test(name) && /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_/.test(name)) return 150
  if (/_sapling$/.test(name) || name === 'mangrove_propagule') return 100
  if (/_wool$/.test(name)) return 100
  if (/_carpet$/.test(name)) return 67
  return 0
}

/**
 * Fuels the bot burns, the ones it would rather keep last: coal first, then wood it has a use for only as wood (planks,
 * logs), sticks, then the long burns that are worth more (a coal block, blaze rods). Lava buckets and tools aren't
 * burnt unless asked for.
 */
export const FUEL_PREFERENCE: Array<(name: string) => boolean> = [
  name => name === 'coal' || name === 'charcoal',
  name => /_planks$/.test(name) || name === 'bamboo_mosaic',
  name => /_slab$/.test(name),
  name => /_(log|wood|stem|hyphae)$/.test(name) || name === 'bamboo_block',
  name => name === 'stick' || /_sapling$/.test(name) || name === 'bamboo' || name === 'dead_bush',
  name => name === 'dried_kelp_block',
  name => name === 'coal_block',
  name => name === 'blaze_rod'
]

export interface FuelChoice {
  name: string
  count: number
  /** the ticks those burn for */
  ticks: number
}

/**
 * The fuel to load for `ticksNeeded` of burning: the preferred kind the bot has, as many as cover the need (all it has
 * when they don't). `preferred` names a fuel to use first. Null when there's nothing to burn.
 */
export function chooseFuel (items: Array<Pick<Item, 'name' | 'count'>>, ticksNeeded: number, preferred?: string): FuelChoice | null {
  const totals = new Map<string, number>()
  for (const item of items) if (burnTicks(item.name) > 0) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  const pick = (name: string): FuelChoice => {
    const each = burnTicks(name)
    const count = Math.min(totals.get(name) ?? 0, Math.max(1, Math.ceil(ticksNeeded / each)))
    return { name, count, ticks: count * each }
  }
  if (preferred != null) return totals.has(preferred) ? pick(preferred) : null
  for (const isKind of FUEL_PREFERENCE) {
    // of a kind, the item there's most of
    const names = [...totals.keys()].filter(isKind).sort((a, b) => ((totals.get(b) ?? 0) - (totals.get(a) ?? 0)) !== 0 ? (totals.get(b) ?? 0) - (totals.get(a) ?? 0) : a.localeCompare(b))
    if (names.length > 0) return pick(names[0])
  }
  return null
}

export interface SmeltArgs {
  input: string
  /** items to smelt (default: all the bot has of `input`) */
  count?: number
  /** the fuel to burn (default: chooseFuel's pick) */
  fuel?: string
  /** the furnace to use (default: the nearest within `furnaceDistance`, else one the bot places) */
  furnace?: Vec3
  furnaceDistance?: number
  /** break the furnace the bot placed and take it back once done (default false) */
  pickUpFurnace?: boolean
  /** ticks without the furnace getting on before giving up (default 400) */
  stallTicks?: number
}

export interface SmeltResult {
  /** what came out */
  output: string | null
  count: number
  furnace: Vec3
  placedFurnace: boolean
  /** fuel loaded, by item name */
  fuel: ItemCounts
  /** the inventory's change, by item name */
  items: ItemCounts
  ticks: number
}

const FURNACE_BLOCKS = ['furnace']

async function getFurnace (bot: Bot, args: SmeltArgs, signal?: AbortSignal): Promise<{ furnace: Block, placed: boolean }> {
  const ids = FURNACE_BLOCKS.map(name => bot.registry.blocksByName[name].id)
  if (args.furnace != null) {
    const block = bot.blockAt(args.furnace)
    if (block == null || !ids.includes(block.type)) throw new SkillError('NOT_FOUND', `no furnace at ${args.furnace.toString()}`)
    return { furnace: block, placed: false }
  }
  const found = bot.findBlock({ matching: ids, maxDistance: args.furnaceDistance ?? 16 })
  if (found != null) return { furnace: found, placed: false }
  if (countItems(bot, 'furnace') === 0) await craft(bot, { item: 'furnace' }, signal)
  const pos = findPlacementNear(pos => bot.blockAt(pos), bot.entity.position)
  if (pos == null) throw new SkillError('CANNOT_PLACE', 'no room next to the bot for a furnace')
  await placeBlock(bot, { pos, item: 'furnace' }, signal)
  const furnace = bot.blockAt(pos)
  if (furnace == null || !ids.includes(furnace.type)) throw new SkillError('VERIFY_FAILED', `no furnace at ${pos.toString()} after placing it`)
  return { furnace, placed: true }
}

export async function smelt (bot: Bot, args: SmeltArgs, signal?: AbortSignal): Promise<SmeltResult> {
  throwIfAborted(signal)
  itemId(bot, args.input)
  const have = countItems(bot, args.input)
  const count = args.count ?? have
  if (count <= 0 || have < count) throw new SkillError('MISSING_ITEMS', `${have} ${args.input} in the inventory, ${count} to smelt`)
  const stallTicks = args.stallTicks ?? 400

  const { furnace: furnaceBlock, placed } = await getFurnace(bot, args, signal)
  await navigateToReach(bot, furnaceBlock.position, signal)

  const before = inventoryCounts(bot)
  const fuel: ItemCounts = {}
  let output: string | null = null
  let smelted = 0
  let ticks = 0
  const result = (): SmeltResult => ({
    output, count: smelted, furnace: furnaceBlock.position, placedFurnace: placed, fuel, items: countsDelta(before, inventoryCounts(bot)), ticks
  })

  await settleInventory(bot, signal)
  const window: Furnace = await bot.openFurnace(furnaceBlock)
  // the client's ticks from the furnace's opening (one a server tick under lockstep)
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    // a furnace someone used: take what's in its output and input first, so all that comes out is the bot's
    if (window.outputItem() != null) await window.takeOutput()
    if (window.inputItem() != null && window.inputItem()?.name !== args.input) await window.takeInput()
    if (window.outputItem() != null || (window.inputItem() != null && window.inputItem()?.name !== args.input)) {
      throw new SkillError('NO_SPACE', 'no room in the inventory for what was in the furnace', result())
    }

    // what the furnace window reaches: the main slots and the hotbar, not the off hand (an item there can't be put in)
    const inWindow = (name: string): number => window.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
    let loaded = window.inputItem()?.count ?? 0
    const load = async (): Promise<void> => {
      const room = 64 - (window.inputItem()?.count ?? 0)
      const n = Math.min(count - loaded, room, inWindow(args.input))
      if (n > 0) {
        await window.putInput(itemId(bot, args.input), null, n)
        loaded += n
      }
    }
    await load()

    // the burn ticks loaded so far, and those the furnace had when opened (its litTime data slot)
    let fuelTicks = 0
    const refuel = async (): Promise<boolean> => {
      // AbstractFurnaceBlockEntity.serverTick: the fuel slot's next item lights when the burn runs out
      if (window.fuelItem() != null) return true
      const left = (count - smelted) * SMELT_TICKS - Math.max(0, fuelTicks - ticks)
      const choice = chooseFuel(window.items(), Math.max(left, SMELT_TICKS), args.fuel)
      if (choice == null) return false
      await window.putFuel(itemId(bot, choice.name), null, choice.count)
      fuel[choice.name] = (fuel[choice.name] ?? 0) + choice.count
      fuelTicks += choice.ticks
      return true
    }
    // the furnace's data slots come with the window: wait for them before telling whether it burns
    await waitUntil(bot, () => (window as any).totalProgress != null, 5, signal)
    const burning = (): boolean => (window.fuel ?? 0) > 0
    if (burning()) fuelTicks = Math.round((window.fuel ?? 0) * ((window as any).totalFuel ?? 0))
    if (!burning() && !(await refuel())) throw new SkillError('MISSING_ITEMS', 'nothing to burn', result())

    let lastState = ''
    let still = 0
    while (smelted < count) {
      throwIfAborted(signal, result())
      // a tick at a time: the furnace's progress (its data slots) and its output slot, as the server sends them
      await waitUntil(bot, () => false, 1, signal)
      const out = window.outputItem()
      if (out != null) {
        output = out.name
        if (out.count >= Math.min(out.stackSize, count - smelted) || (window.inputItem() == null && !burning())) {
          const n = out.count
          await window.takeOutput()
          smelted += n
        }
      }
      if (smelted >= count) break
      if (loaded < count && (window.inputItem()?.count ?? 0) < 64) await load()
      // out of fuel: the loaded fuel all burnt (by the ticks), or the furnace stopped with input left
      if (window.inputItem() != null && window.fuelItem() == null && !burning() && (ticks > fuelTicks || still >= 20)) {
        if (!(await refuel())) throw new SkillError('MISSING_ITEMS', 'out of fuel', result())
      }
      const state = `${window.progress ?? 0}|${window.inputItem()?.count ?? 0}|${window.outputItem()?.count ?? 0}|${window.fuel ?? 0}`
      if (state !== lastState) {
        lastState = state
        still = 0
      } else if (++still >= stallTicks) {
        throw new SkillError('TIMEOUT', `the furnace didn't get on for ${stallTicks} ticks`, result())
      }
    }
    // fuel left in the slot comes back
    if (window.fuelItem() != null) await window.takeFuel().catch(() => {})
  } finally {
    bot.off('physicsTick', onTick)
    window.close()
  }

  const res = result()
  if (output != null && (res.items[output] ?? 0) < smelted) {
    throw new SkillError('VERIFY_FAILED', `took ${smelted} ${output} out, the inventory gained ${res.items[output] ?? 0}`, res)
  }
  if (placed && args.pickUpFurnace === true) await collectBlock(bot, { positions: [furnaceBlock.position] }, signal)
  return res
}
