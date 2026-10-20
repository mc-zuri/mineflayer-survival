// The milestone handlers past the overworld's gear, over the nether, stronghold and End skills: the nether (a portal
// built and gone through, blaze rods at a fortress's spawner, pearls by bartering or from endermen, and back), the
// eyes (crafted, thrown and crossed to the stronghold, down to its portal room) and the End (the frame filled and gone
// through, the dragon fought, out by the exit portal). Each skill runs as one foreground task, so the reflexes still
// preempt it (it starts over after).
import type { Bot } from 'mineflayer'
import { BOOKSHELVES, EYES_FOR_FRAME, EYES_TARGET, FOOD_GOAL, eyesForPortal } from './planner/progression'
import type { MilestoneHandler } from './runner'
import { barterForPearls, blockGetter, buildPortal, castPortalAway, preparePortalSite, collectBlazeRods, enterNether, findFortress, huntEndermen, huntable, isAdultPiglin, returnOverworld, wearGold, wearingGold, withNetherSafety } from './nether/skills'
import { travel } from './skills/travel'
import { dayPhase } from './planner/schedule'
import { findLavaSources, isLavaSource, lavaPools } from './nether/portal'
import { obsidianFromLava, refillWater } from './nether/obsidian'
import { descendTo, ensureSurface, inWater, spiralWaypoints, toShore } from './executor/explore'
import { moveNear } from './skills/gridWalk'
import { tunnelTo } from './skills/tunnel'
import { SkillError, isAbort, isSkillError } from './skills/errors'
import type { ExploreOptions } from './nether/fortress'
import { craftEyes, overland, strongholdToPortalRoom } from './end/strongholdSkills'
import { crossToIsland, enterEnd, fightDragon, gotoNear, isInEnd, leaveEnd, readPortalRoom, rememberGateways, SCAFFOLD_ITEMS, visibleGateways } from './end/skills'
import { towerUp } from './end/skills/world'
import { collectBlock } from './skills/collectBlock'
import { countBookshelves, enchant, enchantGear, findEnchantingTable, offerCostRange } from './skills/enchant'
import { applyBooks } from './skills/anvil'
import { experience, gainLevels } from './skills/xp'
import { knownFarmableSpawners, nearestXpFarm } from './skills/spawnerFarm'
import { BREEDING_FOOD, breedAnimals, gatherHerd, isAdult, releaseAnimals } from './skills/husbandry'
import { makeWaterHole, plantSugarCane } from './skills/caneFarm'
import { carvePumpkin, wearPumpkin } from './skills/pumpkin'
import { herdPen, inPen, leadIntoPen, type PenPlan } from './skills/pen'
import { TRIP_KIT, kitSpares, stashTripKit } from './skills/tripKit'
import { pickupDrops } from './skills/pickupDrops'
import { countItems, waitTicks } from './skills/util'
import { normalizeDimension, type WorldMemory } from './core/memory'
import { TaskError } from './core/errors'
import { FARM_PLOTS } from './core/crops'
import { findFarmSite, knownFarms, plantFarm, rememberFarm, SEED_OF } from './skills/farm'
import { describeRequest, ownedInventory, type Executor } from './executor/executor'
import { heldFor, type ObtainRequest } from './planner/obtain'
import type { Inventory } from './core/inventory'
import { Vec3 } from 'vec3'
import { findBlocks } from './core/findBlocks'
import { nearestBiomeSpot, pearlLeg } from './nether/ground'
import { endermenFromCover, forgetCover } from './nether/endermanCover'
import { NetherBiomeSource } from './worldgen/netherBiomes'
import { ruinedPortalCandidates } from './worldgen/placement'
import type { Seed } from './worldgen/random'
import { excludedSpawner, levelSeed, unreachableSpawners } from './nether/fortressSkills'

const inNether = (bot: Bot): boolean => normalizeDimension(bot.game?.dimension) === 'the_nether'

/** rods and pearls still wanted for EYES_TARGET eyes (each rod is 2 powder, an eye a pearl and a powder) */
export function netherNeeds (inv: { count: (name: string) => number }): { rods: number, pearls: number } {
  const eyes = inv.count('ender_eye')
  const powder = inv.count('blaze_powder') + 2 * inv.count('blaze_rod')
  const wanted = Math.max(0, EYES_TARGET - eyes)
  return { rods: Math.max(0, Math.ceil((wanted - powder) / 2)), pearls: Math.max(0, wanted - inv.count('ender_pearl')) }
}

/** the point of interest where the bot's herd was let out */
export const HERD = 'herd'

/**
 * What the enchanting's room in the bag keeps (a forced makeRoom throws the rest it must): the herd's wheat, the
 * shelves' canes, paper, leather, books and wood, the table's lapis and the anvil's iron (the 40 iron thrown for room
 * to kill the herd's cows left the anvil with 'no plan', 26.3), the table itself and its makings (thrown, and the
 * gear's enchanting failed at 'can't craft 1 enchanting_table')
 */
export const ENCHANTING_KEEP: Record<string, number> = { wheat: 64, wheat_seeds: 64, sugar_cane: 256, paper: 256, leather: 64, book: 64, bookshelf: 64, oak_log: 64, oak_planks: 64, lapis_lazuli: 64, iron_ingot: 31, iron_block: 3, enchanting_table: 1, anvil: 1, diamond: 3, obsidian: 4 }

/**
 * Room in the bag for the enchanting's work, what it takes kept (ENCHANTING_KEEP); a bag that can't be made room in
 * (INVENTORY_FULL: nothing left the makeRoom may throw or store) is gone on with, the work trying as it is
 */
async function enchantingRoom (executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  await executor.makeRoom?.(ENCHANTING_KEEP, signal, true)?.catch(err => {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`enchanting: no room: ${(err as Error).message}`)
  })
}

/** the herd pen's sizes tried, biggest first (cells across, the ring included) */
export const PEN_SIZES = [9, 7, 5]
/** tries at a pen of a size: the fences got once, a placement failed tried again */
export const PEN_TRIES = 3

/** ticks the enchanting milestone may spend growing its herd for the books' leather (lockstep: days of game time) */
export const HERD_BUDGET_TICKS = 150000
/** a wait between the herd's chores, by the herd */
export const HERD_CHORE_TICKS = 3000

/**
 * The herd's next chore for `want` leather: kill the surplus adults when they (beyond the breeders) cover the leather
 * still wanted, else breed (the cows, the wheat and the cooldown permitting) and wait for the calves to grow
 * (24000 ticks, AgeableMob.BABY_START_AGE)
 */
export function herdChore (state: { leather: number, want: number, adults: number, calves: number, wheat: number, timeUp?: boolean }): 'done' | 'kill' | 'breed' | 'grow' {
  const needed = state.want - state.leather
  if (needed <= 0) return 'done'
  if (state.adults - BREEDERS_KEPT >= needed) return 'kill'
  // the wheat gone with calves still growing: they're waited for first (killing the herd then left 14 calves and
  // 8 leather of 46, 26.3); the farm's next wheat may come meanwhile
  if (state.wheat < 2 && state.timeUp !== true && state.calves > 0) return 'grow'
  // no more breeding (the wheat gone, the time up): the surplus the herd has is what there is
  if ((state.wheat < 2 || state.timeUp === true) && state.adults > BREEDERS_KEPT) return 'kill'
  if (state.wheat < 2 || state.timeUp === true) return 'done'
  return 'breed'
}

/**
 * Leather from the bot's own herd until `want` are held or HERD_BUDGET_TICKS are gone: every pair bred as its cooldown
 * ends, the calves waited for by the herd, the wheat farm harvested for their food (not baked), and the
 * surplus adults killed once they cover what's wanted (two kept to breed on)
 */
export async function leatherFromHerd (bot: Bot, executor: Executor, want: number, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  const start = executor.tasks.tick
  const home = executor.memory.getPois(HERD, { dimension: 'overworld', near: bot.entity.position })[0]
  let at = home != null ? new Vec3(home.x, home.y, home.z) : bot.entity.position.clone()
  // the herd shut in a pen by home (cows wander: a herd of 8 let out was 5 to 8 by home over 150000 ticks, its calves
  // gone off), the pen built or the one remembered; the herd left loose and gathered when there's none
  let pen: PenPlan | null = null
  // the biggest pen the ground near home takes (a hillside home had no ground for 9 across, 26.3 seed 2)
  // (the fences and the gate are got here, out of the pen's task: an obtain inside it queued its 'make room' task
  // behind the pen's own and both waited on each other for 300000 ticks, 26.3)
  sizes: for (const size of PEN_SIZES) {
    let obtained = false
    for (let round = 0; round < PEN_TRIES; round++) {
      let needs: Array<{ item: string, count: number }> | null = null
      try {
        const r = await executor.task('the herd pen', async (s) => await herdPen(bot, {
          home: at,
          memory: executor.memory,
          obtain: async (reqs) => { needs = reqs; throw new TaskError('MISSING_ITEMS', `the pen takes ${reqs.map(q => `${q.count} ${q.item}`).join(', ')}`) },
          mob: 'cow',
          size
        }, s), signal)
        pen = r.pen
        at = pen.center.clone()
        log(`herd: the pen at ${pen.center.toString()} (${pen.size} across)${r.built ? ' built' : ''}, ${r.inside} cows in`)
        break sizes
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        if (needs != null && !obtained) {
          obtained = true
          const want: Array<{ item: string, count: number }> = needs
          await executor.obtain(want, signal).catch(e => { if (signal.aborted || TaskError.is(e, 'DIED')) throw e; log(`herd: no fences: ${(e as Error).message}`) })
          continue
        }
        log(`herd: no pen of ${size}: ${(err as Error).message}`)
        // a block not placed (a cow in the way, the bot's own box in the gate's cell: the gate refused 3 times, 26.3)
        // or the pen not as planned: tried again, its ring kept as far as it got (planPen takes its fences)
        if (/CANNOT_PLACE|VERIFY_FAILED/.test((err as Error).message) && round < PEN_TRIES - 1) continue
        if (!/no ground/.test((err as Error).message)) break sizes
        break
      }
    }
  }
  // the herd: the cows in the pen and those about it still to be led in (counting the pen's alone, a pen built 20
  // blocks off home counted 0 cows of 8, and the herd was given up on with its wheat gone, 26.3)
  const near = (e: any): boolean => (pen != null && inPen(pen, e.position)) || e.position.distanceTo(at) <= (pen != null ? 48 : 96)
  let lastLine = ''
  for (;;) {
    if (signal.aborted) throw signal.reason
    // back to the herd for its chores, up on its ground (the levels' mining between takes the bot off: 120 blocks off
    // and 60 down, or 14 under it in a cave, the herd out of reach and never bred, on 26.3)
    if (Math.hypot(bot.entity.position.x - at.x, bot.entity.position.z - at.z) > 12 || Math.abs(bot.entity.position.y - at.y) > 4) {
      await executor.task('back to the herd', async (s) => await overland(bot, { target: at, range: 4 }, s), signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`herd: no way back: ${(err as Error).message}`)
      })
    }
    const cows = Object.values(bot.entities).filter(e => (e.name === 'cow' || e.name === 'mooshroom') && near(e))
    const state = { leather: countItems(bot, 'leather'), want, adults: cows.filter(e => isAdult(bot, e)).length, calves: cows.filter(e => !isAdult(bot, e)).length, wheat: countItems(bot, 'wheat'), timeUp: executor.tasks.tick - start > HERD_BUDGET_TICKS }
    const chore = herdChore(state)
    const line = `herd: ${chore} (${state.adults} cows, ${state.calves} calves, ${state.leather} of ${want} leather, ${state.wheat} wheat)`
    if (line !== lastLine) { log(line); lastLine = line }
    if (chore === 'done' || executor.tasks.tick - start > HERD_BUDGET_TICKS * 1.5) {
      log(`herd: ${state.leather} leather of ${want} (${state.adults} cows, ${state.calves} calves) after ${executor.tasks.tick - start} ticks`)
      return state.leather
    }
    if (chore === 'grow') {
      await harvestGrownFarms(bot, executor, signal, log, false).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
      await executor.task('wait for the calves', async (s) => { await waitTicks(bot, HERD_CHORE_TICKS, s) }, signal)
      continue
    }
    if (chore === 'kill') {
      // room for the leather and the beef first (a full bag left the drops on the ground: 'hunt killed the cow drops
      // {}' over and over, the leather short of the shelves, 26.3)
      if ((bot.inventory.emptySlotCount?.() ?? 9) < 2) await enchantingRoom(executor, signal, log)
      await executor.obtain([{ item: 'leather', count: state.leather + 1 }], signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`herd: no leather: ${(err as Error).message}`)
      })
      continue
    }
    // the farm's wheat for the herd, the strays brought home (cows wander: the herd of 8 let out was 5 to 8 by home
    // over 150000 ticks, its calves gone off), and the pairs ready
    await harvestGrownFarms(bot, executor, signal, log, false).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
    const strays = pen == null ? 0 : Object.values(bot.entities).filter(e => e.name === 'cow' && !inPen(pen as PenPlan, e.position) && e.position.distanceTo(at) <= 32).length
    if (pen != null && strays > 0 && countItems(bot, 'wheat') > 0) {
      await executor.task('the herd into its pen', async (s) => await leadIntoPen(bot, pen as PenPlan, { mob: 'cow' }, s), signal).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
    } else if (pen == null) {
      await executor.task('gather the herd', async (s) => await gatherHerd(bot, at, { mob: 'cow' }, s), signal).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
    }
    if (countItems(bot, 'wheat') >= 2 && state.adults >= 2) {
      await executor.task('breed the cows', async (s) => await breedAnimals(bot, { mob: 'cow', pairs: Math.floor(state.adults / 2), radius: 48 }, s), signal)
        .then(r => log(`herd: ${r.fed} fed (${state.adults} cows, ${state.calves} calves, ${state.leather} leather of ${want})`))
        .catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
    }
    // the calves grow meanwhile, the bot by the herd (the levels' mining between dug it into a pit under the herd it
    // never got out of, 140000 ticks on one coal ore, on 26.3: the levels are the enchanting's own after)
    await executor.task('wait for the calves', async (s) => { await waitTicks(bot, HERD_CHORE_TICKS, s) }, signal)
  }
}

