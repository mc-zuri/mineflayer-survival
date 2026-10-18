// buildBase: the storage room built in the game. A site near the spawn chosen by siteSelection (dug into stone where
// there is some), the furniture's materials gathered through the executor, the room and airlock dug out, the
// blueprint's blocks placed in planBuild's order through placeBlock (the shell's material obtained once digging has
// paid what it pays), the result recorded in the WorldMemory, and the real blocks run through the safety checker.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from '../core/errors'
import { isBed } from '../core/items'
import { normalizeDimension } from '../core/memory'
import type { Executor } from '../executor/executor'
import { isAbort } from '../skills/errors'
import { collectBlock } from '../skills/collectBlock'
import { navigate } from '../skills/navigate'
import { placeBlock } from '../skills/placeBlock'
import { isFree } from '../skills/placement'
import { AIR_BLOCKS, countItems, trace, waitTicks } from '../skills/util'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { type BlockGetter, type Vec, blockRegistry, posKey } from './blocks'
import { generateBlueprint, planBuild, SHELL_MATERIALS, type Blueprint, type BlueprintOptions, type Placement } from './blueprint'
import { checkStorageSafety, type SafetyReport } from './safety'
import { selectSite, siteCandidates, type SiteScore } from './siteSelection'
import { BASE_POI } from './pois'

/**
 * The first base: a 6 × 3 × 4 room (11 chest places along the walls, 1 furnace, a crafting table and a bed), the
 * blueprint's 2 layers of cobblestone around it. The checker proves the default 2 layers safe for any interior.
 */
export const BASE_BLUEPRINT: BlueprintOptions = { width: 6, height: 3, depth: 4, furnaces: 1, chestLayers: 1 }

export interface BuildBaseOptions {
  /** gathers the materials and stores the valuables (its memory gets the base) */
  executor: Executor
  blueprint?: BlueprintOptions
  /** the interior's min corner (default: the best site siteSelection finds around `around`) */
  origin?: Vec
  /** where to look for a site (default: the world spawn, else the bot) */
  around?: Vec
  /** the site grid: how far, how far apart, and how deep under `around` (defaults 24, 8, [10, 14, 18]) */
  radius?: number
  step?: number
  depths?: number[]
  /** chests placed now; the rest of the blueprint's are kept as spare places (default 4) */
  chests?: number
  /** get the materials first (default true; false builds with what the bot holds) */
  gather?: boolean
  /** place attempts per block before it counts as missing (default 3) */
  attempts?: number
  log?: (line: string) => void
  signal?: AbortSignal
}

export interface BuildBaseResult {
  blueprint: Blueprint
  site: SiteScore | null
  dug: number
  placed: number
  /** placements the world doesn't have after building */
  missing: Placement[]
  /** the chests placed */
  chests: Vec3[]
  safety: SafetyReport
}

/** the world as the base modules read it, from the bot's chunks (unloaded: undefined, air: null) */
export function botWorld (bot: Bot): BlockGetter {
  return (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b == null) return undefined
    if (AIR_BLOCKS.has(b.name)) return null
    return { name: b.name, stateId: b.stateId }
  }
}

/** the item that places a blueprint block: the torch for a wall torch, a held shell material for the shell */
export function placementItem (p: Placement, held: (name: string) => number, shellMaterial: string): string | null {
  if (p.block === 'wall_torch') return 'torch'
  if (p.stage !== 'furniture') {
    // any of the shell materials does (they share blast resistance 6): the blueprint's first, then what's held most
    if (held(shellMaterial) > 0) return shellMaterial
    return [...SHELL_MATERIALS].sort((a, b) => held(b) - held(a)).find(m => held(m) > 0) ?? null
  }
  if (p.block.endsWith('_bed')) {
    if (held(p.block) > 0) return p.block
    return null
  }
  return p.block
}

const DIR: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }

