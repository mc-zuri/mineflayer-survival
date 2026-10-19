// The cells the hazard reflex took the bot out of, kept out of by the walks for a while after: the reflex steps the bot
// off a magma block, and the walk it hands back to must not take it straight back on (a 26.3 bot by seed 2's
// fortress was taken off a magma block on a bridge's wall and back onto it 430 times, till it died).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

/** ticks a cell the hazard reflex took the bot out of is kept out of (30 s) */
export const HAZARD_LEFT_TICKS = 600

/** the pathfinder's COST_INF: a step cost this high forbids the step */
const FORBID = 1000000

const left = new WeakMap<Bot, Map<string, number>>()

function keyOf (p: { x: number, y: number, z: number }): string {
  return `${p.x},${p.y},${p.z}`
}

/** the client ticks so far: the task runner's count, else the lockstep's, else the clock's (50 ms a tick) */
function nowTick (bot: Bot): number {
  return bot.survival?.tasks?.tick ?? (bot as any).lockstep?.ticks ?? Math.floor(Date.now() / 50)
}

/**
 * The cell the bot stands in on a hot floor (onHotFloor: the block 0.2 under the feet, Entity.getOnPos), over that
 * block
 */
export function hotFloorCell (bot: Bot): Vec3 {
  return bot.entity.position.offset(0, -0.2, 0).floored().offset(0, 1, 0)
}

/** remembers a cell the bot was taken out of for HAZARD_LEFT_TICKS (the cell its feet are in: a magma block's top) */
export function noteHazardLeft (bot: Bot, cell: Vec3): void {
  let cells = left.get(bot)
  if (cells == null) { cells = new Map(); left.set(bot, cells) }
  const now = nowTick(bot)
  for (const [k, at] of cells) if (now - at > HAZARD_LEFT_TICKS || at > now) cells.delete(k)
  cells.set(keyOf(cell.floored()), now)
}

/** whether the cell is one the bot was taken out of within HAZARD_LEFT_TICKS */
export function hazardLeft (bot: Bot, cell: { x: number, y: number, z: number }): boolean {
  const cells = left.get(bot)
  if (cells == null || cells.size === 0) return false
  const at = cells.get(keyOf(cell))
  if (at == null) return false
  const age = nowTick(bot) - at
  return age >= 0 && age <= HAZARD_LEFT_TICKS
}

/** forgets the cells (a death, a dimension change) */
export function clearHazardsLeft (bot: Bot): void {
  left.get(bot)?.clear()
}

/** the pathfinder's step rule: no move ends in a cell the bot was taken out of lately (hazardLeft) */
export function hazardLeftStepCost (bot: Bot): (block: { position: Vec3 }) => number {
  return (block) => hazardLeft(bot, block.position) ? FORBID : 0
}

/**
 * Whether a player standing in `cell` stands on pointed dripstone: a stalagmite's tip in the cell (its box 0.6875 high,
 * the feet on it), or a column of it under the cell. PointedDripstoneBlock.fallOn: a fall onto a tip pointing up
 * hurts as one 2.5 blocks longer, twice over (a jump off one and back onto it hurts), and a drop onto it worse.
 */
export function onDripstone (blockAt: (p: Vec3) => { name: string } | null | undefined, cell: { x: number, y: number, z: number }): boolean {
  // (a plain x, y, z: the pathfinder's nodes' positions have no Vec3 methods)
  const at = new Vec3(cell.x, cell.y, cell.z)
  return blockAt(at)?.name === 'pointed_dripstone' || blockAt(at.offset(0, -1, 0))?.name === 'pointed_dripstone'
}

/**
 * The pathfinder's step rule: no move ends standing on pointed dripstone (onDripstone), no walk onto a stalagmite and
 * no drop onto one. A 26.3 bot whose walk had stood it on a stalagmite in a dripstone cave crit-jumped at the zombies
 * there and was impaled 17 times, once a jump, till it died.
 */
export function dripstoneStepCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  return (block) => onDripstone(p => bot.blockAt(p), block.position) ? FORBID : 0
}

/** adds dripstoneStepCost to the pathfinder's step rules for good (once) */
export function keepOffDripstone (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalDripstone === true)) return
  const cost = dripstoneStepCost(bot)
  ;(cost as any).survivalDripstone = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost] })
}

/** adds hazardLeftStepCost to the pathfinder's step rules for good (once) */
export function keepOutOfHazardsLeft (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalHazardLeft === true)) return
  const cost = hazardLeftStepCost(bot)
  ;(cost as any).survivalHazardLeft = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost] })
  // (a respawn or another dimension: the cells were another world's)
  bot.on('respawn', () => clearHazardsLeft(bot))
}
