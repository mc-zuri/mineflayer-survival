// tunnelTo: a staircase dug down (or a 2-high tunnel along) toward a point underground, a block at a time, never
// opening a block lava touches and never stepping onto nothing: the way players dig down to a stronghold.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, throwIfAborted } from './errors'
import { walkTo } from './navigate'
import { placeBlock } from './placeBlock'
import { CARDINALS, countItems, settleInventory, trace, waitTicks, waitUntil } from './util'

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
      // open the cells
      let ok = true
      for (const c of clear) {
        const b = bot.blockAt(c)
        if (b == null) { ok = false; break }
        if (b.boundingBox !== 'block') continue
        if (!b.diggable) { trace('tunnelTo: undiggable', b.name); ok = false; break }
        bot.pathingUtil?.refresh?.()
        const tool = (bot as any).pathingUtil?.bestHarvestingTool?.(b)
        if (tool != null && bot.heldItem?.slot !== tool.slot) { await settleInventory(bot, signal); await bot.equip(tool, 'hand') }
        try {
          await bot.dig(b, true)
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
      // a floor to step onto
      if (bot.blockAt(floor)?.boundingBox !== 'block') {
        const filler = fillers.find(f => countItems(bot, f) > 0)
        if (filler == null) { trace('tunnelTo: no floor and no filler'); continue }
        try { await placeBlock(bot, { pos: floor, item: filler }, signal) } catch (err) { trace('tunnelTo: floor not placed:', (err as Error).message); continue }
      }
      await walkTo(bot, stand.offset(0.5, 0, 0.5), { within: 0.25, maxTicks: 30 }, signal)
      // the step down is a fall into the hole: a few ticks after the bot is over it
      await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.y < stand.y + 0.5, 15, signal)
      if (bot.entity.position.floored().equals(stand) || bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) < 0.8) { stepped = true; break }
      trace('tunnelTo: the step to', stand.toString(), 'ended at', bot.entity.position.toString())
    }
    if (!stepped) throw new SkillError('NO_PATH', `no safe step toward ${target.toString()} from ${feet.toString()}`, { steps, dug, position: bot.entity.position.clone() })
  }
  return { steps, dug, position: bot.entity.position.clone() }
}
