// The night's mine started in a slime chunk when the slime balls of the nether's fire resistance are short (its magma
// cream: a blaze powder and a slime ball) and the seed is known: Slime.checkSlimeSpawnRules lets slimes spawn under y
// 40 there whatever the light (worldgen/slime), so the mine's tunnels and the caves it opens there are where they come,
// and the fights with them leave the small ones' balls (a slime splits on its death into 2 to 4 of half its size,
// Slime.remove; only a size 1 drops slime balls) for the drops reflex to pick up. A room dug there and watched from
// past 24 off (NaturalSpawner spawns nothing nearer a player) got no slime in 4 runs of 10000 to 12000 ticks on 26.3 seed
// 2, by night and by day, at y 24 and at y -20: the server held 71 to 73 monsters all the while, at the mob cap
// (NaturalSpawner spawns no monster past it), and not one slime anywhere, so no room is dug.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { slimeChunksNear } from '../worldgen/slime'
import type { Seed } from '../worldgen/random'
import { travel } from './travel'
import { isAbort } from './errors'
import { countItems, trace } from './util'

/** slime balls (or magma cream) wanted in the bag: the brew's one and a spare (the stock's slime mark keeps 2) */
export const SLIME_BALLS_WANTED = 2
/** the slime chunks looked for this many chunks round the bot (64 blocks: a short walk at dusk) */
export const SLIME_SEARCH_CHUNKS = 4

/** whether the bag holds fewer slime balls and magma cream than `want` */
export function slimeBallsShort (bot: Bot, want = SLIME_BALLS_WANTED): boolean {
  return countItems(bot, ['slime_ball', 'magma_cream']) < want
}

/** the middle of the nearest slime chunk within `radius` chunks of (x, z), at height y, or null */
export function nearestSlimeChunk (seed: Seed, x: number, z: number, y = 0, radius = SLIME_SEARCH_CHUNKS): Vec3 | null {
  const chunk = slimeChunksNear(seed, x, z, radius)[0]
  return chunk == null ? null : new Vec3(chunk.x * 16 + 8, y, chunk.z * 16 + 8)
}

/** whether (x, z) is in a slime chunk of the seed */
export function inSlimeChunk (seed: Seed, x: number, z: number): boolean {
  return slimeChunksNear(seed, x, z, 0).length > 0
}

/**
 * To the middle of the nearest slime chunk (on the surface: the night's mine digs down from where it starts), when
 * the bot isn't in one already; resolves where it is, null when there's none near or the walk failed
 */
export async function toSlimeChunk (bot: Bot, seed: Seed, signal?: AbortSignal): Promise<Vec3 | null> {
  const p = bot.entity.position
  if (inSlimeChunk(seed, p.x, p.z)) return p.floored()
  const target = nearestSlimeChunk(seed, p.x, p.z, Math.floor(p.y))
  if (target == null) return null
  trace('toSlimeChunk: the slime chunk', Math.floor(target.x / 16), Math.floor(target.z / 16), 'at', target.toString())
  try {
    await travel(bot, { target, range: 4 }, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    trace('toSlimeChunk: the way there:', (err as Error).message)
    return null
  }
  // (on dry ground: a lake over the chunk's middle is no place to dig down from, nor to smelt and craft in)
  await toDryGroundIn(bot, Math.floor(target.x / 16), Math.floor(target.z / 16), signal)
  return inSlimeChunk(seed, bot.entity.position.x, bot.entity.position.z) ? bot.entity.position.floored() : null
}

/**
 * The chunk's column nearest the bot whose top is dry ground (no water or lava: columnSurface), or null: where the
 * night's mine starts in a slime chunk with water over its middle
 */
export function dryColumnIn (lookup: (p: Vec3) => { name: string, boundingBox: string } | null, chunkX: number, chunkZ: number, from: Vec3): Vec3 | null {
  const { columnSurface } = require('../executor/explore') as typeof import('../executor/explore')
  const cols: Vec3[] = []
  for (let x = chunkX * 16; x < chunkX * 16 + 16; x++) for (let z = chunkZ * 16; z < chunkZ * 16 + 16; z++) cols.push(new Vec3(x, Math.floor(from.y), z))
  cols.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))
  for (const c of cols) {
    const top = columnSurface(lookup, c.x, c.z, c.y)
    if (top != null && !['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'ice'].includes(top)) return c
  }
  return null
}

/**
 * Out of the water onto dry ground in the chunk (dryColumnIn), else to the nearest shore (toShore). A 1.21.11 bot's
 * night mine in the slime chunk at (151, -90) was started in a lake there: its smelt and craft sank it, the drowning
 * reflex took it up three times, and it drowned at (147, 57, -89) (grimls-2, t83599 to t85228).
 */
export async function toDryGroundIn (bot: Bot, chunkX: number, chunkZ: number, signal?: AbortSignal): Promise<boolean> {
  const { inWater, toShore } = require('../executor/explore') as typeof import('../executor/explore')
  if (!inWater(bot)) return true
  const dry = dryColumnIn(p => bot.blockAt(p) as any, chunkX, chunkZ, bot.entity.position)
  if (dry != null) {
    trace('toSlimeChunk: in the water: to dry ground at', dry.x, dry.z)
    try {
      await travel(bot, { target: dry, range: 1 }, signal)
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return !inWater(bot) || await toShore(bot, signal)
}
