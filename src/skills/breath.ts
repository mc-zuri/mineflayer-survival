// Keeping the bot's head out of water on its walks. The player breathes only with its eyes out of water
// (LivingEntity.baseTick: the air supply runs down while the eyes are in water, 300 ticks of it, then 2 damage a
// second), and the pathfinder walks and swims under water like through air: a way to an ore through a flooded cave
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
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost] })
}