/**
 * The way the bot faces to place a blueprint block in its state: along a bed or a door (BedBlock and DoorBlock take
 * the player's facing), back at the player for a chest or a furnace (ChestBlock, AbstractFurnaceBlock: the opposite
 * of the player's facing); none for the rest (a wall torch faces off the face it's put on).
 */
export function placementFacing (p: Pick<Placement, 'block' | 'state'>): Vec3 | undefined {
  const d = DIR[String(p.state.facing)]
  if (d == null || p.block === 'wall_torch') return undefined
  if (p.block.endsWith('_bed') || p.block.endsWith('_door')) return new Vec3(d[0], 0, d[1])
  return new Vec3(0 - d[0], 0, 0 - d[1])
}

/** the materials a build plan takes: item name → count (a door or a bed once, the torches as torches) */
export function buildMaterials (placements: readonly Placement[], chestsNow: number, shellMaterial: string): Record<string, number> {
  const out: Record<string, number> = {}
  let chests = 0
  for (const p of placements) {
    if (p.autoPlaced === true) continue
    let name = p.block === 'wall_torch' ? 'torch' : p.stage !== 'furniture' ? shellMaterial : p.block
    if (name === 'chest' && ++chests > chestsNow) continue
    if (name.endsWith('_bed')) name = 'bed'
    out[name] = (out[name] ?? 0) + 1
  }
  return out
}

/** the chests to place now: the first `n` of the blueprint's (a line's pairs in order, so they join) */
export function chestsToPlace (blueprint: Blueprint, n: number): Set<string> {
  return new Set(blueprint.storage.slice(0, n).map(p => posKey(p.x, p.y, p.z)))
}

function v (p: Vec): Vec3 {
  return new Vec3(p.x, p.y, p.z)
}

/** pathfinder exclusion areas that keep the shell from being broken and the room from being built in */
function protectSite (bot: Bot, blueprint: Blueprint): () => void {
  const pathfinder: any = bot.pathfinder
  const before = pathfinder?.defaultMoveSettings
  if (before == null) return () => {}
  const carved = new Set(blueprint.dig.map(c => posKey(c.x, c.y, c.z)))
  const { min, max } = blueprint.bounds
  const inBounds = (p: Vec3): boolean => p.x >= min.x && p.y >= min.y && p.z >= min.z && p.x < max.x && p.y < max.y && p.z < max.z
  const shell = (block: any): number => {
    const p = block.position as Vec3
    return inBounds(p) && !carved.has(posKey(p.x, p.y, p.z)) ? 1e9 : 0
  }
  const room = (block: any): number => {
    const p = block.position as Vec3
    return carved.has(posKey(p.x, p.y, p.z)) ? 1e9 : 0
  }
  pathfinder.setMoveOptions({
    ...before,
    exclusionAreasBreak: [...(before.exclusionAreasBreak ?? []), shell],
    exclusionAreasPlace: [...(before.exclusionAreasPlace ?? []), room]
  })
  return () => pathfinder.setMoveOptions(before)
}

/**
 * Keeps the built base from being broken by the pathfinder from now on (every block of its box), and from being
 * built in (the room and the airlock).
 */
export function protectBase (bot: Bot, blueprint: Pick<Blueprint, 'bounds' | 'dig'>): void {
  const pathfinder: any = bot.pathfinder
  const settings = pathfinder?.defaultMoveSettings
  if (settings == null) return
  const carved = new Set(blueprint.dig.map(c => posKey(c.x, c.y, c.z)))
  const { min, max } = blueprint.bounds
  const inBounds = (p: Vec3): boolean => p.x >= min.x && p.y >= min.y && p.z >= min.z && p.x < max.x && p.y < max.y && p.z < max.z
  const keep = (block: any): number => inBounds(block.position) ? 1e9 : 0
  const room = (block: any): number => carved.has(posKey(block.position.x, block.position.y, block.position.z)) ? 1e9 : 0
  ;(keep as any).survivalBase = true
  ;(room as any).survivalBase = true
  const others = (list: any[] | undefined): any[] => (list ?? []).filter(f => f.survivalBase !== true)
  pathfinder.setMoveOptions({
    ...settings,
    exclusionAreasBreak: [...others(settings.exclusionAreasBreak), keep],
    exclusionAreasPlace: [...others(settings.exclusionAreasPlace), room]
  })
}

