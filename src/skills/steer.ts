import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

// Tick-by-tick steering for combat and escapes: one look and a set of keys a tick, no path search (too slow for a
// creeper's 30-tick fuse). The pathfinder is for getting somewhere; this is for getting away or getting close.

const DANGER_BLOCKS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose', 'pointed_dripstone'])

export function isDangerBlock (name: string | undefined): boolean {
  return name != null && DANGER_BLOCKS.has(name)
}

function blockName (bot: Bot, pos: Vec3): string | undefined {
  return bot.blockAt(pos)?.name
}

function isSolid (bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos)
  return b != null && b.boundingBox === 'block'
}

function isPassable (bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos)
  return b == null || (b.boundingBox === 'empty' && !isDangerBlock(b.name))
}

/** How safe a step onto the column at pos is: 0 is fine, more is worse, Infinity is never (lava, a wall, a deep drop). */
export function stepCost (bot: Bot, feet: Vec3): number {
  const f = feet.floored()
  if (isDangerBlock(blockName(bot, f)) || isDangerBlock(blockName(bot, f.offset(0, 1, 0)))) return Infinity
  if (!isPassable(bot, f)) {
    // a step up (a jump) when the two blocks over it are free, else a wall
    return isPassable(bot, f.offset(0, 1, 0)) && isPassable(bot, f.offset(0, 2, 0)) ? 1 : Infinity
  }
  if (!isPassable(bot, f.offset(0, 1, 0))) return Infinity
  for (let d = 1; d <= 4; d++) {
    const below = f.offset(0, -d, 0)
    const name = blockName(bot, below)
    if (name === 'water') return 0.5
    if (isDangerBlock(name)) return Infinity
    if (isSolid(bot, below)) return d <= 3 ? (d - 1) * 0.5 : Infinity
  }
  return Infinity
}

/**
 * Whether a step into the column at `feet` is one to die of: lava, fire or another danger block at the feet or the
 * head, or a fall into one, or of more than `maxDrop` blocks (default 3: LivingEntity.causeFallDamage) with no water
 * under. A wall or a step up is none (walking into it does no harm).
 */
export function deadlyStep (bot: Bot, feet: Vec3, maxDrop = 3): boolean {
  const f = feet.floored()
  if (isDangerBlock(blockName(bot, f)) || isDangerBlock(blockName(bot, f.offset(0, 1, 0)))) return true
  if (isSolid(bot, f)) return false
  for (let d = 1; d <= maxDrop + 1; d++) {
    const below = f.offset(0, -d, 0)
    const name = blockName(bot, below)
    if (name === 'water') return false
    if (isDangerBlock(name)) return true
    if (isSolid(bot, below)) return false
  }
  return true
}

/**
 * Whether walking on along `yaw` (mineflayer's: the look's direction is -sin, -cos) steps into a deadly column
 * (deadlyStep) within `reach` blocks of the bot's middle, at its feet's height: the edge of a ledge over the lava sea,
 * a basalt delta's lava pocket. Checked from the near side of the bot's box on (its half width, 0.3).
 */
export function edgeAhead (bot: Bot, yaw: number, reach = 1.2, maxDrop = 3, dry = false): boolean {
  const pos = bot.entity.position
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  for (const k of [0.45, 0.8, reach]) {
    if (k > reach) continue
    const p = new Vec3(pos.x + dx * k, pos.y + 0.01, pos.z + dz * k)
    if (deadlyStep(bot, p, maxDrop) || (dry && wetStep(bot, p, maxDrop))) return true
  }
  return false
}

/**
 * Whether a step into the column at `feet` is into the water: the water at the feet, or the first thing under them
 * within `maxDrop` + 1 the water (a pond's edge). With SteerOptions.dry a fight keeps out of it: a 1.21.11 bot fought a
 * drowned off the shore into the sea (ls3b-1.21.11, t401692)
 */
