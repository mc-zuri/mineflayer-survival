// bucket: fill a bucket from a water or lava source, empty one into a cell, and cast obsidian by pouring water where
// it reaches a lava source.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { navigate, navigateToReach } from './navigate'
import { isInteractive, isSolid } from './placement'
import { CARDINALS, FACES, blockAtOrThrow, blockReach, canSee, countItems, eyeHeight, eyePosition, findInventoryItem, settleInventory, waitUntil, withinReach, type Block } from './util'

export type Fluid = 'water' | 'lava'

/** a fluid's source block (LiquidBlock.LEVEL 0) */
export function isSource (block: { name: string, getProperties?: () => Record<string, unknown>, metadata?: number } | null, fluid: Fluid): boolean {
  if (block == null || block.name !== fluid) return false
  const level = block.getProperties?.().level ?? block.metadata
  return Number(level) === 0
}

export interface FillBucketArgs {
  fluid: Fluid
  /** the source to take (default: the nearest within `maxDistance`) */
  pos?: Vec3
  maxDistance?: number
}

export interface BucketResult {
  pos: Vec3
  /** the bucket now in the inventory */
  item: string
}

/**
 * Points on a source's shape (FlowingFluid.getShape: a box 8/9 of the block high), where a look at it hits it: the
 * surface first, then its sides and its bottom (BucketItem.use's ray, ClipContext.Fluid.SOURCE_ONLY, stops at any face
 * of the shape, so a source overhead is taken from below).
 */
export function surfacePoints (pos: Vec3): Vec3[] {
  const top = 8 / 9 - 0.02
  const points = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([x, z]) => pos.offset(x, top, z))
  for (const [x, z] of [[0.02, 0.5], [0.98, 0.5], [0.5, 0.02], [0.5, 0.98]]) points.push(pos.offset(x, 0.45, z))
  for (const [x, z] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8]]) points.push(pos.offset(x, 0.02, z))
  return points
}

/**
 * Goes where the bot sees what `aim` aims at (a point a look at hits, from the given eyes) within reach: closer step
 * by step when it doesn't, then to a spot near `pos` it sees it from (the nearest spot in reach can be behind a
 * block), and returns that point.
 */
