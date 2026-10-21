// Keeping the bot's head out of water on its walks. The player breathes only with its eyes out of water
// (LivingEntity.baseTick: the air supply runs down while the eyes are in water, 300 ticks of it, then 2 damage a
// second; the same in 26.3), and the pathfinder walks and swims under water like through air: a way to an ore through a flooded cave
// (an aquifer) drowned the bot on seed 5.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

const WATER = new Set(['water', 'bubble_column'])

/**
 * The extra cost, in ticks, of a step with the head under water and no air over it: dear enough that a way through
 * dry rock or a swim at the surface goes first, short of a wall (a keep-out left a bot already in a flooded cave with
 * no way out at all: seed 7, 100000 ticks under water)
 */
export const UNDERWATER_STEP_COST = 100

export type NameLookup = (pos: Vec3) => { name: string } | null

/**
 * A step cost for the pathfinder (an exclusion area): a cell whose head room is water with no air right over it (a
 * flooded tunnel, the bottom of a lake: no air to come up to) costs UNDERWATER_STEP_COST more. Swimming at the
 * surface (the head room's water under air) and wading cost nothing more.
 */
export function underwaterStepCost (lookup: NameLookup): (block: { position: Vec3 }) => number {
  return (block) => {
    const head = block.position.offset(0, 1, 0)
    if (!WATER.has(lookup(head)?.name ?? '')) return 0
    const over = lookup(head.offset(0, 1, 0))?.name
    return over === 'air' || over === 'cave_air' || over == null ? 0 : UNDERWATER_STEP_COST
  }
}

/** adds underwaterStepCost to the pathfinder's step costs for good (once) */
export function keepHeadAboveWater (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalBreath === true)) return
  const cost = underwaterStepCost(pos => bot.blockAt(pos) as any)
  ;(cost as any).survivalBreath = true
  // (and not under again where the drowning reflex took it up from lately)
  const drowned = drownedStepCost(bot, pos => bot.blockAt(pos) as any)
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost, drowned] })
}

/** ticks a spot the drowning reflex took the bot up from stays off for the work (its targets, its ways under water) */
export const DROWNED_TICKS = 6000
/** how far round such a spot (across, and up or down) */
export const DROWNED_RADIUS = 8
/** the extra cost of a step with the head in water within DROWNED_RADIUS of such a spot: not under there again */
export const DROWNED_STEP_COST = 1000

/**
 * ticks a spot is kept off once the drowning reflex took the bot up from it twice within DROWNED_REPEAT_WINDOW, or the
 * bot drowned there (left for good, a game's while): a 26.3 bot's night shelter by an aquifer was gone back into after
 * 8 drowning reflexes, and it drowned (f1-26.3, t197024 to t200563); a 1.21.11 Grim game's bot drowned in the sea, went
 * back to its death spot there and drowned there again (f1-grim, t108690 and t120443)
 */
export const DROWNED_REPEAT_TICKS = 24000
/** the window two drownings at a spot make it one left for good (DROWNED_REPEAT_TICKS) */
export const DROWNED_REPEAT_WINDOW = 1200
/** the cost of a step with the head in water by a spot left for good, for a bot out of the water: COST_INF */
export const DROWNED_FORBID = 1000000

const drownings = new WeakMap<Bot, Array<{ at: Vec3, tick: number, until: number }>>()

/** the client ticks so far: the task runner's count, else the lockstep's, else the clock's */
function nowTick (bot: Bot): number {
  return (bot as any).survival?.tasks?.tick ?? (bot as any).lockstep?.ticks ?? Math.floor(Date.now() / 50)
}

/**
 * remembers where the drowning reflex took the bot up from, for DROWNED_TICKS; a second time within DROWNED_RADIUS and
 * DROWNED_REPEAT_WINDOW, or `forGood` (the bot drowned there), for DROWNED_REPEAT_TICKS. Resolves whether the spot is
 * one left for good now.
 */
export function noteDrowning (bot: Bot, at: Vec3, forGood = false): boolean {
  let list = drownings.get(bot)
  if (list == null) drownings.set(bot, list = [])
  const now = nowTick(bot)
  for (let i = list.length - 1; i >= 0; i--) if (now > list[i].until || list[i].tick > now) list.splice(i, 1)
  const spot = at.floored()
  const near = (d: { at: Vec3 }): boolean => Math.max(Math.abs(d.at.x - spot.x), Math.abs(d.at.y - spot.y), Math.abs(d.at.z - spot.z)) <= DROWNED_RADIUS
  const repeat = forGood || list.some(d => near(d) && now - d.tick <= DROWNED_REPEAT_WINDOW)
  list.push({ at: spot, tick: now, until: now + (repeat ? DROWNED_REPEAT_TICKS : DROWNED_TICKS) })
  return repeat
}

function spotsNear (bot: Bot, pos: { x: number, y: number, z: number }, radius: number): Array<{ at: Vec3, tick: number, until: number }> {
  const list = drownings.get(bot)
  if (list == null || list.length === 0) return []
  const now = nowTick(bot)
  return list.filter(d => now - d.tick >= 0 && now <= d.until && Math.max(Math.abs(d.at.x - pos.x), Math.abs(d.at.y - pos.y), Math.abs(d.at.z - pos.z)) <= radius)
}

/** whether `pos` is within `radius` of a spot the bot drowned at lately (kept off: DROWNED_TICKS, DROWNED_REPEAT_TICKS) */
export function drownedNear (bot: Bot, pos: { x: number, y: number, z: number }, radius = DROWNED_RADIUS): boolean {
  return spotsNear(bot, pos, radius).length > 0
}

/** whether `pos` is within `radius` of a spot left for good (two drownings, or a death by drowning) */
export function drownedForGoodNear (bot: Bot, pos: { x: number, y: number, z: number }, radius = DROWNED_RADIUS): boolean {
  return spotsNear(bot, pos, radius).some(d => d.until - d.tick > DROWNED_TICKS)
}

/** forgets the spots */
export function clearDrownings (bot: Bot): void {
  drownings.get(bot)?.splice(0)
}

/**
 * A step cost: a cell with its head room in water within DROWNED_RADIUS of a spot the bot drowned at lately
 * (drownedNear) costs DROWNED_STEP_COST more, so the walk the drowning reflex hands back to doesn't take the bot back
 * under: a 1.21.11 bot's 'mine 16 cobblestone' went under a pond's water at y 56 again after each surfacing, 35 times
 * in 28000 ticks (ls3-1.21.11, t1071 to t29598). By a spot left for good (drownedForGoodNear) none at all
 * (DROWNED_FORBID) for a bot out of the water, its way out of it all the same for one in it.
 */
export function drownedStepCost (bot: Bot, lookup: NameLookup): (block: { position: Vec3 }) => number {
  return (block) => {
    const p = block.position
    if (!WATER.has(lookup(new Vec3(p.x, p.y + 1, p.z))?.name ?? '')) return 0
    if (!drownedNear(bot, p)) return 0
    if (drownedForGoodNear(bot, p)) {
      const at = (bot as any).entity?.position
      const wet = at != null && [0, 1].some(dy => WATER.has(lookup(new Vec3(Math.floor(at.x), Math.floor(at.y) + dy, Math.floor(at.z)))?.name ?? ''))
      return wet ? DROWNED_STEP_COST : DROWNED_FORBID
    }
    return DROWNED_STEP_COST
  }
}
