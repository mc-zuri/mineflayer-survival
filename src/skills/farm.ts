// farm: a few plots by water tilled with a hoe and sown (wheat from the seeds grass drops, or carrots, potatoes,
// beetroots), the grown crops harvested and sown again. A renewable food the bot can start on day 1 and come back to.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { FARM_PLOTS, GROW_TICKS, GROWN_AGE, isGrown, type FarmRecord } from '../core/crops'
import type { WorldMemory } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { siteLookup } from './spawnProtection'
import { collectBlock } from './collectBlock'
import { navigateToReach } from './navigate'
import { pickupDrops } from './pickupDrops'
import { makeWaterHole } from './caneFarm'
import { dig } from '../core/actions'
import { isSource } from './bucket'
import { countItems, findInventoryItem, resyncInventory, settleInventory, trace, waitTicks, waitUntil, type Block } from './util'

/** what each crop is sown from (vanilla's seed items: CropBlock.getBaseSeedId) */
export const SEED_OF: Readonly<Record<string, string>> = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds'
}

/** the crop block a seed item grows */
export function cropOf (seed: string): string | null {
  return Object.keys(SEED_OF).find(c => SEED_OF[c] === seed) ?? null
}

/** blocks a hoe tills into farmland (HoeItem.TILLABLES: grass, dirt path and dirt) */
export const TILLABLE = new Set(['grass_block', 'dirt', 'dirt_path'])

/**
 * blocks a hoe turns into dirt first, a second use tilling that (HoeItem.TILLABLES: coarse dirt to dirt, rooted dirt
 * to dirt and a hanging roots dropped): the ground of a taiga's farm
 */
export const TILLED_TWICE = new Set(['coarse_dirt', 'rooted_dirt'])

/** ground a farm's plot can be made of: tilled once or twice, or farmland already (a plot left bare) */
export function plotGround (name: string | undefined): boolean {
  return name != null && (TILLABLE.has(name) || TILLED_TWICE.has(name) || name === 'farmland')
}

/** FarmBlock.isNearWater: water within 4 blocks across and at the farmland's level or a block over */
export const HYDRATION_RANGE = 4

/**
 * how far across from its water a farm's plots go (a block of 5 by 5 round it, every cell within HYDRATION_RANGE of
 * the one water)
 */
export const FARM_REACH = 2

/** the plots a new farm has at the least: a water with fewer by it is no farm's (a water hole is dug instead) */
export const FARM_MIN_PLOTS = 6

export type Lookup = (pos: Vec3) => { name: string, boundingBox?: string, getProperties?: () => Record<string, unknown> } | null

const OPEN_ABOVE = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'dandelion', 'poppy', 'snow'])

/**
 * The cells about a farm's water its crops go in, the nearest first: the rows along x of the block round it (FARM_REACH
 * across) whose z is the water's or 2 off it, the rows between them tilled and left bare (spacerCells). CropBlock.
 * getGrowthSpeed adds the moist farmland under and about a crop to its speed and halves it when the same crop stands
 * beside it both along x and along z, or on a diagonal: a crop in a row between bare farmland grows a stage at 1 in 3
 * or 4 of its random ticks, one in a solid block at 1 in 6 to 9 (a 1.21.11 farm of 12 in a block had none grown 65000
 * ticks after its sowing, f5-1.21.11)
 */
export function farmBlockCells (water: Vec3): Vec3[] {
  const out: Vec3[] = []
  for (let dx = -FARM_REACH; dx <= FARM_REACH; dx++) {
    for (let dz = -FARM_REACH; dz <= FARM_REACH; dz += 2) {
      if (dx !== 0 || dz !== 0) out.push(water.offset(dx, 0, dz))
    }
  }
  return out.sort((a, b) => a.distanceSquared(water) - b.distanceSquared(water))
}

