// Stuck reports: what the bot, the pathfinder and the world were when a trip failed (STUCK, a move that failed, no
// path, a goto given up), as plain JSON, with a one-line diagnosis from simple rules (diagnose).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { diagnostics as pfDiagnostics } from '@nxg-org/mineflayer-pathfinder'

type PathState = pfDiagnostics.PathState
type BlocksAround = pfDiagnostics.BlocksAround
type TickSample = pfDiagnostics.TickSample
type DiagEvent = pfDiagnostics.DiagEvent
type Mismatch = pfDiagnostics.Mismatch
type XYZ = [number, number, number]

export type ReportKind = 'stuck' | 'move_failed' | 'no_path' | 'goto_failed' | 'manual'

export interface DigFacts {
  pos: XYZ
  block: string
  /** the held item (null: the hand) */
  tool: string | null
  /** whether the block drops anything to the held item (prismarine-block's canHarvest) */
  harvestable: boolean | null
  /** from the eyes to the block's middle */
  distance: number
  /** within the player's block interaction range (4.5, Player.blockInteractionRange) of the block's middle, plus half its diagonal */
  inReach: boolean
  /** the first block the look from the eyes to the block's middle hits, when it isn't the block */
  raycastBlockedBy: { pos: XYZ, block: string } | null
  /** the face being dug, and whether it faces the bot's eyes */
  face: XYZ | null
  faceTowardsBot: boolean | null
}

export interface ReportFacts {
  /** the solid block the bot pushes into: forward held and collided horizontally */
  blockedAhead: { pos: XYZ, block: string } | null
  dig: DigFacts | null
  /** the cells round the bot's two blocks (4 sides at feet and head, over its head and under it): all solid */
  enclosed: { solid: boolean, unbreakable: string[], blocks: string[] }
  /** leaves in the blocks around */
  leavesAround: number
  /**
   * The last ticks the bot stood still with no movement key held (forward, back, left, right, jump): the keys it held,
   * and how far it was from the current move's exit
   */
  idle: { ticks: number, controls: string, exitDistance: number | null, exit: XYZ | null } | null
  /** the block the last dig (in the last 20 ticks) was of, and whether the crosshair is on it */
  crosshair: { digTarget: XYZ, cursor: { pos: XYZ, block: string } | null, onTarget: boolean } | null
}

export interface StuckReport {
  version: 1
  kind: ReportKind
  time: string
  /** the pathfinder check's client tick */
  tick: number
  message: string
  diagnosis: string
  bot: {
    username: string
    version: string
    dimension: string | null
    pos: XYZ
    vel: XYZ
    onGround: boolean
    collided: boolean
    yaw: number
    pitch: number
    controls: string
    health: number | null
    food: number | null
    heldItem: string | null
    cursorBlock: { pos: XYZ, block: string } | null
    digging: { pos: XYZ, block: string, face: XYZ | null } | null
  }
  path: PathState | null
  recent: {
    samples: TickSample[]
    events: DiagEvent[]
    mismatches: Mismatch[]
    mismatchSince: number | null
    mismatchSinceClass: string | null
    stats: Record<string, number> | null
  }
  blocks: BlocksAround | null
  facts: ReportFacts
  entities: Array<{ id: number, name: string, type: string, pos: XYZ, distance: number }>
  errors: Array<{ name: string, message: string, code?: string, reason?: string }>
  /** what the caller added (the goal's options, the skill) */
  context?: Record<string, unknown>
}

const xyz = (v: { x: number, y: number, z: number }): XYZ => [v.x, v.y, v.z]
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d
const rxyz = (v: { x: number, y: number, z: number }): XYZ => [round(v.x), round(v.y), round(v.z)]

/** a dig's face as a vector: mineflayer's targetDigFace is the face's number (prismarine-world's BlockFace) */
export function faceVector (face: unknown): Vec3 | null {
  if (face == null) return null
  if (face instanceof Vec3) return face
  const faces: XYZ[] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
  const f = typeof face === 'number' ? faces[face] : null
  return f != null ? new Vec3(f[0], f[1], f[2]) : null
}

