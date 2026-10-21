// danger: the places the bot keeps away from: the deep dark's sculk, seen as it goes (its sensors hear the bot's steps
// and digs, its shriekers call the warden: the pathfinder's costs for it, the mining targets left there, the warden
// fled), and where pillagers are in view (an outpost's, a patrol's: the mining targets left there).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { findBlocks } from '../core/findBlocks'
import { normalizeDimension } from '../core/memory'
import { isAbort } from './errors'
import { navigate } from './navigate'
import { steerAway } from './steer'
import { eyePosition, isAlive, type Entity, TaskError, throwIfAborted, waitTicks } from './combatUtil'
import { countItems, trace } from './util'
import { placeBlock } from './placeBlock'
import { spawnerMob } from './spawnerFarm'
import { caveRuleOn } from './caves'

/** the deep dark's blocks that hear or call: sensors (SculkSensorBlockEntity's listener, 8 blocks; the calibrated one 16), shriekers, catalysts */
export const SCULK_LISTENERS = new Set(['sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker'])
export const SCULK_SIGNS = new Set([...SCULK_LISTENERS, 'sculk_catalyst'])
/** blocks never broken or stepped on: a shrieker stepped on shrieks (SculkShriekerBlock.stepOn), a sensor hears its own break */
export const SCULK_UNTOUCHED = SCULK_LISTENERS

/** a sensor's hearing (SculkSensorBlockEntity.VibrationUser.getListenerRadius: 8; a calibrated one's 16) */
export function listenerRadius (name: string): number {
  return name === 'calibrated_sculk_sensor' ? 16 : 8
}

/** the kinds of danger kept: a sensor's hearing, and the deep dark's ground (its sculk, DEEP_DARK_RADIUS round) */
export type DangerKind = 'sculk' | 'deepdark'

/** the deep dark's blocks: its sculk carpets and veins, the sensors, shriekers and catalysts in them */
export const DEEP_DARK_BLOCKS = new Set([...SCULK_SIGNS, 'sculk', 'sculk_vein'])
/**
 * how far round the deep dark's blocks the ground is the deep dark's (its wardens come out of the shriekers' calls,
 * SculkShriekerBlockEntity; their sonic boom reaches 15): a 26.3 bot went to a lava pool at y -57 in it for its
 * enchanting table's obsidian, a shrieker called a warden out, and its boom killed the bot (f2-26.3, t83894 to t87920)
 */
export const DEEP_DARK_RADIUS = 16

/** whether a block of the deep dark (DEEP_DARK_BLOCKS) lies within `radius` of `pos` in the loaded chunks */
export function deepDarkNear (bot: Bot, pos: { x: number, y: number, z: number }, radius = DEEP_DARK_RADIUS): boolean {
  if (normalizeDimension(bot.game?.dimension) !== 'overworld' || pos.y > SCULK_SCAN_Y + radius) return false
  if (typeof (bot.world as any)?.getColumn !== 'function' && typeof bot.findBlocks !== 'function') return false
  const ids = [...DEEP_DARK_BLOCKS].map(n => (bot.registry.blocksByName as any)[n]?.id).filter((n): n is number => n != null)
  if (ids.length === 0) return false
  return findBlocks(bot, { matching: ids, point: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)), maxDistance: radius, count: 1 }).length > 0
}

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
  // and the deep dark's ground, its sculk and veins too: DEEP_DARK_RADIUS round each
  const dark = [...DEEP_DARK_BLOCKS].map(n => (bot.registry.blocksByName as any)[n]?.id).filter((n): n is number => n != null)
  for (const pos of findBlocks(bot, { matching: dark, maxDistance: 32, count: 64 })) map.note('deepdark', pos, DEEP_DARK_RADIUS)
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
    if (dangerMap(bot).points.length === 0) return 0
    // the deep dark's ground: no step into it for a bot not fit for the caves (skills/caves caveRuleOn), but out of it
    // for one in it (f2-26.3's warden)
    if (caveRuleOn(bot) && dangerMap(bot).at(p, 'deepdark').length > 0) {
      const at = bot.entity?.position
      if (at == null || dangerMap(bot).at(at.floored(), 'deepdark').length === 0) return NEVER
    }
    // (every shrieker and sensor is a sculk point itself: a step on one is within its reach)
    if (!near(p)) return 0
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

/** the warden's sonic boom's reach (SonicBoom: within 15 blocks across and 20 up or down, through walls, shields and armor) */
export const SONIC_BOOM_XZ = 15
export const SONIC_BOOM_Y = 20
/** how far the bot runs from a warden: past its FOLLOW_RANGE 24 and the boom's 15 */
export const WARDEN_SAFE_DISTANCE = 28

/** out of the warden's boom and its follow: further than WARDEN_SAFE_DISTANCE across, or more than SONIC_BOOM_Y up or down */
export function clearOfWarden (bot: Bot, warden: Entity): boolean {
  const p = bot.entity.position
  const q = warden.position
  return Math.hypot(p.x - q.x, p.z - q.z) >= WARDEN_SAFE_DISTANCE || Math.abs(p.y - q.y) > SONIC_BOOM_Y
}

/**
 * Away from a warden till clear of it (clearOfWarden): the pathfinder's way out of its reach (a goal anywhere
 * WARDEN_SAFE_DISTANCE from it, its tunnels and stairs gone back up), the open ground's run straight away between.
 * Never fought: 500 health, a 30 hit and a sonic boom of 10 through shield and armor every 40 ticks it can't reach
 * (SonicBoom: charged 34 ticks, within 15 across). A 26.3 bot digging a staircase up out of the deep dark was boomed
 * twice from 16 and 18 blocks off, its diamond pickaxe in hand (full-26.3-s9183-a).
 */