/** books kept out of the shelves, to enchant and put on the gear at an anvil */
export const BOOKS_KEPT = 1

/** adult cows kept to breed when the rest are killed for leather */
export const BREEDERS_KEPT = 2

/**
 * The shelves the leather at hand makes books for (3 books a shelf, a book a leather; the table's book first, and
 * BOOKS_KEPT for the anvil): the leather, books and shelves held, and an adult cow's leather each beyond BREEDERS_KEPT, plus the shelves round the
 * table already; at most BOOKSHELVES
 */
export function shelvesForLeather (inv: { count: (name: string) => number }, adultCows: number, around = 0, reserve = BOOKS_KEPT): number {
  const books = inv.count('book') + inv.count('leather') + Math.max(0, adultCows - BREEDERS_KEPT) - (inv.count('enchanting_table') > 0 || around > 0 ? 0 : 1) - reserve
  return Math.min(BOOKSHELVES, around + inv.count('bookshelf') + Math.max(0, Math.floor(books / 3)))
}

/**
 * The shelves the paper at hand makes books for (3 a book: the paper and the sugar cane held; the table's book first,
 * and BOOKS_KEPT), plus the shelves held and round the table; at most BOOKSHELVES
 */
export function shelvesForPaper (inv: { count: (name: string) => number }, around = 0, reserve = BOOKS_KEPT): number {
  const books = inv.count('book') + Math.floor((inv.count('paper') + inv.count('sugar_cane')) / 3) - (inv.count('enchanting_table') > 0 || around > 0 ? 0 : 1) - reserve
  return Math.min(BOOKSHELVES, around + inv.count('bookshelf') + Math.max(0, Math.floor(books / 3)))
}

/** ticks the enchanting milestone's bookshelves may cost (the plan's estimate): a day's work */
export const SHELF_BUDGET_TICKS = 24000

/**
 * The most bookshelves (of `max`, in steps of 3: a shelf is 3 books) whose plan costs `budget` ticks or less, 0 when
 * even 3 cost more: the 15 of a level-30 table are 135 sugar canes and 45 cows' leather, which a world often hasn't got
 * near (seed 2: 4 canes within 96 blocks of the base), and a table with fewer still enchants, at lower levels
 */
export function shelvesWithin (cost: (shelves: number) => number | null, budget: number, max = BOOKSHELVES): number {
  for (let n = max; n > 0; n -= 3) {
    const c = cost(n)
    if (c != null && c <= budget) return n
  }
  return 0
}

/**
 * The enchanting milestone: the table and the lapis (its goals), then the bookshelves the world gives within
 * SHELF_BUDGET_TICKS (planned again with what the first try found: a source explored for in vain costs more after),
 * then the table set up with those and the gear enchanted
 */
/** the kept animals' spawn eggs and the canes a farm is planted with */
export const KEPT_ANIMAL_EGGS = ['cow_spawn_egg', 'mooshroom_spawn_egg', 'sheep_spawn_egg', 'pig_spawn_egg', 'chicken_spawn_egg', 'rabbit_spawn_egg']
export const CANE_FARM_CANES = 8

/**
 * The renewable materials of the enchanting by the base: animals let out of the eggs held and bred with their food
 * (the leather of the books), and a cane farm by water (their paper). None of it stops the milestone: what fails is
 * logged and the materials come from elsewhere.
 */
export async function keepFarms (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const tryIt = async (what: string, fn: (s: AbortSignal) => Promise<string>): Promise<void> => {
    try {
      log(`${what}: ${await executor.task(what, fn, signal)}`)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`${what}: ${(err as Error).message}`)
    }
  }
  for (const egg of KEPT_ANIMAL_EGGS) {
    if (countItems(bot, egg) > 0) {
      // where the herd lives: its chores are done from there
      executor.memory.addPoi(HERD, bot.entity.position.floored(), normalizeDimension(bot.game?.dimension), egg.replace('_spawn_egg', ''))
      await tryIt(`let out the ${egg.replace('_spawn_egg', '')}s`, async (s) => `${await releaseAnimals(bot, { egg }, s)} let out`)
    }
  }
  for (const mob of ['cow', 'mooshroom', 'sheep', 'pig'] as const) {
    if (!BREEDING_FOOD[mob].some(f => countItems(bot, f) >= 2)) continue
    if (Object.values(bot.entities).filter(e => e.name === mob && e.position.distanceTo(bot.entity.position) <= 24).length < 2) continue
    await tryIt(`breed the ${mob}s`, async (s) => { const r = await breedAnimals(bot, { mob }, s); return `${r.fed} fed, ${r.pairs} pairs` })
  }
  if (countItems(bot, 'sugar_cane') >= CANE_FARM_CANES && executor.memory.getPois('cane_farm').length === 0) {
    await tryIt('plant a cane farm', async (s) => { const r = await plantSugarCane(bot, { count: CANE_FARM_CANES, memory: executor.memory }, s); return `${r.planted.length} canes, ${r.water.length} water holes` })
  }
}

/** enchanted books made at the table from the levels left after the gear, put on the gear at an anvil (at most) */
export const BOOKS_TO_ENCHANT = 3

/**
 * After the gear: books enchanted with the levels and lapis left, an anvil got (its iron) and the books put on the
 * gear, and the gear still plain enchanted again: the second round of the enchanting
 */
export async function enchantBooksAndApply (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  // the book kept out of the shelves (BOOKS_KEPT), made from its leather and paper now
  if (countItems(bot, 'book') === 0 && countItems(bot, 'lapis_lazuli') > 0 && experience(bot).level >= 1) {
    await executor.obtain([{ item: 'book', count: BOOKS_KEPT }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`enchanting: no book to enchant: ${(err as Error).message}`)
    })
  }
  for (let i = 0; i < BOOKS_TO_ENCHANT && countItems(bot, 'book') > 0 && countItems(bot, 'lapis_lazuli') > 0 && experience(bot).level >= 1; i++) {
    try {
      const r = await executor.task('enchant a book', async (s) => await enchant(bot, { item: 'book', memory: executor.memory }, s), signal)
      log(`enchanting: a book with ${r.enchants.map(e => `${e.name} ${e.lvl}`).join(', ')}`)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`enchanting: no book: ${(err as Error).message}`)
      break
    }
  }
  if (countItems(bot, 'enchanted_book') === 0) return
  try {
    if (countItems(bot, 'anvil') === 0 && bot.findBlock?.({ matching: (b: any) => /anvil$/.test(b.name), maxDistance: 16 }) == null) await executor.obtain([{ item: 'anvil', count: 1 }], signal)
    const applied = await executor.task('the books on the gear', async (s) => await applyBooks(bot, {}, s), signal)
    log(`anvil: ${applied.map(a => `${a.item} (${a.cost} levels)`).join(', ') || 'nothing took a book'}`)
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`anvil: ${(err as Error).message}`)
  }
  // the gear still plain, at the table again
  try {
    await executor.task('enchant the gear again', async (s) => await enchantGear(bot, { executor, signal: s, targetLevel: 0, bookshelves: 0 }), signal)
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`enchanting again: ${(err as Error).message}`)
  }
}

/** levels to go from which the enchanting builds an experience farm at a spawner it knows */
export const XP_FARM_WORTH = 10
/** how far off a spawner may be for that */
export const XP_FARM_TRIP = 256

/** ticks the enchanting may spend on the top offer's levels (lockstep: days of game time) */
export const LEVELS_BUDGET_TICKS = 72000
/** a tunnel leg's length for the levels' ores when none is near */
export const LEVELS_LEG = 48
/** where the levels' ores are looked for when the near ones are gone: the deep ores (redstone, lapis, diamond) */
export const LEVELS_DEPTH = -30

/**
 * Levels up to `level` within LEVELS_BUDGET_TICKS: gainLevels (the experience farm, the ores, the smelting, the mobs
 * within 48 blocks), and when none is left near, down to LEVELS_DEPTH for the deep ores, then tunnel legs of
 * LEVELS_LEG blocks along the axes in turn to more; resolves the level got
 */
export async function levelsToward (bot: Bot, executor: Executor, level: number, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  const start = executor.tasks.tick
  let leg = 0
  // many levels to go and a zombie spawner known with no farm yet: the experience farm built first (the epochs'),
  // its levels a tenth of the ores' ticks (121000 ticks of ore mining for 13 of 24 levels, 26.3)
  const dimension = normalizeDimension(bot.game?.dimension)
  if (level - experience(bot).level >= XP_FARM_WORTH && nearestXpFarm(executor.memory, bot.entity.position, dimension) == null &&
    knownFarmableSpawners(executor.memory, bot.entity.position, dimension).some(sp => sp.pos.distanceTo(bot.entity.position) <= XP_FARM_TRIP)) {
    log(`levels: ${experience(bot).level} of ${level}: an xp farm at the spawner first`)
    const { xpFarmEpochHandler } = await import('./epochs')
    await xpFarmEpochHandler({ bot, executor, signal, log, milestone: null as any, state: null as any }).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`levels: no xp farm: ${(err as Error).message}`)
    })
  }
  while (experience(bot).level < level && executor.tasks.tick - start < LEVELS_BUDGET_TICKS) {
    if (signal.aborted) throw signal.reason
    const before = experience(bot).level
    try {
      // (the experience farm first, when the bot has built one: the epochs' xp farm)
      const farm = nearestXpFarm(executor.memory, bot.entity.position, normalizeDimension(bot.game?.dimension)) ?? undefined
      await executor.task('levels', async (s) => await gainLevels(bot, { level, range: 48, maxTicks: 12000, farm }, s), signal)
      // (done with no level gained: nothing more to have from it)
      if (experience(bot).level <= before) break
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      if (!/NOT_FOUND/.test((err as Error).message)) continue
      if (bot.entity.position.y > LEVELS_DEPTH + 10) {
        log(`levels: ${experience(bot).level} of ${level}: down to y ${LEVELS_DEPTH} for the deep ores`)
        await executor.task('down for the ores', async (s) => await descendTo(bot, LEVELS_DEPTH, {}, s), signal).catch(e => { if (signal.aborted || TaskError.is(e, 'DIED')) throw e })
        continue
      }
      const dir = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)][leg++ % 4]
      const to = bot.entity.position.floored().plus(dir.scaled(LEVELS_LEG))
      log(`levels: ${experience(bot).level} of ${level}: a tunnel on to ${to.toString()} for ores`)
      await executor.task('a tunnel for ores', async (s) => await tunnelTo(bot, { target: to, range: 2, maxSteps: LEVELS_LEG * 2 }, s), signal).catch(e => { if (signal.aborted || TaskError.is(e, 'DIED')) throw e })
    }
  }
  log(`levels: ${experience(bot).level} of ${level} after ${executor.tasks.tick - start} ticks`)
  return experience(bot).level
}