/** the bare farmland rows between a farm's crop rows (farmBlockCells), the nearest first */
export function spacerCells (water: Vec3): Vec3[] {
  const out: Vec3[] = []
  for (let dx = -FARM_REACH; dx <= FARM_REACH; dx++) {
    for (const dz of [-1, 1]) out.push(water.offset(dx, 0, dz))
  }
  return out.sort((a, b) => a.distanceSquared(water) - b.distanceSquared(water))
}

/** the cells about a water a plot can be made on now (farmBlockCells): plot ground, open above (a plant there is broken first) */
export function plotCells (lookup: Lookup, water: Vec3, plots = Infinity): Vec3[] {
  const cells: Vec3[] = []
  for (const cell of farmBlockCells(water)) {
    if (cells.length >= plots) break
    if (!plotGround(lookup(cell)?.name)) continue
    if (!OPEN_ABOVE.has(lookup(cell.offset(0, 1, 0))?.name ?? 'stone')) continue
    cells.push(cell)
  }
  return cells
}

/**
 * Where to sow: a water source with up to `plots` cells of plot ground about it at its level (plotCells: a block of
 * 5 by 5 round it), open above, the nearest to the water first, `least` of them at the least. The water's cell is the
 * farm's place. Null when no water near `center` has them.
 */
export function findFarmSite (lookup: Lookup, center: Vec3, radius = 24, plots = FARM_PLOTS, least = 1): { water: Vec3, cells: Vec3[] } | null {
  let best: { water: Vec3, cells: Vec3[], score: number } | null = null
  const c = center.floored()
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -4; dy <= 4; dy++) {
        const w = c.offset(dx, dy, dz)
        const b = lookup(w)
        if (b?.name !== 'water' || Number(b.getProperties?.().level ?? 0) !== 0) continue
        if (!OPEN_ABOVE.has(lookup(w.offset(0, 1, 0))?.name ?? 'stone')) continue
        const cells = plotCells(lookup, w, plots)
        if (cells.length === 0 || cells.length < Math.min(least, plots)) continue
        const score = cells.length * 100 - w.distanceTo(c)
        if (best == null || score > best.score) best = { water: w, cells, score }
      }
    }
  }
  return best == null ? null : { water: best.water, cells: best.cells }
}

const HOLDS_WATER = (name: string | undefined): boolean => name != null && !OPEN_ABOVE.has(name) && name !== 'water' && name !== 'lava' && name !== 'farmland'
/** the natural ground a farm's hole is dug in (never a block of the base's) */
const HOLE_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'dirt_path'])

/**
 * A cell to dig a farm's water hole in (no water near home has plot ground by it): a ground block with solid blocks on
 * its four sides and under it (the water poured in stays: FlowingFluid spreads only into a cell open at its level or
 * under), open above, with the most cells of plot ground about it (plotCells: room for the farm to grow; `least` of
 * them at the least), then the nearest to `center`; not under the bot (its cell and the ring about it). The cane farm's hole
 * (waterHoleSite) takes podzol as ground, which no hoe tills: a 1.21.11 bot's hole by its home in an old growth pine
 * taiga had no plot by it and its farm was never sown, all game (f5-1.21.11, seed 671229120248951486, t76740).
 */
export function farmHoleSite (lookup: Lookup, center: Vec3, radius = 12, least = FARM_MIN_PLOTS, avoid: (pos: Vec3) => boolean = () => false): Vec3 | null {
  const c = center.floored()
  let best: { p: Vec3, cells: number, d: number } | null = null
  for (let dy = -3; dy <= 2; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy >= -2) continue
        const p = c.offset(dx, dy, dz)
        if (avoid(p) || !HOLE_GROUND.has(lookup(p)?.name ?? '') || !OPEN_ABOVE.has(lookup(p.offset(0, 1, 0))?.name ?? 'stone')) continue
        if (!HOLDS_WATER(lookup(p.offset(0, -1, 0))?.name)) continue
        if (![[1, 0], [-1, 0], [0, 1], [0, -1]].every(([x, z]) => HOLDS_WATER(lookup(p.offset(x, 0, z))?.name))) continue
        const cells = plotCells(lookup, p).length
        if (cells < least) continue
        const d = p.distanceTo(c)
        if (best == null || cells > best.cells || (cells === best.cells && d < best.d)) best = { p, cells, d }
      }
    }
  }
  return best?.p ?? null
}

