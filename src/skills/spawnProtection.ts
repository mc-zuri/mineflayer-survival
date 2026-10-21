// Spawn protection: the square about the world spawn where a dedicated server lets no player who isn't an op break or
// place a block (DedicatedServer.isUnderSpawnProtection: in the spawn's dimension, with an op on the server, the
// player none, spawn-protection above 0, and max(|dx|, |dz|) to the spawn at most spawn-protection; 16 by default,
// DedicatedServerProperties). The server refuses the dig's start (ServerPlayerGameMode.handleBlockBreakAction) and the
// use on a block there (ServerGamePacketListenerImpl.handleUseItemOn: the block clicked) and puts the block back. 26.3
// says so on the action bar (ServerPlayer.sendSpawnProtectionMessage: 'build.spawn_protection' with the block's
// toShortString, "1, 67, 1 is under spawn protection"); 1.21.11 says nothing, the block is only put back.
//
// And any server's refusals (a claim, a protected region, adventure mode): a dig or a place the server put back marks
// its cell for REFUSED_CELL_TICKS, and more than two close together a region with no dig nor place in it.
//
// The bot learns the square (from the message, or from the same cell's dig or place put back SPAWN_REFUSALS times
// near the spawn) and keeps its work out of it: the pathfinder breaks and places nothing in it, the mine steps,
// collectBlock and placeBlock pass its blocks over, and the base's site is chosen out of it. It walks through it.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { normalizeDimension } from '../core/memory'
import { trace } from './util'
import { navigate } from './navigate'
import { findBlocks } from '../core/findBlocks'

/** the vanilla server's spawn-protection (DedicatedServerProperties: 16), the radius taken once a refusal is seen */
export const SPAWN_PROTECTION_RADIUS = 16
/** a dig or a place put back at the same cell this many times near the spawn is the spawn's protection */
export const SPAWN_REFUSALS = 2
/** how far from the spawn a cell's refusals are taken for its protection (twice the default radius) */
export const SPAWN_INFER_RANGE = 32
/** the ticks a dig's or a place's prediction waits for the server to put the block back (its answer and acknowledgement) */
export const REFUSAL_TICKS = 40
/** the cost the pathfinder's rules put on a block in the square: never broken nor placed (past its COST_INF) */
export const SPAWN_PROTECTION_COST = 1e9
/** how far past the square the bot walks to put a block down by it (findPlacementNear's 5 and the place's block) */
export const SPAWN_LEAVE_MARGIN = 7
/** a cell whose dig or place the server put back is neither dug nor placed in for this many ticks */
export const REFUSED_CELL_TICKS = 1200
/** this many refusals within REGION_RANGE of each other within REGION_WINDOW ticks are a protected region */
export const REGION_REFUSALS = 3
export const REGION_RANGE = 8
export const REGION_WINDOW = 1200
/** the region: the refusals' square and REGION_MARGIN about it, for REGION_TICKS */
export const REGION_MARGIN = 2
export const REGION_TICKS = 6000
/** the translation key of the refusal's message (ServerPlayer.sendSpawnProtectionMessage) */
export const SPAWN_PROTECTION_KEY = 'build.spawn_protection'

/** the blocks that fall into a cell dug under them (FallingBlock): their coming back is no refusal */
const FALLING = /(^|_)(sand|gravel|concrete_powder|anvil|scaffolding|dragon_egg|suspicious_sand|suspicious_gravel)$/

/** the plugin's option: a radius known (0: none), or 'auto' to learn it from the server's refusals */
export type SpawnProtectionOption = number | 'auto'

interface Pending { tick: number, type: number, stateId: number }

export interface SpawnProtectionState {
  option: SpawnProtectionOption
  /** the radius known (the option's, or learnt), null while none is */
  radius: number | null
  /** the dimension of the world spawn (the spawn_position packet's, the overworld before it says) */
  dimension: string
  /** the bot's op level (the server's entity event 24 + level): an op is never under the protection */
  opLevel: number
  /** refusals counted by cell */
  refusals: Map<string, number>
  /** the breaks the client predicted, by cell: the block that was there */
  digs: Map<string, Pending>
  /** the places the client predicted, by cell: the block that was there before */
  places: Map<string, Pending>
  /** cells (by dimension and cell) whose dig or place the server refused lately: not tried again till `until` */
  refused: Map<string, { until: number, dig: boolean, place: boolean }>
  /** the refusals of the last REGION_WINDOW ticks */
  recent: Array<{ cell: Vec3, tick: number, dimension: string }>
  /** the protected regions learnt from them: no dig nor place in them till `until` */
  regions: Array<{ x: number, z: number, radius: number, dimension: string, until: number }>
  tick: number
}