export function wetStep (bot: Bot, feet: Vec3, maxDrop = 3): boolean {
  const f = feet.floored()
  if (blockName(bot, f) === 'water') return true
  if (isSolid(bot, f)) return false
  for (let d = 1; d <= maxDrop + 1; d++) {
    const name = blockName(bot, f.offset(0, -d, 0))
    if (name === 'water') return true
    if (isSolid(bot, f.offset(0, -d, 0))) return false
  }
  return false
}

export interface SteerOptions {
  sprint?: boolean
  lookPitch?: number
  /**
   * stop short of a deadly edge ahead (edgeAhead), sneaking for the tick so the speed already had doesn't carry the bot
   * over (Player.maybeBackOffFromEdge): for a fight or a chase that only wants to get near, not for an escape through
   * lava (default false)
   */
  guard?: boolean
  /**
   * with `guard`, the most blocks a step down may drop (default 3, a fall that does no harm): less keeps a chase on its
   * own level
   */
  maxDrop?: number
  /** with `guard`, a step into the water is an edge too (wetStep): a fight from dry ground stays on it */
  dry?: boolean
}

/**
 * Turns toward the point and walks (sprinting unless told not), jumping over steps and swimming up in water; with
 * `guard`, stops at a deadly edge instead. Returns whether it walked on.
 */
export function steerToward (bot: Bot, point: Vec3, opts: SteerOptions = {}): boolean {
  const pos = bot.entity.position
  const yaw = Math.atan2(-(point.x - pos.x), -(point.z - pos.z))
  void bot.look(yaw, opts.lookPitch ?? 0, true)
  if (opts.guard === true && edgeAhead(bot, yaw, 1.2, opts.maxDrop ?? 3, opts.dry === true)) {
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    bot.setControlState('sneak', true)
    return false
  }
  if (opts.guard === true) bot.setControlState('sneak', false)
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('sprint', opts.sprint !== false)
  const e = bot.entity as any
  bot.setControlState('jump', (e.isCollidedHorizontally === true && bot.entity.onGround) || e.isInWater === true || e.isInLava === true)
  return true
}

/** the most a flee's heading may turn toward the threat (the cosine to the way straight away from it): across, not at */
export const FLEE_TOWARD = -0.25

/** a flee's lean toward a place to run to (fleeHeading's `toward`): its weight against the way straight away's 3 */
export const FLEE_LEAN = 2

/**
 * a hair under half the player's width (EntityType.PLAYER 0.6): the body's sides along a flee's line, where a gap its
 * middle fits but its body doesn't (a trunk's corner under a canopy) is no way
 */
export const BODY_HALF = 0.29

/** the points a flee's line is looked at, half a block apart: a corner cut between two is a corner the body hits */
const FLEE_SAMPLES = [0.5, 1, 1.5, 2, 2.5, 3]

/**
 * The feet's cell height of the bot on the ground, or of the ground it's jumping from or falling to within 2 blocks
 * (a bot mid-jump against a trunk is looked at from the cell it jumped from, not the one its feet are in for the tick)
 */
export function groundFeetY (bot: Bot): number {
  const pos = bot.entity.position
  const y = Math.floor(pos.y + 1e-3)
  if (bot.entity.onGround) return y
  for (let d = 0; d <= 2; d++) {
    if (isSolid(bot, new Vec3(pos.x, y - d - 1, pos.z)) && isPassable(bot, new Vec3(pos.x, y - d, pos.z))) return y - d
  }
  return y
}

/**
 * Whether the bot's body at `at` (its feet's height) has the room to jump: the cells over its head (feet + 2) under
 * each of its corners open. A leaf or a block there stops the jump short (Entity.move's collision), and a step up of
 * one block can't be taken: two 1.21.11 bots fled creepers under low oak canopies, jumping in place at a step, and
 * were blown up (ls3b-1.21.11, t327032 at (158, 70, 321) and t439660 at (27, 64, 203))
 */