/** the cells of a farm (its farmland) that have a crop of `crop` grown on them */
export function grownPlots (lookup: Lookup, cells: readonly Vec3[], crop: string): Vec3[] {
  return cells.filter(c => { const b = lookup(c.offset(0, 1, 0)); return b?.name === crop && isGrown(b) })
}

/**
 * The plots grown or a stage short of it: the ones a wait of a couple of minutes may see grown (CropBlock.randomTick:
 * a stage at a random tick's 1 in 25 / speed + 1, minutes a stage)
 */
export function nearlyGrownPlots (lookup: Lookup, cells: readonly Vec3[], crop: string): Vec3[] {
  const grown = GROWN_AGE[crop]
  return cells.filter(c => {
    const b = lookup(c.offset(0, 1, 0))
    if (b?.name !== crop) return false
    return grown == null || isGrown(b) || Number((b as any).getProperties?.().age ?? 0) >= grown - 1
  })
}

/**
 * Ticks till half a farm's plots have grown, read off its crops' ages (the plot at the middle of them by age: its stages
 * left at GROW_TICKS / GROWN_AGE a stage, CropBlock.randomTick's average; a bare plot at age 0); null when a plot's
 * chunk isn't loaded (its crop unknown). A farm sown long ago may not have grown: its random ticks come only within the
 * simulation distance of a player, and in the light (CropBlock: a brightness of 9 at the least). A 1.21.11 bot's farm
 * counted grown by its sowing's age was gone to for a starving meal and gave 'nothing grown' (f5-1.21.11, t145711).
 */
export function growingLeft (lookup: Lookup, cells: readonly Vec3[], crop: string): number | null {
  const grown = GROWN_AGE[crop]
  if (grown == null || cells.length === 0) return null
  const ages: number[] = []
  for (const c of cells) {
    const b = lookup(c.offset(0, 1, 0))
    if (b == null) return null
    ages.push(b.name === crop ? Math.min(grown, Number(b.getProperties?.().age ?? 0)) : 0)
  }
  ages.sort((a, b) => b - a)
  const middle = ages[Math.ceil(ages.length / 2) - 1]
  return Math.round((grown - middle) * GROW_TICKS / grown)
}

/**
 * A farm's plots as they are, for the log: the crops by age, the bare farmland, the plots that are farmland no more
 * (trampled: FarmBlock.fallOn, or dried out to dirt), and the least light over a crop (CropBlock.randomTick grows one
 * only at a brightness of 9 or more)
 */
export function farmCensus (lookup: (pos: Vec3) => any, cells: readonly Vec3[], crop: string): string {
  const ages = new Map<number, number>()
  let bare = 0
  let lost = 0
  let unknown = 0
  let light = Infinity
  for (const c of cells) {
    const ground = lookup(c)
    const above = lookup(c.offset(0, 1, 0))
    if (ground == null || above == null) { unknown++; continue }
    if (ground.name !== 'farmland') { lost++; continue }
    if (above.name !== crop) { bare++; continue }
    const age = Number(above.getProperties?.().age ?? 0)
    ages.set(age, (ages.get(age) ?? 0) + 1)
    if (typeof above.skyLight === 'number') light = Math.min(light, Math.max(above.skyLight, above.light ?? 0))
  }
  const parts = [...ages].sort((a, b) => b[0] - a[0]).map(([a, n]) => `${n} at age ${a}`)
  if (bare > 0) parts.push(`${bare} bare`)
  if (lost > 0) parts.push(`${lost} no farmland`)
  if (unknown > 0) parts.push(`${unknown} not loaded`)
  if (Number.isFinite(light)) parts.push(`light ${light} at the least`)
  return parts.join(', ')
}

async function holdItem (bot: Bot, name: string): Promise<void> {
  const item = findInventoryItem(bot, name)
  if (item == null) throw new SkillError('MISSING_ITEMS', `no ${name} to hold`)
  if (bot.heldItem?.name !== name) await bot.equip(item, 'hand')
}