/** the error and its causes, outermost first */
export function errorChain (err: unknown): StuckReport['errors'] {
  const out: StuckReport['errors'] = []
  let e: any = err
  for (let i = 0; e != null && i < 8; i++) {
    if (e instanceof Error || typeof e === 'object') {
      const entry: StuckReport['errors'][number] = { name: e.name ?? 'Error', message: String(e.message ?? e) }
      if (typeof e.code === 'string') entry.code = e.code
      if (typeof e.reason === 'string') entry.reason = e.reason
      out.push(entry)
      e = e.cause
    } else {
      out.push({ name: typeof e, message: String(e) })
      break
    }
  }
  return out
}

function blockName (block: any): string {
  return pfDiagnostics.describeBlock(block)
}

function isSolid (block: any): boolean {
  return block != null && block.boundingBox === 'block'
}

function isUnbreakable (block: any): boolean {
  return isSolid(block) && (block.diggable === false || block.hardness == null || block.hardness < 0)
}

/** the block the bot pushes into, when it holds forward and collided horizontally (the move's direction by yaw) */
export function blockedAhead (bot: Bot): ReportFacts['blockedAhead'] {
  const entity = bot.entity as any
  if (entity == null || entity.isCollidedHorizontally !== true || !bot.getControlState('forward')) return null
  // mineflayer's yaw: forward is (-sin yaw, -cos yaw)
  const dx = -Math.sin(entity.yaw)
  const dz = -Math.cos(entity.yaw)
  const pos: Vec3 = entity.position
  for (const reach of [0.4, 0.7]) {
    for (const dy of [0, 1]) {
      const at = new Vec3(pos.x + dx * reach, pos.y + dy + 0.01, pos.z + dz * reach).floored()
      const block = bot.blockAt(at, false)
      if (block != null && (isSolid(block) || (block as any).shapes?.length > 0) && !at.equals(pos.floored().offset(0, dy, 0))) {
        return { pos: xyz(at), block: blockName(block) }
      }
    }
  }
  return null
}

/** what's known of the dig under way: tool, reach, a block in the way, the face */
export function digFacts (bot: Bot): DigFacts | null {
  const target = (bot as any).targetDigBlock
  if (target?.position == null) return null
  const pos: Vec3 = target.position
  const eye = bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0)
  const middle = pos.offset(0.5, 0.5, 0.5)
  const distance = eye.distanceTo(middle)
  const held = bot.heldItem
  let harvestable: boolean | null = null
  try {
    harvestable = typeof target.canHarvest === 'function' ? target.canHarvest(held?.type ?? null) : null
  } catch {}
  let raycastBlockedBy: DigFacts['raycastBlockedBy'] = null
  try {
    const dir = middle.minus(eye).normalize()
    const hit = (bot.world as any)?.raycast?.(eye, dir, distance + 0.5)
    if (hit?.position != null && !hit.position.equals(pos)) raycastBlockedBy = { pos: xyz(hit.position), block: blockName(hit) }
  } catch {}
  const face = faceVector((bot as any).targetDigFace)
  let faceTowardsBot: boolean | null = null
  if (face != null) {
    // the face's plane: the bot's eyes on its outer side
    const plane = middle.plus(face.scaled(0.5))
    const toEye = eye.minus(plane)
    faceTowardsBot = toEye.x * face.x + toEye.y * face.y + toEye.z * face.z > 0
  }
  return {
    pos: xyz(pos),
    block: blockName(target),
    tool: held?.name ?? null,
    harvestable,
    distance: round(distance, 3),
    inReach: distance <= 4.5 + 0.87,
    raycastBlockedBy,
    face: face != null ? xyz(face) : null,
    faceTowardsBot
  }
}

export function enclosure (bot: Bot): ReportFacts['enclosed'] {
  const feet = bot.entity.position.floored()
  const cells = [
    feet.offset(1, 0, 0), feet.offset(-1, 0, 0), feet.offset(0, 0, 1), feet.offset(0, 0, -1),
    feet.offset(1, 1, 0), feet.offset(-1, 1, 0), feet.offset(0, 1, 1), feet.offset(0, 1, -1),
    feet.offset(0, 2, 0), feet.offset(0, -1, 0)
  ]
  const blocks = cells.map((p) => bot.blockAt(p, false))
  const solid = blocks.every(isSolid)
  const unbreakable = [...new Set(blocks.filter(isUnbreakable).map((b: any) => b.name as string))]
  return { solid, unbreakable, blocks: blocks.map((b: any) => b?.name ?? 'unloaded') }
}