export const enchantingHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  await keepFarms(bot, executor, signal, log)
  // the wheat farm the herd is fed from (seeds held, water near)
  await startFarm(bot, executor, signal, log).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
  // the table's 4 obsidian made from lava with the water bucket when there's no table yet (the planner only mines
  // obsidian that's there: a 26.3 whole-game run explored for some for 200000 ticks)
  if (countItems(bot, 'enchanting_table') === 0 && findEnchantingTable(bot, { memory: executor.memory }) == null && countItems(bot, 'obsidian') < TABLE_OBSIDIAN) {
    await obsidianFromPools(bot, executor, TABLE_OBSIDIAN, signal, log)
  }
  await executor.obtain(milestone.goals(state), signal)
  // the herd grown for the 15 shelves' books (45, a leather each) and the anvil's book, when the bot keeps cows
  const herd = executor.memory.getPois(HERD, { dimension: 'overworld', near: bot.entity.position })[0]
  const kept = Object.values(bot.entities).filter(e => e.name === 'cow' && e.position.distanceTo(bot.entity.position) <= 48).length
  if (kept >= 2 || herd != null) {
    const books = 3 * BOOKSHELVES + BOOKS_KEPT
    await leatherFromHerd(bot, executor, Math.max(0, books - countItems(bot, 'book') - 3 * countItems(bot, 'bookshelf')), signal, log)
  }
  const table = findEnchantingTable(bot, { memory: executor.memory, maxDistance: 16 })
  const around = table != null ? countBookshelves(pos => bot.blockAt(pos) as any, table.position) : 0
  // as many shelves as the leather at hand makes books for: what's held and the adult cows about (two kept to breed);
  // the plan's estimate for 44 cows sent the bot exploring for cows and pigs 100 blocks out for 20000 ticks (26.3)
  const cows = Object.values(bot.entities).filter(e => (e.name === 'cow' || e.name === 'mooshroom') && isAdult(bot, e) && e.position.distanceTo(bot.entity.position) <= 32).length
  // (and the paper: the leather of 41 books with the canes of 21 had the shelves' plan fail whole, 'short of 84
  // sugar_cane', and none made, 26.3)
  const cap = Math.min(shelvesForLeather({ count: (n: string) => countItems(bot, n) }, cows, around), shelvesForPaper({ count: (n: string) => countItems(bot, n) }, around))
  // room for the shelves' crafts, what they take kept (the stage's bag full of cobblestone, coal and raw meat failed
  // the paper's craft five times, 'the inventory is full', and the milestone was left out, 26.3)
  await enchantingRoom(executor, signal, log)
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = countItems(bot, 'bookshelf')
    const want = shelvesWithin(n => {
      if (n <= held + around) return 0
      const plan = executor.plan([{ item: 'bookshelf', count: n - around }])
      return plan.ok ? plan.cost : null
    }, SHELF_BUDGET_TICKS, cap)
    if (want <= held + around) break
    log(`enchanting: ${want} bookshelves (${held + around} so far)`)
    try {
      await executor.obtain([{ item: 'bookshelf', count: want - around }], signal)
      break
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`enchanting: ${countItems(bot, 'bookshelf') + around} bookshelves: ${(err as Error).message}`)
    }
  }
  const shelves = Math.min(BOOKSHELVES, countItems(bot, 'bookshelf') + around)
  // the levels of the table's top offer first (30 with 15 shelves), the deep ores and the tunnels' after the near
  // ones run out (gainLevels alone stopped at 26 of 29: 'no ore, smelt, kill left within 32 blocks', 26.3)
  const workplace = bot.entity.position.clone()
  await levelsToward(bot, executor, offerCostRange(2, shelves).max, signal, log)
  // back to the table (the one remembered), or where the bot was to set it up, from the ores' tunnels
  const poi = executor.memory.getPois('enchanting_table', { dimension: 'overworld', near: workplace })[0]
  const tableAt = poi != null ? new Vec3(poi.x, poi.y, poi.z) : workplace
  if (tableAt.distanceTo(bot.entity.position) > 8) {
    await executor.task('back to the table', async (s) => await overland(bot, { target: tableAt, range: 3 }, s), signal).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
  }
  // room in the bag to take the armor off for the table (a full bag kept it on: 'no unenchanted diamond_chestplate')
  // (forced: the junk alone left the bag full, and the armor stayed on unenchanted again, 26.3)
  await enchantingRoom(executor, signal, log)
  await executor.task('enchant the gear', async (s) => await enchantGear(bot, { executor, signal: s, bookshelves: shelves }), signal)
  await enchantBooksAndApply(bot, executor, signal, log)
}

/**
 * The axis walks a fortress search takes in turn, without the seed: findFortress's first (along the nearer axis, away
 * from 0), then the other axis both ways, then back the first way
 */
export function fortressRoutes (from: { x: number, z: number }): Array<Required<Pick<ExploreOptions, 'axis' | 'direction'>>> {
  const axis = Math.abs(from.z) <= Math.abs(from.x) ? 'x' : 'z'
  const other = axis === 'x' ? 'z' : 'x'
  const away = (a: 'x' | 'z'): 1 | -1 => (a === 'x' ? from.x : from.z) < 0 ? -1 : 1
  return [{ axis, direction: away(axis) }, { axis: other, direction: away(other) }, { axis: other, direction: -away(other) as 1 | -1 }, { axis, direction: -away(axis) as 1 | -1 }]
}

/**
 * The next fortress search's walk: the routes in turn, by the searches counted in memory (the 'fortress_search' point's
 * note, counted up here, saved with the rest), so a search that found none doesn't walk the same line again
 */
export function fortressRoute (memory: WorldMemory, from: Vec3): ExploreOptions {
  const routes = fortressRoutes(from)
  const done = Number(/^searches=(\d+)/.exec(memory.getPois('fortress_search', { dimension: 'the_nether' })[0]?.note ?? '')?.[1] ?? 0)
  const route = routes[done % routes.length]
  memory.addPoi('fortress_search', { x: 0, y: 0, z: 0 }, 'the_nether', `searches=${done + 1};last=${route.direction > 0 ? '+' : '-'}${route.axis}`)
  return route
}

/** the pools of PORTAL_LAVA lava sources or more in the loaded chunks (96 blocks round), nearest first: their middles */
export function nearestLavaPools (bot: Bot): Array<{ x: number, y: number, z: number }> {
  const id = bot.registry.blocksByName.lava?.id
  if (id == null || typeof bot.findBlocks !== 'function') return []
  const sources = findBlocks(bot, { matching: id, maxDistance: 96, count: 4096 })
    .filter(p => isLavaSource({ name: 'lava', properties: (bot.blockAt(p) as any)?.getProperties?.() } as any))
    .map(p => ({ x: p.x, y: p.y, z: p.z }))
  return lavaPools(sources, bot.entity.position, PORTAL_LAVA).map(p => p.center)
}

/** the nearest pool of PORTAL_LAVA lava sources or more in the loaded chunks (96 blocks round), its middle */
export function nearestLavaPool (bot: Bot): { x: number, y: number, z: number } | null {
  const id = bot.registry.blocksByName.lava?.id
  if (id == null || typeof bot.findBlocks !== 'function') return null
  const sources = findBlocks(bot, { matching: id, maxDistance: 96, count: 4096 })
    .filter(p => isLavaSource({ name: 'lava', properties: (bot.blockAt(p) as any)?.getProperties?.() } as any))
    .map(p => ({ x: p.x, y: p.y, z: p.z }))
  return lavaPools(sources, bot.entity.position, PORTAL_LAVA)[0]?.center ?? null
}

/**
 * A nether portal by the bot's means: placed from 10 obsidian carried; else cast by a lava pool of the loaded chunks,
 * the nearest first, each gone to (the caves' lakes too) and tried: the cast where its mould has room, else obsidian
 * made from the pool's shore and placed up on the surface; the pools tried are remembered (lava_tried) and passed
 * over after; else the obsidian got by the planner. (A cave's lake on 26.3 seed 2 had no room for the mould and no
 * shore, and the milestone failed on it five times.)
 */
export async function buildAPortal (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const count = (name: string): number => countItems(bot, name)
  const placeFromObsidian = async (): Promise<void> => {
    await executor.task('up to the surface', async (s) => await ensureSurface(bot, s), signal)
    try {
      await executor.task('build a nether portal', async (s) => await buildPortal(bot, { method: 'obsidian' }, s), signal)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED') || !/no flat clear ground/.test((err as Error).message)) throw err
      // no flat clear ground near: a site made where the bot is
      log('a portal frame: no flat clear ground: a site dug out here')
      await executor.task('build a nether portal', async (s) => {
        const site = await preparePortalSite(bot, s)
        return await buildPortal(bot, { method: 'obsidian', origin: site.origin, axis: site.axis }, s)
      }, signal)
    }
  }
  // the flint and steel to light it got first (the iron for it mined: a 26.3 whole game built its frame from the
  // obsidian it mined, then failed the milestone 'no iron ingot for flint and steel')
  if (count('flint_and_steel') === 0 && count('fire_charge') === 0) {
    await executor.obtain([{ item: 'flint_and_steel', count: 1 }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`a portal frame: flint and steel: ${(err as Error).message}`)
    })
  }
  if (count('obsidian') >= PORTAL_OBSIDIAN) return await placeFromObsidian()
  // a bucket and its water first (a death lost the kit's: every pool after was 'no water bucket to make obsidian with')
  if (count('water_bucket') === 0 && count('bucket') === 0) {
    await executor.obtain([{ item: 'bucket', count: 1 }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`a portal frame: a bucket: ${(err as Error).message}`)
    })
  }
  await refillWater(bot, signal)
  // a diamond pickaxe for the obsidian (a death lost the kit's: 'no diamond pickaxe to mine obsidian with' at every
  // pool after, 26.3)
  if (countItems(bot, ['diamond_pickaxe', 'netherite_pickaxe']) === 0) {
    await executor.obtain([{ item: 'diamond_pickaxe', count: 1 }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`a portal frame: a diamond pickaxe: ${(err as Error).message}`)
    })
  }
  // the obsidian in the world first (in sight, a ruined portal's): no lava worked for what's there
  await naturalObsidian(bot, executor, PORTAL_OBSIDIAN, signal, log)
  if (count('obsidian') >= PORTAL_OBSIDIAN) return await placeFromObsidian()
  const tries = (p: { x: number, y: number, z: number }): number => {
    const poi = executor.memory.getPois('lava_tried', { dimension: 'overworld' }).find(t => Math.hypot(t.x - p.x, t.z - p.z) < 16 && Math.abs(t.y - p.y) < 16)
    return poi == null ? 0 : Number(/tries=(\d+)/.exec(poi.note ?? '')?.[1] ?? 1)
  }
  for (let depth = 0; depth < 2 + PORTAL_LEGS; depth++) {
    if (depth >= 2) {
      // no pool left within 96 blocks to try: a leg of PORTAL_LEG blocks along the next of the surface walks, then
      // the pools there (the run stopped on five instant 'no lava found's after its pools were tried: 26.3 seed 2)
      if (nearestLavaPools(bot).some(p => tries(p) < POOL_TRIES)) break
      const route = fortressRoute(executor.memory, bot.entity.position)
      const dir = route.axis === 'x' ? new Vec3(route.direction as number, 0, 0) : new Vec3(0, 0, route.direction as number)
      const to = bot.entity.position.plus(dir.scaled(PORTAL_LEG))
      log(`a portal frame: no lava left to try near: on to ${to.floored().toString()}`)
      await executor.task('up to the surface', async (s) => await ensureSurface(bot, s), signal).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
      await executor.task('a leg for lava', async (s) => await travel(bot, { target: to, range: 8 }, s), signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`a portal frame: the leg: ${(err as Error).message}`)
      })
    }
    if ((depth === 1 || depth >= 2) && bot.entity.position.y >= DEEP_LAVA_Y + 10) {
      // the deep caves' lava next (the lava lakes under y -54 are everywhere, their floors a shore to pour on)
      log(`a portal frame: down to y ${DEEP_LAVA_Y} for the deep lava`)
      await executor.task('down to the deep lava', async (s) => await descendTo(bot, DEEP_LAVA_Y, {}, s), signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`down: ${(err as Error).message}`)
      })
    }
  // obsidian there already in the loaded chunks (where the caves' lava met their water, a ruined portal): mined
  // (none with lava against it: the bot mining a lake's lid falls into the lava under it)
  const lavaNext = (p: Vec3): boolean => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]].some(([dx, dy, dz]) => bot.blockAt(p.offset(dx, dy, dz))?.name === 'lava')
  const natural = (bot.findBlocks?.({ matching: bot.registry.blocksByName.obsidian.id, maxDistance: 64, count: PORTAL_OBSIDIAN * 4 }) ?? []).filter(p => !lavaNext(p))
  if (natural.length > 0 && natural.length >= PORTAL_OBSIDIAN - count('obsidian')) {
    log(`a portal frame: ${natural.length} obsidian in sight: mining it`)
    try {
      // a block's mining a use of the pickaxe: no stop for a worn one that has them left (TaskInfo.uses)
      await executor.task('mine the obsidian', async (s) => await withNetherSafety(bot, async () => await collectBlock(bot, { positions: natural.slice(0, PORTAL_OBSIDIAN - count('obsidian')), pickup: true, avoidLava: true }, s)), signal, { uses: () => Math.max(0, PORTAL_OBSIDIAN - count('obsidian')) })
      if (count('obsidian') >= PORTAL_OBSIDIAN) return await placeFromObsidian()
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`a portal frame: the obsidian: ${(err as Error).message}`)
    }
  }
  // the pools not tried first, then those tried once (after a death or with a bucket refilled the second goes)
  const pools = nearestLavaPools(bot).map(p => ({ p, n: tries(p) })).filter(t => t.n < POOL_TRIES).sort((a, b) => a.n - b.n).map(t => t.p)
  for (const pool of pools.slice(0, 4)) {
    const at = new Vec3(pool.x, pool.y, pool.z)
    log(`a portal frame: the lava pool at ${pool.x.toFixed(0)} ${pool.y.toFixed(0)} ${pool.z.toFixed(0)}`)
    const before = executor.memory.getPois('lava_tried', { dimension: 'overworld' }).find(t => Math.hypot(t.x - at.x, t.z - at.z) < 16 && Math.abs(t.y - at.y) < 16)
    if (before != null) executor.memory.removePoi('lava_tried', new Vec3(before.x, before.y, before.z))
    executor.memory.addPoi('lava_tried', at.floored(), 'overworld', `tries=${tries(pool) + 1}`)
    try {
      await executor.task('to the lava', async (s) => await moveNear(bot, at, 5, s).catch(async err => {
        if (isAbort(err)) throw err
        // (a tunnel stops short of the lava, a step from it refused: near enough to work by from 8 blocks, the pool
        // seen from there: 'no safe step' 5 blocks over a 26.3 cave lake ended the pool's try)
        await tunnelTo(bot, { target: at, range: 5 }, s).catch(e => { if (isAbort(e) || bot.entity.position.distanceTo(at) > 8) throw e })
      }), signal)
      try {
        await executor.task('build a nether portal', async (s) => await buildPortal(bot, {}, s), signal)
        return
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED') || !isSkillError(err, 'CANNOT_PLACE')) throw err
        log(`a portal frame: ${(err as Error).message}: obsidian from the lava's shore`)
      }
      try {
        await executor.task('obsidian from the lava', async (s) => await obsidianFromLava(bot, PORTAL_OBSIDIAN, s), signal)
        return await placeFromObsidian()
      } catch (err) {
        // (no diamond pickaxe to mine the obsidian with, or no water: the cast takes neither)
        if (signal.aborted || TaskError.is(err, 'DIED') || !(isSkillError(err, 'NOT_FOUND') || isSkillError(err, 'MISSING_ITEMS'))) throw err
        log(`a portal frame: ${(err as Error).message}: the lava carried to a cast away from it`)
      }
      // no shore either: the pool's lava carried in buckets to a cast away from it
      // (the pool's, round its middle: the bot may be off it by now, the obsidian's tries having walked it away, and
      // its own spot had none in 16, 'no cast at … from the 0 lava sources', 26.3)
      const lava = findLavaSources(blockGetter(bot), at, 16).map(p => new Vec3(p.x, p.y, p.z))
      const away = castNearSpot(bot.entity.position, lava)
      if (away != null) {
        // a deep pool: the cast on a site dug in the rock CAST_AWAY blocks off it, the trips for its lava short (a 26.3
        // whole game carried the lava of the deep pools up 120 blocks a trip to the surface, after exploring 20000
        // ticks for the iron of more buckets, some 20000 to 50000 ticks a pool, and it failed)
        log(`a portal frame: the cast ${CAST_AWAY} blocks off the deep pool, at ${away.floored().toString()}`)
        // an empty bucket first, within CAST_BUCKET_TICKS (the exploring for its iron took a 26.3 bot 50 blocks off,
        // where the cast had 7 of the pool's sources in sight), then back to the spot by the pool
        if (count('bucket') === 0 && count('lava_bucket') === 0) {
          await withTickBudget(bot, CAST_BUCKET_TICKS, signal, async (s) => await executor.obtain([{ item: 'bucket', count: 1 }], s)).catch(err => {
            if (signal.aborted || TaskError.is(err, 'DIED')) throw err
            log(`buckets: ${(err as Error).message}`)
          })
        }
        await executor.task('off the lava', async (s) => await tunnelTo(bot, { target: away, range: 2 }, s), signal).catch(err => {
          if (signal.aborted || TaskError.is(err, 'DIED')) throw err
          log(`a portal frame: off the lava: ${(err as Error).message}`)
        })
      } else {
        await executor.obtain([{ item: 'bucket', count: LAVA_BUCKETS }], signal).catch(err => {
          if (signal.aborted || TaskError.is(err, 'DIED')) throw err
          log(`buckets: ${(err as Error).message}`)
        })
        await executor.task('up to the surface', async (s) => await ensureSurface(bot, s), signal)
      }
      await executor.task('cast a portal', async (s) => await castPortalAway(bot, lava, Math.max(1, countItems(bot, 'bucket')), s), signal)
      return
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`a portal frame at that pool: ${(err as Error).message}`)
    }
  }
  }
  log(`a portal frame: no pool to cast by, ${count('obsidian')} obsidian: getting obsidian`)
  // within OBSIDIAN_OBTAIN_TICKS: the milestone tried again after, its pools and legs anew (an unbounded explore for
  // obsidian went over the ocean for 48000 ticks, 26.3)
  await withTickBudget(bot, OBSIDIAN_OBTAIN_TICKS, signal, async (s) => await executor.obtain([{ item: 'obsidian', count: PORTAL_OBSIDIAN }], s))
  await placeFromObsidian()
}

