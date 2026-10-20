/** a dimension as `bot.game.dimension` names it, without the `minecraft:` prefix */
export type Dimension = 'overworld' | 'the_nether' | 'the_end' | (string & {})

export interface Pos { x: number, y: number, z: number }

export interface Located extends Pos {
  dimension: Dimension
}

export interface RememberedBlock extends Located {
  name: string
  /** the bot tick it was last seen at */
  seen: number
}

export interface KnownChest extends Located {
  /** item name → count, as last seen in the window */
  items: Record<string, number>
  seen: number
}

/** structures and places the plan steers by */
export type PoiKind =
  | 'nether_portal'
  | 'end_portal'
  | 'fortress'
  | 'bastion'
  | 'stronghold'
  /** a triangulated guess from eye of ender throws, not yet confirmed */
  | 'stronghold_estimate'
  | 'village'
  | 'enchanting_table'
  | (string & {})

export interface Poi extends Located {
  kind: PoiKind
  note?: string
  seen: number
}

export interface Death extends Located {
  seen: number
  /** died under a roof (a cave, a mine): no sky over the spot */
  underground?: boolean
  /** false when what it dropped is worth no trip back (dropsWorthATrip: a few blocks of dirt) */
  worth?: boolean
}

export interface WorldMemoryJSON {
  version: 1
  blocks: RememberedBlock[]
  chests: KnownChest[]
  base: Located | null
  pois: Poi[]
  death: Death | null
}

export interface WorldMemoryOptions {
  /** remembered positions kept per block name; the oldest go first (default 256) */
  maxPerBlock?: number
}

export function normalizeDimension (dimension: string | undefined): Dimension {
  if (dimension == null || dimension === '') return 'overworld'
  return dimension.startsWith('minecraft:') ? dimension.slice('minecraft:'.length) : dimension
}

