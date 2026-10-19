// bot.findBlocks by state id: the nearest blocks of some types in the loaded chunks, read from the columns' state ids.
// mineflayer's findBlocks makes a prismarine Block (its block entity, biome and light read) for every one of the 4096
// cells of each section whose palette has a match: the fortress scan after each hop, the planner's look round for
// what's in sight and the village check held a 26.3 run 1 to 4.7 s at a time, 87 s of a 10 minute nether stage.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

export interface FindBlocksOptions {
  /** block ids (bot.registry.blocksByName[name].id) */
  matching: number | readonly number[]
  /** from where (default the bot's position), floored */
  point?: Vec3
  /** blocks within this distance of the point (default 16) */
  maxDistance?: number
  /** the nearest this many (default 1) */
  count?: number
}

/** per registry: the state ids of each block id */
const stateTables = new WeakMap<object, Map<string, Uint8Array>>()

/** a table by state id of the blocks matching, or null when the registry has no state ranges */
function matchTable (bot: Bot, ids: readonly number[]): Uint8Array | null {
  const registry = bot.registry as any
  let tables = stateTables.get(registry)
  if (tables == null) stateTables.set(registry, tables = new Map())
  const key = ids.join(',')
  let table = tables.get(key)
  if (table != null) return table
  let max = 0
  for (const b of registry.blocksArray as any[]) if (typeof b.maxStateId === 'number') max = Math.max(max, b.maxStateId)
  table = new Uint8Array(max + 1)
  for (const id of ids) {
    const b = registry.blocks[id]
    if (b == null) continue
    if (typeof b.minStateId !== 'number' || typeof b.maxStateId !== 'number') return null
    table.fill(1, b.minStateId, b.maxStateId + 1)
  }
  tables.set(key, table)
  return table
}

/**
 * The nearest `count` blocks of the ids within `maxDistance` of the point, nearest first (as bot.findBlocks; exactly
 * the nearest, where findBlocks stops at the octahedron's layer that has them). A section with none of them in its
 * palette is skipped (as findBlocks), and the cells of the others are matched by their state id, no Block made.
 */
export function findBlocks (bot: Bot, opts: FindBlocksOptions): Vec3[] {
  const ids = typeof opts.matching === 'number' ? [opts.matching] : opts.matching
  const world = bot.world as any
  const table = typeof world?.getColumn === 'function' ? matchTable(bot, ids) : null
  if (table == null) return bot.findBlocks({ ...opts, matching: [...ids] })
  const point = (opts.point ?? bot.entity.position).floored()
  const maxDistance = opts.maxDistance ?? 16
  const count = opts.count ?? 1
  const minY: number = (bot.game as any)?.minY ?? 0
  const height: number = (bot.game as any)?.height ?? 256

  // the sections within reach, nearest first (by the distance from the point to the section's box)
  const sections: Array<{ x: number, y: number, z: number, d: number }> = []
  const lo = (v: number): number => Math.floor((v - maxDistance) / 16)
  const hi = (v: number): number => Math.floor((v + maxDistance) / 16)
  const syLo = Math.max(lo(point.y), Math.floor(minY / 16))
  const syHi = Math.min(hi(point.y), Math.floor((minY + height - 1) / 16))
  const gap = (v: number, s: number): number => v < s * 16 ? s * 16 - v : v > s * 16 + 15 ? v - (s * 16 + 15) : 0
  for (let sx = lo(point.x); sx <= hi(point.x); sx++) {
    for (let sz = lo(point.z); sz <= hi(point.z); sz++) {
      for (let sy = syLo; sy <= syHi; sy++) {
        const d = Math.hypot(gap(point.x, sx), gap(point.y, sy), gap(point.z, sz))
        if (d <= maxDistance) sections.push({ x: sx, y: sy, z: sz, d })
      }
    }
  }
  sections.sort((a, b) => a.d - b.d)

  const found: Array<{ pos: Vec3, d: number }> = []
  const local = new Vec3(0, 0, 0)
  let sorted = true
  for (const s of sections) {
    if (found.length >= count) {
      if (!sorted) { found.sort((a, b) => a.d - b.d); sorted = true }
      if (s.d > found[count - 1].d) break
    }
    const column = world.getColumn(s.x, s.z)
    if (column == null) continue
    const section = column.sections?.[s.y - Math.floor(minY / 16)]
    // (an empty section, or one whose palette has none of the blocks: as findBlocks' isBlockInSection)
    if (column.sections != null && section == null) continue
    if (Array.isArray(section?.palette) && !section.palette.some((state: number) => table[state] === 1)) continue
    // (a section of one block, 1.18's SingleValueContainer: no palette, its one value)
    if (section?.palette == null && typeof section?.data?.value === 'number' && table[section.data.value] !== 1) continue
    for (let y = s.y * 16; y < s.y * 16 + 16; y++) {
      const dy = y - point.y
      for (let lx = 0; lx < 16; lx++) {
        const dx = s.x * 16 + lx - point.x
        for (let lz = 0; lz < 16; lz++) {
          if (table[column.getBlockStateId(local.set(lx, y, lz))] !== 1) continue
          const dz = s.z * 16 + lz - point.z
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (d > maxDistance) continue
          found.push({ pos: new Vec3(s.x * 16 + lx, y, s.z * 16 + lz), d })
          sorted = false
        }
      }
    }
  }
  found.sort((a, b) => a.d - b.d)
  return found.slice(0, count).map(f => f.pos)
}

/** the nearest block of the ids within reach (as bot.findBlock), or null */
export function findBlock (bot: Bot, opts: Omit<FindBlocksOptions, 'count'>): ReturnType<Bot['blockAt']> {
  if (typeof (bot.world as any)?.getColumn !== 'function') return bot.findBlock({ ...opts, matching: typeof opts.matching === 'number' ? opts.matching : [...opts.matching] })
  const at = findBlocks(bot, { ...opts, count: 1 })[0]
  return at == null ? null : bot.blockAt(at)
}