export function jumpRoom (bot: Bot, at: Vec3): boolean {
  const y = Math.floor(at.y + 1e-3) + 2
  for (const dx of [-BODY_HALF, BODY_HALF]) {
    for (const dz of [-BODY_HALF, BODY_HALF]) {
      if (!isPassable(bot, new Vec3(at.x + dx, y, at.z + dz))) return false
    }
  }
  return true
}

/** whether the column at `feet` is a step up (its feet's cell a block to climb) */
function isStepUp (bot: Bot, feet: Vec3): boolean {
  return !isPassable(bot, feet.floored())
}

/**
 * The cost of the body's way along a flee's line from `from` (the bot's feet on the ground) to `step` blocks on, in
 * the direction (dx, dz): each half block's point and the body's sides there (BODY_HALF) safe (stepCost), a step up
 * only with the room to jump before it (jumpRoom). Infinity when the body can't go that way.
 */
export function lineCost (bot: Bot, from: Vec3, dx: number, dz: number, steps = 3): number {
  let cost = 0
  for (const k of FLEE_SAMPLES) {
    if (k > steps) break
    const center = from.offset(dx * k, 0, dz * k)
    for (const side of [0, BODY_HALF, -BODY_HALF]) {
      // (the body's side, square to the line)
      const p = center.offset(-dz * side, 0, dx * side)
      const c = stepCost(bot, p)
      if (c === Infinity) return Infinity
      if (isStepUp(bot, p) && !jumpRoom(bot, from.offset(dx * (k - 0.5), 0, dz * (k - 0.5)))) return Infinity
      if (side === 0 && Number.isInteger(k)) cost += c
    }
  }
  return cost
}

/** a mob a flee keeps its line clear of (fleeHeading's `avoid`) */
export interface CrowdMob { position: Vec3, width?: number }

/** how far along a flee's line another mob's body is looked for (CROWD_AHEAD), and the room kept from it */
export const CROWD_AHEAD = 2.5
export const CROWD_MARGIN = 0.6

/**
 * Whether the next CROWD_AHEAD blocks along (dx, dz) from `pos` pass no mob of `crowd` (within 2 up or down) nearer
 * than the two bodies' half widths and CROWD_MARGIN; one behind the line is no matter (after mine-ai-mcp's
 * survival/positioning/combat/creeper-retreat.ts clearsCrowd, MIT, its notice in skills/lavaFlow.ts): a run from a
 * creeper into a zombie's arms is no run
 */
export function clearsCrowd (pos: Vec3, dx: number, dz: number, crowd: readonly CrowdMob[]): boolean {
  for (const e of crowd) {
    if (Math.abs(e.position.y - pos.y) > 2) continue
    const tx = e.position.x - pos.x
    const tz = e.position.z - pos.z
    const along = tx * dx + tz * dz
    if (along <= 1e-10) continue
    const k = Math.min(along, CROWD_AHEAD)
    const cx = tx - dx * k
    const cz = tz - dz * k
    if (Math.hypot(cx, cz) < (0.6 + (e.width ?? 0.6)) / 2 + CROWD_MARGIN) return false
  }
  return true
}

/**
 * The heading (mineflayer yaw) that leads furthest from the threat over safe ground, or null if every way is shut;
 * with `toward` (the base, a lit place), the ways nearer it are the better by FLEE_LEAN, still never back at the threat.
 * The way is the body's (lineCost: its width, the room to jump a step), not its middle's: a line between a trunk and a
 * canopy's low leaves its middle passed and its body didn't kept a bot jumping in place by a creeper (ls3b-1.21.11)
 */
