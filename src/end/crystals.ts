import { Vec3 } from 'vec3'
import type { Pos } from '../core/memory'
import { ARROW_EYE_OFFSET, arrowHits, solveAim, type ArrowWorld } from '../skills/arrow'
import { cageBars, spikeColumns, spikeCrystal, type Box, type EndSpike, type SpikeCrystal } from './spikes'

/** EndCrystal.hurtServer: the crystal explodes with power 6; Explosion damage reaches 2 × power */
export const CRYSTAL_EXPLOSION_POWER = 6
export const CRYSTAL_DANGER_RADIUS = 2 * CRYSTAL_EXPLOSION_POWER

export interface ShootSpot extends Pos {
  /** horizontal distance to the spike's center */
  distance: number
  /** blocks to pillar up at the spot first (0: shoot from the ground); y is the feet height on top */
  pillar: number
  /** where to aim from there: a point of the crystal's box the straight line reaches */
  aim: Pos
  /** the bow shot that hits it from there (skills/arrow solveAim, checked with arrowHits against the spikes) */
  shot: { yaw: number, pitch: number, ticks: number }
}

export interface CrystalTarget {
  spike: EndSpike
  crystal: SpikeCrystal
  /** the middle of the crystal's box */
  aim: Pos
  /**
   * shoot: an open line of sight from `shootFrom`. pillar: a caged spike (or no bow); pillar
   * up beside it and break the bars facing `shootFrom`, then come down and shoot (with no bow:
   * hit it from the pillar, and eat the explosion)
   */
  method: 'shoot' | 'pillar'
  /** where to shoot it from (after the cage is opened, for a caged one); null with no bow or no line */
  shootFrom: ShootSpot | null
  pillar?: {
    /** the column to pillar up, just outside the spike, on the side of shootFrom */
    column: { x: number, z: number }
    /** feet height on top of the pillar: level with the crystal */
    topY: number
    /** the bars between the crystal and shootFrom, to break from the pillar */
    breakBars: Pos[]
  }
}

export interface CrystalPlanOptions {
  /** the end's surface height under a point (default 64 everywhere: the main island is roughly flat) */
  groundY?: (x: number, z: number) => number
  /** blocks other than the spikes' that stop an arrow, when known */
  solidAt?: (x: number, y: number, z: number) => boolean
  /** the bot has a bow and arrows (otherwise every crystal is reached by pillar) */
  bow?: boolean
  /** where the bot is, to order the route from */
  from?: { x: number, z: number }
  /** spikes whose crystal is known to be gone (by index) */
  destroyed?: Iterable<number>
  /** bars already broken */
  brokenBars?: Iterable<Pos>
  /** the farthest it should shoot from (default 72) */
  maxShootDistance?: number
  /** shooting spots stay within this distance of 0,0 (default 80: the main island) */
  islandRadius?: number
  /** the most it will pillar up to get a line (default 24) */
  maxPillar?: number
  /** ground to keep off when choosing where to shoot from (the dragon's breath clouds) */
  avoid?: (x: number, z: number) => boolean
}