/** tills a cell with the best hoe held (a plant on it broken first; coarse or rooted dirt tilled twice); resolves once it's farmland */
export async function till (bot: Bot, cell: Vec3, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const above = bot.blockAt(cell.offset(0, 1, 0))
  if (above != null && above.name !== 'air' && above.name !== 'cave_air') await collectBlock(bot, { positions: [above.position], anyTool: true }, signal)
  const hoe = bot.inventory.items().filter(i => i.name.endsWith('_hoe')).sort((a, b) => b.type - a.type)[0]
  if (hoe == null) throw new SkillError('NO_TOOL', 'no hoe to till with')
  await navigateToReach(bot, cell, signal)
  // with a shield in the off hand the hoe tills only sneaking (from 26.3 the tilling is a block transformer, which
  // passes while the player means to raise the shield: BlockTransformer.playerHasBlockingItemUseIntent, not
  // Player.isSecondaryUseActive); the shift reaches the server with a tick's input, before the use
  const sneak = bot.inventory.slots[45]?.name === 'shield' && !bot.getControlState('sneak')
  if (sneak) {
    bot.setControlState('sneak', true)
    await waitTicks(bot, 2, signal)
  }
  try {
    // (coarse or rooted dirt: dirt first, then farmland)
    if (TILLED_TWICE.has(bot.blockAt(cell)?.name ?? '')) await tillHeld(bot, cell, hoe, signal, 'dirt')
    await tillHeld(bot, cell, hoe, signal)
  } finally {
    if (sneak) bot.setControlState('sneak', false)
  }
}

async function tillHeld (bot: Bot, cell: Vec3, hoe: Item, signal?: AbortSignal, into = 'farmland'): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand')
    const block = bot.blockAt(cell) as Block
    await bot.activateBlock(block, new Vec3(0, 1, 0))
    if (await waitUntil(bot, () => bot.blockAt(cell)?.name === into, 10, signal)) return
    // the hand the server holds may not be the one the bag shows (every cell of a 26.3 farm stayed grass after the
    // hoe, crafted just before at a table put away): the inventory settled and the hoe selected afresh, once
    trace('till: no', into, 'at', cell.toString(), 'holding', bot.heldItem?.name ?? 'nothing', 'slot', bot.quickBarSlot, 'above', bot.blockAt(cell.offset(0, 1, 0))?.name ?? '?')
    await settleInventory(bot, signal)
    // the server's own inventory sent again (a craft's output put in a near-full bag may sit elsewhere than the
    // client shows), then the hoe found in it
    await resyncInventory(bot, signal).catch(() => false)
    const other = (bot.quickBarSlot + 1) % 9
    bot.setQuickBarSlot(other)
    await waitUntil(bot, () => false, 2, signal)
    const again = bot.inventory.items().filter(i => i.name === hoe.name)[0] ?? hoe
    await bot.equip(again, 'hand')
  }
  throw new SkillError('VERIFY_FAILED', `${bot.blockAt(cell)?.name ?? 'nothing'} at ${cell.toString()} after the hoe (holding ${bot.heldItem?.name ?? 'nothing'})`)
}

/** sows a seed item on farmland; resolves once the crop stands on it */
export async function sow (bot: Bot, cell: Vec3, seed: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const crop = cropOf(seed)
  if (crop == null) throw new SkillError('MISSING_ITEMS', `${seed} sows no crop`)
  if (bot.blockAt(cell.offset(0, 1, 0))?.name === crop) return
  // (from on the plot too: a seed goes on the farmland under the feet, the crop having no collision. Asked to stand
  // off it, the pathfinder found no way from the plot the harvest left the bot on, and the plot stayed bare)
  await navigateToReach(bot, cell, signal, { outside: false })
  await holdItem(bot, seed)
  await bot.activateBlock(bot.blockAt(cell) as Block, new Vec3(0, 1, 0))
  if (!(await waitUntil(bot, () => bot.blockAt(cell.offset(0, 1, 0))?.name === crop, 10, signal))) {
    throw new SkillError('VERIFY_FAILED', `no ${crop} on ${cell.toString()} after sowing`)
  }
}