function key (p: Located): string {
  return `${p.dimension}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

function at (p: Pos, dimension: Dimension): Located {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: normalizeDimension(dimension) }
}

function distSq (a: Pos, b: Pos): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

export interface FindOptions {
  dimension?: Dimension
  /** sort by distance to this point and drop the ones farther than maxDistance */
  near?: Pos
  maxDistance?: number
  count?: number
}

/**
 * What the bot has seen of the world: block positions by type (ores, logs, water...), the
 * chests it opened and their contents, the base, points of interest and where it last died.
 * Plain data, so it can be written to JSON between runs.
 */
export class WorldMemory {
  /** the bot tick stamped on everything remembered from now on */
  now = 0
  /**
   * The game's ticks before this run (a resumed game's, its save's ticks): `now` is this and the run's tick
   * (bot.survival), so the stamps of a save and of the run resumed from it are of one clock and a chest's age holds
   */
  tickBase = 0

  private readonly blocks = new Map<string, Map<string, RememberedBlock>>()
  private readonly blockAt = new Map<string, string>()
  private readonly chests = new Map<string, KnownChest>()
  private pois: Poi[] = []
  base: Located | null = null
  death: Death | null = null
  private readonly maxPerBlock: number
  private readonly chestListeners = new Set<(chest: Located) => void>()

  constructor (opts: WorldMemoryOptions = {}) {
    this.maxPerBlock = opts.maxPerBlock ?? 256
  }

  rememberBlock (name: string, pos: Pos, dimension: Dimension = 'overworld'): void {
    const loc = at(pos, dimension)
    const k = key(loc)
    const previous = this.blockAt.get(k)
    if (previous != null && previous !== name) this.blocks.get(previous)?.delete(k)
    let byPos = this.blocks.get(name)
    if (byPos == null) this.blocks.set(name, byPos = new Map())
    byPos.delete(k) // re-insert so the map stays oldest-first
    byPos.set(k, { name, ...loc, seen: this.now })
    this.blockAt.set(k, name)
    if (byPos.size > this.maxPerBlock) {
      const oldest = byPos.keys().next().value as string
      byPos.delete(oldest)
      this.blockAt.delete(oldest)
    }
  }

  /** the block at pos is gone (mined, or seen to be something else) */
  forgetBlock (pos: Pos, dimension: Dimension = 'overworld'): void {
    const k = key(at(pos, dimension))
    const name = this.blockAt.get(k)
    if (name == null) return
    this.blocks.get(name)?.delete(k)
    this.blockAt.delete(k)
  }

  /** remembered blocks of the given names, nearest first when `near` is set */
  findBlocks (names: string | readonly string[], opts: FindOptions = {}): RememberedBlock[] {
    const wanted = typeof names === 'string' ? [names] : names
    const dimension = opts.dimension != null ? normalizeDimension(opts.dimension) : null
    let out: RememberedBlock[] = []
    for (const name of wanted) {
      for (const b of this.blocks.get(name)?.values() ?? []) {
        if (dimension == null || b.dimension === dimension) out.push(b)
      }
    }
    if (opts.near != null) {
      const near = opts.near
      if (opts.maxDistance != null) {
        const max = opts.maxDistance * opts.maxDistance
        out = out.filter(b => distSq(b, near) <= max)
      }
      out.sort((a, b) => distSq(a, near) - distSq(b, near))
    }
    return opts.count != null ? out.slice(0, opts.count) : out
  }

  /** stores what a chest held when the bot last closed it */
  rememberChest (pos: Pos, items: Record<string, number>, dimension: Dimension = 'overworld'): void {
    const loc = at(pos, dimension)
    const kept: Record<string, number> = {}
    for (const [name, count] of Object.entries(items)) if (count > 0) kept[name] = count
    this.chests.set(key(loc), { ...loc, items: kept, seen: this.now })
    this.chestChanged(loc)
  }

  forgetChest (pos: Pos, dimension: Dimension = 'overworld'): void {
    const loc = at(pos, dimension)
    if (this.chests.delete(key(loc))) this.chestChanged(loc)
  }

  /**
   * Calls `fn` each time a chest is remembered or forgotten (not on a restore): the runner's save, written after every
   * chest change so a resume doesn't carry contents the world no longer has. The unsubscribe.
   */
  onChestChange (fn: (chest: Located) => void): () => void {
    this.chestListeners.add(fn)
    return () => { this.chestListeners.delete(fn) }
  }

  private chestChanged (loc: Located): void {
    for (const fn of this.chestListeners) {
      try { fn(loc) } catch {}
    }
  }

  chestAt (pos: Pos, dimension: Dimension = 'overworld'): KnownChest | undefined {
    return this.chests.get(key(at(pos, dimension)))
  }

  knownChests (dimension?: Dimension): KnownChest[] {
    const all = [...this.chests.values()]
    return dimension == null ? all : all.filter(c => c.dimension === normalizeDimension(dimension))
  }

  /** chests that hold the item, most first */
  findItem (name: string, dimension?: Dimension): Array<{ chest: KnownChest, count: number }> {
    return this.knownChests(dimension)
      .filter(c => (c.items[name] ?? 0) > 0)
      .map(chest => ({ chest, count: chest.items[name] }))
      .sort((a, b) => b.count - a.count)
  }

  setBase (pos: Pos, dimension: Dimension = 'overworld'): void {
    this.base = at(pos, dimension)
  }

  addPoi (kind: PoiKind, pos: Pos, dimension: Dimension = 'overworld', note?: string): Poi {
    const loc = at(pos, dimension)
    this.pois = this.pois.filter(p => !(p.kind === kind && key(p) === key(loc)))
    const poi: Poi = { kind, ...loc, seen: this.now }
    if (note != null) poi.note = note
    this.pois.push(poi)
    return poi
  }

  removePoi (kind: PoiKind, pos?: Pos, dimension: Dimension = 'overworld'): void {
    const k = pos == null ? null : key(at(pos, dimension))
    this.pois = this.pois.filter(p => !(p.kind === kind && (k == null || key(p) === k)))
  }

  getPois (kind: PoiKind, opts: FindOptions = {}): Poi[] {
    const dimension = opts.dimension != null ? normalizeDimension(opts.dimension) : null
    const out = this.pois.filter(p => p.kind === kind && (dimension == null || p.dimension === dimension))
    if (opts.near != null) {
      const near = opts.near
      out.sort((a, b) => distSq(a, near) - distSq(b, near))
    }
    return opts.count != null ? out.slice(0, opts.count) : out
  }

  setDeath (pos: Pos, dimension: Dimension = 'overworld', underground?: boolean, worth?: boolean): void {
    this.death = { ...at(pos, dimension), seen: this.now, ...(underground != null ? { underground } : {}), ...(worth != null ? { worth } : {}) }
  }

  toJSON (): WorldMemoryJSON {
    const blocks: RememberedBlock[] = []
    for (const byPos of this.blocks.values()) blocks.push(...byPos.values())
    return {
      version: 1,
      blocks: blocks.map(b => ({ ...b })),
      chests: [...this.chests.values()].map(c => ({ ...c, items: { ...c.items } })),
      base: this.base == null ? null : { ...this.base },
      pois: this.pois.map(p => ({ ...p })),
      death: this.death == null ? null : { ...this.death }
    }
  }

  /** replaces everything remembered with what the JSON holds (a run resumed from a saved memory, in place) */
  restore (json: WorldMemoryJSON | string): void {
    const loaded = WorldMemory.fromJSON(json, { maxPerBlock: this.maxPerBlock })
    this.blocks.clear()
    this.blockAt.clear()
    this.chests.clear()
    for (const [name, byPos] of loaded.blocks) this.blocks.set(name, byPos)
    for (const [k, name] of loaded.blockAt) this.blockAt.set(k, name)
    for (const [k, chest] of loaded.chests) this.chests.set(k, chest)
    this.pois = loaded.pois
    this.base = loaded.base
    this.death = loaded.death
  }

  static fromJSON (json: WorldMemoryJSON | string, opts: WorldMemoryOptions = {}): WorldMemory {
    const data: WorldMemoryJSON = typeof json === 'string' ? JSON.parse(json) : json
    if (data.version !== 1) throw new Error(`unknown world memory version ${String(data.version)}`)
    const mem = new WorldMemory(opts)
    for (const b of data.blocks) {
      mem.now = b.seen
      mem.rememberBlock(b.name, b, b.dimension)
    }
    for (const c of data.chests) {
      mem.now = c.seen
      mem.rememberChest(c, c.items, c.dimension)
    }
    for (const p of data.pois) {
      mem.now = p.seen
      mem.addPoi(p.kind, p, p.dimension, p.note)
    }
    mem.base = data.base == null ? null : { ...data.base }
    mem.death = data.death == null ? null : { ...data.death }
    mem.now = Math.max(0, ...data.blocks.map(b => b.seen), ...data.chests.map(c => c.seen), ...data.pois.map(p => p.seen), data.death?.seen ?? 0)
    return mem
  }
}