function keyOf (x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** the spike blocks that stop an arrow: obsidian columns, the bedrock under each crystal, cage bars */
export function spikeBlocks (spikes: EndSpike[], brokenBars: Iterable<Pos> = []): Set<string> {
  const out = new Set<string>()
  for (const s of spikes) {
    for (const c of spikeColumns(s)) {
      // only the upper part matters for shots from the surface
      for (let y = Math.max(40, s.height - 40); y < s.height; y++) out.add(keyOf(c.x, y, c.z))
    }
    out.add(keyOf(s.centerX, s.height, s.centerZ))
    for (const b of cageBars(s)) out.add(keyOf(b.x, b.y, b.z))
  }
  for (const b of brokenBars) out.delete(keyOf(b.x, b.y, b.z))
  return out
}

/** the blocks a straight line from a to b passes through (3D DDA), excluding the end cells */
export function cellsOnLine (a: Pos, b: Pos): Pos[] {
  const out: Pos[] = []
  let x = Math.floor(a.x)
  let y = Math.floor(a.y)
  let z = Math.floor(a.z)
  const ex = Math.floor(b.x)
  const ey = Math.floor(b.y)
  const ez = Math.floor(b.z)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  const sz = Math.sign(dz)
  const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity
  const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity
  const tdz = sz !== 0 ? Math.abs(1 / dz) : Infinity
  let tx = sx > 0 ? (x + 1 - a.x) * tdx : sx < 0 ? (a.x - x) * tdx : Infinity
  let ty = sy > 0 ? (y + 1 - a.y) * tdy : sy < 0 ? (a.y - y) * tdy : Infinity
  let tz = sz > 0 ? (z + 1 - a.z) * tdz : sz < 0 ? (a.z - z) * tdz : Infinity
  for (let guard = 0; guard < 4096; guard++) {
    if (tx <= ty && tx <= tz) { if (tx > 1) break; x += sx; tx += tdx } else if (ty <= tz) { if (ty > 1) break; y += sy; ty += tdy } else { if (tz > 1) break; z += sz; tz += tdz }
    if (x === ex && y === ey && z === ez) break
    out.push({ x, y, z })
  }
  return out
}

/** where the segment a→b first enters the box (the arrow hits the crystal there), or b */
export function boxEntry (a: Pos, b: Pos, box: Box): Pos {
  let t0 = 0
  let t1 = 1
  for (const [o, d, lo, hi] of [[a.x, b.x - a.x, box.minX, box.maxX], [a.y, b.y - a.y, box.minY, box.maxY], [a.z, b.z - a.z, box.minZ, box.maxZ]]) {
    if (d === 0) { if (o < lo || o > hi) return b; continue }
    let ta = (lo - o) / d
    let tb = (hi - o) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
  }
  if (t0 > t1) return b
  return { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0, z: a.z + (b.z - a.z) * t0 }
}

/**
 * Plans the crystals. For each spike still holding one it looks for the cheapest place to
 * shoot from with a straight, clear line to the crystal's box (an arrow's arc only rises
 * above that line): on the ground if it can, else on a short pillar, trading distance
 * against pillar height. A caged crystal is a pillar job: up beside the spike, break the bars
 * on the shooting line, down, shoot. The crystals come in route order: nearest first from
 * `from`, then each next nearest to the last spot.
 */
export function planCrystals (spikes: EndSpike[], opts: CrystalPlanOptions = {}): CrystalTarget[] {
  const groundY = opts.groundY ?? (() => 64)
  const destroyed = new Set(opts.destroyed ?? [])
  const maxD = opts.maxShootDistance ?? 72
  const island = opts.islandRadius ?? 80
  const maxPillar = opts.maxPillar ?? 24
  const bow = opts.bow ?? true
  const blocks = spikeBlocks(spikes, opts.brokenBars ?? [])
  // a spike's top is no place to shoot from: the ground there is the obsidian's top, 20 to 40 blocks up
  const spikeCells = new Set(spikes.flatMap(s => spikeColumns(s).map(c => `${c.x},${c.z}`)))
  const avoid = opts.avoid
  const offLimits = (x: number, z: number): boolean => spikeCells.has(`${Math.floor(x)},${Math.floor(z)}`) || (avoid?.(x, z) ?? false)
  const blocked = (p: Pos): boolean => blocks.has(keyOf(p.x, p.y, p.z)) || (opts.solidAt?.(p.x, p.y, p.z) ?? false)
  const targets: CrystalTarget[] = []
  for (const spike of spikes) {
    if (destroyed.has(spike.index)) continue
    const crystal = spikeCrystal(spike)
    const insideCage = (p: Pos): boolean => Math.abs(p.x - spike.centerX) <= 2 && Math.abs(p.z - spike.centerZ) <= 2 && p.y >= spike.height && p.y <= spike.height + 3
    // aim at the middle, or high on the box for a steep line over the spike's rim
    const aims = [crystal.center, { ...crystal.center, y: crystal.box.maxY - 0.2 }]
    const found = bow ? bestShootSpot(spike, crystal, aims, blocked, insideCage, groundY, maxD, island, maxPillar, offLimits) : null
    if (!spike.guarded && found != null) {
      targets.push({ spike, crystal, aim: crystal.center, method: 'shoot', shootFrom: found.spot })
      continue
    }
    // pillar on the shooting side (or inward), just outside the obsidian (radius + 1)
    const toward = found != null ? { x: found.spot.x - spike.centerX - 0.5, z: found.spot.z - spike.centerZ - 0.5 } : { x: -spike.centerX, z: -spike.centerZ }
    const len = Math.hypot(toward.x, toward.z)
    const l = len > 0 ? len : 1
    const off = spike.radius + 1.5
    const column = { x: Math.floor(spike.centerX + 0.5 + toward.x / l * off), z: Math.floor(spike.centerZ + 0.5 + toward.z / l * off) }
    const topY = spike.height + 1
    const breakBars = spike.guarded ? (found != null && found.bars.length > 0 ? found.bars : facingBars(spike, column, topY)) : []
    targets.push({ spike, crystal, aim: crystal.center, method: 'pillar', shootFrom: found?.spot ?? null, pillar: { column, topY, breakBars } })
  }
  return route(targets, opts.from ?? { x: 0, z: 0 })
}

/** the cheapest spot with a clear line (cage bars allowed for a caged spike: they get broken) */
function bestShootSpot (spike: EndSpike, crystal: SpikeCrystal, aims: Pos[], blocked: (p: Pos) => boolean, insideCage: (p: Pos) => boolean,
  groundY: (x: number, z: number) => number, maxD: number, island: number, maxPillar: number, offLimits: (x: number, z: number) => boolean): { spot: ShootSpot, bars: Pos[] } | null {
  const r = Math.hypot(spike.centerX, spike.centerZ)
  const inward = Math.atan2(-spike.centerZ, -spike.centerX)
  let best: { spot: ShootSpot, bars: Pos[], cost: number } | null = null
  for (let d = CRYSTAL_DANGER_RADIUS; d <= maxD; d += 2) {
    if (best != null && d * 0.25 >= best.cost) break
    for (let k = 0; k < 16; k++) {
      // inward first, then fanning out both ways
      const turn = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8)
      const a = (r > 0 ? inward : 0) + turn
      const x = Math.floor(spike.centerX + 0.5 + Math.cos(a) * d) + 0.5
      const z = Math.floor(spike.centerZ + 0.5 + Math.sin(a) * d) + 0.5
      if (Math.hypot(x, z) > island) continue
      if (offLimits(x, z)) continue
      const ground = groundY(x, z)
      for (let h = 0; h <= maxPillar; h++) {
        const cost = d * 0.25 + h * 2 + Math.abs(turn)
        if (best != null && cost >= best.cost) break
        const eye = { x, y: ground + h + 1.62, z }
        let clear: { aim: Pos, bars: Pos[], shot: ShootSpot['shot'] } | null = null
        for (const aim of aims) {
          const hits = cellsOnLine(eye, boxEntry(eye, aim, crystal.box)).filter(blocked)
          const bars = hits.filter(insideCage)
          if (hits.length !== bars.length || (bars.length > 0 && !spike.guarded)) continue
          const shot = bowShot(eye, aim, crystal, blocked, insideCage, spike.guarded)
          if (shot != null) { clear = { aim, bars: shot.bars, shot: shot.shot }; break }
        }
        if (clear != null) {
          best = { spot: { x, y: ground + h, z, distance: Math.hypot(x - spike.centerX - 0.5, z - spike.centerZ - 0.5), pillar: h, aim: clear.aim, shot: clear.shot }, bars: clear.bars, cost }
          break
        }
      }
    }
  }
  return best == null ? null : { spot: best.spot, bars: best.bars }
}