export async function escapeWarden (bot: Bot, warden: Entity, opts: { signal?: AbortSignal, maxTicks?: number } = {}): Promise<{ ticks: number }> {
  const maxTicks = opts.maxTicks ?? 1200
  const start = (bot as any).lockstep?.ticks as number | undefined
  let ticks = 0
  const spent = (): number => start != null ? ((bot as any).lockstep.ticks as number) - start : ticks
  try {
    while (spent() < maxTicks) {
      throwIfAborted(opts.signal)
      if (!isAlive(bot, warden) || clearOfWarden(bot, warden)) return { ticks: spent() }
      const at = warden.position.floored()
      try {
        // (the pathfinder's own sprint; a few hundred ticks, then the warden's place looked at again)
        await navigate(bot, { goal: new goals.GoalInvert(new goals.GoalNear(at.x, at.y, at.z, WARDEN_SAFE_DISTANCE)) as any, maxTicks: 200, planTicks: 60 }, opts.signal)
      } catch (err) {
        if (isAbort(err)) throw err
        trace('escapeWarden: no way off:', (err as Error).message)
        for (let t = 0; t < 20; t++) {
          if (!steerAway(bot, warden.position)) break
          bot.setControlState('sprint', true)
          await waitTicks(bot, 1, opts.signal)
          ticks++
        }
        bot.clearControlStates()
      }
      ticks++
    }
    throw new TaskError('TIMEOUT', 'the warden is still close')
  } finally {
    bot.clearControlStates()
  }
}

/** the nearest warden within `range`, alive */
export function nearestWarden (bot: Bot, range = 40): Entity | null {
  let best: Entity | null = null
  let bestD = range
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'warden' || !isAlive(bot, e)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best
}

/** a block that gives light enough that no monster spawns by it (a torch's 14, a lantern's 15; Monster.isDarkEnoughToSpawn: block light 0) */
export const SPAWNER_LIGHTS = /(^|_)(torch|lantern|campfire|glowstone|sea_lantern|shroomlight|jack_o_lantern)$/
const SPAWNER_SIDES = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const AIR = new Set(['air', 'cave_air', 'void_air'])

/** whether the bot's eyes see the block: the first block on the line to its middle is it (BlockGetter.clip) */
export function seesBlock (bot: Bot, pos: Vec3): boolean {
  const from = eyePosition(bot)
  const to = pos.offset(0.5, 0.5, 0.5)
  const delta = to.minus(from)
  const dist = delta.norm()
  if (dist < 1e-6) return true
  const raycast = (bot.world as any)?.raycast
  if (typeof raycast === 'function') {
    const hit: any = raycast.call(bot.world, from, delta.scaled(1 / dist), dist + 1)
    return hit?.position != null && hit.position.equals(pos)
  }
  for (let t = 0.25; t < dist - 0.9; t += 0.25) {
    const p = from.plus(delta.scaled(t / dist)).floored()
    if (!p.equals(pos) && bot.blockAt(p)?.boundingBox === 'block') return false
  }
  return true
}

/** a light by the spawner (on it or against a side): its spawn volume's lit (14 at the spawner, 9 or more 4 off) */
export function spawnerLit (bot: Bot, spawner: Vec3): boolean {
  return SPAWNER_SIDES.some(d => SPAWNER_LIGHTS.test(bot.blockAt(spawner.plus(d))?.name ?? ''))
}

/**
 * The monster spawners within `range` the bot sees that are dark (no light by them, spawnerLit), nearest first: in
 * the overworld only (the nether's blaze spawners are the rods' camp)
 */
export function darkSpawners (bot: Bot, range: number): Vec3[] {
  if (normalizeDimension(bot.game?.dimension) !== 'overworld') return []
  const id = (bot.registry.blocksByName as any).spawner?.id
  if (id == null) return []
  return findBlocks(bot, { matching: [id], maxDistance: range, count: 8 }).filter(p => {
    const mob = spawnerMob(bot.blockAt(p) as any)
    const hostile = mob == null || (bot.registry.entitiesByName as any)[mob]?.type === 'hostile'
    return hostile && !spawnerLit(bot, p) && seesBlock(bot, p)
  })
}

/**
 * A torch put on a dungeon's spawner (on its top, else against a side with room): the spawner's mobs need the dark
 * (BaseSpawner's spawns go by the type's SpawnPlacements, Monster.checkMonsterSpawnRules, the light only waived for a
 * trial spawner), and a torch's light, 14 there, is over 0 all through its spawn volume (4 across, 1 up or down). A
 * 26.3 bot in iron mining at y -23 was set on by four zombies at once and killed (full-26.3-fresh-l); a spawner left
 * dark by the mine keeps sending them, four at a go every 10 to 40 seconds while the bot's within 16
 */
export async function lightSpawner (bot: Bot, spawner: Vec3, signal?: AbortSignal): Promise<Vec3> {
  if (countItems(bot, 'torch') === 0) throw new TaskError('MISSING_ITEMS', 'no torch to light the spawner with')
  const cell = SPAWNER_SIDES.map(d => spawner.plus(d)).find(p => AIR.has(bot.blockAt(p)?.name ?? ''))
  if (cell == null) throw new TaskError('FAILED', `no room by the spawner at ${spawner.toString()} for a torch`)
  trace('lightSpawner: a torch at', cell.toString(), 'on the spawner at', spawner.toString())
  await placeBlock(bot, { pos: cell, item: 'torch', against: spawner }, signal)
  return cell
}
