// spawnerFarm: the experience farm of a dungeon's zombie spawner, a kill booth in its wall. Vanilla's BaseSpawner
// spawns its mob (up to 4 a go, every 200 - 800 ticks, while fewer than 6 are about and a player is within 16 blocks)
// within 4 blocks across of it and a block up or down, where it's dark (Monster.isDarkEnoughToSpawn: no block light).
// The room is sealed where caves cut through its walls (MonsterRoomFeature leaves 1 - 5 such holes), so what spawns
// stays in, and the bot stands in a booth dug two blocks into a wall: between it and the room the wall's block at the
// floor is kept and the one over it dug, a slit a block high. A zombie (1.95 high) can't get through the slit, and its
// attack reaches only 0.83 blocks out of its box across (Mob.getAttackBoundingBox), short of the bot a block further
// in, jumping or not; the bot's reach (3) goes through the slit to the zombie pressed against the wall after it. A
// pillar two blocks up doesn't do: a zombie jumping at its foot (1.25 up) reaches the bot's feet (26.3, health lost
// and the bot knocked off). No water and no drop: the bot's reach does the killing; the orbs fly in to it
// (ExperienceOrb follows a player within 8 blocks). A baby zombie (0.98 high) fits through the slit: it is fought in
// the booth. Same in 1.21.11 and 26.3.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SkillError, isAbort, throwIfAborted } from './errors'
import { distanceToBox, entityBox, eyePosition, isAlive, metadataValue, yawPitchOf, type Entity } from './combatUtil'
import { eat } from './eat'
import { attackStrengthOf, bestMeleeWeapon } from './weapons'
import { collectBlock } from './collectBlock'
import { navigate } from './navigate'
import { placeBlock } from './placeBlock'
import { countItems, trace, waitTicks, waitUntil } from './util'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { SCAFFOLD_ITEMS } from '../executor/steps'
import { normalizeDimension, type WorldMemory } from '../core/memory'
import type { TaskError } from '../core/errors'

/** the bot's level and points as the server last sent them (xp.ts's experience, here so xp.ts can use the farm) */
function experience (bot: Bot): { level: number, points: number } {
  const xp = (bot as any).experience ?? {}
  return { level: xp.level ?? 0, points: xp.points ?? 0 }
}

/** the spawners' mobs the kill booth is safe from (melee alone, too tall for the slit, no bow) */
export const BOOTH_MOBS: readonly string[] = ['zombie', 'husk', 'zombie_villager']
/** BaseSpawner's spawnRange: how far across of it a mob spawns */
export const SPAWN_RANGE = 4
/** BaseSpawner's requiredPlayerRange */
export const SPAWNER_PLAYER_RANGE = 16
/** the point of interest a farm is kept as */
export const XP_FARM_POI = 'xp_farm'
/** the point of interest of a spawner seen */
export const SPAWNER_POI = 'spawner'

export interface FarmBlock {
  name: string
  boundingBox?: string
  blockEntity?: any
}
export type FarmLookup = (pos: Vec3) => FarmBlock | null

/** the mob a spawner spawns (its block entity's SpawnData.entity.id, which the server sends: getUpdateTag), or null */
export function spawnerMob (block: FarmBlock | null): string | null {
  const id = block?.blockEntity?.SpawnData?.entity?.id
  return typeof id === 'string' ? id.replace(/^minecraft:/, '') : null
}

const passable = (b: FarmBlock | null): boolean => b != null && b.boundingBox === 'empty' && b.name !== 'lava'
const solid = (b: FarmBlock | null): boolean => b != null && b.boundingBox === 'block'
/** blocks the farm never digs */
const KEEP = /^(bedrock|spawner|chest|trapped_chest|barrier|end_portal_frame|reinforced_deepslate)$/

