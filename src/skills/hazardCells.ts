// The cells the hazard reflex took the bot out of, kept out of by the walks for a while after: the reflex steps the bot
// off a magma block, and the walk it hands back to must not take it straight back on (a 26.3 bot by seed 2's
// fortress was taken off a magma block on a bridge's wall and back onto it 430 times, till it died).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { caveCells, caveRuleOn, inCaveWall } from './caves'

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

/**
 * the extra cost, in ticks, of a move ending on a magma block for a bot not sneaking (magmaStepCost): a walk round
 * goes first, short of a wall (a bot on a magma floor walks off it)
 */
export const MAGMA_STEP_COST = 1000

/**
 * The pathfinder's step rule: a move ending on a magma block (its feet over one: MagmaBlock.stepOn burns a player that
 * isn't stepping carefully, Entity.isSteppingCarefully: sneaking) costs MAGMA_STEP_COST, but for a bot sneaking. A 26.3
 * bot's walk to a ruined portal's obsidian underground was taken back onto the magma among its netherrack after each
 * of 12 hazard reflexes, and it burned to death there (ls4-26.3, t54809 to t57447).
 */
export function magmaStepCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  return (block) => {
    const p = block.position
    if (bot.blockAt(new Vec3(p.x, p.y - 1, p.z))?.name !== 'magma_block') return 0
    return bot.getControlState?.('sneak') === true ? 0 : MAGMA_STEP_COST
  }
}

/** adds magmaStepCost to the pathfinder's step rules for good (once) */
export function keepOffMagma (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalMagma === true)) return
  const cost = magmaStepCost(bot)
  ;(cost as any).survivalMagma = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost] })
}

/**
 * Whether obsidian in sight is no place to mine for the bot: lava within 2 of it, magma within 1 (a ruined portal's
 * floor: the bot stands on it or beside it to mine), or, for a bot not fit for the caves (skills/caves caveRuleOn),
 * under the rock or in a cave's wall (a ruined portal underground is a cave's, its netherrack and magma round it). A
 * 26.3 bot's 'obsidian: 1 in sight: mining 1' went for a ruined portal's underground at y 46, stood on its magma, and
 * burned to death there through 12 hazard reflexes (ls4-26.3, t54809 to t57447).
 */
export function obsidianHazard (bot: Bot, p: Vec3): boolean {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const name = bot.blockAt(p.offset(dx, dy, dz))?.name
        if (name === 'lava') return true
        if (name === 'magma_block' && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) <= 1) return true
      }
    }
  }
  if (!caveRuleOn(bot)) return false
  return caveCells(bot).roofed(p.floored()) || inCaveWall(bot, p)
}


/** the extra cost, in ticks, of a move ending with lava against the feet or the head (lavaEdgeStepCost) */
export const LAVA_EDGE_STEP_COST = 500

/**
 * The pathfinder's step rule in the overworld: a move ending with lava in or against the body's cells (the feet's and
 * the head's sides, over the head, under the feet) costs LAVA_EDGE_STEP_COST more, so a way stands off a pool's edge
 * where it can (a knock, a slip, a block broken by it lets the lava in). A 26.3 bot mining a deep pool's obsidian at y
 * -29 stood by its lava and swam into it (ls4-26.3, t188576).
 */
export function lavaEdgeStepCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  // (the classifier's lookup: the block states, no prismarine Block made for each of a search's cells)
  const view = caveCells(bot).view
  const lava = (x: number, y: number, z: number): boolean => view.block(new Vec3(x, y, z))?.name === 'lava'
  return (block) => {
    if (/nether|end/.test(String(bot.game?.dimension ?? ''))) return 0
    const { x, y, z } = block.position
    if (lava(x, y - 1, z) || lava(x, y, z) || lava(x, y + 1, z) || lava(x, y + 2, z)) return LAVA_EDGE_STEP_COST
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (lava(x + dx, y, z + dz) || lava(x + dx, y + 1, z + dz)) return LAVA_EDGE_STEP_COST
    return 0
  }
}

/** adds lavaEdgeStepCost to the pathfinder's step rules for good (once) */
export function keepOffLavaEdges (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalLavaEdge === true)) return
  const cost = lavaEdgeStepCost(bot)
  ;(cost as any).survivalLavaEdge = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost] })
}
