// tunnelTo: a staircase dug down (or a 2-high tunnel along) toward a point underground, a block at a time, never
// opening a block lava touches and never stepping onto nothing: the way players dig down to a stronghold.
import type { Bot } from 'mineflayer'
import { caveStep, sealCaveOpenings } from './caves'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { walkTo } from './navigate'
import { placeBlock } from './placeBlock'
import { CARDINALS, countItems, settleInventory, trace, waitTicks, waitUntil } from './util'
import { dig } from '../core/actions'
import { keepRoom } from './bag'

export interface TunnelArgs {
  target: Vec3
  /** done within this many blocks (default 2) */
  range?: number
  /** steps to give up after (default 400) */
  maxSteps?: number
  /** blocks to put under a step over a hole (default: cobblestone, then other fillers) */
  fillers?: string[]
  /** checked before each step: true stops the dig there (something found on the way) */
  until?: () => boolean
  /** a step with no floor that can't be given one may drop this far onto safe ground (default 4) */
  maxDrop?: number
  /**
   * the cave rule's turns (caveStep: no step into a cave or opening onto one for a bot not fit for the caves; default
   * true); false for a way out of a hazard, where any way off it is the better
   */
  caves?: boolean
}

export interface TunnelResult {
  steps: number
  dug: number
  position: Vec3
}

/** the cells to clear for one step from `feet` along `dir`, down a level when `down` (the head's path included) */
export function stepCells (feet: Vec3, dir: Vec3, down: boolean): { clear: Vec3[], stand: Vec3, floor: Vec3 } {
  const ahead = feet.plus(dir)
  if (down) return { clear: [ahead.offset(0, 1, 0), ahead, ahead.offset(0, -1, 0)], stand: ahead.offset(0, -1, 0), floor: ahead.offset(0, -2, 0) }
  return { clear: [ahead.offset(0, 1, 0), ahead], stand: ahead, floor: ahead.offset(0, -1, 0) }
}