const states = new WeakMap<object, SpawnProtectionState>()

const keyOf = (p: { x: number, y: number, z: number }): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const cellOf = (key: string): Vec3 => { const [x, y, z] = key.split(',').map(Number); return new Vec3(x, y, z) }

/** the bot's spawn protection state, or null when installSpawnProtection hasn't run */
export function spawnProtectionState (bot: Bot): SpawnProtectionState | null {
  return states.get(bot) ?? null
}

/** the world spawn the square is about (the spawn_position packet's: ServerLevel.getRespawnData), or null */
export function spawnCenter (bot: Bot): Vec3 | null {
  const p = (bot as any).spawnPoint as Vec3 | undefined
  return p == null ? null : new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
}

/** max(|dx|, |dz|) from the spawn to the cell (DedicatedServer.isUnderSpawnProtection's measure), Infinity with no spawn */
export function spawnDistance (bot: Bot, pos: { x: number, z: number }): number {
  const c = spawnCenter(bot)
  if (c == null) return Infinity
  return Math.max(Math.abs(Math.floor(pos.x) - c.x), Math.abs(Math.floor(pos.z) - c.z))
}

const dimensionOf = (bot: Bot): string => normalizeDimension((bot as any).game?.dimension)

/** whether the server refused a dig (or a place) at this very cell lately (REFUSED_CELL_TICKS) */
export function refusedCell (bot: Bot, pos: { x: number, y: number, z: number }, kind: 'dig' | 'place'): boolean {
  const state = states.get(bot)
  const mark = state?.refused.get(`${dimensionOf(bot)}:${keyOf(pos)}`)
  return mark != null && mark.until > (state as SpawnProtectionState).tick && mark[kind]
}

/** whether the cell is in a protected region learnt from the refusals (and `margin` about it) */
export function inRefusedRegion (bot: Bot, pos: { x: number, y: number, z: number }, margin = 0): boolean {
  const state = states.get(bot)
  if (state == null || state.regions.length === 0) return false
  const dimension = dimensionOf(bot)
  return state.regions.some(r => r.until > state.tick && r.dimension === dimension &&
    Math.max(Math.abs(Math.floor(pos.x) - r.x), Math.abs(Math.floor(pos.z) - r.z)) <= r.radius + margin)
}

/** whether a dig of the block is refused: the spawn's square, the cell refused lately, or a region */
export function breakRefused (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  return underSpawnProtection(bot, pos) || refusedCell(bot, pos, 'dig') || inRefusedRegion(bot, pos)
}

/** whether a use of the block (a place against it, opening it) is refused: the spawn's square or a region */
export function useRefused (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  return underSpawnProtection(bot, pos) || inRefusedRegion(bot, pos)
}

/** whether a block placed in the cell is refused: the square or a region and a block about them, or the cell refused lately */
export function placeRefused (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  return placeUnderSpawnProtection(bot, pos) || refusedCell(bot, pos, 'place') || inRefusedRegion(bot, pos, 1)
}

/** whether the bot is in the spawn's dimension, where the square is */
function inSpawnDimension (bot: Bot, state: SpawnProtectionState): boolean {
  const here = (bot as any).game?.dimension
  return here == null || normalizeDimension(here) === state.dimension
}

/**
 * Whether the cell is in the square the bot can't break or place in: the radius known, in the spawn's dimension, the
 * bot no op (but for a radius the option sets), max(|dx|, |dz|) to the spawn at most the radius and `margin`.
 */
export function underSpawnProtection (bot: Bot, pos: { x: number, y: number, z: number }, margin = 0): boolean {
  const state = states.get(bot)
  if (state?.radius == null || state.radius <= 0) return false
  if (state.opLevel > 0 && state.option === 'auto') return false
  if (!inSpawnDimension(bot, state)) return false
  return spawnDistance(bot, pos) <= state.radius + margin
}

/**
 * Whether a block placed in the cell is refused: the server checks the block clicked (handleUseItemOn), one beside
 * the cell, so the cells a block out of the square are left too
 */
export function placeUnderSpawnProtection (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  return underSpawnProtection(bot, pos, 1)
}

/** the pathfinder's break rule: SPAWN_PROTECTION_COST where a dig is refused (breakRefused) */
export function spawnProtectionBreakCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  return (block) => breakRefused(bot, block.position) ? SPAWN_PROTECTION_COST : 0
}

