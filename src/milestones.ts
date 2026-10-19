// The milestone handlers past the overworld's gear, over the nether, stronghold and End skills: the nether (a portal
// built and gone through, blaze rods at a fortress's spawner, pearls by bartering or from endermen, and back), the
// eyes (crafted, thrown and crossed to the stronghold, down to its portal room) and the End (the frame filled and gone
// through, the dragon fought, out by the exit portal). Each skill runs as one foreground task, so the reflexes still
// preempt it (it starts over after).
import type { Bot } from 'mineflayer'
import { BOOKSHELVES, EYES_FOR_FRAME, EYES_TARGET, eyesForPortal } from './planner/progression'
import type { MilestoneHandler } from './runner'
import { barterForPearls, blockGetter, buildPortal, castPortalAway, collectBlazeRods, enterNether, findFortress, huntEndermen, isAdultPiglin, returnOverworld, withNetherSafety } from './nether/skills'
import { travel } from './skills/travel'
import { dayPhase } from './planner/schedule'
import { findLavaSources, isLavaSource, lavaPools } from './nether/portal'
import { obsidianFromLava, refillWater } from './nether/obsidian'
import { descendTo, ensureSurface, spiralWaypoints } from './executor/explore'
import { moveNear } from './skills/gridWalk'
import { tunnelTo } from './skills/tunnel'
import { isAbort, isSkillError } from './skills/errors'
import type { ExploreOptions } from './nether/fortress'
import { craftEyes, overland, strongholdToPortalRoom } from './end/strongholdSkills'
import { crossToIsland, enterEnd, fightDragon, gotoNear, isInEnd, leaveEnd, readPortalRoom, SCAFFOLD_ITEMS } from './end/skills'
import { collectBlock } from './skills/collectBlock'
import { countBookshelves, enchant, enchantGear, findEnchantingTable } from './skills/enchant'
import { applyBooks } from './skills/anvil'
import { experience, gainLevels } from './skills/xp'
import { BREEDING_FOOD, breedAnimals, gatherHerd, isAdult, releaseAnimals } from './skills/husbandry'
import { makeWaterHole, plantSugarCane } from './skills/caneFarm'
import { carvePumpkin, wearPumpkin } from './skills/pumpkin'
import { TRIP_KIT, stashTripKit } from './skills/tripKit'
import { pickupDrops } from './skills/pickupDrops'
import { countItems, waitTicks } from './skills/util'
import { normalizeDimension, type WorldMemory } from './core/memory'
import { TaskError } from './core/errors'
import { FARM_PLOTS } from './core/crops'
import { findFarmSite, knownFarms, plantFarm, rememberFarm, SEED_OF } from './skills/farm'
import type { Executor } from './executor/executor'
import { Vec3 } from 'vec3'

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

/** ticks the enchanting milestone may spend growing its herd for the books' leather (lockstep: days of game time) */
export const HERD_BUDGET_TICKS = 150000
/** a wait between the herd's chores, by the herd */
export const HERD_CHORE_TICKS = 3000

/**
 * The herd's next chore for `want` leather: kill the surplus adults when they (beyond the breeders) cover the leather
 * still wanted, else breed (the cows, the wheat and the cooldown permitting) and wait for the calves to grow
 * (24000 ticks, AgeableMob.BABY_START_AGE)
 */
export function herdChore (state: { leather: number, want: number, adults: number, calves: number, wheat: number, timeUp?: boolean }): 'done' | 'kill' | 'breed' {
  const needed = state.want - state.leather
  if (needed <= 0) return 'done'
  if (state.adults - BREEDERS_KEPT >= needed) return 'kill'
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
  const at = home != null ? new Vec3(home.x, home.y, home.z) : bot.entity.position.clone()
  const near = (e: any): boolean => e.position.distanceTo(at) <= 96
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
    if (chore === 'kill') {
      await executor.obtain([{ item: 'leather', count: state.leather + 1 }], signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`herd: no leather: ${(err as Error).message}`)
      })
      continue
    }
    // the farm's wheat for the herd, the strays brought home (cows wander: the herd of 8 let out was 5 to 8 by home
    // over 150000 ticks, its calves gone off), and the pairs ready
    await harvestGrownFarms(bot, executor, signal, log, false).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
    await executor.task('gather the herd', async (s) => await gatherHerd(bot, at, { mob: 'cow' }, s), signal).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
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