/**
 * What the nether isn't gone into without (after deaths the bot went in with a stone pickaxe and nothing on, and the
 * piglins killed it by the portal, 26.3): a sword and a chestplate (iron at least, got when missing, as can be), and a
 * golden piece worn (the piglins leave a player with gold on alone: PiglinAi.isWearingGold), crafted from the ingots
 */
export async function netherKit (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const worn = (slot: 'torso'): string | undefined => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name
  const want: Array<{ item: string | string[], count: number, optional?: boolean }> = []
  if (countItems(bot, ['diamond_sword', 'iron_sword', 'netherite_sword']) === 0) want.push({ item: 'iron_sword', count: 1, optional: true })
  if (!/(iron|diamond|netherite)_chestplate/.test(worn('torso') ?? '') && countItems(bot, ['iron_chestplate', 'diamond_chestplate', 'netherite_chestplate']) === 0) want.push({ item: 'iron_chestplate', count: 1, optional: true })
  if (countItems(bot, 'shield') === 0 && bot.inventory.slots[45]?.name !== 'shield') want.push({ item: 'shield', count: 1, optional: true })
  if (want.length > 0) {
    await executor.obtain(want as any, signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`nether kit: ${(err as Error).message}`)
    })
  }
  // a sword at the least, stone if no iron came (a bot gone in with its hands empty died to the magma cubes by the
  // portal three times in a row, 26.3)
  if (countItems(bot, SWORDS) === 0) {
    await executor.obtain([{ item: 'stone_sword', count: 1 }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`nether kit: no sword: ${(err as Error).message}`)
    })
  }
  // the golden boots made now, put on once in (kept on there: goldArmorRequired is the nether's)
  if (!wearingGold(bot) && countItems(bot, GOLD_PIECES) === 0 && countItems(bot, 'gold_ingot') >= 4) {
    await executor.obtain([{ item: 'golden_boots', count: 1 }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`nether kit: no golden boots: ${(err as Error).message}`)
    })
  }
  // what the bot doesn't go in without, gathered (the gold mined, the armor's iron, food) within NETHER_GEAR_TICKS;
  // still short, the milestone fails and is tried again rather than going in bare
  if (inNether(bot)) return
  // the renewable food first, the farm's grown wheat harvested and baked, before any other source of the gate's food
  // is planned (seed 2's kit went exploring for melons and berry bushes, 30000 ticks for none, its farm by the base)
  if (netherGearNeeds(ownedInventory(bot)).some(r => r.unit === 'nutrition')) {
    // (and one sown when there's none yet, for the kits after a death)
    await startFarm(bot, executor, signal, log).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`nether kit: no farm: ${(err as Error).message}`)
    })
    await harvestGrownFarms(bot, executor, signal, log).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`nether kit: the farm: ${(err as Error).message}`)
    })
  }
  const missing = netherGearNeeds(ownedInventory(bot))
  if (missing.length === 0) return
  log(`nether kit: getting ${missing.map(describeRequest).join(', ')} before going in`)
  await withTickBudget(bot, NETHER_GEAR_TICKS, signal, async (s) => await executor.obtain(missing, s)).catch(err => {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`nether kit: ${(err as Error).message}`)
  })
  const still = netherGearNeeds(ownedInventory(bot))
  if (still.length > 0) throw Object.assign(new SkillError('MISSING_ITEMS', `not going into the nether without ${still.map(describeRequest).join(', ')}`), { notReady: true })
}

const GOLD_PIECES = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']

/**
 * the food points the bot goes into the nether with at the least: the blaze nook's fight heals on them (a 26.3 bot in
 * iron with a bow, 64 arrows and 80 points ran out of food in the hall's nook under seed 2's throne at (-277, 77, -159)
 * two runs of three, 3 to 5 rods got; with 120, two of three still, tests/integration/blaze BLAZE_KIT gateIronBow, gate2)
 */
export const NETHER_FOOD_POINTS = 120
/**
 * the arrows the bow goes into the nether with at the least: the blazes are shot from the nook (a full draw of a plain
 * bow takes 3 or so a blaze, the misses lost in the throne, and 8 rods are 16 kills or so; with 16 a 26.3 bot shot 3
 * and was out, then went in among them with its sword and died)
 */
export const NETHER_ARROWS = 64
/** the ticks the gear for the nether may take to get, when it's missing */
export const NETHER_GEAR_TICKS = 48000

/**
 * What the bot doesn't go into the nether without (worn or carried): a sword, an iron helmet, chestplate and leggings or better, a golden
 * piece (or the 4 ingots for boots) for the piglins, a shield, a bow and NETHER_ARROWS, and NETHER_FOOD_POINTS of
 * food. After a death the bot went back
 * in bare, no gold and no armor, and died to the piglins, the blazes or the lava again (26.3).
 */
export function netherGearNeeds (inv: Inventory): ObtainRequest[] {
  const out: ObtainRequest[] = []
  if (inv.countAny(SWORDS.filter(s => s !== 'wooden_sword' && s !== 'golden_sword')) === 0) out.push({ item: 'stone_sword', count: 1 })
  if (inv.countAny(['iron_chestplate', 'diamond_chestplate', 'netherite_chestplate']) === 0) out.push({ item: 'iron_chestplate', count: 1 })
  // and the helmet and leggings (the boots golden): the blazes' fireballs past the shield in the bow's nook burn on, and
  // a 26.3 bot with only the chestplate, a bow, 64 arrows and 120 food points died in the hall's nook under seed 2's
  // throne at (-277, 77, -159) six runs of six; with the helmet and leggings too, alive three of three (BLAZE_KIT gateBow
  // BLAZE_ARROWS=64 BLAZE_FOOD=15, gate2)
  if (inv.countAny(['iron_helmet', 'diamond_helmet', 'netherite_helmet']) === 0) out.push({ item: 'iron_helmet', count: 1 })
  if (inv.countAny(['iron_leggings', 'diamond_leggings', 'netherite_leggings']) === 0) out.push({ item: 'iron_leggings', count: 1 })
  if (inv.countAny(GOLD_PIECES) === 0 && inv.count('gold_ingot') < 4) out.push({ item: 'golden_boots', count: 1 })
  // a shield for the blazes' fireballs (the raw iron smelted for it), and a bow's arrows: a 26.3 bot with neither shield
  // nor arrows left got no rods at the spawner, and starved (blaze2)
  if (inv.count('shield') === 0) out.push({ item: 'shield', count: 1 })
  // a bow and NETHER_ARROWS, a bow carried or not: with a sword alone the blazes of a throne walled in (seed 2's at
  // (-277, 77, -159), the whole game's from its portal) were fought among them, in their spawn volume, and 26.3 bots
  // with a stone sword (the gate's least, nether-26.3-q3's bag) died there 6 runs of 6 for 0 to 1 rods, one in iron with
  // an iron sword got 0 to 1 rods in 16000 ticks; the fight gives such a spawner up now (tests/integration/blaze)
  if (inv.count('bow') === 0) out.push({ item: 'bow', count: 1 })
  if (inv.count('arrow') < NETHER_ARROWS) out.push({ item: 'arrow', count: NETHER_ARROWS })
  const food = heldFor(inv, FOOD_GOAL, { unit: 'nutrition' })
  if (food < NETHER_FOOD_POINTS) out.push({ item: FOOD_GOAL, count: NETHER_FOOD_POINTS, unit: 'nutrition' })
  return out
}

/** the golden piece put on in the nether, when one is held or can be made (the piglins leave such a player alone) */
export async function goldOnInTheNether (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  if (!inNether(bot) || wearingGold(bot) || (countItems(bot, GOLD_PIECES) === 0 && countItems(bot, 'gold_ingot') < 4)) return
  await executor.task('gold on for the piglins', async (s) => await wearGold(bot, s), signal).catch(err => {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`nether: no gold on: ${(err as Error).message}`)
  })
}

/** blocks carried for the nether's bridges and pillars (netherrack mined when fewer than half are held) */
export const NETHER_BLOCKS = 64

/** a lava pool is tried this many times at most (a death or a lost bucket the first time) */
export const POOL_TRIES = 2
/** legs walked for lava when every pool near is tried */
export const PORTAL_LEGS = 3
/** a leg's length */
export const PORTAL_LEG = 128

/** the depth of the deep caves' lava lakes (the aquifers' lava level, y -54 and under) the portal's search goes down to */
export const DEEP_LAVA_Y = -50

/** a pool under this height has its lava cast near it (castNearSpot), not carried up to the surface */
export const CAST_NEAR_Y = 40
/** how far from a deep pool's nearest source its cast is made */
export const CAST_AWAY = 12
/** the ticks an empty bucket for a deep pool's cast may take to make */
export const CAST_BUCKET_TICKS = 8000

/**
 * Where a deep pool's cast goes: CAST_AWAY blocks from its nearest source, on the bot's side of it at the bot's
 * height, so the cast's water doesn't reach the pool (it spreads 7). Null for a pool above CAST_NEAR_Y.
 */
export function castNearSpot (bot: { x: number, y: number, z: number }, lava: ReadonlyArray<{ x: number, y: number, z: number }>): Vec3 | null {
  if (lava.length === 0 || bot.y >= CAST_NEAR_Y) return null
  const cx = lava.reduce((n, p) => n + p.x + 0.5, 0) / lava.length
  const cz = lava.reduce((n, p) => n + p.z + 0.5, 0) / lava.length
  let dx = bot.x - cx
  let dz = bot.z - cz
  const len = Math.hypot(dx, dz)
  if (len < 0.5) { dx = 1; dz = 0 } else { dx /= len; dz /= len }
  // past the farthest source along the way out
  const reach = Math.max(...lava.map(p => (p.x + 0.5 - cx) * dx + (p.z + 0.5 - cz) * dz))
  return new Vec3(Math.floor(cx + dx * (reach + CAST_AWAY)), Math.floor(bot.y), Math.floor(cz + dz * (reach + CAST_AWAY)))
}

