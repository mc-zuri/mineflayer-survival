// The server's corrections of the bot's position (its teleports back: ServerGamePacketListenerImpl.handleMovePlayer
// refusing a move, mineflayer's forcedMove) over and over at one spot: the client's world isn't the server's there (a
// block it has as air, a break the server refused that the client never put back), and the move walks into it again
// and again. A bot in the web client was teleported back 25 to 82 times every 100 ticks for 1000 ticks and more, its
// ForwardDropDown to (10.5, 44, -15.5) stuck at (11.3, 45, -15.45). Past CORRECTION_LIMIT in CORRECTION_WINDOW ticks
// at one spot, the move is stopped and planned again: the pathfinder's cached blocks dropped, and the cells between
// the bot and the move's end kept off for SUSPECT_TICKS (its step rule), so the new path goes another way.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { trace } from './util'

/** more corrections than this in CORRECTION_WINDOW ticks, within CORRECTION_SPOT of each other, is a move stuck */
export const CORRECTION_LIMIT = 10
export const CORRECTION_WINDOW = 100
export const CORRECTION_SPOT = 2
/** the cells toward the stuck move's end are kept off for this many ticks */
export const SUSPECT_TICKS = 1200
/** the step rule's cost of such a cell: never stepped in (the pathfinder's COST_INF) */
export const SUSPECT_COST = 1e6

interface GuardState {
  tick: number
  corrections: Array<{ tick: number, pos: Vec3 }>
  /** cells kept off, by key: until when */
  suspects: Map<string, number>
  /** the tick of the last recovery: one a window at most */
  recovered: number
}

const guards = new WeakMap<object, GuardState>()
const keyOf = (p: { x: number, y: number, z: number }): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

/** whether the cell is kept off after a stuck move's corrections */
export function suspectCell (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  const state = guards.get(bot)
  const until = state?.suspects.get(keyOf(pos))
  return until != null && until > (state as GuardState).tick
}

/**
 * The cells between the corrected position and the move's end (at the feet's and head's height, from the lower of the
 * two to the higher): the ones the client may have wrong. Not the bot's own cell.
 */
export function cellsToward (from: Vec3, to: Vec3): Vec3[] {
  const a = from.floored()
  const b = to.floored()
  const out = new Map<string, Vec3>()
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z), 1)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y) + 1
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(a.x + (b.x - a.x) * i / steps)
    const z = Math.round(a.z + (b.z - a.z) * i / steps)
    for (let y = y0; y <= y1; y++) {
      if (x === a.x && z === a.z) continue
      const c = new Vec3(x, y, z)
      out.set(keyOf(c), c)
    }
  }
  return [...out.values()]
}

/** the stuck move stopped: the cells toward its end kept off, the pathfinder's cache dropped, the path planned again */
function recover (bot: Bot, state: GuardState, at: Vec3): void {
  state.recovered = state.tick
  const pf = bot.pathfinder as any
  const move = pf?.currentMove
  const end = move != null && typeof move.x === 'number' ? new Vec3(move.x, move.y, move.z) : null
  const cells = end != null ? cellsToward(at, end) : []
  for (const c of cells) state.suspects.set(keyOf(c), state.tick + SUSPECT_TICKS)
  trace('corrections: stuck at', at.toString(), state.corrections.length, 'corrections; kept off', cells.map(c => c.toString()).join(' '))
  try { pf?.world?.clearCache?.() } catch {}
  if (pf?.isPathing === true && typeof pf.reset === 'function') void Promise.resolve(pf.reset('blockUpdate')).catch(() => {})
}

/** the pathfinder's step rule of the cells kept off (once) */
function keepOffSuspects (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if (((settings.exclusionAreasStep ?? []) as any[]).some(f => f?.survivalCorrections === true)) return
  const step = (block: { position: { x: number, y: number, z: number } }): number => suspectCell(bot, block.position) ? SUSPECT_COST : 0
  ;(step as any).survivalCorrections = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), step] })
}

/** watches the server's corrections of the bot's position (once) */
export function guardCorrections (bot: Bot): void {
  if (guards.has(bot)) return
  const state: GuardState = { tick: 0, corrections: [], suspects: new Map(), recovered: -Infinity }
  guards.set(bot, state)
  keepOffSuspects(bot)
  bot.on('physicsTick' as any, () => {
    state.tick++
    if (state.tick % 200 === 0) for (const [k, until] of state.suspects) if (until <= state.tick) state.suspects.delete(k)
  })
  bot.on('forcedMove' as any, () => {
    const pos = bot.entity?.position
    if (pos == null) return
    const at = pos.clone()
    state.corrections = state.corrections.filter(c => state.tick - c.tick < CORRECTION_WINDOW && c.pos.distanceTo(at) <= CORRECTION_SPOT)
    state.corrections.push({ tick: state.tick, pos: at })
    if (state.corrections.length > CORRECTION_LIMIT && state.tick - state.recovered >= CORRECTION_WINDOW) recover(bot, state, at)
  })
}