export const enchantingHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  await keepFarms(bot, executor, signal, log)
  // the wheat farm the herd is fed from (seeds held, water near)
  await startFarm(bot, executor, signal, log).catch(err => { if (signal.aborted || TaskError.is(err, 'DIED')) throw err })
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
  const cap = shelvesForLeather({ count: (n: string) => countItems(bot, n) }, cows, around)
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
  const sources = bot.findBlocks({ matching: id, maxDistance: 96, count: 4096 })
    .filter(p => isLavaSource({ name: 'lava', properties: (bot.blockAt(p) as any)?.getProperties?.() } as any))
    .map(p => ({ x: p.x, y: p.y, z: p.z }))
  return lavaPools(sources, bot.entity.position, PORTAL_LAVA).map(p => p.center)
}

/** the nearest pool of PORTAL_LAVA lava sources or more in the loaded chunks (96 blocks round), its middle */
export function nearestLavaPool (bot: Bot): { x: number, y: number, z: number } | null {
  const id = bot.registry.blocksByName.lava?.id
  if (id == null || typeof bot.findBlocks !== 'function') return null
  const sources = bot.findBlocks({ matching: id, maxDistance: 96, count: 4096 })
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
    await executor.task('build a nether portal', async (s) => await buildPortal(bot, { method: 'obsidian' }, s), signal)
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
      await executor.task('mine the obsidian', async (s) => await withNetherSafety(bot, async () => await collectBlock(bot, { positions: natural.slice(0, PORTAL_OBSIDIAN - count('obsidian')), pickup: true }, s)), signal)
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
        await tunnelTo(bot, { target: at, range: 5 }, s)
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
        if (signal.aborted || TaskError.is(err, 'DIED') || !isSkillError(err, 'NOT_FOUND')) throw err
        log(`a portal frame: ${(err as Error).message}: the lava carried up to a cast on the surface`)
      }
      // no shore either: the pool's lava carried up in buckets (more made from the iron) to a cast on flat ground
      const lava = findLavaSources(blockGetter(bot), bot.entity.position, 16).map(p => new Vec3(p.x, p.y, p.z))
      await executor.obtain([{ item: 'bucket', count: LAVA_BUCKETS }], signal).catch(err => {
        if (signal.aborted || TaskError.is(err, 'DIED')) throw err
        log(`buckets: ${(err as Error).message}`)
      })
      await executor.task('up to the surface', async (s) => await ensureSurface(bot, s), signal)
      await executor.task('cast a portal', async (s) => await castPortalAway(bot, lava, Math.max(1, countItems(bot, 'bucket')), s), signal)
      return
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`a portal frame at that pool: ${(err as Error).message}`)
    }
  }
  }
  log(`a portal frame: no pool to cast by, ${count('obsidian')} obsidian: getting obsidian`)
  await executor.obtain([{ item: 'obsidian', count: PORTAL_OBSIDIAN }], signal)
  await placeFromObsidian()
}

/** a lava pool is tried this many times at most (a death or a lost bucket the first time) */
export const POOL_TRIES = 2
/** legs walked for lava when every pool near is tried */
export const PORTAL_LEGS = 3
/** a leg's length */
export const PORTAL_LEG = 128

/** the depth of the deep caves' lava lakes (the aquifers' lava level, y -54 and under) the portal's search goes down to */
export const DEEP_LAVA_Y = -50

/** the empty buckets a cast carried up from far lava takes its lava in, a trip */
export const LAVA_BUCKETS = 5

/** a frame's obsidian, and the lava sources to cast one from */
export const PORTAL_OBSIDIAN = 10
export const PORTAL_LAVA = 10

