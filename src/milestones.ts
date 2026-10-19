// The milestone handlers past the overworld's gear, over the nether, stronghold and End skills: the nether (a portal
// built and gone through, blaze rods at a fortress's spawner, pearls by bartering or from endermen, and back), the
// eyes (crafted, thrown and crossed to the stronghold, down to its portal room) and the End (the frame filled and gone
// through, the dragon fought, out by the exit portal). Each skill runs as one foreground task, so the reflexes still
// preempt it (it starts over after).
import type { Bot } from 'mineflayer'
import { BOOKSHELVES, EYES_FOR_FRAME, EYES_TARGET, eyesForPortal } from './planner/progression'
import type { MilestoneHandler } from './runner'
import { blockGetter, buildPortal, collectBlazeRods, enterNether, findFortress, obtainPearls, returnOverworld } from './nether/skills'
import { findLavaSources, isLavaSource, lavaPools } from './nether/portal'
import { obsidianFromLava } from './nether/obsidian'
import { ensureSurface } from './executor/explore'
import { moveNear } from './skills/gridWalk'
import { tunnelTo } from './skills/tunnel'
import { isAbort, isSkillError } from './skills/errors'
import type { ExploreOptions } from './nether/fortress'
import { craftEyes, strongholdToPortalRoom } from './end/strongholdSkills'
import { crossToIsland, enterEnd, fightDragon, isInEnd, leaveEnd, readPortalRoom, SCAFFOLD_ITEMS } from './end/skills'
import { collectBlock } from './skills/collectBlock'
import { countBookshelves, enchant, enchantGear, findEnchantingTable } from './skills/enchant'
import { applyBooks } from './skills/anvil'
import { experience } from './skills/xp'
import { BREEDING_FOOD, breedAnimals, isAdult, releaseAnimals } from './skills/husbandry'
import { plantSugarCane } from './skills/caneFarm'
import { carvePumpkin, wearPumpkin } from './skills/pumpkin'
import { countItems } from './skills/util'
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
    if (countItems(bot, egg) > 0) await tryIt(`let out the ${egg.replace('_spawn_egg', '')}s`, async (s) => `${await releaseAnimals(bot, { egg }, s)} let out`)
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
  await executor.obtain(milestone.goals(state), signal)
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

/** the nearest pool of PORTAL_LAVA lava sources or more in the loaded chunks (96 blocks round), its middle */
export function nearestLavaPool (bot: Bot): { x: number, y: number, z: number } | null {
  const id = bot.registry.blocksByName.lava?.id
  if (id == null || typeof bot.findBlocks !== 'function') return null
  const sources = bot.findBlocks({ matching: id, maxDistance: 96, count: 4096 })
    .filter(p => isLavaSource({ name: 'lava', properties: (bot.blockAt(p) as any)?.getProperties?.() } as any))
    .map(p => ({ x: p.x, y: p.y, z: p.z }))
  return lavaPools(sources, bot.entity.position, PORTAL_LAVA)[0]?.center ?? null
}

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
      let lava = findLavaSources(blockGetter(bot), bot.entity.position, 16).length
      if (lava < PORTAL_LAVA && count('obsidian') < PORTAL_OBSIDIAN) {
        // a pool in the loaded chunks (the client has the caves' blocks too: the lava lakes deep down), gone to
        const pool = nearestLavaPool(bot)
        if (pool != null) {
          log(`a portal frame: the lava pool at ${pool.x.toFixed(0)} ${pool.y.toFixed(0)} ${pool.z.toFixed(0)}`)
          await executor.task('to the lava', async (s) => await moveNear(bot, new Vec3(pool.x, pool.y, pool.z), 5, s).catch(async err => {
            if (isAbort(err)) throw err
            await tunnelTo(bot, { target: new Vec3(pool.x, pool.y, pool.z), range: 5 }, s)
          }), signal)
          lava = findLavaSources(blockGetter(bot), bot.entity.position, 16).length
        }
      }
      if (lava < PORTAL_LAVA && count('obsidian') < PORTAL_OBSIDIAN) {
        log(`a portal frame: ${lava} lava sources near, ${count('obsidian')} obsidian: getting obsidian`)
        await executor.obtain([{ item: 'obsidian', count: PORTAL_OBSIDIAN }], signal)
      }
      log('building a nether portal')
      try {
        await executor.task('build a nether portal', async (s) => await buildPortal(bot, {}, s), signal)
      } catch (err) {
        if (signal.aborted || TaskError.is(err, 'DIED') || !isSkillError(err, 'CANNOT_PLACE')) throw err
        // no room by the lava for the cast's mould (a cave's lake): obsidian made from the pool with the water
        // bucket and mined, and the frame placed from it up on the surface
        log(`a portal frame: ${(err as Error).message}: obsidian from the lava instead`)
        await executor.task('obsidian from the lava', async (s) => await obsidianFromLava(bot, PORTAL_OBSIDIAN, s), signal)
        await executor.task('up to the surface', async (s) => await ensureSurface(bot, s), signal)
        await executor.task('build a nether portal', async (s) => await buildPortal(bot, { method: 'obsidian' }, s), signal)
      }
    }
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
    await executor.task('blaze rods', async (s) => await collectBlazeRods(bot, { count: count('blaze_rod') + needs.rods, spawner }, s), signal)
  }
  const pearls = netherNeeds({ count }).pearls
  if (pearls > 0) {
    log(`ender pearls: ${pearls} to get`)
    await executor.task('ender pearls', async (s) => await obtainPearls(bot, { pearls: count('ender_pearl') + pearls }, s), signal)
  }
  await executor.task('back to the overworld', async (s) => await returnOverworld(bot, {}, s), signal)
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
    await executor.task('into the End', async (s) => await enterEnd(bot, { signal: s }), signal)
  }
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
  const site = findFarmSite(pos => bot.blockAt(pos) as any, home, 24)
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
export async function harvestGrownFarms (bot: Bot, executor: Executor, signal: AbortSignal, log: (line: string) => void): Promise<number> {
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
  if (wheat >= 3) {
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