export interface BuildReportOptions {
  kind: ReportKind
  error?: unknown
  message?: string
  goal?: unknown
  /** the cube's radius of blocks about the bot (default 3: 7 x 7 x 7) */
  radius?: number
  context?: Record<string, unknown>
}

/** a stuck report of the bot as it is now */
export function buildReport (bot: Bot, opts: BuildReportOptions): StuckReport {
  const pf = (bot as any).pathfinder
  const check = pf?.diagnostics as pfDiagnostics.PredictionCheck | undefined
  const entity = bot.entity as any
  const radius = opts.radius ?? 3
  let path: PathState | null = null
  try {
    if (pf != null) path = pfDiagnostics.describePathState(pf, opts.goal ?? pf.currentGoal)
  } catch {}
  let blocks: BlocksAround | null = null
  try {
    blocks = pfDiagnostics.blocksAround(entity.position, radius, pfDiagnostics.worldBlockOf(bot), pf?.world ?? {})
  } catch {}
  let cursorBlock: StuckReport['bot']['cursorBlock'] = null
  try {
    const b = (bot as any).blockAtCursor?.(5)
    if (b != null) cursorBlock = { pos: xyz(b.position), block: blockName(b) }
  } catch {}
  const dig = (bot as any).targetDigBlock
  const controls = pfDiagnostics.controlsString({
    forward: bot.getControlState('forward'),
    back: bot.getControlState('back'),
    left: bot.getControlState('left'),
    right: bot.getControlState('right'),
    jump: bot.getControlState('jump'),
    sprint: bot.getControlState('sprint'),
    sneak: bot.getControlState('sneak')
  })
  const entities: StuckReport['entities'] = []
  for (const e of Object.values(bot.entities ?? {}) as any[]) {
    if (e === entity || e?.position == null) continue
    const distance = e.position.distanceTo(entity.position)
    if (distance > 16) continue
    entities.push({ id: e.id, name: e.name ?? e.username ?? 'unknown', type: e.type ?? 'unknown', pos: rxyz(e.position), distance: round(distance, 2) })
  }
  entities.sort((a, b) => a.distance - b.distance)
  const held = bot.heldItem
  const errors = errorChain(opts.error)
  let leavesAround = 0
  for (const cell of blocks?.blocks ?? []) if (/_leaves\b/.test(cell.block.split(/[[#]/)[0])) leavesAround++

  const report: StuckReport = {
    version: 1,
    kind: opts.kind,
    time: new Date().toISOString(),
    tick: check?.tick ?? 0,
    message: opts.message ?? errors[0]?.message ?? opts.kind,
    diagnosis: '',
    bot: {
      username: bot.username,
      version: bot.version,
      dimension: (bot.game as any)?.dimension ?? null,
      pos: rxyz(entity.position),
      vel: rxyz(entity.velocity),
      onGround: entity.onGround === true,
      collided: entity.isCollidedHorizontally === true,
      yaw: round(entity.yaw),
      pitch: round(entity.pitch),
      controls,
      health: bot.health ?? null,
      food: bot.food ?? null,
      heldItem: held != null ? `${held.name} x${held.count as number}` : null,
      cursorBlock,
      digging: dig?.position != null ? { pos: xyz(dig.position), block: blockName(dig), face: ((f) => f != null ? xyz(f) : null)(faceVector((bot as any).targetDigFace)) } : null
    },
    path,
    recent: {
      samples: check?.samples?.toArray() ?? [],
      events: check?.recentEvents?.() ?? [],
      mismatches: check?.mismatches?.toArray() ?? [],
      mismatchSince: check?.mismatchSince ?? null,
      mismatchSinceClass: check?.mismatchSinceClass ?? null,
      stats: check?.stats != null ? { ...check.stats } : null
    },
    blocks,
    facts: { blockedAhead: blockedAhead(bot), dig: digFacts(bot), enclosed: enclosure(bot), leavesAround, idle: null, crosshair: null },
    entities: entities.slice(0, 20),
    errors,
    context: opts.context
  }
  report.facts.idle = idleFacts(report)
  report.facts.crosshair = crosshairFacts(report)
  report.diagnosis = diagnose(report)
  return report
}

/**
 * The last dig's block (the dig now, else one in the samples of the last 20 ticks) against the block in the crosshair.
 * None for a dig of the samples whose block broke (its last block update since left no block): that dig ended with its
 * block gone, and the look since is another action's. A pillar's place, its look down, had 'crosshair on dirt at
 * (-188, 60, -90), not the dig's block at (-188, 62, -90)' for the dig over its head that broke 6 ticks before (f9-26.3)
 */
export function crosshairFacts (r: StuckReport): ReportFacts['crosshair'] {
  let target: XYZ | null = r.bot.digging?.pos ?? null
  const samples = r.recent.samples
  const end = samples[samples.length - 1]?.tick ?? r.tick
  // (the last tick of that dig in the samples)
  let since = r.tick
  for (let i = samples.length - 1; target == null && i >= 0 && samples[i].tick > end - 20; i--) {
    target = samples[i].dig ?? null
    since = samples[i].tick
  }
  if (target == null) return null
  if (r.bot.digging == null) {
    const at = target
    // (the last update of the block left none: broken, a fluid flowed in; a refused break's is the block put back)
    const last = r.recent.events.filter((e) => e.type === 'block_update' && e.tick >= since && Array.isArray(e.pos) && (e.pos as number[]).every((v, i) => v === at[i])).pop()
    if (last != null && /^(air|cave_air|void_air|water|lava)$/.test(String(last.to ?? ''))) return null
  }
  const cursor = r.bot.cursorBlock
  const onTarget = cursor != null && cursor.pos.every((v, i) => v === target?.[i])
  return { digTarget: target, cursor, onTarget }
}

const MOVE_KEYS = /(^|\+)(forward|back|left|right|jump)(\+|$)/

/** the run of samples at the end with no movement key and no movement (idle) */
export function idleFacts (r: StuckReport): ReportFacts['idle'] {
  const samples = r.recent.samples
  const last = samples[samples.length - 1]
  if (last == null) return null
  let ticks = 0
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (MOVE_KEYS.test(s.controls)) break
    const d = Math.hypot(s.pos[0] - last.pos[0], s.pos[1] - last.pos[1], s.pos[2] - last.pos[2])
    if (d > 0.01) break
    ticks++
  }
  if (ticks === 0) return null
  const exit = r.path?.currentMove?.to ?? null
  const exitDistance = exit != null ? round(Math.hypot(exit[0] - last.pos[0], exit[2] - last.pos[2]), 3) : null
  return { ticks, controls: last.controls, exitDistance, exit }
}

const fmt = (p: XYZ): string => `(${p.map((n) => Math.round(n * 100) / 100).join(', ')})`
const shortBlock = (b: string): string => b.replace(/#\d+$/, '')

/**
 * The report's diagnosis: the first rules that hold, most specific first, as one line ('; ' between them, up to 3).
 * The rules read only the report, so a saved one gives the same line.
 */
export function diagnose (r: StuckReport): string {
  const found: string[] = []
  const add = (line: string | null | undefined): void => { if (line != null && !found.includes(line)) found.push(line) }

  // a dig that holds the bot: why it doesn't get anywhere
  const dig = r.facts.dig
  if (dig != null && (r.kind === 'stuck' || r.kind === 'move_failed')) {
    const why: string[] = []
    if (dig.harvestable === false) why.push(`no tool (holding ${dig.tool ?? 'nothing'})`)
    if (dig.faceTowardsBot === false) why.push('wrong face')
    if (!dig.inReach) why.push(`out of reach (${dig.distance} blocks)`)
    if (dig.raycastBlockedBy != null) why.push(`raycast blocked by ${shortBlock(dig.raycastBlockedBy.block)} at ${fmt(dig.raycastBlockedBy.pos)}`)
    add(`dig of ${shortBlock(dig.block)} at ${fmt(dig.pos)} not progressing${why.length > 0 ? ` (${why.join(', ')})` : ''}`)
  }

  // a dig whose block isn't in the crosshair (vanilla digs only the block the crosshair hits)
  const crosshair = r.facts.crosshair
  if (crosshair != null && !crosshair.onTarget && (r.kind === 'stuck' || r.kind === 'move_failed')) {
    add(`crosshair on ${crosshair.cursor != null ? `${shortBlock(crosshair.cursor.block)} at ${fmt(crosshair.cursor.pos)}` : 'nothing'}, not the dig's block at ${fmt(crosshair.digTarget)} (yaw ${r.bot.yaw}, pitch ${r.bot.pitch})`)
  }

  // a move that holds the bot with no key to move it: the executor waits on something that doesn't come
  const idle = r.facts.idle
  if (idle != null && idle.ticks >= 20 && (r.kind === 'stuck' || r.kind === 'move_failed') && dig == null && r.path?.currentMove != null) {
    add(`no movement key held for ${idle.ticks} ticks (keys: ${idle.controls === '' ? 'none' : idle.controls})${idle.exit != null ? `, ${String(idle.exitDistance)} from the move's exit ${fmt(idle.exit)}` : ''}: the ${r.path.currentMove.type} executor isn't driving the bot`)
  }

  const corrections = r.recent.events.filter((e) => e.type === 'position_correction').length
  if (corrections >= 2) add(`server corrected position ${corrections} times in the last ${r.recent.samples.length} ticks`)

  if (r.recent.mismatchSince != null && r.recent.mismatchSinceClass != null) {
    add(`prediction mismatch since tick ${r.recent.mismatchSince}: ${r.recent.mismatchSinceClass}`)
  } else {
    const faults = r.recent.mismatches.filter((m) => m.cls !== 'own_block_change' && m.tick > r.tick - 40)
    if (faults.length >= 3) {
      const counts = new Map<string, number>()
      for (const m of faults) counts.set(m.cls, (counts.get(m.cls) ?? 0) + 1)
      add(`prediction mismatches in the last 40 ticks: ${[...counts].map(([c, n]) => `${c} x${n}`).join(', ')}`)
    }
  }

  const disagreements = r.blocks?.disagreements ?? []
  if (disagreements.length > 0) {
    const d = disagreements[0]
    add(`cache says ${shortBlock(d.cache)}, world says ${shortBlock(d.world)} at ${fmt(d.pos)}${disagreements.length > 1 ? ` (and ${disagreements.length - 1} more cells)` : ''}`)
  }

  if (r.path?.goalExclusion?.excluded === true) add(`goal inside excluded area (${fmt(r.path.goalExclusion.pos)})`)

  if (r.facts.enclosed.solid && r.facts.enclosed.unbreakable.length > 0 && (r.kind === 'no_path' || r.kind === 'goto_failed' || r.kind === 'stuck')) {
    add(`enclosed by unbreakable ${r.facts.enclosed.unbreakable.join(', ')}: no way out`)
  }

  if (r.facts.blockedAhead != null) add(`pushing forward into ${shortBlock(r.facts.blockedAhead.block)} at ${fmt(r.facts.blockedAhead.pos)}: collision`)

  if (r.kind === 'no_path' || r.kind === 'goto_failed') {
    if (r.path != null && !r.path.settings.canDig) add('no path with digging off (canDig false)')
    else if (r.facts.leavesAround > 0) add(`no breakable path (leaves treated as unbreakable? ${r.facts.leavesAround} leaves around)`)
    if (r.path?.lastSearch != null) add(`the last search ended: ${r.path.lastSearch.status}`)
  }

  if (r.kind === 'move_failed' || found.length === 0) {
    const failed = [...r.recent.events].reverse().find((e) => e.type === 'move_failed') as (DiagEvent & { move?: { type: string, to: XYZ }, error?: string }) | undefined
    if (failed?.move != null) add(`move ${failed.move.type} to ${fmt(failed.move.to)} failed: ${failed.error ?? 'unknown'}`)
  }

  if (found.length === 0) add(`${r.kind}: no rule matched (${r.message})`)
  return found.slice(0, 3).join('; ')
}