export function fleeHeading (bot: Bot, threat: Vec3, samples = 16, toward?: Vec3, avoid: readonly CrowdMob[] = []): number | null {
  const pos = bot.entity.position
  const from = new Vec3(pos.x, groundFeetY(bot), pos.z)
  const away = new Vec3(pos.x - threat.x, 0, pos.z - threat.z)
  const len = Math.hypot(away.x, away.z)
  const ax = len > 1e-6 ? away.x / len : 1
  const az = len > 1e-6 ? away.z / len : 0
  const tlen = toward == null ? 0 : Math.hypot(toward.x - pos.x, toward.z - pos.z)
  const tx = toward != null && tlen > 1e-6 ? (toward.x - pos.x) / tlen : 0
  const tz = toward != null && tlen > 1e-6 ? (toward.z - pos.z) / tlen : 0
  let best: number | null = null
  let bestScore = -Infinity
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2
    const dx = -Math.sin(angle)
    const dz = -Math.cos(angle)
    // never at the threat: in a tunnel shut behind it, the one open way led a 26.3 bot fleeing a creeper toward it,
    // into its blast (nether-26.3-q3); none open but that way is no way (cornered)
    if (dx * ax + dz * az < FLEE_TOWARD) continue
    // (nor through another mob's body: clearsCrowd)
    if (!clearsCrowd(pos, dx, dz, avoid)) continue
    const cost = lineCost(bot, from, dx, dz)
    if (cost === Infinity) continue
    const score = (dx * ax + dz * az) * 3 + (dx * tx + dz * tz) * FLEE_LEAN - cost
    if (score > bestScore) {
      bestScore = score
      best = angle
    }
  }
  return best
}

/** a block lookup (bot.blockAt's, or a test's) */
export type SteerLookup = (pos: Vec3) => { name: string, boundingBox: string } | null

/** how far across a flee's route looks (fleeRoute), and the most cells it opens */
export const FLEE_ROUTE_RADIUS = 8
export const FLEE_ROUTE_NODES = 800
/** how much further from the threats than the bot is the route's end must be (else there's no route) */
export const FLEE_ROUTE_GAIN = 2
/** the nearest a route's cells may pass a threat (or the bot's distance now, if it's nearer) */
export const FLEE_ROUTE_KEEP_OFF = 2.5
/** the extra cost of a cell in the water on a route (a swim's a third of a sprint) */
export const FLEE_ROUTE_WATER_COST = 3

export interface FleeRouteOptions {
  /** how far across (default FLEE_ROUTE_RADIUS) */
  radius?: number
  /** the most cells opened (default FLEE_ROUTE_NODES) */
  maxNodes?: number
  /**
   * the nearest its cells may pass a threat (default FLEE_ROUTE_KEEP_OFF, or less when the bot is nearer: a step past
   * a zombie at its side is a way out); a creeper's is FLEE_ROUTE_KEEP_OFF whatever (a run past its fuse at 2 blocks
   * is a death: its blast is cut off with blocks instead, evadeCreeper)
   */
  keepOff?: number
}

/** how much nearer than it is now a route away from a creeper may pass it (creeperKeepOff) */
export const CREEPER_ROUTE_SLACK = 0.5

/**
 * The nearest a route away from a creeper at `creeper` may pass it: no nearer than the bot is now (less
 * CREEPER_ROUTE_SLACK), FLEE_ROUTE_KEEP_OFF at least. A route out of a nook past the creeper at its mouth, 2.5 off, was
 * a run through the blast's reach: 13 of damage where the sword's hits from the nook took 0 to 5
 * (tests/integration/creeperTerrain 'nook')
 */
export function creeperKeepOff (from: Vec3, creeper: Vec3): number {
  return Math.max(FLEE_ROUTE_KEEP_OFF, Math.hypot(from.x - creeper.x, from.z - creeper.z) - CREEPER_ROUTE_SLACK)
}

const DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

/**
 * A short route on foot away from the threats when no straight line is (fleeHeading null): the cells the body can walk
 * (the feet's and the head's open, a full block or the water under them, no danger), a step to the side or a diagonal
 * one (both its sides open: no corner cut), a step up with the room to jump (the feet + 2 open where it's taken from),
 * a drop of 3 at most; never nearer a threat than `keepOff` (FleeRouteOptions). Its end is the cell furthest from the threats
 * (less its cost), FLEE_ROUTE_GAIN further than the bot at least; null when there's none. A bot under an oak's low
 * leaves in a hollow, each step out of it one the canopy stopped its jump at, had its way out a step along the hollow
 * first, then up where the leaves end (ls3b-1.21.11, t439660). Returns the cells after `from`, in order.
 */