/**
 * The flat-arc bow shot from `eye` at `aim` (the arrow leaves 0.1 under the eye), flown with
 * vanilla's arrow physics against the spike blocks; for a caged spike its bars don't stop the
 * flight here but come back as the ones to break. Null when the arrow doesn't get there.
 */
function bowShot (eye: Pos, aim: Pos, crystal: SpikeCrystal, blocked: (p: Pos) => boolean, insideCage: (p: Pos) => boolean, guarded: boolean): { shot: ShootSpot['shot'], bars: Pos[] } | null {
  const stops = (p: Pos): boolean => blocked(p) && !(guarded && insideCage(p))
  const world: ArrowWorld = {
    clip: (from, to) => {
      for (const c of [...cellsOnLine(from, to), { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) }]) {
        if (!stops(c)) continue
        const p = boxEntry(from, to, { minX: c.x, minY: c.y, minZ: c.z, maxX: c.x + 1, maxY: c.y + 1, maxZ: c.z + 1 })
        return new Vec3(p.x, p.y, p.z)
      }
      return null
    }
  }
  const start = new Vec3(eye.x, eye.y - ARROW_EYE_OFFSET, eye.z)
  const sol = solveAim(start, new Vec3(aim.x, aim.y, aim.z), { world })
  if (sol == null) return null
  const box = crystal.box
  const flight = arrowHits(start, sol.yaw, sol.pitch, { min: new Vec3(box.minX, box.minY, box.minZ), max: new Vec3(box.maxX, box.maxY, box.maxZ) }, { world })
  if (flight.hit == null) return null
  const bars: Pos[] = []
  const seen = new Set<string>()
  const points = [...flight.path.map(s => s.position), flight.hit.point]
  for (let i = 1; i < points.length; i++) {
    for (const c of cellsOnLine(points[i - 1], points[i])) {
      const k = keyOf(c.x, c.y, c.z)
      if (guarded && blocked(c) && insideCage(c) && !seen.has(k)) { seen.add(k); bars.push(c) }
    }
  }
  return { shot: { yaw: sol.yaw, pitch: sol.pitch, ticks: sol.ticks }, bars }
}

