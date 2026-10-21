// A blaze spawner's spawns kept to a dark patch by the nook with torches: BaseSpawner.serverTick, with no custom spawn
// rules (a fortress's spawner has none: NetherFortressPieces' setEntityId(BLAZE)), takes a spawn only where
// mob.checkSpawnRules holds, PathfinderMob's getWalkTargetValue(pos) >= 0, which for a Monster is 0.5 less the light's
// magic value (LevelReader.getLightLevelDependentMagicValue: lerp(ambient_light 0.1, v / (4 - 3v), 1) of the raw
// brightness v / 15): a blaze comes out only where the light is 11 or under (26.3; the placement rule itself,
// Monster.checkAnyLightMonsterSpawnRules, waives it). A torch's 14 makes 12 two steps off. The spawns are tried 4 a
// round at random cells of the volume (the triangle over 4 across either way, -1 to 1 up), a lit one a miss, and the
// next round comes the next tick while none came: with most of the volume lit they come one at a time, in the patch.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { SPAWN_RANGE, spawnWeight, type BlazeNook, type NookLookup, bunkerKept, enterBunker, fightHealth, holdOffBlazes, openSill, withBlocksKept } from './blazeFight'
import { placeBlock } from '../skills/placeBlock'
import { isAbort, throwIfAborted } from '../skills/errors'
import { countItems, trace } from '../skills/util'
import { isAlive } from '../skills/combatUtil'

/** a torch's light (Blocks.TORCH, lightLevel 14) */
export const TORCH_LIGHT = 14
/** a blaze spawns where the light is this or under (getWalkTargetValue >= 0 in the nether's ambient light 0.1) */
export const BLAZE_SPAWN_LIGHT = 11
/** the share of the spawns left dark, by the nook */
export const DARK_PATCH = 0.12
/** the torches put at the most */
export const SPAWNER_TORCHES = 8
/** the torches the spawner's lighting takes at the least (planSpawnerTorches' 4 light some 3 in 4 of seed 2's throne's spawns) */
export const LIGHT_TORCHES = 4