export function fleeRoute (lookup: SteerLookup, from: Vec3, threats: readonly Vec3[], opts: FleeRouteOptions = {}): Vec3[] | null {
  const radius = opts.radius ?? FLEE_ROUTE_RADIUS
  const maxNodes = opts.maxNodes ?? FLEE_ROUTE_NODES
  const start = from.floored()
  const passable = (p: Vec3): boolean => { const b = lookup(p); return b == null || (b.boundingBox === 'empty' && !isDangerBlock(b.name)) }
  const solid = (p: Vec3): boolean => { const b = lookup(p); return b != null && b.boundingBox === 'block' && !isDangerBlock(b.name) }
  const water = (p: Vec3): boolean => lookup(p)?.name === 'water'
  const clear = (p: Vec3): boolean => passable(p) && passable(p.offset(0, 1, 0))
  const threatDistance = (p: Vec3): number => {
    let d = Infinity
    for (const t of threats) d = Math.min(d, Math.hypot(p.x + 0.5 - t.x, p.z + 0.5 - t.z))
    return d
  }
  const startDistance = threatDistance(start)
  const keepOff = opts.keepOff ?? Math.min(FLEE_ROUTE_KEEP_OFF, startDistance - 0.25)
  /** where a body stepping into the open column at `n` lands: its feet's cell (a drop of 3 at most), or null */
  const landing = (n: Vec3): { at: Vec3, extra: number } | null => {
    for (let d = 0; d <= 3; d++) {
      const feet = n.offset(0, -d, 0)
      if (d > 0 && !passable(feet)) return null
      if (water(feet) || water(feet.offset(0, -1, 0))) return { at: feet, extra: FLEE_ROUTE_WATER_COST }
      const under = lookup(feet.offset(0, -1, 0))
      if (under != null && isDangerBlock(under.name)) return null
      if (solid(feet.offset(0, -1, 0))) return { at: feet, extra: d * 0.5 }
    }
    return null
  }
  const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`
  const cost = new Map<string, number>([[key(start), 0]])
  const parent = new Map<string, Vec3 | null>([[key(start), null]])
  const open: Vec3[] = [start]
  let opened = 0
  let best: Vec3 | null = null
  let bestScore = -Infinity
  while (open.length > 0 && opened < maxNodes) {
    // (the cheapest open cell next: a small Dijkstra)
    let bi = 0
    for (let i = 1; i < open.length; i++) if ((cost.get(key(open[i])) ?? Infinity) < (cost.get(key(open[bi])) ?? Infinity)) bi = i
    const c = open.splice(bi, 1)[0]
    opened++
    const cc = cost.get(key(c)) ?? 0
    if (c !== start) {
      const score = threatDistance(c) - cc * 0.2
      if (score > bestScore) { bestScore = score; best = c }
    }
    for (const [dx, dz] of DIRS) {
      const diagonal = dx !== 0 && dz !== 0
      const n = c.offset(dx, 0, dz)
      if (Math.abs(n.x - start.x) > radius || Math.abs(n.z - start.z) > radius) continue
      // a diagonal step only with both its sides open (the body would catch on the corner)
      if (diagonal && (!clear(c.offset(dx, 0, 0)) || !clear(c.offset(0, 0, dz)))) continue
      let next: { at: Vec3, extra: number } | null = null
      if (clear(n)) next = landing(n)
      else if (!diagonal && solid(n) && clear(n.offset(0, 1, 0)) && passable(c.offset(0, 2, 0))) next = { at: n.offset(0, 1, 0), extra: 1 }
      if (next == null) continue
      if (threatDistance(next.at) < keepOff) continue
      const nc = cc + (diagonal ? Math.SQRT2 : 1) + next.extra
      const k = key(next.at)
      if (nc >= (cost.get(k) ?? Infinity)) continue
      cost.set(k, nc)
      parent.set(k, c)
      open.push(next.at)
    }
  }
  if (best == null || threatDistance(best) < startDistance + FLEE_ROUTE_GAIN) return null
  const route: Vec3[] = []
  for (let p: Vec3 | null = best; p != null && key(p) !== key(start); p = parent.get(key(p)) ?? null) route.unshift(p)
  return route
}

/** the bot's blocks, for fleeRoute */
export function steerLookup (bot: Bot): SteerLookup {
  return p => bot.blockAt(p) as any
}

/** a way away this tick: a heading along a straight line (fleeHeading), or the middle of the next cell of a route (fleeRoute) */
export type FleeWay = { heading: number } | { cell: Vec3 }

/**
 * The way to run from the threat this tick: the straight line's heading (fleeHeading), else (or with `route`, the line
 * got the bot nowhere: Headway) the next cell of a route out (fleeRoute); null when there's neither (cornered)
 */
export function fleeWay (bot: Bot, threat: Vec3, toward?: Vec3, opts: { route?: boolean, keepOff?: number, avoid?: readonly CrowdMob[] } = {}): FleeWay | null {
  if (opts.route !== true) {
    const heading = fleeHeading(bot, threat, 16, toward, opts.avoid)
    if (heading != null) return { heading }
  }
  const pos = bot.entity.position
  const route = fleeRoute(steerLookup(bot), new Vec3(pos.x, groundFeetY(bot), pos.z), [threat], { keepOff: opts.keepOff })
  if (route == null || route.length === 0) return null
  // (the first cell whose middle the bot isn't at yet)
  const next = route.find(c => Math.hypot(c.x + 0.5 - pos.x, c.z + 0.5 - pos.z) > 0.3) ?? route[route.length - 1]
  return { cell: next }
}

/** Runs along the way this tick, sprinting (jumping a step, swimming up in water). */
export function steerAlong (bot: Bot, way: FleeWay): void {
  if ('cell' in way) {
    steerToward(bot, way.cell.offset(0.5, 0, 0.5), { sprint: true })
    return
  }
  void bot.look(way.heading, 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('sprint', true)
  const e = bot.entity as any
  bot.setControlState('jump', (e.isCollidedHorizontally === true && bot.entity.onGround) || e.isInWater === true || e.isInLava === true)
}

/**
 * Runs from the threat this tick (leaning toward `toward`, when given: fleeHeading; by a route with `route`: fleeWay);
 * false when there's no safe way.
 */
export function steerAway (bot: Bot, threat: Vec3, toward?: Vec3, opts: { route?: boolean, keepOff?: number } = {}): boolean {
  const way = fleeWay(bot, threat, toward, opts)
  if (way == null) {
    bot.clearControlStates()
    return false
  }
  steerAlong(bot, way)
  return true
}

/** ticks and blocks of a run's headway (Headway): less than HEADWAY_BLOCKS across in HEADWAY_TICKS is none (a sprint from a stand covers some 1.5, a swim 0.8) */
export const HEADWAY_TICKS = 8
export const HEADWAY_BLOCKS = 0.7

/**
 * A run's headway: whether the bot got anywhere across over the last `ticks` ticks it ran. None is a way that isn't one (the body caught on a corner, a jump stopped by a ceiling): the flee
 * takes a route next, and then counts as cornered.
 */
export class Headway {
  private readonly at: Vec3[] = []
  constructor (readonly ticks = HEADWAY_TICKS, readonly blocks = HEADWAY_BLOCKS) {}

  /** the bot's place this tick of the run; true when it got less than `blocks` across in the last `ticks` */
  update (pos: Vec3): boolean {
    this.at.push(pos.clone())
    if (this.at.length > this.ticks + 1) this.at.shift()
    if (this.at.length <= this.ticks) return false
    const first = this.at[0]
    return Math.hypot(pos.x - first.x, pos.z - first.z) < this.blocks
  }

  /** a new count (a tick the bot didn't run, a new way) */
  reset (): void {
    this.at.length = 0
  }
}