/** the pathfinder's place rule: SPAWN_PROTECTION_COST where a place is refused (placeRefused) */
export function spawnProtectionPlaceCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  return (block) => placeRefused(bot, block.position) ? SPAWN_PROTECTION_COST : 0
}

/** the pathfinder's break and place rules for the square, added once (they cost nothing while no radius is known) */
export function keepOffSpawnProtection (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if (((settings.exclusionAreasBreak ?? []) as any[]).some(f => f?.survivalSpawn === true)) return
  const brk = spawnProtectionBreakCost(bot)
  const place = spawnProtectionPlaceCost(bot)
  ;(brk as any).survivalSpawn = true
  ;(place as any).survivalSpawn = true
  pf.setMoveOptions({ ...settings, exclusionAreasBreak: [...(settings.exclusionAreasBreak ?? []), brk], exclusionAreasPlace: [...(settings.exclusionAreasPlace ?? []), place] })
}

/**
 * The cell a message says is under spawn protection, or null: the translatable 'build.spawn_protection' with the
 * block's "x, y, z" (BlockPos.toShortString), or its English text from a server that sends it as text
 */
export function spawnProtectionMessage (msg: any): Vec3 | null {
  if (msg == null) return null
  const parse = (s: string): Vec3 | null => {
    const m = /(-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(s)
    return m == null ? null : new Vec3(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  const find = (m: any): Vec3 | null => {
    if (m == null || typeof m !== 'object') return null
    if (m.translate === SPAWN_PROTECTION_KEY) {
      const arg = m.with?.[0]
      const text = typeof arg === 'string' ? arg : typeof arg?.toString === 'function' ? arg.toString() : arg?.text
      return typeof text === 'string' ? parse(text) : null
    }
    for (const part of m.extra ?? []) {
      const found = find(part)
      if (found != null) return found
    }
    return null
  }
  const found = find(msg)
  if (found != null) return found
  const text = typeof msg === 'string' ? msg : typeof msg.toString === 'function' ? String(msg.toString()) : ''
  const m = /^(-?\d+, -?\d+, -?\d+) is under spawn protection/.exec(text.trim())
  return m == null ? null : parse(m[1])
}

/**
 * The square learnt from a refusal at `cell`: its radius the cell's distance from the spawn, SPAWN_PROTECTION_RADIUS
 * at the least (or the option's), and never less than known before. A dig under way in it is stopped, a place the
 * client predicted against it is put back at once (no block under the bot that the server hasn't), and a path under
 * way is planned again with the square kept.
 */
export function learnSpawnProtection (bot: Bot, cell: Vec3, why: string): void {
  const state = states.get(bot)
  if (state == null) return
  const d = spawnDistance(bot, cell)
  if (!Number.isFinite(d)) return
  const floor = typeof state.option === 'number' && state.option > 0 ? state.option : SPAWN_PROTECTION_RADIUS
  const radius = Math.max(state.radius ?? floor, d)
  const grew = radius !== state.radius
  state.radius = radius
  // the bot was refused: it's no op, whatever it was told
  if (state.option === 'auto') state.opLevel = 0
  if (grew) trace('spawnProtection: radius', radius, 'about', String(spawnCenter(bot)), 'from', why, 'at', cell.toString())
  undoRefusedPlaces(bot, cell)
  const digging = (bot as any).targetDigBlock?.position
  if (digging != null && underSpawnProtection(bot, digging) && typeof bot.stopDigging === 'function') {
    try { bot.stopDigging() } catch {}
  }
  if (grew) replan(bot)
}

/** the path under way planned again, with the refused cells kept */
function replan (bot: Bot): void {
  const pf = bot.pathfinder as any
  if (pf?.isPathing === true && typeof pf.reset === 'function') void Promise.resolve(pf.reset('blockUpdate')).catch(() => {})
}

/**
 * The places the client predicted beside the refused cell (the one clicked) or in the square put back to what the
 * server has at once, before its answer comes: the bot stood on such a block, and a server's anticheat saw it stand
 * on air ('standing on air - force-sending blocks below', a Paper server)
 */
function undoRefusedPlaces (bot: Bot, cell: Vec3): void {
  const state = states.get(bot)
  if (state == null) return
  for (const [key, pending] of [...state.places]) {
    const p = cellOf(key)
    const beside = Math.abs(p.x - cell.x) + Math.abs(p.y - cell.y) + Math.abs(p.z - cell.z) <= 1
    if (!beside && !placeUnderSpawnProtection(bot, p)) continue
    state.places.delete(key)
    const now = bot.blockAt(p)
    if (now == null || now.type !== pending.type) continue
    const update = (bot as any)._updateBlockState
    if (typeof update === 'function') update(p, pending.stateId)
    else (bot.world as any)?.setBlockStateId?.(p, pending.stateId)
  }
}

/**
 * A refusal at the cell (its dig or place put back by the server): the cell marked for REFUSED_CELL_TICKS (any server:
 * a claim, a protected region, adventure mode) and the path under way planned round it; REGION_REFUSALS of them
 * within REGION_RANGE of each other lately (no op) a protected region; SPAWN_REFUSALS at the same cell near the
 * spawn ('auto' and no op) its protection.
 */
export function noteRefusal (bot: Bot, cell: Vec3, why: string): void {
  const state = states.get(bot)
  if (state == null) return
  const dimension = dimensionOf(bot)
  const markKey = `${dimension}:${keyOf(cell)}`
  const mark = state.refused.get(markKey)
  const dig = why === 'dig'
  state.refused.set(markKey, { until: state.tick + REFUSED_CELL_TICKS, dig: dig || (mark?.dig ?? false), place: !dig || (mark?.place ?? false) })
  trace('spawnProtection: refused', why, cell.toString(), 'kept from it', REFUSED_CELL_TICKS, 'ticks')
  replan(bot)
  if (state.opLevel === 0) noteRegion(bot, state, cell, dimension)
  if (state.option !== 'auto' || state.opLevel > 0) return
  if (!inSpawnDimension(bot, state)) return
  if (spawnDistance(bot, cell) > SPAWN_INFER_RANGE) return
  const key = keyOf(cell)
  const n = (state.refusals.get(key) ?? 0) + 1
  state.refusals.set(key, n)
  trace('spawnProtection: refused', why, cell.toString(), n)
  if (n >= SPAWN_REFUSALS) learnSpawnProtection(bot, cell, `${n} ${why}s put back`)
}

/** the refusals close together lately: REGION_REFUSALS of them a protected region about them */
function noteRegion (bot: Bot, state: SpawnProtectionState, cell: Vec3, dimension: string): void {
  state.recent = state.recent.filter(r => state.tick - r.tick <= REGION_WINDOW)
  state.recent.push({ cell: cell.floored(), tick: state.tick, dimension })
  const near = state.recent.filter(r => r.dimension === dimension && Math.max(Math.abs(r.cell.x - cell.x), Math.abs(r.cell.z - cell.z)) <= REGION_RANGE)
  if (near.length < REGION_REFUSALS) return
  const xs = near.map(r => r.cell.x)
  const zs = near.map(r => r.cell.z)
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
  const x = Math.floor((x0 + x1) / 2)
  const z = Math.floor((z0 + z1) / 2)
  const radius = Math.max(x1 - x, x - x0, z1 - z, z - z0) + REGION_MARGIN
  state.regions = state.regions.filter(r => r.until > state.tick)
  state.regions.push({ x, z, radius, dimension, until: state.tick + REGION_TICKS })
  trace('spawnProtection: a protected region about', x, z, 'radius', radius, 'from', near.length, 'refusals')
  replan(bot)
}

/**
 * Sets the spawn protection up on the bot (once): the option's radius, and with 'auto' the radius learnt from the
 * server's message and from refusals; the pathfinder's rules (keepOffSpawnProtection)
 */
export function installSpawnProtection (bot: Bot, option: SpawnProtectionOption = 'auto'): SpawnProtectionState {
  const known = states.get(bot)
  if (known != null) return known
  const state: SpawnProtectionState = {
    option,
    radius: typeof option === 'number' && option > 0 ? option : null,
    dimension: 'overworld',
    opLevel: 0,
    refusals: new Map(),
    digs: new Map(),
    places: new Map(),
    refused: new Map(),
    recent: [],
    regions: [],
    tick: 0
  }
  states.set(bot, state)
  keepOffSpawnProtection(bot)
  const client = (bot as any)._client
  // the spawn's dimension (from 1.21.9 the packet's global pos has one: ServerLevel.getRespawnData)
  client?.on?.('spawn_position', (packet: any) => {
    const name = packet?.globalPos?.dimensionName ?? packet?.globalPos?.dimension
    if (typeof name === 'string') state.dimension = normalizeDimension(name)
  })
  // the op level the server gives the player (ServerPlayer's entity event 24 + its permission level)
  client?.on?.('entity_status', (packet: any) => {
    const status = Number(packet?.entityStatus)
    if (packet?.entityId === bot.entity?.id && status >= 24 && status <= 28) state.opLevel = status - 24
  })
  bot.on('message' as any, (msg: any) => {
    const cell = spawnProtectionMessage(msg)
    if (cell != null) learnSpawnProtection(bot, cell, 'the server\'s message')
  })
  bot.on('physicsTick' as any, () => {
    state.tick++
    for (const map of [state.digs, state.places]) {
      for (const [key, p] of map) if (state.tick - p.tick > REFUSAL_TICKS) map.delete(key)
    }
    if (state.tick % 200 === 0) for (const [key, m] of state.refused) if (m.until <= state.tick) state.refused.delete(key)
  })
  // the server's putting a predicted block back: the dug block back in its cell, the placed one gone to what was there;
  // then a break the client predicts (mineflayer's dig ends on its own air, the block it digs at that cell) noted,
  // before the dig's own listener takes it for its end. A place the bot digs is no refusal.
  const onUpdate = (oldBlock: any, newBlock: any): void => {
    if (newBlock?.position == null) return
    const key = keyOf(newBlock.position)
    const dug = state.digs.get(key)
    if (dug != null && newBlock.type === dug.type) {
      state.digs.delete(key)
      noteRefusal(bot, newBlock.position, 'dig')
      return
    }
    const target = (bot as any).targetDigBlock?.position
    const digging = target != null && keyOf(target) === key
    const placed = state.places.get(key)
    if (placed != null && (digging || (newBlock.type !== placed.type && newBlock.stateId === placed.stateId))) {
      state.places.delete(key)
      if (!digging) noteRefusal(bot, newBlock.position, 'place')
    }
    if (digging && newBlock.type === 0 && oldBlock != null && oldBlock.type !== 0 && !FALLING.test(String(oldBlock.name))) {
      state.digs.set(key, { tick: state.tick, type: oldBlock.type, stateId: oldBlock.stateId })
    }
  }
  if (typeof (bot as any).prependListener === 'function') (bot as any).prependListener('blockUpdate', onUpdate)
  else bot.on('blockUpdate' as any, onUpdate)
  // (a dig of another's that sets no targetDigBlock, mineflayer-mouse's, tells its end with the block it broke)
  bot.on('diggingCompleted' as any, (block: any) => {
    if (block?.position == null || block.type == null || block.type === 0 || FALLING.test(String(block.name))) return
    const key = keyOf(block.position)
    if (!state.digs.has(key)) state.digs.set(key, { tick: state.tick, type: block.type, stateId: block.stateId })
  })
  // a place the client predicted, the block that was there
  bot.on('blockPlaced' as any, (oldBlock: any, newBlock: any) => {
    if (oldBlock?.position == null || newBlock == null) return
    state.places.set(keyOf(oldBlock.position), { tick: state.tick, type: newBlock.type, stateId: oldBlock.stateId })
  })
  return state
}

/**
 * Walks the bot out of the square and `margin` blocks past it (the side it's nearest), when the radius is known and
 * it's in there: the block the work places by it (a crafting table, a furnace) goes down outside. Resolves whether it
 * walked.
 */
export async function leaveSpawnProtection (bot: Bot, margin: number, signal?: AbortSignal): Promise<boolean> {
  const state = states.get(bot)
  const center = spawnCenter(bot)
  if (state?.radius == null || center == null || !underSpawnProtection(bot, bot.entity.position, margin)) return false
  const pos = bot.entity.position
  const dx = Math.floor(pos.x) - center.x
  const dz = Math.floor(pos.z) - center.z
  const out = state.radius + margin + 2
  // (along the axis it's furthest out on, or east from the spawn itself)
  const target = Math.abs(dx) >= Math.abs(dz)
    ? new Vec3(center.x + (dx < 0 ? -out : out), pos.y, Math.floor(pos.z))
    : new Vec3(Math.floor(pos.x), pos.y, center.z + (dz < 0 ? -out : out))
  trace('spawnProtection: out of the square to', target.toString())
  await navigate(bot, { goal: new goals.GoalNearXZ(target.x, target.z, 1) }, signal)
  return true
}

/**
 * A block to use (a crafting table, a furnace) that the server lets the bot use: `found` when it's out of the square,
 * else the nearest of `matching` within `maxDistance` that is, or null (handleUseItemOn refuses a use on a block in it)
 */
export function usableOutside (bot: Bot, found: ReturnType<Bot['blockAt']>, matching: number | number[], maxDistance: number): ReturnType<Bot['blockAt']> {
  if (found == null || !useRefused(bot, found.position)) return found
  for (const pos of findBlocks(bot, { matching, maxDistance, count: 32 })) {
    if (!useRefused(bot, pos)) return bot.blockAt(pos)
  }
  return null
}
