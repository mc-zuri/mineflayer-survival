// danger: the places the bot keeps away from: the deep dark's sculk, seen as it goes (its sensors hear the bot's steps
// and digs, its shriekers call the warden: the pathfinder's costs for it, the mining targets left there), and where
// pillagers are in view (an outpost's, a patrol's: the mining targets left there).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { findBlocks } from '../core/findBlocks'
import { normalizeDimension } from '../core/memory'
import { isAlive } from './combatUtil'

/** the deep dark's blocks that hear or call: sensors (SculkSensorBlockEntity's listener, 8 blocks; the calibrated one 16), shriekers, catalysts */
export const SCULK_LISTENERS = new Set(['sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker'])
export const SCULK_SIGNS = new Set([...SCULK_LISTENERS, 'sculk_catalyst'])
/** blocks never broken or stepped on: a shrieker stepped on shrieks (SculkShriekerBlock.stepOn), a sensor hears its own break */
export const SCULK_UNTOUCHED = SCULK_LISTENERS

/** a sensor's hearing (SculkSensorBlockEntity.VibrationUser.getListenerRadius: 8; a calibrated one's 16) */
export function listenerRadius (name: string): number {
  return name === 'calibrated_sculk_sensor' ? 16 : 8
}

/** the kinds of danger kept */
export type DangerKind = 'sculk'

export interface DangerPoint {
  kind: DangerKind
  x: number
  y: number
  z: number
  /** within this distance is the danger's */
  radius: number
  /** the bot's tick it is forgotten at (Infinity: never) */
  until: number
}

/** the mobs of an outpost or a patrol (Raider's) */
export const PILLAGER_KIN = new Set(['pillager', 'vindicator', 'evoker', 'illusioner', 'ravager'])
/** how far from a pillager in view the bot's mining targets are left (an outpost's tower and its spawns about it) */
export const PILLAGER_RADIUS = 32
/** the cost the pathfinder adds to a step or a dig within a sensor's hearing (a long way round is cheaper) */
export const SCULK_COST = 60
/** the pathfinder's cost for what is never done (the exclusion areas' 'forbid') */
export const NEVER = 1e9
/** ticks between the looks for sculk about (a block search) */
export const SCAN_TICKS = 100
/** the deep dark is under y 0 (the deep_dark biome's placement, at depth); sculk is looked for below this */
export const SCULK_SCAN_Y = 20

export class DangerMap {
  readonly points: DangerPoint[] = []
  tick = 0

  /** a danger noted, or one at the same cell of the same kind kept longer */
  note (kind: DangerKind, pos: { x: number, y: number, z: number }, radius: number, ticks = Infinity): void {
    const x = Math.floor(pos.x)
    const y = Math.floor(pos.y)
    const z = Math.floor(pos.z)
    const until = this.tick + ticks
    const same = this.points.find(p => p.kind === kind && p.x === x && p.y === y && p.z === z)
    if (same != null) { same.until = Math.max(same.until, until); same.radius = Math.max(same.radius, radius); return }
    this.points.push({ kind, x, y, z, radius, until })
  }

  /** the danger points whose reach `pos` is in, now */
  at (pos: { x: number, y: number, z: number }, kind?: DangerKind): DangerPoint[] {
    return this.points.filter(p => (kind == null || p.kind === kind) && p.until > this.tick &&
      Math.hypot(p.x + 0.5 - (pos.x + 0.5), p.y + 0.5 - (pos.y + 0.5), p.z + 0.5 - (pos.z + 0.5)) <= p.radius)
  }

  /** forgets the dangers past their time */
  prune (): void {
    for (let i = this.points.length - 1; i >= 0; i--) if (this.points[i].until <= this.tick) this.points.splice(i, 1)
  }
}

const maps = new WeakMap<Bot, DangerMap>()

/** the bot's danger map (made on first use) */
export function dangerMap (bot: Bot): DangerMap {
  let map = maps.get(bot)
  if (map == null) maps.set(bot, map = new DangerMap())
  return map
}

/** whether `pos` is in a danger's reach (any kind, or the kind given) */
export function inDanger (bot: Bot, pos: { x: number, y: number, z: number }, kind?: DangerKind): boolean {
  return dangerMap(bot).at(pos, kind).length > 0
}

/**
 * A pillager (or one of its kin) in view within PILLAGER_RADIUS of `pos`: a pillager outpost's (they spawn about its
 * tower for good, PillagerOutpost's spawn overrides) or a patrol's. A 26.3 bot with a stone sword and no armor went to
 * an outpost to mine its hay bales for bread, and its pillagers shot it there (full-26.3-s9183-a)
 */