/** the cage bars on the pillar's side at the crystal's height, for when there's no shooting line */
function facingBars (spike: EndSpike, column: { x: number, z: number }, topY: number): Pos[] {
  const from = { x: column.x + 0.5, y: topY + 1.62, z: column.z + 0.5 }
  const aim = spikeCrystal(spike).center
  const bars = new Set(cageBars(spike).map(b => keyOf(b.x, b.y, b.z)))
  return cellsOnLine(from, boxEntry(from, aim, spikeCrystal(spike).box)).filter(p => bars.has(keyOf(p.x, p.y, p.z)))
}

function route (targets: CrystalTarget[], from: { x: number, z: number }): CrystalTarget[] {
  const left = [...targets]
  const out: CrystalTarget[] = []
  let at = from
  while (left.length > 0) {
    let best = 0
    let bestD = Infinity
    left.forEach((t, i) => {
      const p = t.pillar != null ? { x: t.pillar.column.x + 0.5, z: t.pillar.column.z + 0.5 } : (t.shootFrom ?? { x: t.spike.centerX, z: t.spike.centerZ })
      const d = Math.hypot(p.x - at.x, p.z - at.z)
      if (d < bestD) { bestD = d; best = i }
    })
    const t = left.splice(best, 1)[0]
    out.push(t)
    at = t.shootFrom ?? (t.pillar != null ? { x: t.pillar.column.x + 0.5, z: t.pillar.column.z + 0.5 } : at)
  }
  return out
}