export interface FarmResult {
  water: Vec3
  /** the farmland sown */
  cells: Vec3[]
  crop: string
}

/**
 * Starts a farm by water near `center` (or sows more of the farm at `water`): up to `plots` cells tilled and sown with
 * `seed` (as many as the seeds held).
 * The bot never jumps on the farmland it makes (FarmBlock.fallOn tramples it): it works each cell from beside it.
 */
export async function plantFarm (bot: Bot, args: { seed: string, center?: Vec3, plots?: number, radius?: number, water?: Vec3 }, signal?: AbortSignal): Promise<FarmResult> {
  const crop = cropOf(args.seed)
  if (crop == null) throw new SkillError('MISSING_ITEMS', `${args.seed} sows no crop`)
  const seeds = countItems(bot, args.seed)
  if (seeds === 0) throw new SkillError('MISSING_ITEMS', `no ${args.seed}`)
  const plots = Math.min(args.plots ?? FARM_PLOTS, seeds)
  // (no water nor plot in the square about the spawn a server keeps: spawn protection)
  const lookup: Lookup = siteLookup(bot, pos => bot.blockAt(pos) as any)
  // (a farm's own water: its block's plots not made yet, the farm sown further)
  const site = args.water != null
    ? { water: args.water, cells: plotCells(lookup, args.water, plots) }
    : findFarmSite(lookup, args.center ?? bot.entity.position, args.radius ?? 24, plots)
  if (site == null || site.cells.length === 0) throw new SkillError('NOT_FOUND', 'no water with tillable ground beside it')
  const sown: Vec3[] = []
  for (const cell of site.cells) {
    if (countItems(bot, args.seed) === 0) break
    try {
      if (bot.blockAt(cell)?.name !== 'farmland') await till(bot, cell, signal)
      await sow(bot, cell, args.seed, signal)
      sown.push(cell)
    } catch (err) {
      if (isAbort(err) || (err instanceof SkillError && err.code === 'NO_TOOL')) throw err
      trace('plantFarm: the cell at', cell.toString(), 'failed:', (err as Error).message)
    }
  }
  if (sown.length === 0) throw new SkillError('VERIFY_FAILED', `nothing sown by the water at ${site.water.toString()}`)
  // the bare rows between the crops' tilled (moist farmland about a crop speeds it, the same crop beside it on two
  // sides slows it: CropBlock.getGrowthSpeed); a near-water farmland with nothing on it stays (FarmBlock.randomTick)
  for (const cell of spacerCells(site.water)) {
    const name = bot.blockAt(cell)?.name
    if (!TILLABLE.has(name ?? '') && !TILLED_TWICE.has(name ?? '')) continue
    if (!OPEN_ABOVE.has(bot.blockAt(cell.offset(0, 1, 0))?.name ?? 'stone')) continue
    try {
      await till(bot, cell, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('plantFarm: a bare row cell at', cell.toString(), 'failed:', (err as Error).message)
    }
  }
  return { water: site.water, cells: sown, crop }
}

/**
 * Harvests the grown crops of a farm and sows each plot again from what it dropped: returns what came in, by item.
 * The plots not grown yet are left.
 */
export async function harvestFarm (bot: Bot, farm: { cells: readonly Vec3[], crop: string }, signal?: AbortSignal): Promise<Record<string, number>> {
  const seed = SEED_OF[farm.crop]
  const before: Record<string, number> = {}
  const names = [seed, farm.crop === 'wheat' ? 'wheat' : farm.crop === 'beetroots' ? 'beetroot' : seed]
  for (const n of names) before[n] = countItems(bot, n)
  for (const cell of grownPlots(pos => bot.blockAt(pos) as any, farm.cells, farm.crop)) {
    throwIfAborted(signal)
    try {
      await collectBlock(bot, { positions: [cell.offset(0, 1, 0)], anyTool: true }, signal)
      await pickupDrops(bot, { near: cell.offset(0.5, 1, 0.5), radius: 3 }, signal).catch(() => {})
      await settleInventory(bot, signal)
      if (countItems(bot, seed) > 0 && bot.blockAt(cell)?.name === 'farmland') await sow(bot, cell, seed, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('harvestFarm: the plot at', cell.toString(), 'failed:', (err as Error).message)
    }
  }
  const gained: Record<string, number> = {}
  for (const n of names) gained[n] = countItems(bot, n) - before[n]
  return gained
}

/** the farms the memory has (its 'farm' points of interest), with their water, in a dimension */
export function knownFarms (memory: WorldMemory, dimension = 'overworld'): Array<FarmRecord & { water: Vec3 }> {
  const out: Array<FarmRecord & { water: Vec3 }> = []
  for (const poi of memory.getPois('farm', { dimension })) {
    try {
      const rec = JSON.parse(poi.note ?? '') as FarmRecord
      if (typeof rec.crop === 'string' && Array.isArray(rec.cells)) out.push({ ...rec, water: new Vec3(poi.x, poi.y, poi.z) })
    } catch {}
  }
  return out
}

/** whether a crop block at `pos` stands on a plot of one of the bot's farms (knownFarms: the cell under it) */
export function ownFarmCrop (memory: WorldMemory, pos: { x: number, y: number, z: number }, dimension = 'overworld'): boolean {
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y) - 1
  const z = Math.floor(pos.z)
  return knownFarms(memory, dimension).some(f => f.cells.some(([cx, cy, cz]) => cx === x && cy === y && cz === z))
}

/** notes a farm sown at the world's age `age` */
export function rememberFarm (memory: WorldMemory, farm: FarmResult, age: number, dimension = 'overworld'): void {
  const rec: FarmRecord = { crop: farm.crop, cells: farm.cells.map(c => [c.x, c.y, c.z]), sown: age }
  memory.addPoi('farm', farm.water, dimension, JSON.stringify(rec))
}

export function farmCells (rec: FarmRecord): Vec3[] {
  return rec.cells.map(([x, y, z]) => new Vec3(x, y, z))
}

/** the plots a farm's records hold, all its farms in a dimension together */
export function farmPlots (memory: WorldMemory, dimension = 'overworld'): number {
  return knownFarms(memory, dimension).reduce((n, f) => n + f.cells.length, 0)
}

/**
 * Notes a farm sown at `farm.water`: its cells added to the farm the memory has at that water (one record a water,
 * the cells of both), else a new one
 */
export function extendFarm (memory: WorldMemory, farm: FarmResult, age: number, dimension = 'overworld'): FarmRecord {
  const old = knownFarms(memory, dimension).find(f => f.water.equals(farm.water) && f.crop === farm.crop)
  const cells = [...(old?.cells ?? [])]
  for (const c of farm.cells) if (!cells.some(([x, y, z]) => x === c.x && y === c.y && z === c.z)) cells.push([c.x, c.y, c.z])
  const rec: FarmRecord = { crop: farm.crop, cells, sown: old?.sown ?? age }
  if (old != null) memory.removePoi('farm', farm.water, dimension)
  memory.addPoi('farm', farm.water, dimension, JSON.stringify(rec))
  return rec
}

/**
 * Bone meal on a farm's crops not grown yet (BoneMealItem.useOn, CropBlock.performBonemeal: 2 to 5 stages a use),
 * each until it's grown or the bone meal runs out. Resolves the uses.
 */
export async function boneMealFarm (bot: Bot, farm: { cells: readonly Vec3[], crop: string }, signal?: AbortSignal): Promise<number> {
  let uses = 0
  for (const cell of farm.cells) {
    const at = cell.offset(0, 1, 0)
    for (let tries = 0; tries < 4; tries++) {
      throwIfAborted(signal)
      const crop = bot.blockAt(at)
      if (crop?.name !== farm.crop || isGrown(crop as any) || countItems(bot, 'bone_meal') === 0) break
      const age = Number((crop as any).getProperties?.().age ?? 0)
      try {
        await navigateToReach(bot, at, signal)
        await holdItem(bot, 'bone_meal')
        await bot.activateBlock(crop, new Vec3(0, 1, 0))
        uses++
      } catch (err) {
        if (isAbort(err)) throw err
        break
      }
      // the crop's new age with the block's update
      if (!(await waitUntil(bot, () => Number((bot.blockAt(at) as any)?.getProperties?.().age ?? 0) > age, 10, signal))) break
    }
  }
  return uses
}

/**
 * The cells a farm's water is widened by into a spring (makeFarmSpring): east, south and south-east of it, a 2 by 2 of
 * sources each with two others beside it, so one taken by a bucket fills again (FlowingFluid.getNewLiquid: a cell with
 * two sources beside it and a solid block or water under it is a source). The east cell is a crop row's plot, the two
 * south ones a bare row's
 */
export function springCells (water: Vec3): Vec3[] {
  return [water.offset(1, 0, 1), water.offset(1, 0, 0), water.offset(0, 0, 1)]
}

/** whether a farm's water is a spring: its 2 by 2 all sources */
export function isSpring (lookup: (pos: Vec3) => any, water: Vec3): boolean {
  return [water, ...springCells(water)].every(p => isSource(lookup(p), 'water'))
}

/**
 * A farm's water made a spring (springCells: the 2 by 2 of sources a bucket refills at for good, the second farm's hole,
 * the obsidian's casts, the bottles): the water bucket held poured in the south-east cell dug out (makeWaterHole), then
 * the crop and the farmland of the two cells between it and the farm's water dug out, each a source then. The bot's
 * one bucket of water poured into a lone hole by home was its farm's water, and no other water by home had a spot to
 * be seen from: the second farm's hole was never dug (f5-1.21.11 resumed from its base, t151321 to t216626). Resolves
 * whether the water is a spring now.
 */
export async function makeFarmSpring (bot: Bot, water: Vec3, signal?: AbortSignal): Promise<boolean> {
  const lookup = (p: Vec3): any => bot.blockAt(p)
  if (isSpring(lookup, water)) return true
  if (!isSource(lookup(water), 'water')) throw new SkillError('NOT_FOUND', `no water at the farm's ${water.toString()}`)
  if (countItems(bot, 'water_bucket') === 0) throw new SkillError('MISSING_ITEMS', 'no water bucket for the spring')
  const [corner, east, south] = springCells(water)
  if (!isSource(lookup(corner), 'water')) {
    const above = lookup(corner.offset(0, 1, 0))
    if (above != null && above.boundingBox !== 'block' && above.name !== 'air' && above.name !== 'cave_air') {
      await navigateToReach(bot, corner.offset(0, 1, 0), signal)
      await dig(bot, bot.blockAt(corner.offset(0, 1, 0)) as Block, { signal })
    }
    const hole = await makeWaterHole(bot, water, signal, corner)
    if (hole == null) throw new SkillError('VERIFY_FAILED', `no water poured at ${corner.toString()}`)
  }
  for (const cell of [east, south]) {
    throwIfAborted(signal)
    if (isSource(lookup(cell), 'water')) continue
    // (its crop first, then the farmland: the water of the two sources beside it a source there)
    // (a crop not grown broken by hand: collectBlock passes one over till it's grown, 'broke 0 of 1 blocks', f5-1.21.11
    // t223105)
    const above = lookup(cell.offset(0, 1, 0))
    if (above != null && above.name !== 'air' && above.name !== 'cave_air') {
      await navigateToReach(bot, cell.offset(0, 1, 0), signal)
      await dig(bot, bot.blockAt(cell.offset(0, 1, 0)) as Block, { signal })
    }
    if (lookup(cell) != null && lookup(cell).name !== 'water') await collectBlock(bot, { positions: [cell], anyTool: true }, signal)
  }
  await waitUntil(bot, () => isSpring(lookup, water), 60, signal)
  return isSpring(lookup, water)
}