export interface SpawnerFarmPlan {
  spawner: Vec3
  /** cells to fill: the holes out of the room and in its floor, lowest first */
  seal: Vec3[]
  /** the booth's open sides (filled from inside it) */
  boothSeal: Vec3[]
  /** where the bot's feet are in the booth, two blocks into the wall */
  stand: Vec3
  /** the wall's block at the floor between the booth and the room (dug to get in, put back from inside) */
  barrier: Vec3
  /** the slit over it, dug */
  slit: Vec3
  /** the room's floor cell before the slit, where a zombie is hit */
  killCell: Vec3
}

const CARDINALS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

/**
 * The farm round a spawner: the room (the open cells reachable from the spawner within SPAWN_RANGE across, from its
 * level to 3 over), the holes to seal (a cell on the room's edge with an opening further out, a hole in its floor),
 * and the booth: a floor cell of the room against a wall (the wall solid at the floor and two over it), the booth two
 * cells into the wall (its feet and head cells diggable, a floor under it), the fewest of its sides to seal, near the
 * spawner. Null when no wall will do.
 */
export function planSpawnerFarm (lookup: FarmLookup, spawner: Vec3): SpawnerFarmPlan | null {
  const S = spawner.floored()
  const R = SPAWN_RANGE
  const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`
  const inBounds = (p: Vec3): boolean => Math.abs(p.x - S.x) <= R && Math.abs(p.z - S.z) <= R && p.y >= S.y && p.y <= S.y + 3
  // the room: a flood of the open cells from round the spawner
  const room = new Map<string, Vec3>()
  const queue: Vec3[] = []
  for (const d of [...CARDINALS, new Vec3(0, 1, 0)]) {
    const p = S.plus(d)
    if (inBounds(p) && passable(lookup(p))) { room.set(key(p), p); queue.push(p) }
  }
  while (queue.length > 0) {
    const c = queue.shift() as Vec3
    for (const d of [...CARDINALS, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]) {
      const n = c.plus(d)
      if (!inBounds(n) || room.has(key(n)) || !passable(lookup(n))) continue
      room.set(key(n), n)
      queue.push(n)
    }
  }
  if (room.size === 0) return null
  const cells = [...room.values()]
  // the holes: an edge cell open further out, a floor cell open below
  const seal = new Map<string, Vec3>()
  for (const c of cells) {
    const edge = Math.abs(c.x - S.x) === R || Math.abs(c.z - S.z) === R
    if (edge && CARDINALS.some(d => { const n = c.plus(d); return !inBounds(n) && passable(lookup(n)) })) seal.set(key(c), c)
    if (c.y === S.y && passable(lookup(c.offset(0, -1, 0)))) { const b = c.offset(0, -1, 0); seal.set(key(b), b) }
  }
  const sealed = (p: Vec3): boolean => seal.has(key(p))
  const solidOrSealed = (p: Vec3): boolean => solid(lookup(p)) || sealed(p)
  const diggable = (p: Vec3): boolean => { const b = lookup(p); return b != null && (passable(b) || (solid(b) && !KEEP.test(b.name))) && b.name !== 'water' }
  let best: (SpawnerFarmPlan & { score: number }) | null = null
  for (const kill of cells) {
    if (kill.y !== S.y || kill.equals(S) || sealed(kill)) continue
    // a zombie stands there: a floor, and room over it
    if (!solidOrSealed(kill.offset(0, -1, 0)) || !room.has(key(kill.offset(0, 1, 0)))) continue
    for (const d of CARDINALS) {
      const barrier = kill.plus(d)
      const stand = barrier.plus(d)
      if (room.has(key(barrier)) || !solid(lookup(barrier)) || !solid(lookup(barrier.offset(0, 2, 0)))) continue
      if (KEEP.test(lookup(barrier)?.name ?? '')) continue
      const slit = barrier.offset(0, 1, 0)
      if (!diggable(slit) || !diggable(stand) || !diggable(stand.offset(0, 1, 0))) continue
      if (!solid(lookup(stand.offset(0, -1, 0)))) continue
      // the booth's other sides, its head's and its feet's, and over its head: open ones sealed
      const sides: Vec3[] = [stand.offset(0, 2, 0)]
      for (const e of CARDINALS) {
        if (e.equals(d.scaled(-1))) continue
        for (const dy of [0, 1]) sides.push(stand.plus(e).offset(0, dy, 0))
      }
      const open = sides.filter(p => !solid(lookup(p)))
      if (open.some(p => { const b = lookup(p); return b == null || b.name === 'lava' })) continue
      const score = -open.length * 10 - kill.distanceTo(S)
      if (best == null || score > best.score) best = { spawner: S, seal: [], boothSeal: open, stand, barrier, slit, killCell: kill, score }
    }
  }
  if (best == null) return null
  const { score, ...plan } = best
  plan.seal = [...seal.values()].sort((a, b) => a.y - b.y)
  return plan
}

/** the spawners within `radius` of the bot, with their mobs */
export function findSpawners (bot: Bot, radius = 48): Array<{ pos: Vec3, mob: string | null }> {
  const id = bot.registry.blocksByName.spawner?.id
  if (id == null) return []
  return bot.findBlocks({ matching: id, maxDistance: radius, count: 16 }).map(pos => ({ pos, mob: spawnerMob(bot.blockAt(pos) as any) }))
}

/** notes the spawners about the bot (a 'spawner' point of interest each, its mob as the note); resolves how many are new */
export function noteSpawners (bot: Bot, memory: WorldMemory, radius = 48): number {
  const dimension = normalizeDimension(bot.game?.dimension)
  let n = 0
  for (const s of findSpawners(bot, radius)) {
    const known = memory.getPois(SPAWNER_POI, { dimension }).some(p => p.x === s.pos.x && p.y === s.pos.y && p.z === s.pos.z)
    if (known) continue
    memory.addPoi(SPAWNER_POI, s.pos, dimension, s.mob ?? '')
    n++
  }
  return n
}

/** the spawners the memory has whose mob the booth farms, nearest `near` first */
export function knownFarmableSpawners (memory: WorldMemory, near?: Vec3, dimension = 'overworld'): Array<{ pos: Vec3, mob: string }> {
  return memory.getPois(SPAWNER_POI, { dimension, near })
    .filter(p => BOOTH_MOBS.includes(p.note ?? ''))
    .map(p => ({ pos: new Vec3(p.x, p.y, p.z), mob: p.note as string }))
}

export interface XpFarm {
  spawner: Vec3
  mob: string
  /** the bot's feet in the booth */
  stand: Vec3
  /** the wall's block between the booth and the room, at the floor */
  barrier: Vec3
  dimension: string
}

/** the farms the memory has */
export function knownXpFarms (memory: WorldMemory, dimension = 'overworld'): XpFarm[] {
  const out: XpFarm[] = []
  for (const poi of memory.getPois(XP_FARM_POI, { dimension })) {
    try {
      const rec = JSON.parse(poi.note ?? '') as { mob: string, stand: [number, number, number], barrier: [number, number, number] }
      out.push({ spawner: new Vec3(poi.x, poi.y, poi.z), mob: rec.mob, stand: new Vec3(...rec.stand), barrier: new Vec3(...rec.barrier), dimension })
    } catch {}
  }
  return out
}

/** how far off a farm is still gone to for levels */
export const XP_FARM_RANGE = 160

/** the nearest farm the memory has within `range` of `from`, or null */
export function nearestXpFarm (memory: WorldMemory, from: Vec3, dimension = 'overworld', range = XP_FARM_RANGE): XpFarm | null {
  return knownXpFarms(memory, dimension).filter(f => f.stand.distanceTo(from) <= range).sort((a, b) => a.stand.distanceTo(from) - b.stand.distanceTo(from))[0] ?? null
}

export function rememberXpFarm (memory: WorldMemory, farm: XpFarm): void {
  memory.removePoi(XP_FARM_POI, farm.spawner, farm.dimension)
  const v = (p: Vec3): [number, number, number] => [p.x, p.y, p.z]
  memory.addPoi(XP_FARM_POI, farm.spawner, farm.dimension, JSON.stringify({ mob: farm.mob, stand: v(farm.stand), barrier: v(farm.barrier) }))
}

/** a building block the bag has (the scaffold's), or null */
function buildingBlock (bot: Bot): string | null {
  return SCAFFOLD_ITEMS.find(n => countItems(bot, n) > 0) ?? null
}

/** blocks the farm takes at most: the seals and the barrier put back */
export function blocksFor (plan: SpawnerFarmPlan): number {
  return plan.seal.length + plan.boothSeal.length + 1
}

/** the light sources in the room that would stop the spawns (a torch the bot or a mineshaft put there) */
const LIGHTS = /(^|_)(torch|lantern|campfire|glowstone|sea_lantern|shroomlight|jack_o_lantern)$/

/** fills the open cells with the bag's blocks; resolves how many weren't filled */
async function fill (bot: Bot, cells: readonly Vec3[], signal?: AbortSignal): Promise<number> {
  let missed = 0
  for (const cell of cells) {
    throwIfAborted(signal)
    if (!passable(bot.blockAt(cell) as any)) continue
    const item = buildingBlock(bot)
    if (item == null) throw new SkillError('MISSING_ITEMS', 'out of blocks to seal with')
    try {
      await placeBlock(bot, { pos: cell, item }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      missed++
      trace('spawnerFarm: no block put at', cell.toString(), (err as Error).message)
    }
  }
  return missed
}

/**
 * Builds the farm round the spawner at `spawner` (planSpawnerFarm): the room's holes sealed with the bag's blocks, its
 * lights broken, the booth dug and gone into, its open sides and the barrier filled from inside. Resolves the farm,
 * the bot in its booth. Throws NOT_FOUND for no spawner, a mob the booth isn't for or no plan, MISSING_ITEMS without
 * the blocks.
 */
export async function buildSpawnerFarm (bot: Bot, spawner: Vec3, signal?: AbortSignal): Promise<XpFarm> {
  throwIfAborted(signal)
  const block = bot.blockAt(spawner)
  if (block?.name !== 'spawner') throw new SkillError('NOT_FOUND', `no spawner at ${spawner.toString()}`)
  const mob = spawnerMob(block as any) ?? 'unknown'
  if (!BOOTH_MOBS.includes(mob)) throw new SkillError('NOT_FOUND', `a ${mob} spawner: the booth farm is for ${BOOTH_MOBS.join(', ')}`)
  // (into the room first: what's loaded about it is what the plan reads)
  await navigate(bot, { goal: new goals.GoalNear(spawner.x, spawner.y, spawner.z, 3) }, signal)
  const plan = planSpawnerFarm(pos => bot.blockAt(pos) as any, spawner)
  if (plan == null) throw new SkillError('NOT_FOUND', `no wall for a booth by the spawner at ${spawner.toString()}`)
  if (countItems(bot, SCAFFOLD_ITEMS) < blocksFor(plan)) throw new SkillError('MISSING_ITEMS', `${blocksFor(plan)} blocks to build the farm with, ${countItems(bot, SCAFFOLD_ITEMS)} held`)
  trace('spawnerFarm: sealing', plan.seal.length, 'holes, the booth at', plan.stand.toString(), 'its slit at', plan.slit.toString())
  await fill(bot, plan.seal, signal)
  // the room dark again (BaseSpawner's mob needs block light 0)
  const lights: Vec3[] = []
  for (let dx = -SPAWN_RANGE; dx <= SPAWN_RANGE; dx++) {
    for (let dz = -SPAWN_RANGE; dz <= SPAWN_RANGE; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        const p = spawner.offset(dx, dy, dz)
        if (LIGHTS.test(bot.blockAt(p)?.name ?? '')) lights.push(p)
      }
    }
  }
  if (lights.length > 0) await collectBlock(bot, { positions: lights, pickup: true }, signal).catch(err => { if (isAbort(err)) throw err })
  const farm: XpFarm = { spawner: spawner.floored(), mob, stand: plan.stand, barrier: plan.barrier, dimension: normalizeDimension(bot.game?.dimension) }
  await enterBooth(bot, farm, signal)
  const missed = await fill(bot, plan.boothSeal, signal)
  if (missed > 0) throw new SkillError('CANNOT_PLACE', `${missed} of the booth's open sides not filled`)
  return farm
}