const UP = new Vec3(0, 1, 0)
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), UP, new Vec3(0, -1, 0)]
const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`

/** the spawner's spawn cells (a blaze's box has no block in it there: the cell and the one over free) and their shares */
export function spawnCells (lookup: NookLookup, spawner: Vec3): Array<{ cell: Vec3, weight: number }> {
  const S = spawner.floored()
  const free = (p: Vec3): boolean => { const b = lookup(p); return b != null && b.boundingBox === 'empty' && b.name !== 'lava' }
  const out: Array<{ cell: Vec3, weight: number }> = []
  for (let dx = -SPAWN_RANGE; dx <= SPAWN_RANGE; dx++) {
    for (let dz = -SPAWN_RANGE; dz <= SPAWN_RANGE; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = S.offset(dx, dy, dz)
        if (free(c) && free(c.plus(UP))) out.push({ cell: c, weight: spawnWeight(dx) * spawnWeight(dz) / 3 })
      }
    }
  }
  return out
}

/** the cells a torch at each of `torches` lights over BLAZE_SPAWN_LIGHT: its light spread through what isn't a full block, 1 less a step */
export function litCells (lookup: NookLookup, torches: readonly Vec3[]): Set<string> {
  const lit = new Set<string>()
  const reach = TORCH_LIGHT - BLAZE_SPAWN_LIGHT - 1
  for (const t of torches) {
    let front = [t]
    const seen = new Set([key(t)])
    lit.add(key(t))
    for (let step = 1; step <= reach; step++) {
      const next: Vec3[] = []
      for (const p of front) {
        for (const d of SIDES) {
          const q = p.plus(d)
          if (seen.has(key(q))) continue
          seen.add(key(q))
          const b = lookup(q)
          if (b == null || b.boundingBox === 'block') continue
          lit.add(key(q))
          next.push(q)
        }
      }
      front = next
    }
  }
  return lit
}

/**
 * The torches that light the most of the spawns but a dark patch by the nook (`dark`: the cells left, DARK_PATCH of
 * the spawns nearest the nook's eyes): floor cells (air over a full block) within SPAWN_RANGE + 1 of the spawner, its
 * top first among equals, chosen one at a time for the most lit beside the patch, none lighting any of it; at most
 * `max`, and none that adds less than 4% of the spawns
 */
export function planSpawnerTorches (lookup: NookLookup, spawner: Vec3, eye: Vec3, max = SPAWNER_TORCHES): { torches: Vec3[], dark: Vec3[], unlit: number } {
  const S = spawner.floored()
  const cells = spawnCells(lookup, S)
  const total = cells.reduce((n, c) => n + c.weight, 0)
  const byNear = [...cells].sort((a, b) => a.cell.offset(0.5, 0.9, 0.5).distanceTo(eye) - b.cell.offset(0.5, 0.9, 0.5).distanceTo(eye))
  const dark = new Set<string>()
  let darkWeight = 0
  for (const c of byNear) {
    if (darkWeight >= DARK_PATCH * total) break
    dark.add(key(c.cell))
    darkWeight += c.weight
  }
  const candidates: Vec3[] = []
  for (let dx = -SPAWN_RANGE - 1; dx <= SPAWN_RANGE + 1; dx++) {
    for (let dz = -SPAWN_RANGE - 1; dz <= SPAWN_RANGE + 1; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const p = S.offset(dx, dy, dz)
        const b = lookup(p)
        const under = lookup(p.offset(0, -1, 0))
        if (b == null || b.boundingBox !== 'empty' || b.name === 'lava' || b.name === 'fire' || under == null || under.boundingBox !== 'block') continue
        candidates.push(p)
      }
    }
  }
  // the spawner's top first among equals (the classic torch on it)
  candidates.sort((a, b) => (a.equals(S.plus(UP)) ? -1 : 0) - (b.equals(S.plus(UP)) ? -1 : 0))
  const torches: Vec3[] = []
  let lit = new Set<string>()
  const litWeight = (set: Set<string>): number => cells.reduce((n, c) => n + (set.has(key(c.cell)) && !dark.has(key(c.cell)) ? c.weight : 0), 0)
  for (let i = 0; i < max; i++) {
    let best: { p: Vec3, set: Set<string>, gain: number } | null = null
    const now = litWeight(lit)
    for (const p of candidates) {
      if (torches.some(t => t.equals(p))) continue
      const set = new Set([...lit, ...litCells(lookup, [p])])
      if ([...dark].some(d => set.has(d))) continue
      const gain = litWeight(set) - now
      if (best == null || gain > best.gain + 1e-9) best = { p, set, gain }
    }
    if (best == null || best.gain < 0.04 * total) break
    torches.push(best.p)
    lit = best.set
  }
  const unlit = total > 0 ? 1 - litWeight(lit) / total : 1
  return { torches, dark: cells.filter(c => dark.has(key(c.cell))).map(c => c.cell), unlit }
}

/**
 * The torches of planSpawnerTorches put (placeBlock: walked to, on the floor), as many as the bag has; resolves those
 * put. A torch that won't go in is passed over.
 */
export async function lightBlazeSpawner (bot: Bot, spawner: Vec3, eye: Vec3, signal?: AbortSignal, max = SPAWNER_TORCHES): Promise<Vec3[]> {
  const lookup: NookLookup = p => bot.blockAt(p) as any
  const plan = planSpawnerTorches(lookup, spawner, eye, Math.min(max, countItems(bot, 'torch')))
  trace('lightBlazeSpawner: at', spawner.toString(), plan.torches.length, 'torches, the spawns left', plan.unlit.toFixed(2))
  const put: Vec3[] = []
  for (const t of plan.torches) {
    throwIfAborted(signal)
    try {
      await placeBlock(bot, { pos: t, item: 'torch', against: t.offset(0, -1, 0) }, signal)
      put.push(t)
    } catch (err) {
      if (isAbort(err)) throw err
      trace('lightBlazeSpawner: no torch at', t.toString(), (err as Error).message)
    }
  }
  return put
}

/** the torches a lighting trip out of the bunker puts at the most (the next trip the next) */
export const LIGHT_TRIP_TORCHES = 3
/**
 * a lighting trip goes back in once more blazes than this are within 16, or one within LIGHT_TRIP_NEAR (a 1.21.11 bot
 * back in its bunker by seed 2's open throne at (-290, 77, -209) from a trip with 4 about came in at 3.6 health and
 * was fireballed)
 */
export const LIGHT_TRIP_BLAZES = 2
export const LIGHT_TRIP_NEAR = 5

/** the most ticks the bunker's lighting trip holds off the blazes before each torch */
export const LIGHT_GUARD_TICKS = 200

/**
 * The spawner lit from the bunker (the first rods' cover), all but the patch of its spawns nearest the bunker's eyes:
 * out by the sill, each torch of planSpawnerTorches put with the blazes about held off first where the bot stands
 * (holdOffBlazes untilSafe: the shield toward one about to shoot, the sword at one in reach), the trip given up at
 * `sealAt` health; back in after and the bunker shut again (enterBunker). The blazes then come out one at a time, in
 * the patch in its slit's sight (BaseSpawner: a spawn tried where it's lit is a miss), and leave none to wander about
 * it out of sight: the unlit spawner at seed 2's open throne (-290, 77, -209) made 49 within 48 of a bunker that killed
 * 10 in its first 6000 ticks, its rods never fetched (26.3). Resolves the torches put.
 */
export async function lightFromBunker (bot: Bot, nook: BlazeNook, spawner: Vec3, sealAt = 10, signal?: AbortSignal, max = LIGHT_TRIP_TORCHES): Promise<Vec3[]> {
  const lookup: NookLookup = p => bot.blockAt(p) as any
  const plan = planSpawnerTorches(lookup, spawner, nook.stand.offset(0.5, 1.62, 0.5), Math.min(SPAWNER_TORCHES, countItems(bot, 'torch')))
  plan.torches = plan.torches.filter(t => !['torch', 'wall_torch'].includes(bot.blockAt(t)?.name ?? '')).slice(0, max)
  trace('lightFromBunker: at', spawner.toString(), plan.torches.length, 'torches, the spawns left', plan.unlit.toFixed(2))
  const put: Vec3[] = []
  if (plan.torches.length === 0) return put
  try {
    await openSill(bot, nook, signal)
    await withBlocksKept(bot, [...bunkerKept(nook), spawner.floored()], async () => {
      for (const t of plan.torches) {
        throwIfAborted(signal)
        if (fightHealth(bot) <= sealAt) { trace('lightFromBunker: health', bot.health, ': back in'); break }
        // (more come about it, or one on it: back in)
        const me = bot.entity.position
        const blazes = Object.values(bot.entities).filter(e => e.name === 'blaze' && isAlive(bot, e as any) && e.position.distanceTo(me) <= 16)
        if (blazes.length > LIGHT_TRIP_BLAZES || blazes.some(e => e.position.distanceTo(me) <= LIGHT_TRIP_NEAR)) { trace('lightFromBunker:', blazes.length, 'blazes about: back in'); break }
        await holdOffBlazes(bot, { signal, maxTicks: LIGHT_GUARD_TICKS, untilSafe: true })
        try {
          await placeBlock(bot, { pos: t, item: 'torch', against: t.offset(0, -1, 0) }, signal)
          put.push(t)
        } catch (err) {
          if (isAbort(err)) throw err
          trace('lightFromBunker: no torch at', t.toString(), (err as Error).message)
        }
      }
    })
  } finally {
    await enterBunker(bot, nook, signal)
  }
  return put
}
