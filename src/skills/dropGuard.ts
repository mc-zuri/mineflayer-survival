// No drop on a path the bot's health can't take: the pathfinder's maxDropDown held to what it can fall and live
// (LivingEntity.calculateFallDamage: the fall past the safe 3 blocks, rounded up, a jump's rise of 1.25 counted in),
// put back as the health comes back. A 26.3 bot starving at 1 health (normal difficulty stops starving there) walked an
// explore leg off a 4-block drop and "hit the ground too hard" (full-26.3-fresh-d).
// At low health (LOW_HEALTH or under) the path keeps off the jumps and edges a slip off kills from: no parkour (its
// executor gives up a jump it won't make, and the run-up's speed carries on over the edge), no sprint jumps, and the
// pathfinder's costs for an edge and a jump by a deadly drop raised (Movement.deadlyFall, held to the capped drop): a
// 26.3 bot starved to 2 health slid off a ledge after a ParkourForward it gave up ('will not make this jump!') and fell
// 5 blocks, and one at 0.2 health 'hit the ground too hard' walking a snowy mountain's explore leg (full-26.3-s31337-f).
import type { Bot } from 'mineflayer'
import { movementProviders } from '@nxg-org/mineflayer-pathfinder'

/** the pathfinder's own drop at full health (its default, a fall that does no harm) */
export const SAFE_DROP = 3
/** a jump's rise over the step it leaves, counted into a drop's fall (a parkour or a jump down) */
export const JUMP_RISE = 1.25

/** the most a path may drop at `health`: the fall's damage, ceil(drop + JUMP_RISE - 3), under the health */
export function dropForHealth (health: number, wanted = SAFE_DROP): number {
  let drop = wanted
  while (drop > 1 && Math.max(0, Math.ceil(drop + JUMP_RISE - SAFE_DROP)) >= health) drop--
  return drop
}

/** the health at or under which the path keeps off jumps and edges (movesForHealth) */
export const LOW_HEALTH = 4
/** the pathfinder's edgeHazardCost at low health: a long way round before a walk along a deadly edge (its default 4) */
export const LOW_HEALTH_EDGE_COST = 40
/** the pathfinder's hazardJumpCost at low health (its default 20) */
export const LOW_HEALTH_JUMP_COST = 80

/** the moves a low-health path goes without */
export const PARKOUR_MOVES: readonly unknown[] = [movementProviders.ParkourForward, movementProviders.ParkourDiagonal]

/** the move settings asked for that the health caps */
export interface WantedMoves {
  maxDropDown?: number
  edgeHazardCost?: number
  hazardJumpCost?: number
  allowJumpSprint?: boolean
}

/** the settings the health allows of those asked for: the drop capped (dropForHealth), at low health the edges dear */
export function movesForHealth (health: number, wanted: WantedMoves): Required<WantedMoves> {
  const low = health <= LOW_HEALTH
  const drop = wanted.maxDropDown ?? SAFE_DROP
  return {
    maxDropDown: Math.min(drop, dropForHealth(health, drop)),
    edgeHazardCost: low ? Math.max(wanted.edgeHazardCost ?? 4, LOW_HEALTH_EDGE_COST) : wanted.edgeHazardCost ?? 4,
    hazardJumpCost: low ? Math.max(wanted.hazardJumpCost ?? 20, LOW_HEALTH_JUMP_COST) : wanted.hazardJumpCost ?? 20,
    allowJumpSprint: low ? false : wanted.allowJumpSprint ?? true
  }
}

/**
 * Wraps the pathfinder's setMoveOptions so every set of move settings has its maxDropDown held to dropForHealth and,
 * at low health, its edges and jumps dear (movesForHealth; what was asked kept as survivalWanted, so a setting put
 * back keeps what was asked, not the cap), and sets them again as the health changes; the parkour moves are taken out
 * at low health and put back as it comes back
 */
export function capDropsByHealth (bot: Bot): void {
  const pf = bot.pathfinder as any
  if (pf?.setMoveOptions == null || pf.defaultMoveSettings == null || pf.survivalDropCap === true) return
  pf.survivalDropCap = true
  const set = pf.setMoveOptions.bind(pf)
  const health = (): number => bot.health ?? 20
  const apply = (settings: any): void => {
    const wanted = askedMoves(settings)
    const capped = movesForHealth(health(), wanted)
    set({ ...settings, survivalWanted: wanted, survivalCapped: capped, survivalWantedDrop: wanted.maxDropDown, ...capped })
  }
  pf.setMoveOptions = (settings: any) => apply(settings)
  // the parkour moves' executors, kept while they are out
  const parked = new Map<unknown, unknown>()
  const parkour = (low: boolean): void => {
    if (pf.movements == null) return
    if (low) {
      for (const p of PARKOUR_MOVES) {
        const exec = pf.movements.get(p)
        if (exec == null) continue
        parked.set(p, exec)
        if (typeof pf.dropMovment === 'function') pf.dropMovment(p)
        else pf.movements.delete(p)
      }
    } else {
      for (const [p, exec] of parked) {
        ;(exec as any).settings = pf.defaultMoveSettings
        if (typeof pf.setExecutor === 'function') pf.setExecutor(p, exec)
        else pf.movements.set(p, exec)
      }
      parked.clear()
    }
  }
  let last = ''
  const update = (): void => {
    const wanted: WantedMoves = pf.defaultMoveSettings?.survivalWanted ?? {}
    const now = movesForHealth(health(), wanted)
    const key = JSON.stringify(now)
    if (key === last) return
    last = key
    apply(pf.defaultMoveSettings)
    parkour(health() <= LOW_HEALTH)
  }
  bot.on('health', update)
  apply(pf.defaultMoveSettings)
  last = JSON.stringify(movesForHealth(health(), pf.defaultMoveSettings?.survivalWanted ?? {}))
  parkour(health() <= LOW_HEALTH)
}

const MOVE_KEYS = ['maxDropDown', 'edgeHazardCost', 'hazardJumpCost', 'allowJumpSprint'] as const

/**
 * What a set of move settings asks for: those made from the held ones ({ ...held, edgeHazardCost: 6 }, the nether's)
 * ask what they changed from the capped values held, and what was asked before for the rest; others, what they say
 */
export function askedMoves (settings: any): WantedMoves {
  const wanted: WantedMoves | undefined = settings.survivalWanted
  const capped: WantedMoves | undefined = settings.survivalCapped
  if (wanted == null || capped == null) {
    return {
      maxDropDown: settings.survivalWantedDrop ?? settings.maxDropDown ?? SAFE_DROP,
      edgeHazardCost: settings.edgeHazardCost,
      hazardJumpCost: settings.hazardJumpCost,
      allowJumpSprint: settings.allowJumpSprint
    }
  }
  const out: any = {}
  for (const k of MOVE_KEYS) out[k] = settings[k] !== capped[k] ? settings[k] : wanted[k]
  return out
}
