// farm: a few plots by water tilled with a hoe and sown (wheat from the seeds grass drops, or carrots, potatoes,
// beetroots), the grown crops harvested and sown again. A renewable food the bot can start on day 1 and come back to.
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { FARM_PLOTS, GROWN_AGE, isGrown, type FarmRecord } from '../core/crops'
import type { WorldMemory } from '../core/memory'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { collectBlock } from './collectBlock'
import { navigateToReach } from './navigate'
import { pickupDrops } from './pickupDrops'
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

/** blocks a hoe tills into farmland (HoeItem.TILLABLES: grass, dirt path and dirt; coarse dirt to dirt first) */
export const TILLABLE = new Set(['grass_block', 'dirt', 'dirt_path'])

/** FarmBlock.isNearWater: water within 4 blocks across and at the farmland's level or a block over */
export const HYDRATION_RANGE = 4


export type Lookup = (pos: Vec3) => { name: string, boundingBox?: string, getProperties?: () => Record<string, unknown> } | null

const OPEN_ABOVE = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'dandelion', 'poppy', 'snow'])

/**
 * Where to sow: a water source with up to `plots` tillable cells beside it at its level, open above (a plant there is
 * broken first), the nearest to the water first: one row along the water grows faster than a block of crops
 * (CropBlock.getGrowthSpeed halves the speed of a crop with the same crop on both sides and diagonally). The
 * water's cell is the farm's place. Null when no water near `center` has a tillable cell beside it.
 */
export function findFarmSite (lookup: Lookup, center: Vec3, radius = 24, plots = FARM_PLOTS): { water: Vec3, cells: Vec3[] } | null {
  let best: { water: Vec3, cells: Vec3[], score: number } | null = null
  const c = center.floored()
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -4; dy <= 4; dy++) {
        const w = c.offset(dx, dy, dz)
        const b = lookup(w)
        if (b?.name !== 'water' || Number(b.getProperties?.().level ?? 0) !== 0) continue
        if (!OPEN_ABOVE.has(lookup(w.offset(0, 1, 0))?.name ?? 'stone')) continue
        const cells: Vec3[] = []
        // a row along the water, both ways along x and along z
        for (const [ax, az] of [[1, 0], [0, 1]]) {
          for (const side of [1, -1]) {
            for (let k = -2; k <= 2 && cells.length < plots; k++) {
              const cell = w.offset(az * side + ax * k, 0, ax * side + az * k)
              if (cells.some(p => p.equals(cell))) continue
              if (!TILLABLE.has(lookup(cell)?.name ?? '')) continue
              if (!OPEN_ABOVE.has(lookup(cell.offset(0, 1, 0))?.name ?? 'stone')) continue
              cells.push(cell)
            }
          }
        }
        if (cells.length === 0) continue
        const score = cells.length * 100 - w.distanceTo(c)
        if (best == null || score > best.score) best = { water: w, cells, score }
      }
    }
  }
  return best == null ? null : { water: best.water, cells: best.cells }
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

async function holdItem (bot: Bot, name: string): Promise<void> {
  const item = findInventoryItem(bot, name)
  if (item == null) throw new SkillError('MISSING_ITEMS', `no ${name} to hold`)
  if (bot.heldItem?.name !== name) await bot.equip(item, 'hand')
}

/** tills a cell with the best hoe held (a plant on it broken first); resolves once it's farmland */
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
    await tillHeld(bot, cell, hoe, signal)
  } finally {
    if (sneak) bot.setControlState('sneak', false)
  }
}

async function tillHeld (bot: Bot, cell: Vec3, hoe: Item, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand')
    const block = bot.blockAt(cell) as Block
    await bot.activateBlock(block, new Vec3(0, 1, 0))
    if (await waitUntil(bot, () => bot.blockAt(cell)?.name === 'farmland', 10, signal)) return
    // the hand the server holds may not be the one the bag shows (every cell of a 26.3 farm stayed grass after the
    // hoe, crafted just before at a table put away): the inventory settled and the hoe selected afresh, once
    trace('till: no farmland at', cell.toString(), 'holding', bot.heldItem?.name ?? 'nothing', 'slot', bot.quickBarSlot, 'above', bot.blockAt(cell.offset(0, 1, 0))?.name ?? '?')
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
 * Starts a farm by water near `center`: up to `plots` cells tilled and sown with `seed` (as many as the seeds held).
 * The bot never jumps on the farmland it makes (FarmBlock.fallOn tramples it): it works each cell from beside it.
 */
export async function plantFarm (bot: Bot, args: { seed: string, center?: Vec3, plots?: number, radius?: number }, signal?: AbortSignal): Promise<FarmResult> {
  const crop = cropOf(args.seed)
  if (crop == null) throw new SkillError('MISSING_ITEMS', `${args.seed} sows no crop`)
  const seeds = countItems(bot, args.seed)
  if (seeds === 0) throw new SkillError('MISSING_ITEMS', `no ${args.seed}`)
  const plots = Math.min(args.plots ?? FARM_PLOTS, seeds)
  const site = findFarmSite(pos => bot.blockAt(pos) as any, args.center ?? bot.entity.position, args.radius ?? 24, plots)
  if (site == null) throw new SkillError('NOT_FOUND', 'no water with tillable ground beside it')
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