/** the empty buckets a cast carried up from far lava takes its lava in, a trip */
export const LAVA_BUCKETS = 5

/** the ticks the last way to a frame's obsidian (the planner's mine of any in the world) may take */
export const OBSIDIAN_OBTAIN_TICKS = 24000

/** a frame's obsidian, and the lava sources to cast one from */
export const PORTAL_OBSIDIAN = 10
export const PORTAL_LAVA = 10

export const netherHandler: MilestoneHandler = async ({ bot, executor, signal, log, seed }) => {
  const count = (name: string): number => countItems(bot, name)
  if (!inNether(bot)) {
    if (executor.memory.getPois('nether_portal', { dimension: 'overworld' }).length === 0) {
      // the frame's makings: 10 lava sources by the bot to cast it from, else 10 obsidian got (the planner's mine
      // step goes to the obsidian of lava met by water): buildPortal casts only from lava within 16 blocks, and the
      // bot that started the nether at the spawn had none near
      await buildAPortal(bot, executor, signal, log)
    }
    // a spare kit by the portal and the respawn point by it (a blaze's death in the nether was the stage lost)
    await leaveTripKit(bot, executor, signal, log)
    await netherKit(bot, executor, signal, log)
    try {
      await executor.task('into the nether', async (s) => await enterNether(bot, { build: false }, s), signal)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED') || inNether(bot)) throw err
      // the portal remembered gone or out of reach: forgotten, and another made the milestone's way (the pools, the
      // dug site, the obsidian), not the bare cast by the bot that failed five times at once, 'no site to cast' (26.3)
      log(`nether: the portal: ${(err as Error).message}: another`)
      for (const poi of executor.memory.getPois('nether_portal', { dimension: 'overworld', near: bot.entity.position })) {
        if (Math.hypot(poi.x - bot.entity.position.x, poi.z - bot.entity.position.z) < 32) executor.memory.removePoi('nether_portal', poi, 'overworld')
      }
      await buildAPortal(bot, executor, signal, log)
      await executor.task('into the nether', async (s) => await enterNether(bot, { build: false }, s), signal)
    }
  }
  await goldOnInTheNether(bot, executor, signal, log)
  await recoverNetherDrops(bot, executor, signal, log)
  const needs = netherNeeds({ count })
  // blocks for the nether's bridges before its long walks (the netherrack about: a path bridged over the lava sea
  // at y 81 ran out of blocks half way, 'no item to place', and the bot fell into the lava, three times on 26.3)
  if (inNether(bot) && countItems(bot, SCAFFOLD_ITEMS) < NETHER_BLOCKS / 2) {
    await executor.obtain([{ item: 'netherrack', count: countItems(bot, 'netherrack') + NETHER_BLOCKS - countItems(bot, SCAFFOLD_ITEMS) }], signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`nether: no netherrack: ${(err as Error).message}`)
    })
  }
  if (needs.rods > 0) {
    log(`blaze rods: ${needs.rods} to get`)
    // the rods wanted fixed before the task (a restart after a reflex read the rods held again and wanted 8 more: a
    // 26.3 bot fought at the spawner with 43 rods until a blaze killed it)
    const rods = count('blaze_rod') + needs.rods
    // a spawner the bot finds no way to is left for the fortress's other (they often have two), else another
    // fortress (a 26.3 bot found no path to one for 6000 ticks, then fell into the lava under it, run blz-d)
    let otherFortress = false
    for (let attempt = 1; ; attempt++) {
      const exclude = unreachableSpawners(bot)
      // a fortress first: the spawner is looked for in the one in view (the arrival is seldom by one)
      const spawner = executor.memory.getPois('blaze_spawner', { dimension: 'the_nether', near: bot.entity.position })
        .find(p => !excludedSpawner(p, exclude))
      // (after a spawner there was no way to, the fortress's other is looked for first: findBlazeSpawner leaves it out)
      if (spawner == null && (attempt === 1 || otherFortress)) {
        const route = fortressRoute(executor.memory, bot.entity.position)
        const found = await executor.task('find a fortress', async (s) => await findFortress(bot, { explore: route, seed, exclude }, s), signal)
        log(`a fortress at ${found.fortress.center.x} ${found.fortress.center.y} ${found.fortress.center.z} (${found.via}, ${found.ticks} ticks)`)
        otherFortress = false
      }
      try {
        await executor.task('blaze rods', async (s) => await collectBlazeRods(bot, { count: rods, spawner, exclude }, s), signal)
        break
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED') || attempt >= BLAZE_SPAWNER_TRIES) throw err
        const message = (err as Error).message
        // no way to it: the fortress's other spawner next (findBlazeSpawner leaves this one out); none other found
        // in a fortress with one out of reach: another fortress
        const unreachable = /no way to the blaze spawner|no blaze came from the blaze spawner/.test(message)
        const none = exclude.length > 0 && /no blaze spawner found|no fortress in view/.test(message)
        if (!unreachable && !none) throw err
        if (none) otherFortress = true
        log(`blaze rods: ${message}: ${none ? 'another fortress' : 'another spawner'}`)
      }
    }
  }
  const pearls = netherNeeds({ count }).pearls
  if (pearls > 0) {
    log(`ender pearls: ${pearls} to get`)
    await pearlsInTheNether(bot, executor, count('ender_pearl') + pearls, signal, log, seed)
  }
  await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal).catch(async err => {
    if (signal.aborted || TaskError.is(err, 'DIED') || !inNether(bot)) throw err
    // low by the lava sea with no way to the portal: up first, then again
    await upFromLowGround(bot, executor, signal, log)
    await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
  })
  // what the nether didn't give: the overworld's endermen by night
  const still = netherNeeds({ count }).pearls
  if (still > 0) {
    log(`ender pearls: ${still} short: the endermen of the overworld's nights`)
    await pearlsByNight(bot, executor, count('ender_pearl') + still, signal, log)
  }
}

/** spawners (and fortresses) the blaze rods are tried at before the milestone gives up */
export const BLAZE_SPAWNER_TRIES = 4

/**
 * legs the nether's pearl search walks before the overworld's nights (10: 4 legs found no piglin, enderman nor warped
 * forest on 26.3 seed 2, and three overworld nights found no enderman either)
 */
export const PEARL_NETHER_LEGS = 10

/** an enchanting table's obsidian */
export const TABLE_OBSIDIAN = 4

/**
 * `count` obsidian made from the lava about (the portal's way: obsidianFromLava at the nearest pools not tried, then
 * the deep lakes), a bucket, its water and a diamond pickaxe got first; resolves whether they're held
 */
/** how far (along the ground) a ruined portal is gone to for its obsidian */
export const RUINED_PORTAL_TRIP = 400
/** the ticks a trip to a ruined portal and its mining may take */
export const RUINED_PORTAL_TICKS = 12000
/** the POI of a ruined portal's candidate gone to (not again) */
export const RUINED_PORTAL_TRIED = 'ruined_portal_tried'

/**
 * Obsidian already in the world, mined before any lava is worked, while a diamond pickaxe is held: the obsidian in
 * the loaded chunks (none with lava against it: its drop would burn), then, with the seed known, the nearest ruined
 * portal's within RUINED_PORTAL_TRIP (ruinedPortalCandidates; its crying obsidian is another block, not taken),
 * within RUINED_PORTAL_TICKS. Up to `want` held in all.
 */
export async function naturalObsidian (bot: Bot, executor: Executor, want: number, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const have = (): number => countItems(bot, 'obsidian')
  if (have() >= want || countItems(bot, ['diamond_pickaxe', 'netherite_pickaxe']) === 0) return
  const quiet = (err: unknown): void => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err }
  // (none with lava against it, its drop would burn; none in water, an ocean's ruined portal: a 26.3 bot mined one
  // 8 deep and drowned there after 160000 ticks of the drowning reflex)
  const fluidNext = (p: Vec3): boolean => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]].some(([dx, dy, dz]) => /^(lava|water|bubble_column)$/.test(bot.blockAt(p.offset(dx, dy, dz))?.name ?? ''))
  const mineInSight = async (range: number, within: AbortSignal): Promise<void> => {
    const id = bot.registry.blocksByName.obsidian?.id
    if (id == null) return
    const found = (bot.findBlocks?.({ matching: id, maxDistance: range, count: 64 }) ?? []).filter(p => !fluidNext(p))
    if (found.length === 0) return
    log(`obsidian: ${found.length} in sight: mining ${Math.min(found.length, want - have())}`)
    await executor.task('mine the obsidian', async (s) => await withNetherSafety(bot, async () => await collectBlock(bot, { positions: found.slice(0, want - have()), pickup: true, avoidLava: true }, s)), within, { uses: () => Math.max(0, want - have()) })
      .catch(err => { quiet(err); log(`obsidian: ${(err as Error).message}`) })
  }
  await withTickBudget(bot, RUINED_PORTAL_TICKS, signal, async (budget) => await mineInSight(64, budget)).catch(err => { quiet(err); log(`obsidian: ${(err as Error).message}`) })
  const seed = (bot as any).survival?.playOptions?.seed as Seed | undefined
  if (have() >= want || seed == null || inNether(bot)) return
  const tried = (c: { x: number, z: number }): boolean => executor.memory.getPois(RUINED_PORTAL_TRIED, { dimension: 'overworld' }).some(p => Math.hypot(p.x - c.x, p.z - c.z) < 32)
  const portal = ruinedPortalCandidates(seed, bot.entity.position).find(c => c.distance <= RUINED_PORTAL_TRIP && !tried(c))
  if (portal == null) return
  const at = new Vec3(portal.x + 8, bot.entity.position.y, portal.z + 8)
  const from = bot.entity.position.clone()
  log(`obsidian: to the ruined portal at ${portal.x} ${portal.z} (${portal.distance.toFixed(0)} blocks)`)
  executor.memory.addPoi(RUINED_PORTAL_TRIED, new Vec3(portal.x, 0, portal.z), 'overworld')
  await withTickBudget(bot, RUINED_PORTAL_TICKS, signal, async (budget) => {
    await executor.task('to a ruined portal', async (s) => await overland(bot, { target: at, range: 16 }, s), budget).catch(quiet)
    await mineInSight(48, budget)
  }).catch(err => { quiet(err); log(`obsidian: the ruined portal: ${(err as Error).message}`) })
  // an ocean's portal left the bot in the sea (its bottom, where every way on from timed out and the drowning reflex
  // went on for 20000 ticks, 26.3): to the shore
  if (inWater(bot)) {
    // and back to where the trip began (the sea about it is no place for the pools after: a 26.3 bot's search for
    // lava from there went over the ocean, the drowning reflex every 300 ticks, 48000 ticks 'exploring for obsidian')
    log(`obsidian: the ruined portal was in the sea: back to ${from.floored().toString()}`)
    await executor.task('to the shore', async (s) => await toShore(bot, s), signal).catch(quiet)
    await executor.task('back from the sea', async (s) => await overland(bot, { target: from, range: 8 }, s), signal).catch(quiet)
  }
}

export async function obsidianFromPools (bot: Bot, executor: Executor, count: number, signal: AbortSignal, log: (line: string) => void): Promise<boolean> {
  const have = (): number => countItems(bot, 'obsidian')
  if (have() >= count) return true
  const quiet = (err: unknown): void => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err }
  if (countItems(bot, ['water_bucket', 'bucket']) === 0) await executor.obtain([{ item: 'bucket', count: 1 }], signal).catch(quiet)
  await refillWater(bot, signal)
  if (countItems(bot, ['diamond_pickaxe', 'netherite_pickaxe']) === 0) await executor.obtain([{ item: 'diamond_pickaxe', count: 1 }], signal).catch(quiet)
  // the obsidian in the world first (in sight, a ruined portal's)
  await naturalObsidian(bot, executor, count, signal, log)
  for (let depth = 0; depth < 2 && have() < count; depth++) {
    if (depth === 1 && bot.entity.position.y >= DEEP_LAVA_Y + 10) {
      await executor.task('down to the deep lava', async (s) => await descendTo(bot, DEEP_LAVA_Y, {}, s), signal).catch(quiet)
    }
    for (const pool of nearestLavaPools(bot).slice(0, 3)) {
      if (have() >= count) break
      const at = new Vec3(pool.x, pool.y, pool.z)
      log(`obsidian: from the lava at ${at.floored().toString()}`)
      try {
        await executor.task('to the lava', async (s) => await moveNear(bot, at, 5, s).catch(async err => {
          if (isAbort(err)) throw err
          await tunnelTo(bot, { target: at, range: 5 }, s).catch(e => { if (isAbort(e) || bot.entity.position.distanceTo(at) > 8) throw e })
        }), signal)
        await executor.task('obsidian from the lava', async (s) => await obsidianFromLava(bot, count, s), signal)
      } catch (err) {
        quiet(err)
        log(`obsidian: ${(err as Error).message}`)
      }
    }
  }
  return have() >= count
}

/** the lowest height a nether pearl leg aims at (the lava sea is at 31) */
export const PEARL_LEG_Y = 64

/** blocks a pearl search in the nether goes on each leg looking for piglins or endermen */
export const PEARL_LEG = 96
/** the spiral's next points a pearl leg is chosen among by the ground seen toward them (pearlLeg) */
export const PEARL_LEG_CHOICES = 4
/** rounds of the overworld's night hunt at most (a hunt, a leg, a day's levels each) */
export const PEARL_ROUNDS = 200
/** game ticks the overworld's night hunt for endermen may take (3 days) */
export const PEARL_NIGHTS_TICKS = 72000