async function approachToSee (bot: Bot, pos: Vec3, aim: (eye: Vec3) => Vec3 | null, signal?: AbortSignal): Promise<Vec3> {
  const reach = blockReach(bot)
  const inView = (): Vec3 | null => {
    const eye = eyePosition(bot)
    const point = withinReach(bot, pos) ? aim(eye) : null
    return point != null && point.distanceTo(eye) <= reach ? point : null
  }
  for (const range of [4, 3]) {
    const point = inView()
    if (point != null) return point
    await navigateToReach(bot, pos, signal, { reach: range })
  }
  let point = inView()
  if (point != null) return point
  const spots = viewSpots(bot, pos, eyeHeight(bot), eye => { const p = aim(eye); return p != null && p.distanceTo(eye) <= reach - 0.25 })
  for (const spot of spots.slice(0, 4)) {
    try {
      await navigate(bot, { goal: new goals.GoalBlock(spot.x, spot.y, spot.z) }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      continue
    }
    point = inView()
    if (point != null) return point
  }
  throw new SkillError('NO_PATH', `no spot found to see ${pos.toString()} from`)
}

/** cells near `pos` the bot can stand in (solid below, two cells free of blocks and lava) whose eyes pass `sees`, nearest the bot first */
function viewSpots (bot: Bot, pos: Vec3, height: number, sees: (eye: Vec3) => boolean, radius = 4): Vec3[] {
  const out: Array<{ cell: Vec3, d: number }> = []
  const free = (p: Vec3): boolean => { const b = bot.blockAt(p); return b != null && !isSolid(b) && b.name !== 'lava' }
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -radius - 1; dy <= radius - 1; dy++) {
        const cell = pos.offset(dx, dy, dz)
        if (!free(cell) || !free(cell.offset(0, 1, 0)) || !isSolid(bot.blockAt(cell.offset(0, -1, 0)))) continue
        if (!sees(cell.offset(0.5, height, 0.5))) continue
        out.push({ cell, d: cell.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).map(c => c.cell)
}

export async function fillBucket (bot: Bot, args: FillBucketArgs, signal?: AbortSignal): Promise<BucketResult> {
  throwIfAborted(signal)
  const { fluid } = args
  const bucket = findInventoryItem(bot, 'bucket')
  if (bucket == null) throw new SkillError('MISSING_ITEMS', 'no empty bucket in the inventory')
  let source: Block | null
  if (args.pos != null) {
    source = blockAtOrThrow(bot, args.pos.floored())
    if (!isSource(source, fluid)) throw new SkillError('NOT_FOUND', `no ${fluid} source at ${args.pos.toString()}`)
  } else {
    source = bot.findBlock({ matching: (block: any) => isSource(block, fluid), maxDistance: args.maxDistance ?? 32 })
    if (source == null) throw new SkillError('NOT_FOUND', `no ${fluid} source nearby`)
  }
  const pos = source.position
  // BucketItem.use: the server picks the source the player looks at (a raycast that stops at source fluids)
  const point = await approachToSee(bot, pos, eye => surfacePoints(pos).find(point => canSee(bot, point, undefined, eye)) ?? null, signal)

  const filled = `${fluid}_bucket`
  const before = countItems(bot, filled)
  await settleInventory(bot, signal)
  await bot.equip(bucket, 'hand')
  await bot.lookAt(point, true)
  bot.activateItem()
  const ok = await waitUntil(bot, () => countItems(bot, filled) > before, 10, signal)
  if (!ok) throw new SkillError('VERIFY_FAILED', `no ${filled} after using the bucket on ${pos.toString()}`)
  return { pos, item: filled }
}

export interface EmptyBucketArgs {
  /** the cell to pour into */
  pos: Vec3
  fluid?: Fluid
}

/**
 * A face to click to pour into `pos`: a solid neighbour's face toward it that the bot's eyes see, with nothing in the
 * way. BucketItem.use raycasts without fluids and pours on the clicked face's side (into the block itself when it
 * holds water, as a slab can, so those aren't used).
 */
function pourPoint (bot: Bot, pos: Vec3, eye: Vec3 = eyePosition(bot)): Vec3 | null {
  for (const face of FACES) {
    const block = bot.blockAt(pos.minus(face))
    if (block == null || !isSolid(block) || isInteractive(block.name) || 'waterlogged' in (block.getProperties?.() ?? {})) continue
    // the face's middle, and points toward its corners
    const centre = block.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    const spread = [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]
    for (const [a, b] of spread) {
      const point = face.x !== 0 ? centre.offset(0, a, b) : face.y !== 0 ? centre.offset(a, 0, b) : centre.offset(a, b, 0)
      // the eyes on the face's outer side, nothing between them and it
      if (eye.minus(point).dot(face) <= 0) continue
      if (canSee(bot, point, block.position, eye)) return point
    }
  }
  return null
}

export async function emptyBucket (bot: Bot, args: EmptyBucketArgs, signal?: AbortSignal): Promise<BucketResult> {
  throwIfAborted(signal)
  const pos = args.pos.floored()
  const item = args.fluid != null ? findInventoryItem(bot, `${args.fluid}_bucket`) : findInventoryItem(bot, ['water_bucket', 'lava_bucket'])
  if (item == null) throw new SkillError('MISSING_ITEMS', `no ${args.fluid ?? 'water or lava'} bucket in the inventory`)
  const fluid = item.name === 'lava_bucket' ? 'lava' : 'water'
  const target = blockAtOrThrow(bot, pos)
  if (isSource(target, fluid)) return { pos, item: 'bucket' }
  if (isSolid(target)) throw new SkillError('CANNOT_PLACE', `${target.name} is at ${pos.toString()}`)

  const point = await approachToSee(bot, pos, eye => pourPoint(bot, pos, eye), signal)
    .catch(err => { throw new SkillError('CANNOT_PLACE', `no face in view to pour against at ${pos.toString()}`, undefined, { cause: err }) })

  await settleInventory(bot, signal)
  await bot.equip(item, 'hand')
  await bot.lookAt(point, true)
  bot.activateItem()
  const ok = await waitUntil(bot, () => isSource(bot.blockAt(pos), fluid), 10, signal)
  if (!ok) throw new SkillError('VERIFY_FAILED', `${bot.blockAt(pos)?.name ?? 'nothing'} at ${pos.toString()} after pouring ${fluid}`)
  return { pos, item: 'bucket' }
}

export interface CastObsidianArgs {
  /** the lava source to turn into obsidian */
  lava: Vec3
  /** take the water back up afterwards (default true) */
  recoverWater?: boolean
}

export interface CastObsidianResult {
  obsidian: Vec3
  /** where the water was poured */
  water: Vec3
  waterRecovered: boolean
}

/**
 * Cells to pour water into so it reaches the lava (LiquidBlock.shouldSpreadLiquid: a lava source with water beside or
 * above it turns to obsidian): beside it, above it, then above a block beside it (the water runs over the lava).
 */
export function castCandidates (lava: Vec3): Vec3[] {
  return [...CARDINALS.map(dir => lava.plus(dir)), lava.offset(0, 1, 0), ...CARDINALS.map(dir => lava.plus(dir).offset(0, 1, 0))]
}

export async function castObsidian (bot: Bot, args: CastObsidianArgs, signal?: AbortSignal): Promise<CastObsidianResult> {
  throwIfAborted(signal)
  const lava = args.lava.floored()
  if (!isSource(bot.blockAt(lava), 'lava')) throw new SkillError('NOT_FOUND', `no lava source at ${lava.toString()}`)
  if (findInventoryItem(bot, 'water_bucket') == null) throw new SkillError('MISSING_ITEMS', 'no water bucket in the inventory')

  let poured: Vec3 | null = null
  let lastError: unknown = null
  for (const cell of castCandidates(lava)) {
    const block = bot.blockAt(cell)
    if (block == null || isSolid(block) || block.name === 'lava') continue
    // over a block beside the lava, the water needs that block to stand on
    if (cell.y > lava.y && !cell.offset(0, -1, 0).equals(lava) && !isSolid(bot.blockAt(cell.offset(0, -1, 0)))) continue
    try {
      await emptyBucket(bot, { pos: cell, fluid: 'water' }, signal)
      poured = cell
      break
    } catch (err) {
      if (isAbort(err)) throw err
      lastError = err
    }
  }
  if (poured == null) throw new SkillError('CANNOT_PLACE', `no cell to pour water into next to the lava at ${lava.toString()}`, undefined, { cause: lastError })

  // water spreads every 5 ticks (WaterFluid.getTickDelay); a cell over a block beside the lava takes a step
  const cast = await waitUntil(bot, () => bot.blockAt(lava)?.name === 'obsidian', 60, signal)
  let waterRecovered = false
  if (args.recoverWater !== false) {
    try {
      await fillBucket(bot, { fluid: 'water', pos: poured }, signal)
      waterRecovered = true
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  const result = { obsidian: lava, water: poured, waterRecovered }
  if (!cast) throw new SkillError('VERIFY_FAILED', `${bot.blockAt(lava)?.name ?? 'nothing'} at ${lava.toString()} after pouring water at ${poured.toString()}`, result)
  return result
}