/** chooses the site: the best siteSelection score of a grid of candidates around `around` */
export function chooseSite (bot: Bot, blueprintOptions: BlueprintOptions, around: Vec, opts: { radius?: number, step?: number, depths?: number[] } = {}): SiteScore | null {
  const world = botWorld(bot)
  const minY: number = (bot.game as any)?.minY ?? -64
  const candidates = siteCandidates(around, opts.radius ?? 24, opts.step ?? 8, opts.depths ?? [10, 14, 18])
    // the floor's shell must stay above the bedrock layers
    .filter(c => c.y - (blueprintOptions.thickness ?? 2) > minY + 5)
  if (candidates.length === 0) return null
  return selectSite(world, candidates, { ...blueprintOptions, version: bot.version })[0] ?? null
}

/** the base's materials as obtain requests, on top of what the bot holds that it keeps carrying */
function materialRequests (bot: Bot, materials: Record<string, number>, shellMaterial: string): Array<{ item: string | string[], count: number, optional?: boolean }> {
  const out: Array<{ item: string | string[], count: number, optional?: boolean }> = []
  for (const [name, n] of Object.entries(materials)) {
    if (name === shellMaterial) continue
    if (name === 'bed') {
      // any bed (a white one from white wool when it has to be made), left out when there's no sheep to be had
      const beds = Object.keys(bot.registry.itemsByName).filter(isBed)
      out.push({ item: ['white_bed', ...beds.filter(b => b !== 'white_bed')], count: 1, optional: true })
      continue
    }
    // the crafting table and furnace the bot carries stay with it: the base gets its own
    const carried = name === 'crafting_table' || name === 'furnace' ? countItems(bot, name) : 0
    out.push({ item: name, count: n + carried })
  }
  return out
}

/**
 * Builds the base and records it in the executor's memory. Returns what was built and the safety checker's report on
 * the blocks as they are in the world (`safety.safe`: no chest can be blown up from anywhere a mob gets to).
 */