/** blocks of a warped forest (the endermen's nether biome) and of a bastion (its piglins) */
const WARPED_BLOCKS = ['warped_nylium', 'warped_wart_block', 'warped_stem']
const BASTION_BLOCKS = ['gilded_blackstone', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks']

/**
 * Where the nether's pearls are, by the blocks in the loaded chunks: the nearest warped forest's (more than 8 of its
 * blocks), else with gold a bastion's; null when neither is in sight
 */
export function pearlGround (bot: Bot, gold: boolean): { kind: 'warped forest' | 'bastion', at: Vec3 } | null {
  if (typeof bot.findBlocks !== 'function') return null
  const ids = (names: string[]): number[] => names.map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
  const warped = findBlocks(bot, { matching: ids(WARPED_BLOCKS), maxDistance: 128, count: 16 })
  if (warped.length > 8) return { kind: 'warped forest', at: warped[0].offset(0, 1, 0) }
  if (gold) {
    const bastion = findBlocks(bot, { matching: ids(BASTION_BLOCKS), maxDistance: 128, count: 16 })
    if (bastion.length > 8) return { kind: 'bastion', at: bastion[0] }
  }
  return null
}

/** ticks a cover's fight goes on for before the pearl search looks round again (a barter, the legs) */
export const COVER_TICKS = 6000
/** covers failed in a row (no ground about for one, dug wrong, broken) before the forest's endermen are hunted instead */
export const COVER_FAILS = 3

/** the bot in a warped forest: the seed's biome there, else its blocks about the bot (pearlGround's, within 16) */
export function inWarpedForest (bot: Bot, biomes: NetherBiomeSource | null): boolean {
  const at = bot.entity.position
  // (at its edge too: within FOREST_EDGE of the biome, where a cover is planned in it; out of it by a few blocks the
  // search hunted the endermen instead, walked down after one and into the lava sea, 26.3 run p9)
  if (biomes != null) {
    return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => biomes.biomeAt(at.x + dx * FOREST_EDGE, at.z + dz * FOREST_EDGE) === 'warped_forest')
  }
  const seen = pearlGround(bot, false)
  return seen?.kind === 'warped forest' && seen.at.distanceTo(at) <= 16
}

/** how far from a warped forest the bot counts as in it */
export const FOREST_EDGE = 12

/** game ticks the nether's pearl search may take in all (its legs, hunts and waits) before the overworld's nights */
export const PEARL_NETHER_TICKS = 48000
/** rounds (a barter, a hunt, a wait or a leg each) the nether's pearl search takes at most, ticks or not */
export const PEARL_NETHER_ROUNDS = 80
/**
 * barters the nether's pearl search tries at most: a piglin in sight with gold held was a barter each round, 7 in a row
 * timing out with no pearl and 14000 ticks gone before the first leg to the warped forest (26.3 run n2-d; a pearl is
 * one barter in about 47)
 */
export const PEARL_BARTERS = 2
/** a wait in a warped forest for its endermen to spawn round the bot */
export const FOREST_WAIT = 300
/** ticks with no enderman come to a spot in a warped forest before the search goes on to another spot in one */
export const FOREST_IDLE = 1500
/** how far round the bot the seed's warped forests are looked for */
export const FOREST_SEARCH_RADIUS = 1536

/**
 * Pearls in the nether up to `want`: gold bartered with the adult piglins in sight, endermen hunted where they are
 * (the warped forest, the soul sand valleys), the nether walked on in legs of PEARL_LEG blocks to find either, a few
 * legs at most (PEARL_NETHER_LEGS), PEARL_NETHER_TICKS in all; resolves the pearls held (never throws for none found:
 * the overworld's nights are next). With the seed the legs go to the nearest warped forest it puts (NetherBiomeSource:
 * the only nether biome whose monsters are all endermen), and the bot waits in it for them.
 */
export async function pearlsInTheNether (bot: Bot, executor: Executor, want: number, signal: AbortSignal, log: (line: string) => void, seed?: Seed): Promise<number> {
  const count = (name: string): number => countItems(bot, name)
  const start = executor.tasks.tick
  const elapsed = (): number => executor.tasks.tick - start
  let legs = PEARL_NETHER_LEGS
  let legsWalked = 0
  const spiral = spiralWaypoints(bot.entity.position, PEARL_LEG, PEARL_LEG * PEARL_NETHER_LEGS)
  // the spiral's points walked to (by their index)
  const usedLegs = new Set<number>()
  // the seed's biomes, and the warped forest spots tried (a leg there failed, or no enderman came)
  const biomes = seed != null ? new NetherBiomeSource(levelSeed(seed)) : null
  const triedSpots: Array<{ x: number, z: number }> = []
  let forestSpot: { x: number, z: number, distance: number } | null = null
  let lastEnderman = executor.tasks.tick
  // the endermen there was no way to (huntEndermen's), left alone unless they come
  const passOver = new Set<number>()
  let barters = 0
  // the endermen the cover's fight passed over (a stare that took no hold, one angry that never came), and the covers
  // that failed (dug wrong, broken, no ground for one) in a row
  const coverPassOver = new Set<number>()
  let coverFails = 0
  let coverTicks = 0
  let coverPearls = 0
  const goLeg = async (to: Vec3, why: string): Promise<boolean> => {
    legsWalked++
    log(`ender pearls: ${count('ender_pearl')} of ${want}: on to ${to.floored().toString()} for ${why}`)
    try {
      await executor.task('a leg for pearls', async (s) => await withNetherSafety(bot, async () => await travel(bot, {
        target: to,
        range: 8,
        onHop: () => Object.values(bot.entities).some(e => (huntable(bot, e, passOver) || (isAdultPiglin(bot, e) && count('gold_ingot') > 0)) && e.position.distanceTo(bot.entity.position) <= 48)
      }, s)), signal)
      return true
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`ender pearls: the leg: ${(err as Error).message}`)
      await upFromLowGround(bot, executor, signal, log)
      return false
    }
  }
  for (let round = 0; round < PEARL_NETHER_ROUNDS && legsWalked < legs && elapsed() < PEARL_NETHER_TICKS && count('ender_pearl') < want; round++) {
    if (signal.aborted) throw signal.reason
    const piglin = Object.values(bot.entities).some(e => isAdultPiglin(bot, e) && e.position.distanceTo(bot.entity.position) <= 48)
    const enderman = Object.values(bot.entities).some(e => huntable(bot, e, passOver) && e.position.distanceTo(bot.entity.position) <= 48)
    if (enderman) lastEnderman = executor.tasks.tick
    try {
      if (piglin && count('gold_ingot') > 0 && barters < PEARL_BARTERS) {
        barters++
        // room for what the piglins throw (a full bag ended the bartering at once: NO_SPACE, 26.3)
        await executor.makeRoom?.({ gold_ingot: count('gold_ingot') }, signal)?.catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err; log(`ender pearls: no room: ${(err as Error).message}`) })
        await executor.task('barter for pearls', async (s) => await barterForPearls(bot, { pearls: want, range: 48 }, s), signal)
        continue
      }
      // in a warped forest: its endermen fought from a cover dug in its floor, not gone after over its ledges and
      // fungi (an enderman knocked a 26.3 bot off a ledge to its death, run n2-d; one fight ran 13000 ticks against
      // one beyond a stem, n2-c)
      if (inWarpedForest(bot, biomes) && coverFails < COVER_FAILS && executor.tasks.tick - lastEnderman < FOREST_IDLE) {
        try {
          const res = await executor.task('endermen from cover', async (s) => await endermenFromCover(bot, { pearls: want - count('ender_pearl'), maxTicks: COVER_TICKS, idleTicks: FOREST_IDLE, passOver: coverPassOver }, s), signal)
          coverFails = 0
          coverTicks += res.ticks
          coverPearls += res.pearls
          log(`ender pearls: ${count('ender_pearl')} of ${want}: ${res.kills} endermen killed from cover in ${res.ticks} ticks${res.reason === 'idle' ? ', then none about' : res.reason === 'blind' ? ', then none in sight' : ''} (${coverPearls} pearls in ${coverTicks} ticks of cover)`)
          if (res.reason === 'idle' || res.reason === 'blind') {
            // none came for FOREST_IDLE, or none in sight from the covers there: another spot of the forest
            lastEnderman = executor.tasks.tick - FOREST_IDLE
            if (forestSpot != null) triedSpots.push(forestSpot)
            forgetCover(bot)
          } else lastEnderman = executor.tasks.tick
          continue
        } catch (err) {
          if (signal.aborted || TaskError.is(err, 'DIED')) throw err
          coverFails++
          forgetCover(bot)
          log(`ender pearls: the cover: ${(err as Error).message}`)
          // no ground for one here: another spot of the forest (with the seed), its waits and hunts meanwhile
          if (biomes != null && /no ground for an enderman cover/.test((err as Error).message)) {
            if (forestSpot != null) triedSpots.push(forestSpot)
            lastEnderman = executor.tasks.tick - FOREST_IDLE
            continue
          }
        }
      }
      if (enderman) {
        await executor.task('endermen for pearls', async (s) => await huntEndermen(bot, { pearls: want - count('ender_pearl'), range: 48, maxTicks: 6000, passOver }, s), signal)
        continue
      }
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`ender pearls: ${(err as Error).message}`)
      continue
    }
    if (biomes != null) {
      const at = bot.entity.position.clone()
      if (biomes.biomeAt(at.x, at.z) === 'warped_forest' && executor.tasks.tick - lastEnderman < FOREST_IDLE) {
        // in it: its endermen spawn round the bot (the warped forest's monsters are all endermen)
        await executor.task('wait for endermen', async (s) => { await waitTicks(bot, FOREST_WAIT, s) }, signal)
        continue
      }
      // to the nearest warped forest the seed puts, deep in it; another spot once one's been waited at with no
      // enderman come for FOREST_IDLE
      if (forestSpot != null && Math.hypot(at.x - forestSpot.x, at.z - forestSpot.z) <= 32) triedSpots.push(forestSpot)
      forestSpot = nearestBiomeSpot(biomes, at, 'warped_forest', { radius: FOREST_SEARCH_RADIUS, exclude: triedSpots }) ??
        nearestBiomeSpot(biomes, at, 'warped_forest', { radius: FOREST_SEARCH_RADIUS, exclude: triedSpots, depth: 1 })
      if (forestSpot != null) {
        const ok = await goLeg(new Vec3(forestSpot.x + 0.5, Math.max(PEARL_LEG_Y, at.y), forestSpot.z + 0.5), `the seed's warped forest, ${Math.round(forestSpot.distance)} off`)
        // the wait for the endermen from the arrival; a leg that got nowhere: that spot left for another
        lastEnderman = executor.tasks.tick
        if (!ok && bot.entity.position.distanceTo(at) < 16) triedSpots.push(forestSpot)
        continue
      }
    }
    // on to find piglins or endermen: to a warped forest in sight (its nylium: the endermen's biome), or a bastion's
    // blocks with gold held (its piglins), else a leg along the next of the fortress search's walks
    const seen = pearlGround(bot, count('gold_ingot') > 0)
    if (seen != null) {
      if (seen.kind === 'warped forest') legs = Math.max(legs, Math.min(legsWalked + 3, 12))
      if (seen.at.distanceTo(bot.entity.position) <= 16) {
        // in it: the endermen spawn about (a warped forest's spawns are mostly theirs)
        await executor.task('wait for endermen', async (s) => { await waitTicks(bot, 400, s) }, signal)
        continue
      }
      await goLeg(seen.at, seen.kind)
      continue
    }
    // a spiral out from where the search began (the fortress walks' legs went back and forth over the same 100
    // blocks round the fortress, 10 legs and no new ground, 26.3), its next point the way taken unless the ground
    // seen toward one of the few after it is better for the endermen and piglins, or that way is a basalt delta or
    // a soul sand valley (pearlLeg; a leg into seed 2's delta east of the fortress ended in a magma cube swarm by
    // the lava sea, 26.3); no point twice
    if (usedLegs.size >= spiral.length) usedLegs.clear()
    const next = spiral.map((p, i) => ({ p, i })).filter(c => !usedLegs.has(c.i)).slice(0, PEARL_LEG_CHOICES)
    const leg = pearlLeg(bot, bot.entity.position, next.map(c => c.p), { gold: count('gold_ingot') > 0 })
    usedLegs.add(next[leg.index].i)
    const point = leg.point
    if (leg.ground.delta + leg.ground.valley + leg.ground.warped + leg.ground.crimson > 0) {
      log(`ender pearls: the ground that way: ${leg.ground.warped} warped, ${leg.ground.crimson} crimson, ${leg.ground.delta} delta, ${leg.ground.valley} soul sand valley`)
    }
    // at a height well over the lava sea (y 31): a leg at the bot's own height from its shore led it down to the
    // sea's level, and into the lava (26.3)
    await goLeg(new Vec3(point.x, Math.max(PEARL_LEG_Y, bot.entity.position.y), point.z), 'piglins or endermen')
  }
  return count('ender_pearl')
}

/** the height under which a nether path that finds no way on climbs up first (the lava sea is at 31) */
export const NETHER_LOW_Y = 45

/**
 * In the nether by the lava sea with no way on: a pillar 8 up from where the bot stands (the low ground's ways are
 * all beside lava, which the nether's path settings forbid: every leg failed at once from y 34 and the way back to
 * the portal too, 26.3)
 */