/** the bot is in the booth: its feet in the stand's cell */
export function onStand (bot: Bot, stand: Vec3): boolean {
  const p = bot.entity.position
  return Math.abs(p.x - (stand.x + 0.5)) < 0.5 && Math.abs(p.z - (stand.z + 0.5)) < 0.5 && Math.abs(p.y - stand.y) < 0.6
}

/**
 * Into the booth: the barrier and the slit dug, the booth's two cells too (the first time), the bot walked in, and the
 * barrier put back from inside (against the floor under it)
 */
export async function enterBooth (bot: Bot, farm: Pick<XpFarm, 'stand' | 'barrier'>, signal?: AbortSignal): Promise<void> {
  if (onStand(bot, farm.stand) && solid(bot.blockAt(farm.barrier) as any)) return
  const cells = [farm.barrier.offset(0, 1, 0), farm.barrier, farm.stand.offset(0, 1, 0), farm.stand]
  const toDig = cells.filter(p => !passable(bot.blockAt(p) as any))
  if (toDig.length > 0) await collectBlock(bot, { positions: toDig, pickup: false }, signal)
  if (!onStand(bot, farm.stand)) await navigate(bot, { goal: new goals.GoalBlock(farm.stand.x, farm.stand.y, farm.stand.z) }, signal)
  await waitUntil(bot, () => bot.entity.onGround && onStand(bot, farm.stand), 20, signal)
  if (!onStand(bot, farm.stand)) throw new SkillError('VERIFY_FAILED', `the bot is at ${bot.entity.position.toString()}, not in the booth at ${farm.stand.toString()}`)
  const item = buildingBlock(bot)
  if (item == null) throw new SkillError('MISSING_ITEMS', 'no block to shut the booth with')
  await placeBlock(bot, { pos: farm.barrier, item, against: farm.barrier.offset(0, -1, 0) }, signal)
  if (!solid(bot.blockAt(farm.barrier) as any)) throw new SkillError('VERIFY_FAILED', `the booth's barrier at ${farm.barrier.toString()} isn't back`)
}