export async function buildBase (bot: Bot, opts: BuildBaseOptions): Promise<BuildBaseResult> {
  const { executor, signal } = opts
  const log = opts.log ?? ((line: string) => executor.log(line))
  const bpOptions: BlueprintOptions = { ...BASE_BLUEPRINT, ...opts.blueprint, version: bot.version }
  const registry = blockRegistry(bot.version)
  const material = bpOptions.material ?? 'cobblestone'
  const attempts = opts.attempts ?? 3
  const chestsNow = opts.chests ?? 4

  // the site
  let site: SiteScore | null = null
  let origin = opts.origin
  if (origin == null) {
    const spawn = (bot as any).spawnPoint as Vec3 | undefined
    const around = opts.around ?? (spawn != null && spawn.distanceTo(bot.entity.position) < 128 ? spawn : bot.entity.position.floored())
    // the candidates' depths count down from the surface there
    site = chooseSite(bot, bpOptions, around, opts)
    if (site == null) throw new TaskError('NOT_FOUND', 'no site for the base')
    origin = site.origin
    log(`base site ${origin.x} ${origin.y} ${origin.z} (score ${site.score.toFixed(1)}${site.reasons.length > 0 ? ': ' + site.reasons.join('; ') : ''})`)
  }
  const blueprint = generateBlueprint({ ...bpOptions, origin })
  const placeChests = chestsToPlace(blueprint, chestsNow)
  const wanted = (p: Placement): boolean => p.block !== 'chest' || placeChests.has(posKey(p.pos.x, p.pos.y, p.pos.z))

  // the furniture's materials before setting out (the shell's come from digging, and the rest after)
  const firstPlan = planBuild(blueprint, botWorld(bot), registry)
  const materials = buildMaterials(firstPlan.placements.filter(wanted), chestsNow, material)
  if (opts.gather !== false) {
    const requests = materialRequests(bot, materials, material)
    log(`base materials: ${requests.map(r => `${r.count} ${String(r.item).split(',')[0]}`).join(', ')}`)
    try {
      await executor.obtain(requests, signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED', 'ABORTED')) throw err
      // the optional bed may be what failed: build without what's missing
      log(`base materials short: ${(err as Error).message}`)
    }
  }

  const unprotect = protectSite(bot, blueprint)
  let dug = 0
  let placed = 0
  const failures = new Map<string, number>()
  try {
    // to the site: the cell outside the outer door (the pathfinder digs its way down)
    const outside = v(blueprint.entrance.outside)
    await executor.task('to the base site', async (s) => await navigate(bot, { goal: new goals.GoalBlock(outside.x, outside.y, outside.z) }, s), signal).catch(err => {
      if (isAbort(err)) throw err
      log(`no way to the base's entrance: ${(err as Error).message}`)
    })

    // dig out the room and the airlock, from the entrance in
    for (const cell of planBuild(blueprint, botWorld(bot), registry).dig) {
      throwIfAborted(signal)
      const pos = v(cell)
      const block = bot.blockAt(pos)
      if (block == null || isFree(block)) continue
      try {
        await executor.task(`dig ${pos.toString()}`, async (s) => await collectBlock(bot, { positions: [pos] }, s), signal)
        dug++
      } catch (err) {
        if (isAbort(err) || TaskError.is(err, 'DIED')) throw err
        trace('buildBase: dig failed', pos.toString(), (err as Error).message)
      }
    }

    // the shell's material that's still short, once digging paid what it paid
    if (opts.gather !== false) {
      const left = planBuild(blueprint, botWorld(bot), registry)
      const shell = buildMaterials(left.placements.filter(p => p.stage !== 'furniture'), 0, material)[material] ?? 0
      const have = SHELL_MATERIALS.reduce((n, m) => n + countItems(bot, m), 0)
      if (shell > have) {
        log(`base shell: ${shell} blocks to place, ${have} held`)
        try {
          await executor.obtain([{ item: [...SHELL_MATERIALS], count: shell }], signal)
        } catch (err) {
          if (TaskError.is(err, 'DIED', 'ABORTED')) throw err
          log(`shell material short: ${(err as Error).message}`)
        }
      }
    }

    // place, in planBuild's order against the world as it is; what didn't take is tried again in a later round
    for (let round = 0; round < attempts; round++) {
      const plan = planBuild(blueprint, botWorld(bot), registry)
      const todo = plan.placements.filter(p => p.autoPlaced !== true && wanted(p))
      if (todo.length === 0) break
      let progress = false
      // the bed first among the furniture: the bot stands where the furnace goes to face along it
      // the doors last, the outer one first: the bot is in the airlock to hang it, then inside to hang the inner one
      const outer = blueprint.entrance.outerDoor
      const rank = (p: Placement): number => p.stage !== 'furniture' ? 0 : p.block.endsWith('_bed') ? 1 : !p.block.endsWith('_door') ? 2 : p.pos.x === outer.x && p.pos.z === outer.z ? 3 : 4
      const ordered = todo.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) !== rank(b.p) ? rank(a.p) - rank(b.p) : a.i - b.i).map(e => e.p)
      for (const p of ordered) {
        throwIfAborted(signal)
        const key = posKey(p.pos.x, p.pos.y, p.pos.z)
        if ((failures.get(key) ?? 0) >= attempts) continue
        const item = placementItem(p, name => countItems(bot, name), material)
        if (item == null) { failures.set(key, attempts); continue }
        try {
          if (await executor.task(`place ${p.block} ${key}`, async (s) => await placeOne(bot, p, item, s), signal)) { placed++; progress = true }
        } catch (err) {
          if (isAbort(err) || TaskError.is(err, 'DIED')) throw err
          failures.set(key, (failures.get(key) ?? 0) + 1)
          trace('buildBase: place failed', p.block, key, (err as Error).message)
        }
      }
      if (!progress) break
    }
  } finally {
    unprotect()
  }

  // what's there now
  const world = botWorld(bot)
  const final = planBuild(blueprint, world, registry)
  const missing = final.placements.filter(p => p.autoPlaced !== true && wanted(p))
  const chests = blueprint.storage.filter(p => bot.blockAt(v(p))?.name === 'chest').map(v)
  record(bot, executor, blueprint, chests)
  protectBase(bot, blueprint)
  const safety = checkStorageSafety(world, chests, { bounds: blueprint.bounds, registry })
  log(`base built: ${dug} dug, ${placed} placed, ${missing.length} missing, ${chests.length} chests, ${safety.safe ? 'safe' : `${safety.unsafe.length} chests unsafe`}`)
  for (const u of safety.unsafe.slice(0, 5)) log(`unsafe: ${u.reason}`)

  // the valuables into the new chests
  if (chests.length > 0) await executor.storeAtBase({}, signal).catch(err => { if (TaskError.is(err, 'DIED', 'ABORTED')) throw err })
  return { blueprint, site, dug, placed, missing, chests, safety }
}