const LIQUID = new Set(['lava', 'water', 'bubble_column'])
/** blocks a tunnel never digs: a portal's, the bot's chests and beds, its stations */
const KEPT_BLOCKS = /^(obsidian|crying_obsidian|nether_portal|end_portal|end_portal_frame|chest|trapped_chest|barrel|.*_bed|enchanting_table|anvil|furnace|crafting_table)$/
const HARMFUL_GROUND = new Set(['lava', 'magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'cactus', 'powder_snow', 'pointed_dripstone'])

/**
 * Where a step into `stand` with no floor under it lands: the cell over the first solid block within `maxDrop` below
 * it, the cells on the way free of liquids and the ground not harmful; null when it isn't safe
 */
export function dropLanding (lookup: (p: Vec3) => { name: string, boundingBox: string } | null, stand: Vec3, maxDrop: number): Vec3 | null {
  for (let d = 1; d <= maxDrop + 1; d++) {
    const cell = stand.offset(0, -d, 0)
    const b = lookup(cell)
    if (b == null) return null
    if (LIQUID.has(b.name) || HARMFUL_GROUND.has(b.name)) return null
    if (b.boundingBox === 'block') return d - 1 <= maxDrop ? cell.offset(0, 1, 0) : null
  }
  return null
}

/**
 * Digs toward the target: down a staircase while above it (a step forward and down each time, along the axis that's
 * furthest off), then a 2-high tunnel. A step is skipped for another direction when a cell to open has lava or water
 * against it, or the step's floor is lava; a missing floor gets a filler block.
 */
export async function tunnelTo (bot: Bot, args: TunnelArgs, signal?: AbortSignal): Promise<TunnelResult> {
  const range = args.range ?? 2
  const fillers = args.fillers ?? ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'netherrack', 'deepslate']
  const target = args.target.floored()
  let steps = 0
  let dug = 0
  const name = (p: Vec3): string => bot.blockAt(p)?.name ?? 'unknown'
  const liquidAgainst = (p: Vec3): boolean => [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].some(([x, y, z]) => LIQUID.has(name(p.offset(x, y, z))))
  for (; steps < (args.maxSteps ?? 400); steps++) {
    throwIfAborted(signal)
    const feet = bot.entity.position.floored()
    if (feet.distanceTo(target) <= range || args.until?.() === true) break
    // room in the bag before each step (the bag's keeper): the steps' stone comes in as the bot walks into it
    await keepRoom(bot, signal, target)
    const down = feet.y > target.y
    const dx = target.x - feet.x
    const dz = target.z - feet.z
    // the furthest axis first, then the other, then the rest
    const order = [...CARDINALS].sort((a, b) => (b.x * dx + b.z * dz) - (a.x * dx + a.z * dz))
    let stepped = false
    for (const dir of order) {
      if (!down && dir.x * dx + dir.z * dz <= 0 && Math.abs(dx) + Math.abs(dz) > 0) continue
      const { clear, stand, floor } = stepCells(feet, dir, down)
      if (clear.some(c => LIQUID.has(name(c)) || ((bot.blockAt(c)?.boundingBox === 'block') && liquidAgainst(c)))) { trace('tunnelTo: liquid by the step', dir.toString()); continue }
      if (LIQUID.has(name(floor))) { trace('tunnelTo: liquid floor', dir.toString()); continue }
      // (nor into a cave, opening one or over one, for a bot not fit for the caves: round it in the rock, caveStep; the
      // ls4-26.3 game's dug ways to its deep lava pools for obsidian came out in their caves, 5 of its 17 cave entries)
      const cave = args.caves === false ? null : caveStep(bot, { open: clear, floor })
      if (cave != null) { trace('tunnelTo: turns from', dir.toString(), cave); continue }
      // open the cells
      let ok = true
      for (const c of clear) {
        const b = bot.blockAt(c)
        if (b == null) { ok = false; break }
        if (b.boundingBox !== 'block') continue
        if (!b.diggable) { trace('tunnelTo: undiggable', b.name); ok = false; break }
        // a portal's frame, a chest or a bed is gone round, never dug (a stair beside a cave's nether portal dug into
        // its frame, and the portal was out for good: 'no site to cast' five times after, 26.3)
        if (KEPT_BLOCKS.test(b.name)) { trace('tunnelTo: kept', b.name, c.toString()); ok = false; break }
        bot.pathingUtil?.refresh?.()
        const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(b)
        if (tool != null && bot.heldItem?.slot !== tool.slot) { await settleInventory(bot, signal); await bot.equip(tool, 'hand') }
        try {
          await dig(bot, b, { signal })
          dug++
        } catch (err) {
          trace('tunnelTo: digging', b.name, c.toString(), 'failed:', (err as Error).message)
          ok = false
          break
        }
        await waitTicks(bot, 1, signal)
        if (bot.blockAt(c)?.boundingBox === 'block') { trace('tunnelTo: still there after digging', bot.blockAt(c)?.name, c.toString()); ok = false; break }
      }
      if (!ok) continue
      // a floor to step onto: a block put there, else a short drop onto ground with no liquid (an open room under
      // the stair: a stronghold's portal room under a 26.3 bot, 'nothing solid to place against', no way down)
      let landing = stand
      if (bot.blockAt(floor)?.boundingBox !== 'block') {
        const filler = fillers.find(f => countItems(bot, f) > 0)
        let placed = false
        if (filler != null) {
          try { await placeBlock(bot, { pos: floor, item: filler }, signal); placed = true } catch (err) { trace('tunnelTo: floor not placed:', (err as Error).message) }
        }
        if (!placed) {
          const drop = dropLanding(p => bot.blockAt(p) as any, stand, args.maxDrop ?? 4)
          if (drop == null) { trace('tunnelTo: no floor and no safe drop under', stand.toString()); continue }
          landing = drop
        }
      }
      await walkTo(bot, stand.offset(0.5, 0, 0.5), { within: 0.25, maxTicks: 30 }, signal)
      // the step down is a fall into the hole: a few ticks after the bot is over it
      await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.y < landing.y + 0.5, 15 + 5 * (stand.y - landing.y), signal)
      if (bot.entity.position.floored().equals(landing) || bot.entity.position.distanceTo(landing.offset(0.5, 0, 0.5)) < 0.8) {
        // a hole into a cave the step opened all the same sealed
        await sealCaveOpenings(bot, signal)
        stepped = true
        break
      }
      trace('tunnelTo: the step to', stand.toString(), 'ended at', bot.entity.position.toString())
    }
    if (!stepped) throw new SkillError('NO_PATH', `no safe step toward ${target.toString()} from ${feet.toString()}`, { steps, dug, position: bot.entity.position.clone() })
  }
  return { steps, dug, position: bot.entity.position.clone() }
}