export interface UseFarmArgs {
  /** the level to reach */
  level?: number
  /** or this many kills */
  kills?: number
  /** give up after (default 24000) */
  maxTicks?: number
}

export interface UseFarmResult {
  level: number
  points: number
  kills: number
  ticks: number
}

/** the food bar the bot eats at in its booth, with no zombie at the slit (natural regeneration wants 18 or more) */
export const FARM_EAT_AT = 16

/** the hostile mobs the bot in the booth hits: the farm's mob and any other that came in */
const HITTABLE = new Set([...BOOTH_MOBS, 'skeleton', 'spider', 'cave_spider', 'creeper', 'silverfish', 'drowned', 'stray', 'bogged'])

/**
 * Stands in the farm's booth killing what comes to the slit (the mobs within the player's reach of the eyes and in the
 * crosshair, the nearest first, each swing at full strength: Player.getAttackStrengthScale) until the level or the
 * kills are reached, the orbs flying in to the bot. The bot goes back in when it's out. Throws TIMEOUT after maxTicks.
 */
export async function useSpawnerFarm (bot: Bot, farm: XpFarm, args: UseFarmArgs = {}, signal?: AbortSignal): Promise<UseFarmResult> {
  const maxTicks = args.maxTicks ?? 24000
  const start = experience(bot).points
  let ticks = 0
  let kills = 0
  const onTick = (): void => { ticks++ }
  const hit = new Set<number>()
  const onDead = (e: Entity): void => { if (hit.has(e.id)) { kills++; hit.delete(e.id) } }
  const onHurt = (e: Entity): void => {
    if (e !== bot.entity) return
    const near = Object.values(bot.entities).filter(m => m !== bot.entity && HITTABLE.has(m.name ?? '')).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    trace('spawnerFarm: hurt, health', bot.health, 'the nearest', near?.name, near != null && metadataValue(bot, near, 'baby') === true ? '(baby)' : '', near?.position.toString())
  }
  bot.on('physicsTick', onTick)
  bot.on('entityDead', onDead)
  bot.on('entityHurt', onHurt)
  // (the hostiles reflex would go out after them)
  const release = (bot as any).survival?.reflexes?.inhibit?.(['hostiles']) as (() => void) | undefined
  const strength = attackStrengthOf(bot)
  const result = (): UseFarmResult => ({ level: experience(bot).level, points: experience(bot).points - start, kills, ticks })
  const done = (): boolean => (args.level != null && experience(bot).level >= args.level) || (args.kills != null && kills >= args.kills)
  try {
    await enterBooth(bot, farm, signal)
    let lastLevel = experience(bot).level
    while (!done()) {
      throwIfAborted(signal, result())
      if (ticks >= maxTicks) throw new SkillError('TIMEOUT', `level ${experience(bot).level}, ${kills} kills after ${ticks} ticks`, result())
      if (!onStand(bot, farm.stand) || !solid(bot.blockAt(farm.barrier) as any)) {
        trace('spawnerFarm: out of the booth at', bot.entity.position.toString())
        await enterBooth(bot, farm, signal)
      }
      if (experience(bot).level !== lastLevel) { lastLevel = experience(bot).level; trace('spawnerFarm: level', lastLevel, 'kills', kills, 'ticks', ticks, 'health', bot.health) }
      const eye = eyePosition(bot)
      const target = Object.values(bot.entities)
        .filter(e => e !== bot.entity && HITTABLE.has(e.name ?? '') && isAlive(bot, e) && distanceToBox(eye, entityBox(e)) <= 2.9)
        .sort((a, b) => distanceToBox(eye, entityBox(a)) - distanceToBox(eye, entityBox(b)))[0]
      if (target != null) {
        const weapon = bestMeleeWeapon(bot, target.name)
        if (weapon != null && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
        // at what shows of it through the slit: its body at the slit's middle height
        const box = entityBox(target)
        const y = Math.max(box.min.y + 0.1, Math.min(box.max.y - 0.1, farm.barrier.y + 1.5))
        const { yaw, pitch } = yawPitchOf(new Vec3(target.position.x, y, target.position.z).minus(eye))
        await bot.look(yaw, pitch, true)
        if (strength.scale(0.5) >= 1 && strength.attack(target)) hit.add(target.id)
      } else if (bot.food <= FARM_EAT_AT) {
        // fed between the zombies (the swings tire: Player.attack's exhaustion), so the health comes back
        await eat(bot, { signal }).catch(err => { if (isAbort(err)) throw err; trace('spawnerFarm: no meal:', (err as Error).message) })
      }
      await waitTicks(bot, 1, signal)
    }
  } catch (err) {
    if (isAbort(err)) throw (err as TaskError).withPartial?.(result()) ?? err
    throw err
  } finally {
    bot.off('physicsTick', onTick)
    bot.off('entityDead', onDead)
    bot.off('entityHurt', onHurt)
    release?.()
  }
  return result()
}