export const netherHandler: MilestoneHandler = async ({ bot, executor, signal, log }) => {
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
    await executor.task('into the nether', async (s) => await enterNether(bot, { build: true }, s), signal)
  }
  const needs = netherNeeds({ count })
  if (needs.rods > 0) {
    log(`blaze rods: ${needs.rods} to get`)
    // a fortress first: the spawner is looked for in the one in view (the arrival is seldom by one)
    const spawner = executor.memory.getPois('blaze_spawner', { dimension: 'the_nether', near: bot.entity.position })[0]
    if (spawner == null) {
      const route = fortressRoute(executor.memory, bot.entity.position)
      const found = await executor.task('find a fortress', async (s) => await findFortress(bot, { explore: route }, s), signal)
      log(`a fortress at ${found.fortress.center.x} ${found.fortress.center.y} ${found.fortress.center.z} (${found.via}, ${found.ticks} ticks)`)
    }
    // the rods wanted fixed before the task (a restart after a reflex read the rods held again and wanted 8 more: a
    // 26.3 bot fought at the spawner with 43 rods until a blaze killed it)
    const rods = count('blaze_rod') + needs.rods
    await executor.task('blaze rods', async (s) => await collectBlazeRods(bot, { count: rods, spawner }, s), signal)
  }
  const pearls = netherNeeds({ count }).pearls
  if (pearls > 0) {
    log(`ender pearls: ${pearls} to get`)
    await pearlsInTheNether(bot, executor, count('ender_pearl') + pearls, signal, log)
  }
  await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
  // what the nether didn't give: the overworld's endermen by night
  const still = netherNeeds({ count }).pearls
  if (still > 0) {
    log(`ender pearls: ${still} short: the endermen of the overworld's nights`)
    await pearlsByNight(bot, executor, count('ender_pearl') + still, signal, log)
  }
}

/** blocks a pearl search in the nether goes on each leg looking for piglins or endermen */
export const PEARL_LEG = 96
/** rounds of the overworld's night hunt at most (a hunt, a leg, a day's levels each) */
export const PEARL_ROUNDS = 200
/** game ticks the overworld's night hunt for endermen may take (3 days) */
export const PEARL_NIGHTS_TICKS = 72000

/**
 * Pearls in the nether up to `want`: gold bartered with the adult piglins in sight, endermen hunted where they are
 * (the warped forest, the soul sand valleys), the nether walked on in legs of PEARL_LEG blocks to find either, a few
 * legs at most; resolves the pearls held (never throws for none found: the overworld's nights are next)
 */
export async function pearlsInTheNether (bot: Bot, executor: Executor, want: number, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  const count = (name: string): number => countItems(bot, name)
  for (let leg = 0; leg < 4 && count('ender_pearl') < want; leg++) {
    if (signal.aborted) throw signal.reason
    const piglin = Object.values(bot.entities).some(e => isAdultPiglin(bot, e) && e.position.distanceTo(bot.entity.position) <= 48)
    const enderman = Object.values(bot.entities).some(e => e.name === 'enderman' && e.position.distanceTo(bot.entity.position) <= 48)
    try {
      if (piglin && count('gold_ingot') > 0) {
        await executor.task('barter for pearls', async (s) => await barterForPearls(bot, { pearls: want, range: 48 }, s), signal)
        continue
      }
      if (enderman) {
        await executor.task('endermen for pearls', async (s) => await huntEndermen(bot, { pearls: want - count('ender_pearl'), range: 48, maxTicks: 6000 }, s), signal)
        continue
      }
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`ender pearls: ${(err as Error).message}`)
    }
    // on to find piglins or endermen: a leg along the next of the fortress search's walks
    const route = fortressRoute(executor.memory, bot.entity.position)
    const dir = route.axis === 'x' ? new Vec3(route.direction as number, 0, 0) : new Vec3(0, 0, route.direction as number)
    const to = bot.entity.position.plus(dir.scaled(PEARL_LEG))
    log(`ender pearls: ${count('ender_pearl')} of ${want}: on to ${to.floored().toString()} for piglins or endermen`)
    await executor.task('a leg for pearls', async (s) => await withNetherSafety(bot, async () => await travel(bot, {
      target: to,
      range: 8,
      onHop: () => Object.values(bot.entities).some(e => (e.name === 'enderman' || (isAdultPiglin(bot, e) && count('gold_ingot') > 0)) && e.position.distanceTo(bot.entity.position) <= 48)
    }, s)), signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`ender pearls: the leg: ${(err as Error).message}`)
    })
  }
  return count('ender_pearl')
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
  for (let round = 0; round < PEARL_ROUNDS && count('ender_pearl') < want && executor.tasks.tick - start < PEARL_NIGHTS_TICKS; round++) {
    if (signal.aborted) throw signal.reason
    const night = dayPhase(bot.time?.timeOfDay ?? 0) !== 'day'
    try {
      if (!night) {
        await executor.task('levels by day', async (s) => await gainLevels(bot, { level: 30, maxTicks: 3000 }, s), signal)
          .catch(async () => { await executor.task('wait for the night', async (s) => { await waitTicks(bot, 1000, s) }, signal) })
        continue
      }
      const enderman = Object.values(bot.entities).some(e => e.name === 'enderman' && e.position.distanceTo(bot.entity.position) <= 64)
      if (enderman) {
        await executor.task('endermen for pearls', async (s) => await huntEndermen(bot, { pearls: want - count('ender_pearl'), range: 64, maxTicks: 3000 }, s), signal)
        continue
      }
      const center = executor.memory.base != null ? new Vec3(executor.memory.base.x, executor.memory.base.y, executor.memory.base.z) : bot.entity.position
      const point = spiralWaypoints(center, 48, 240)[leg++ % 24]
      await executor.task('a night leg for endermen', async (s) => await overland(bot, {
        target: new Vec3(point.x, bot.entity.position.y, point.z),
        range: 8,
        onHop: () => Object.values(bot.entities).some(e => e.name === 'enderman' && e.position.distanceTo(bot.entity.position) <= 64)
      }, s), signal)
    } catch (err) {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`ender pearls by night: ${(err as Error).message}`)
    }
  }
  log(`ender pearls: ${count('ender_pearl')} of ${want} after ${executor.tasks.tick - start} ticks of the overworld's nights`)
  return count('ender_pearl')
}

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

