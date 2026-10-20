// The last line against a walk off a ledge for every walk, not only the pathfinder's: its edge guard
// (@nxg-org/mineflayer-pathfinder's EdgeGuard) on for every tick. Whenever the bot's keys would take its feet off the
// ground this tick over a drop deeper than the pathfinder's maxDropDown (held to the health, capDropsByHealth) with no
// move planning it, the bot sneaks (Player.maybeBackOffFromEdge holds it at the edge) and lets go of jump and sprint:
// the skills' own steering (walkTo and gridWalk's steps, ensureSurface, the explore legs' walks, the fight's and the
// escapes' steerToward) is held at an edge as goto's moves are. A drop into water, a ladder, a ride and a glide are let
// be. 26.3 bots fell 31 blocks off a move that ran on (full-26.3-fresh-o), 35 off a bridge on an explore leg
// (full-26.3-fresh-r) and 6 at 2 health in a failed jump's slide (full-26.3-s31337-f).
import type { Bot } from 'mineflayer'
import type { EdgeFall } from '@nxg-org/mineflayer-pathfinder'
import { trace } from './util'

/** ticks between two traces of the guard's catches outside goto (a hold at an edge catches each tick) */
const TRACE_EVERY = 100

/** the pathfinder's edge guard on for every tick; the catches of the skills' own walks traced */
export function guardEdges (bot: Bot): void {
  const guard = bot.pathfinder?.edgeGuard
  if (guard == null || (bot as any).survivalEdgeGuard === true) return
  ;(bot as any).survivalEdgeGuard = true
  guard.mode = 'always'
  let last = -Infinity
  bot.on('edgeGuard', (fall: EdgeFall) => {
    if (bot.pathfinder.isPathing || guard.tick - last < TRACE_EVERY) return
    last = guard.tick
    const depth = Number.isFinite(fall.depth) ? `${fall.depth.toFixed(1)} blocks` : 'the void'
    trace(`edge guard: held at ${fall.from.toString()} over a drop of ${depth} (${fall.allowed} allowed)`)
  })
}