export async function upFromLowGround (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  if (!inNether(bot) || bot.entity.position.y >= NETHER_LOW_Y) return
  const top = Math.floor(bot.entity.position.y) + 8
  log(`nether: low by the lava sea at y ${Math.floor(bot.entity.position.y)}: up to ${top}`)
  await executor.task('up from the low ground', async (s) => await towerUp(bot, top, { signal: s }), signal).catch(err => {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`nether: no way up: ${(err as Error).message}`)
  })
}

/** the spiral's legs a night's hunt walks round home (48 apart out to 240: 16 of them) */
export const NIGHT_LEG_STEP = 48
export const NIGHT_LEG_RADIUS = 240

/**
 * The point of a night hunt's leg `leg` round `center`: the spiral's points in turn, again from the first after the
 * last (the hunt took the spiral's 24th of 16: 'Cannot read properties of undefined', each leg after the 16th failing
 * at once)
 */
export function nightLeg (center: { x: number, z: number }, leg: number): { x: number, z: number } {
  const points = spiralWaypoints(center, NIGHT_LEG_STEP, NIGHT_LEG_RADIUS)
  return points[leg % points.length]
}

/**
 * Pearls from the overworld's endermen at night up to `want`, PEARL_NIGHTS_TICKS at most: each night on the surface
 * the endermen in sight hunted, the bot walking a leg of the surface spiral round home when none is; the days spent
 * on levels. Resolves the pearls held.
 */
export async function pearlsByNight (bot: Bot, executor: Executor, want: number, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  const count = (name: string): number => countItems(bot, name)
  const start = executor.tasks.tick
  let leg = 0
  // the endermen there was no way to (across a river, up a cliff), left alone unless they come
  const passOver = new Set<number>()
  // the night's out on the surface is the work: the night reflex's shelter (or bed) held off meanwhile (it took the
  // bot in each night, and three nights found no enderman, 26.3)
  const survival = (bot as any).survival ?? {}
  const before = survival.nightWork
  survival.nightWork = true
  // the nights the ground about held no cover (then the open fight)
  let nightCoverFails = 0
  try {
    for (let round = 0; round < PEARL_ROUNDS && count('ender_pearl') < want && executor.tasks.tick - start < PEARL_NIGHTS_TICKS; round++) {
      if (signal.aborted) throw signal.reason
      const night = dayPhase(bot.time?.timeOfDay ?? 0) !== 'day'
      try {
        if (!night) {
          await executor.task('levels by day', async (s) => await gainLevels(bot, { level: 30, maxTicks: 3000 }, s), signal)
            .catch(async () => { await executor.task('wait for the night', async (s) => { await waitTicks(bot, 1000, s) }, signal) })
          continue
        }
        const enderman = Object.values(bot.entities).some(e => huntable(bot, e, passOver) && e.position.distanceTo(bot.entity.position) <= 64)
        if (enderman) {
          // from a cover (endermenFromCover: a two-high tunnel no enderman gets into, the stare from its stair's top),
          // the open fight only with no ground about for one: a 26.3 bot fought the overworld's endermen in the open,
          // 7 a hit, and died (full-26.3-fresh-d; tests/integration/freshDeaths, a night with 3 endermen: 2 of 3 alive)
          if (nightCoverFails < NIGHT_COVER_FAILS) {
            try {
              await executor.task('endermen from cover', async (s) => await endermenFromCover(bot, { pearls: want - count('ender_pearl'), maxTicks: 3000, range: 64, passOver }, s), signal)
              continue
            } catch (err) {
              if (signal.aborted || TaskError.is(err, 'DIED')) throw err
              log(`ender pearls by night: from cover: ${(err as Error).message}`)
              if (/no ground for an enderman cover/.test((err as Error).message)) nightCoverFails++
              else continue
            }
          }
          await executor.task('endermen for pearls', async (s) => await huntEndermen(bot, { pearls: want - count('ender_pearl'), range: 64, maxTicks: 3000, passOver }, s), signal)
          continue
        }
        const center = executor.memory.base != null ? new Vec3(executor.memory.base.x, executor.memory.base.y, executor.memory.base.z) : bot.entity.position
        const point = nightLeg(center, leg++)
        await executor.task('a night leg for endermen', async (s) => await overland(bot, {
          target: new Vec3(point.x, bot.entity.position.y, point.z),
          range: 8,
          onHop: () => Object.values(bot.entities).some(e => huntable(bot, e, passOver) && e.position.distanceTo(bot.entity.position) <= 64)
        }, s), signal)
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`ender pearls by night: ${(err as Error).message}`)
      }
    }
  } finally {
    survival.nightWork = before
  }
  log(`ender pearls: ${count('ender_pearl')} of ${want} after ${executor.tasks.tick - start} ticks of the overworld's nights`)
  return count('ender_pearl')
}

/** covers found no ground for at night before the night hunt fights in the open */
export const NIGHT_COVER_FAILS = 3

/** eyes kept for the throws still to come while the portal room isn't found */
export const EYE_SEARCH_RESERVE = 2

/**
 * The eyes short of what the rest of the search and the portal take, counting the ones the pearls and powder held
 * make: the room's empty frames once it is found (eyesForPortal), else a frame's 12 and EYE_SEARCH_RESERVE for the
 * throws. More than none sends the run back to the nether for pearls and rods (the eyes run out on a long search).
 */
export function eyesShort (inv: { count: (name: string) => number }, memory: WorldMemory): number {
  const craftable = Math.min(inv.count('ender_pearl'), inv.count('blaze_powder') + 2 * inv.count('blaze_rod'))
  const roomKnown = memory.getPois('end_portal', { dimension: 'overworld' }).length > 0
  const want = roomKnown ? eyesForPortal(memory) : EYES_FOR_FRAME + EYE_SEARCH_RESERVE
  return Math.max(0, want - inv.count('ender_eye') - craftable)
}

export const eyesHandler: MilestoneHandler = async (ctx) => {
  const { bot, executor, signal, log } = ctx
  if (inNether(bot)) await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
  // out of eyes (thrown, broken, a long search): back for more pearls and rods first, not five failures and the end
  // of the game (26.3 seed 2); the search then goes on from the memory's rays and estimate
  const short = eyesShort({ count: (n: string) => countItems(bot, n) }, executor.memory)
  if (short > 0) {
    log(`eyes: ${short} short of the portal and the search: to the nether for pearls and rods`)
    await netherHandler(ctx)
  }
  const makeable = Math.min(countItems(bot, 'ender_pearl'), countItems(bot, 'blaze_powder') + 2 * countItems(bot, 'blaze_rod'))
  if (countItems(bot, 'ender_eye') < EYES_TARGET && makeable > 0) {
    await executor.task('craft the eyes', async (s) => await craftEyes(bot, { count: EYES_TARGET }, s), signal)
  }
  log(`${countItems(bot, 'ender_eye')} eyes: off to the stronghold`)
  const { room } = await executor.task('to the stronghold', async (s) => await strongholdToPortalRoom(bot, {}, s), signal)
  // the milestone's check: the stronghold remembered, enough eyes left for the frame
  executor.memory.addPoi('stronghold', room.room.center, 'overworld', 'portal room')
  log(`the portal room at ${room.room.center.x} ${room.room.center.y} ${room.room.center.z}: ${room.room.eyesNeeded} eyes to put in, ${countItems(bot, 'ender_eye')} held`)
}

/** whether the portal room's frames are within enterEnd's reach of the bot */
export function portalRoomNear (bot: Bot): boolean {
  const room = readPortalRoom(bot)
  return room != null && room.unseen.length === 0
}

/** ticks a chest and a bed for the trip kit may cost (the plan's estimate) */
export const TRIP_KIT_TICKS = 3000

/** ticks the trip kit's spare armor and shield may cost (the plan's estimate: made from what's held, not mined for) */
export const KIT_SPARE_TICKS = 1000

/** the trip kit's spare armor and shield made from the iron held (kitSpares), when that's cheap */
async function makeKitSpares (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const owned = ownedInventory(bot).entries()
  const carried = bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
  for (const want of kitSpares(owned, carried)) {
    const plan = executor.plan(want)
    if (!plan.ok || plan.cost > KIT_SPARE_TICKS) continue
    try {
      // within twice the estimate at most, as the kit's chest and bed
      await withTickBudget(bot, KIT_SPARE_TICKS * 2, signal, async (s) => await executor.obtain(want, s))
      log(`trip kit spares: ${want.map(w => w.item).join(', ')}`)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`trip kit spares: ${want.map(w => w.item).join(', ')}: ${(err as Error).message}`)
    }
  }
}

/**
 * The trip kit left by the bot (skills/tripKit) unless one with something in it is known: a chest got (and a bed when
 * cheap), the spares put in, the respawn point set by it. `beforeStash` runs once the chest and bed are got, before
 * they are put down (back to where the kit belongs: the bed's sheep may be hunted far off)
 */
export async function leaveTripKit (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void, beforeStash?: () => Promise<void>): Promise<void> {
  const known = executor.memory.getPois(TRIP_KIT, { dimension: 'overworld', near: bot.entity.position })[0]
  if (known != null && Object.values(executor.memory.chestAt(known, 'overworld')?.items ?? {}).some(n => n > 0)) return
  // the kit's chest a respawn emptied, by: filled again (a 26.3 bot respawned by the stronghold went 68000 ticks up
  // for the logs of a new chest and the wool of a new bed)
  const chest = known != null ? new Vec3(known.x, known.y, known.z) : null
  if (chest != null && chest.distanceTo(bot.entity.position) <= 32 && bot.blockAt(chest)?.name === 'chest') {
    try {
      await makeKitSpares(bot, executor, signal, log)
      const kit = await executor.task('leave a trip kit', async (s) => await stashTripKit(bot, executor.memory, s, { chest }), signal)
      log(`trip kit again at ${kit.chest.toString()}: ${Object.entries(kit.stored).map(([n, c]) => `${c} ${n}`).join(', ')}`)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`no trip kit: ${(err as Error).message}`)
    }
    return
  }
  try {
    const beds = bot.registry.itemsArray.map(i => i.name).filter(n => n.endsWith('_bed'))
    const hasBed = bot.inventory.items().some(i => i.name.endsWith('_bed'))
    for (const want of [[{ item: 'chest', count: 1 }], ...(hasBed ? [] : [[{ item: beds, count: 1 }]])]) {
      const plan = executor.plan(want)
      if (!plan.ok || plan.cost > TRIP_KIT_TICKS) continue
      // within twice the estimate at most (the bed's 3 sheep, 'cheap' by the plan, were hunted 90000 ticks and 1800
      // blocks off the stronghold, 26.3)
      await withTickBudget(bot, TRIP_KIT_TICKS * 2, signal, async (s) => await executor.obtain(want, s)).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`trip kit: no ${want[0].item === 'chest' ? 'chest' : 'bed'}: ${(err as Error).message}`)
      })
    }
    await makeKitSpares(bot, executor, signal, log)
    await beforeStash?.()
    const kit = await executor.task('leave a trip kit', async (s) => await stashTripKit(bot, executor.memory, s), signal)
    log(`trip kit at ${kit.chest.toString()}: ${Object.entries(kit.stored).map(([n, c]) => `${c} ${n}`).join(', ')}${kit.bed != null ? ', the respawn point by it' : `; no respawn point by it: ${kit.noBed ?? '?'}`}`)
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`no trip kit: ${(err as Error).message}`)
  }
}

/**
 * Runs `fn` under a signal that also aborts after `ticks` game ticks (or with `signal`); throws what `fn` throws, an
 * abort for the budget gone included
 */
/** the tasks a budget's work waits on that aren't its work: the night's sleep and its wait (the runner's) */
const NOT_THE_WORK = new Set(['sleep', 'wait out the night'])

/**
 * Whether the tick goes to something else than the budget's work: the bot asleep, a reflex's task running (a fight,
 * the night's shelter or sleep, eating), or the runner's night sleep or wait: a trip kit's 6000 ticks went to a
 * night's sleep in the middle of its planks, 'over the budget', and no kit was left (full-26.3-fresh-l)
 */
export function tickNotTheWork (bot: Bot): boolean {
  if ((bot as any).isSleeping === true) return true
  const survival = (bot as any).survival
  if (survival?.reflexes?.current != null) return true
  const task = survival?.tasks?.current?.name
  return typeof task === 'string' && (NOT_THE_WORK.has(task) || task.startsWith('reflex:'))
}

export async function withTickBudget<T> (bot: Bot, ticks: number, signal: AbortSignal, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController()
  let n = 0
  // (the ticks of a sleep, a reflex or the night's wait aren't the work's: not counted)
  const onTick = (): void => {
    if (tickNotTheWork(bot)) return
    if (++n >= ticks) ctrl.abort(new TaskError('TIMEOUT', `over the budget of ${ticks} ticks`))
  }
  const onAbort = (): void => { ctrl.abort(signal.reason) }
  bot.on('physicsTick', onTick)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fn(ctrl.signal)
  } finally {
    bot.off('physicsTick', onTick)
    signal.removeEventListener('abort', onAbort)
  }
}

/** ticks a death's drops last (ItemEntity's 6000-tick lifespan) */
export const DROP_LIFESPAN = 6000

/**
 * Back to a death's drops in the End, when the death was there lately and the spot is on the island's ground (not
 * the void): walked to and picked up
 */