/** places one blueprint block: clears what's in the way (a superflat's dirt in the floor), the bed facing its way */
async function placeOne (bot: Bot, p: Placement, item: string, signal?: AbortSignal): Promise<boolean> {
  const pos = v(p.pos)
  const current = bot.blockAt(pos)
  if (current == null) return false
  if (!isFree(current) && current.name !== p.block) await collectBlock(bot, { positions: [pos], pickup: true }, signal)
  const against = p.against != null ? v(p.against) : undefined
  await placeBlock(bot, { pos, item, against, facing: placementFacing(p) }, signal)
  // a door's or bed's other half comes with it
  if (p.block.endsWith('_door') || p.block.endsWith('_bed')) await waitTicks(bot, 2, signal)
  return true
}

function record (bot: Bot, executor: Executor, blueprint: Blueprint, chests: Vec3[]): void {
  const memory = executor.memory
  const dimension = normalizeDimension(bot.game?.dimension)
  const o = blueprint.options.origin
  for (const kind of Object.values(BASE_POI)) memory.removePoi(kind)
  memory.setBase(o, dimension)
  memory.addPoi(BASE_POI.entrance, blueprint.entrance.outside, dimension)
  const b = blueprint.bounds
  memory.addPoi(BASE_POI.bounds, b.min, dimension, `${b.max.x},${b.max.y},${b.max.z}`)
  for (const p of blueprint.placements) {
    const name = bot.blockAt(v(p.pos))?.name
    if (name !== p.block) continue
    if (p.block === 'crafting_table') memory.addPoi(BASE_POI.table, p.pos, dimension)
    if (p.block === 'furnace') memory.addPoi(BASE_POI.furnace, p.pos, dimension)
    if (p.block.endsWith('_bed') && p.state.part === 'foot') memory.addPoi(BASE_POI.bed, p.pos, dimension)
  }
  const placed = new Set(chests.map(c => posKey(c.x, c.y, c.z)))
  for (const c of chests) if (memory.chestAt(c, dimension) == null) memory.rememberChest(c, {}, dimension)
  for (const s of blueprint.storage) if (!placed.has(posKey(s.x, s.y, s.z))) memory.addPoi(BASE_POI.spareChest, s, dimension)
}

function throwIfAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason instanceof TaskError ? signal.reason : new TaskError('ABORTED', 'buildBase was stopped')
}