/**
 * The trip kit left by the bot (skills/tripKit) unless one with something in it is known: a chest got (and a bed when
 * cheap), the spares put in, the respawn point set by it
 */
export async function leaveTripKit (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  const known = executor.memory.getPois(TRIP_KIT, { dimension: 'overworld', near: bot.entity.position })[0]
  if (known != null && Object.values(executor.memory.chestAt(known, 'overworld')?.items ?? {}).some(n => n > 0)) return
  try {
    const beds = bot.registry.itemsArray.map(i => i.name).filter(n => n.endsWith('_bed'))
    const hasBed = bot.inventory.items().some(i => i.name.endsWith('_bed'))
    for (const want of [[{ item: 'chest', count: 1 }], ...(hasBed ? [] : [[{ item: beds, count: 1 }]])]) {
      const plan = executor.plan(want)
      if (plan.ok && plan.cost <= TRIP_KIT_TICKS) await executor.obtain(want, signal)
    }
    const kit = await executor.task('leave a trip kit', async (s) => await stashTripKit(bot, executor.memory, s), signal)
    log(`trip kit at ${kit.chest.toString()}: ${Object.entries(kit.stored).map(([n, c]) => `${c} ${n}`).join(', ')}${kit.bed != null ? ', the respawn point by it' : ''}`)
  } catch (err) {
    if (signal.aborted || TaskError.is(err, 'DIED')) throw err
    log(`no trip kit: ${(err as Error).message}`)
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

/** ticks a pumpkin and shears for the End's carved pumpkin may cost (the plan's estimate) */
export const PUMPKIN_TICKS = 2000

/** blocks to have for the crystals' pillars (the caged ones are 76 to 103 high, the ground at 64) */
export const END_BLOCKS = 64

export const endHandler: MilestoneHandler = async ({ bot, milestone, state, executor, signal, log }) => {
  if (!isInEnd(bot)) {
    // the End kit: a bow, arrows, blocks to pillar, a water bucket, food
    try {
      await executor.obtain(milestone.goals(state).map(g => ({ ...g, optional: true })), signal)
    } catch (err) {
      log(`End kit short: ${(err as Error).message}`)
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
    // a spare kit by the portal room and the respawn point by it, before the End (a death there was the game lost)
    await leaveTripKit(bot, executor, signal, log)
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
    await executor.task('end stone', async (s) => await collectBlock(bot, { names: ['end_stone'], count: END_BLOCKS - blocks, maxDistance: 32 }, s), signal).catch(err => {
      if (signal.aborted || TaskError.is(err, 'DIED')) throw err
      log(`End: end stone: ${(err as Error).message}`)
    })
  }
  const fight = await executor.task('fight the dragon', async (s) => await fightDragon(bot, { signal: s, log: line => log(`dragon: ${line}`) }), signal)
  log(`dragon ${fight.killed ? 'killed' : 'not killed'} in ${fight.ticks} ticks (${fight.meleeHits} hits, ${fight.arrows} arrows)`)
  if (!fight.killed) return
  // the milestone's check: vanilla's end/kill_dragon advancement
  bot.survival.advancements.add('end/kill_dragon')
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
  // no water near: a hole dug and filled from the water bucket held (the herd's wheat farm on 26.3 had none)
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