export async function recoverEndDrops (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const death = executor.memory.death
  if (death == null || death.dimension !== 'the_end' || executor.memory.now - death.seen > DROP_LIFESPAN || death.y < 10) return
  const spot = new Vec3(death.x, death.y, death.z)
  log(`End: back to the drops at ${death.x} ${death.y} ${death.z}`)
  try {
    await executor.task('the drops', async (s) => {
      await crossToIsland(bot, { signal: s })
      await gotoNear(bot, spot, 2, { signal: s })
      return await pickupDrops(bot, { near: spot.offset(0.5, 0.5, 0.5), radius: 10 }, s)
    }, signal)
    executor.memory.death = null
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`End: the drops: ${(err as Error).message}`)
  }
}

/** ticks the way back to a nether death's drops may take */
export const NETHER_DROPS_TICKS = 20000

/**
 * Back to a nether death's drops (its diamond gear at a fortress's spawner): the items of an unloaded chunk don't
 * age (ItemEntity ticks only in loaded chunks), so they lie there till the bot is back; gone to by the nether's path
 * settings within NETHER_DROPS_TICKS (8000 ran out 500 blocks from the portal), unless the death was in the lava sea or the spot is lava when seen
 * (a 26.3 bot came back to the spawner naked three times, its kit's diamonds lying there)
 */
export async function recoverNetherDrops (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const death = executor.memory.death
  if (death == null || death.dimension !== 'the_nether' || !inNether(bot) || death.y <= 33) return
  const spot = new Vec3(death.x, death.y, death.z)
  log(`nether: back to the drops at ${death.x} ${death.y} ${death.z}`)
  try {
    await withTickBudget(bot, NETHER_DROPS_TICKS, signal, async (s) => await executor.task('the nether drops', async (ts) => await withNetherSafety(bot, async () => {
      await travel(bot, { target: spot, range: 3, exactY: true }, ts)
      if (/lava/.test(bot.blockAt(spot.floored())?.name ?? '')) return
      await pickupDrops(bot, { near: spot.offset(0.5, 0.5, 0.5), radius: 10 }, ts)
    }), s))
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`nether: the drops: ${(err as Error).message}`)
  }
  executor.memory.death = null
}

/** ticks a pumpkin and shears for the End's carved pumpkin may cost (the plan's estimate) */
export const PUMPKIN_TICKS = 2000

/**
 * End stone to dig for blocks without digging a pit: the top layer's (the cell over it open) at the bot's ground level,
 * 2 to 16 blocks round it, nearest first; up to `count`
 */
export function endStoneTopLayer (bot: Bot, count: number): Vec3[] {
  const id = bot.registry.blocksByName.end_stone?.id
  if (id == null || typeof bot.findBlocks !== 'function') return []
  const feet = bot.entity.position.floored()
  const open = (p: Vec3): boolean => bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty'
  return findBlocks(bot, { matching: id, maxDistance: 16, count: 512 })
    .filter(p => p.y === feet.y - 1 && open(p) && Math.hypot(p.x - feet.x, p.z - feet.z) >= 2)
    .sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet))
    .slice(0, count)
}

/** blocks to have for the crystals' pillars (the caged ones are 76 to 103 high, the ground at 64) */
export const END_BLOCKS = 64

/** the arrows the End is never entered with fewer of (the crystals: 10, some missed) */
export const END_ARROWS = 16

export const endHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  if (!isInEnd(bot)) {
    // the End kit: a bow, arrows, blocks to pillar, a water bucket, food
    try {
      await executor.obtain(milestone.goals(state).map(g => ({ ...g, optional: true })), signal)
    } catch (err) {
      log(`End kit short: ${(err as Error).message}`)
    }
    // the bow and some arrows at least, not optional: the crystals are shot (a 26.3 bot went in with its bow worn out
    // and every fight failed at once, 'a bow is needed', five times over in the End)
    if (countItems(bot, 'bow') === 0 || countItems(bot, ['arrow', 'spectral_arrow', 'tipped_arrow']) < END_ARROWS) {
      await executor.obtain([{ item: 'bow', count: 1 }, { item: 'arrow', count: Math.max(END_ARROWS, countItems(bot, 'arrow')) }], signal)
    }
    // back to the portal room when the kit's getting (or the stock's top-ups, a death) took the bot off from it:
    // enterEnd reads the frames within 12 blocks (1.21.11 seed 2: 48 gold mined 26 blocks off, 'no end portal frame
    // around' five times)
    if (inNether(bot)) await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
    if (!portalRoomNear(bot)) {
      log('back to the portal room')
      await executor.task('to the portal room', async (s) => await strongholdToPortalRoom(bot, {}, s), signal)
    }
    // a carved pumpkin on for the island's endermen (carved from a pumpkin and shears held, got when cheap: a pumpkin
    // in sight or remembered, shears from 2 iron)
    if (countItems(bot, 'carved_pumpkin') === 0) {
      const want = [{ item: 'pumpkin', count: 1 }, { item: 'shears', count: 1 }]
      const plan = executor.plan(want)
      if (plan.ok && plan.cost <= PUMPKIN_TICKS) {
        await executor.obtain(want, signal).catch(err => {
          if (signal.aborted || TaskError.is(err, 'DIED')) throw err
          log(`End: no pumpkin: ${(err as Error).message}`)
        })
      }
    }
    if (countItems(bot, 'carved_pumpkin') > 0 || (countItems(bot, 'pumpkin') > 0 && countItems(bot, 'shears') > 0)) {
      await executor.task('a carved pumpkin', async (s) => await carvePumpkin(bot, s), signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`End: no carved pumpkin: ${(err as Error).message}`)
      })
    }
    // a spare kit by the portal room and the respawn point by it, before the End (a death there was the game lost);
    // the kit's chest and bed got (a bed's sheep hunted 80 blocks off), back to the room before they are put down,
    // and again after: enterEnd reads the frames within 12 blocks ('no end portal frame around', 26.3 twice in two)
    const backToRoom = async (): Promise<void> => {
      if (portalRoomNear(bot)) return
      log('back to the portal room')
      await executor.task('to the portal room', async (s) => await strongholdToPortalRoom(bot, {}, s), signal)
    }
    await leaveTripKit(bot, executor, signal, log, backToRoom)
    await backToRoom()
    await executor.task('into the End', async (s) => await enterEnd(bot, { signal: s }), signal)
  }
  // the drops of a death on the island, while they last and lie on ground
  if (isInEnd(bot)) await recoverEndDrops(bot, executor, signal, log)
  if (isInEnd(bot) && countItems(bot, 'carved_pumpkin') > 0) await executor.task('wear the pumpkin', async (s) => await wearPumpkin(bot, s), signal)
  // off the arrival platform over the void to the island first (the fight goes for the podium in a straight line)
  await executor.task('over to the island', async (s) => await crossToIsland(bot, { signal: s }), signal)
  // blocks for the crystals' pillars: the island's end stone dug when the bag runs short of them
  const blocks = countItems(bot, SCAFFOLD_ITEMS)
  if (blocks < END_BLOCKS) {
    log(`End: ${blocks} blocks to pillar with: digging end stone`)
    // room for it (a full bag dug none, 'NO_SPACE', and the fights failed five times at once, 'short of blocks to
    // pillar up', 26.3)
    // (a bag of what's never thrown away stays full: the fight goes on with the blocks there are)
    if ((bot.inventory.emptySlotCount?.() ?? 9) < 2) {
      await executor.makeRoom?.({ end_stone: 64, arrow: 64, ender_pearl: 16 }, signal, true)?.catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`End: no room for end stone: ${(err as Error).message}`)
      })
    }
    // the island's top layer only, round the bot and not under it: the nearest end stone dug a pit the bot stood in
    // at y 49, every crystal's pillar spot out of the pathfinder's reach (26.3)
    const top = endStoneTopLayer(bot, END_BLOCKS - blocks)
    await executor.task('end stone', async (s) => await collectBlock(bot, top.length > 0 ? { positions: top } : { names: ['end_stone'], count: END_BLOCKS - blocks, maxDistance: 32 }, s), signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`End: end stone: ${(err as Error).message}`)
    })
  }
  const fight = await executor.task('fight the dragon', async (s) => await fightDragon(bot, { signal: s, log: line => log(`dragon: ${line}`) }), signal)
  log(`dragon ${fight.killed ? 'killed' : 'not killed'} in ${fight.ticks} ticks (${fight.meleeHits} hits, ${fight.arrows} arrows, ${fight.arrowHits} of them hits)`)
  if (!fight.killed) return
  // the milestone's check: vanilla's end/kill_dragon advancement
  bot.survival.advancements.add('end/kill_dragon')
  // the gateway the kill opened on the ring (EnderDragonFight.spawnNewGateway), for the elytra's trip
  rememberGateways(bot, visibleGateways(bot))
  if (isInEnd(bot)) await executor.task('out of the End', async (s) => await leaveEnd(bot, { signal: s }), signal)
}

/** what a farm's start may cost (a hoe and the seeds from grass) before it is left for later */
export const FARM_START_TICKS = 2000

/**
 * Sows a farm of wheat by water near home when none is sown yet and its start is cheap (water within 24 blocks with
 * ground by it, the hoe and seeds for FARM_START_TICKS or less): the renewable food of day 1, harvested when it has
 * grown, while the hunt or the berries feed the bot now. Resolves whether one was sown.
 */
export async function startFarm (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<boolean> {
  const dimension = normalizeDimension(bot.game?.dimension)
  if (dimension !== 'overworld' || knownFarms(executor.memory, dimension).length > 0) return false
  const home = executor.memory.base != null ? new Vec3(executor.memory.base.x, executor.memory.base.y, executor.memory.base.z) : bot.entity.position
  let site = findFarmSite(pos => bot.blockAt(pos) as any, home, 24)
  // no water near: a hole dug and filled from the water bucket held (the herd's wheat farm on 26.3 had none), the
  // empty bucket filled first where there's water within REFILL_RANGE (a 26.3 bot on a mountain with an empty bucket
  // had 'no water with ground by it near: no farm yet', and no farm all game, seed 31337)
  if (site == null && countItems(bot, 'water_bucket') === 0 && countItems(bot, 'bucket') > 0) {
    log('no water by ground near for a farm: the bucket filled for a water hole')
    await refillWater(bot, signal)
  }
  if (site == null && countItems(bot, 'water_bucket') > 0) {
    await executor.task('a water hole for the farm', async (s) => await makeWaterHole(bot, home, s), signal).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
    site = findFarmSite(pos => bot.blockAt(pos) as any, home, 24)
  }
  if (site == null) { log('no water with ground by it near: no farm yet'); return false }
  const plots = Math.min(FARM_PLOTS, site.cells.length)
  const requests = [{ item: '#hoes', count: 1 }, { item: 'wheat_seeds', count: plots }]
  const plan = executor.plan(requests)
  if (!plan.ok || plan.cost > FARM_START_TICKS) { log(`a farm would cost ${plan.ok ? plan.cost : 'no plan'} ticks to start: not now`); return false }
  await executor.obtain(requests, signal)
  const res = await executor.task('sow a farm', async (s) => await plantFarm(bot, { seed: 'wheat_seeds', center: site.water, plots, radius: 4 }, s), signal)
  rememberFarm(executor.memory, res, Number((bot.time as any)?.age ?? 0), dimension)
  log(`a farm of ${res.cells.length} wheat sown by the water at ${res.water.toString()}`)
  return true
}

/** how far a grown farm is gone back to for its harvest when food is wanted */
export const FARM_RANGE = 96

/**
 * The renewable food first: a farm the bot sowed that has grown (Executor.farmCost: nothing left to wait), within
 * FARM_RANGE, harvested and sown again, and its wheat baked into bread. Resolves the bread made.
 */
export async function harvestGrownFarms (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void, bake = true): Promise<number> {
  const dimension = normalizeDimension(bot.game?.dimension)
  let bread = 0
  for (const farm of knownFarms(executor.memory, dimension)) {
    const walk = bot.entity.position.distanceTo(farm.water)
    const cost = executor.farmCost(farm.crop)
    if (walk > FARM_RANGE || cost == null || cost > walk * 5 + 1) continue
    const item = farm.crop === 'wheat' ? 'wheat' : farm.crop === 'beetroots' ? 'beetroot' : SEED_OF[farm.crop]
    log(`the ${farm.crop} at ${farm.water.toString()} has grown: harvesting it`)
    await executor.runStep({ kind: 'farm', item, count: farm.cells.length, crop: farm.crop, seed: SEED_OF[farm.crop], plots: 0, cycles: 1, cost }, signal)
  }
  const wheat = countItems(bot, 'wheat')
  if (bake && wheat >= 3) {
    const before = countItems(bot, 'bread')
    await executor.obtain([{ item: 'bread', count: before + Math.floor(wheat / 3) }], signal)
    bread = countItems(bot, 'bread') - before
  }
  return bread
}

/** food: a grown farm harvested and the farm started (the renewable food), then the points from the cheapest source */
export const foodHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  try {
    await harvestGrownFarms(bot, executor, signal, log)
    await startFarm(bot, executor, signal, log)
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`no farm: ${(err as Error).message}`)
  }
  await executor.obtain(milestone.goals(state), signal)
}

/** the handlers play uses unless bot.survival.handlers or its options name others */
export const MILESTONE_HANDLERS = {
  food: foodHandler,
  enchanting: enchantingHandler,
  nether: netherHandler,
  eyes: eyesHandler,
  end: endHandler
}