export function pillagersNear (bot: Bot, pos: { x: number, y: number, z: number }, radius = PILLAGER_RADIUS): boolean {
  const p = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
  return Object.values(bot.entities).some(e => e !== bot.entity && PILLAGER_KIN.has(e.name ?? '') && isAlive(bot, e) && e.position.distanceTo(p) <= radius)
}

/** a block a mining target there is left for: in the sculk's hearing (inDanger) or by pillagers in view (pillagersNear) */
export function dangerAt (bot: Bot, pos: { x: number, y: number, z: number }): boolean {
  return inDanger(bot, pos, 'sculk') || pillagersNear(bot, pos)
}

/** one look about: the sculk's sensors, shriekers and catalysts within 32 blocks (under SCULK_SCAN_Y) */
export function scanDangers (bot: Bot): void {
  const map = dangerMap(bot)
  map.prune()
  if (bot.entity == null) return
  if (normalizeDimension(bot.game?.dimension) !== 'overworld') return
  if (bot.entity.position.y > SCULK_SCAN_Y || (typeof (bot.world as any)?.getColumn !== 'function' && typeof bot.findBlocks !== 'function')) return
  const ids = [...SCULK_SIGNS].map(n => (bot.registry.blocksByName as any)[n]?.id).filter((n): n is number => n != null)
  for (const pos of findBlocks(bot, { matching: ids, maxDistance: 32, count: 64 })) {
    const name = bot.blockAt(pos)?.name ?? ''
    // a catalyst is the heart of a patch: the sensors about it hear as far
    map.note('sculk', pos, (SCULK_LISTENERS.has(name) ? listenerRadius(name) : 8) + 2)
  }
}

/** the scan every SCAN_TICKS ticks, from the bot's physics ticks (createPlugin) */
export function watchDangers (bot: Bot): void {
  const map = dangerMap(bot)
  bot.on('physicsTick', () => {
    map.tick++
    if (map.tick % SCAN_TICKS === 0) scanDangers(bot)
  })
}

interface BlockInfoLike { position: { x: number, y: number, z: number }, type?: number, name?: string }

/**
 * The pathfinder's exclusion areas for the deep dark: a step on a sensor or a shrieker never (a shrieker stepped on
 * shrieks), a step or a dig within a sensor's hearing SCULK_COST more (the vibrations, VibrationSystem: each step a
 * player takes not sneaking, each block broken), a sensor, shrieker or catalyst never broken
 */
export function sculkMoveAreas (bot: Bot): { step: (b: BlockInfoLike) => number, brk: (b: BlockInfoLike) => number } {
  const nameOf = (b: BlockInfoLike): string => b.name ?? (b.type != null ? bot.registry.blocks[b.type]?.name ?? '' : '')
  const near = (p: { x: number, y: number, z: number }): boolean => dangerMap(bot).at(p, 'sculk').length > 0
  const step = (b: BlockInfoLike): number => {
    const p = b.position
    // (every shrieker and sensor is a sculk point itself: a step on one is within its reach)
    if (dangerMap(bot).points.length === 0 || !near(p)) return 0
    const under = bot.blockAt(new Vec3(p.x, p.y - 1, p.z))?.name ?? ''
    return SCULK_UNTOUCHED.has(under) || SCULK_UNTOUCHED.has(nameOf(b)) ? NEVER : SCULK_COST
  }
  const brk = (b: BlockInfoLike): number => {
    if (SCULK_SIGNS.has(nameOf(b))) return NEVER
    if (dangerMap(bot).points.length === 0) return 0
    return near(b.position) ? SCULK_COST : 0
  }
  ;(step as any).survivalSculk = true
  ;(brk as any).survivalSculk = true
  return { step, brk }
}

/** the deep dark's areas laid over the pathfinder's default settings, once (createPlugin) */
export function installSculkAvoidance (bot: Bot): void {
  const pf: any = (bot as any).pathfinder
  const settings = pf?.defaultMoveSettings
  if (settings?.exclusionAreasStep == null || typeof pf.setMoveOptions !== 'function') return
  if ((settings.exclusionAreasStep as any[]).some(a => a?.survivalSculk === true)) return
  const { step, brk } = sculkMoveAreas(bot)
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...settings.exclusionAreasStep, step], exclusionAreasBreak: [...(settings.exclusionAreasBreak ?? []), brk] })
}
