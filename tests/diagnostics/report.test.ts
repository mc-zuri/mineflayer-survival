import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { Diagnostics, buildReport, diagnose, errorChain, type StuckReport } from '../../src/diagnostics'
import { SkillError } from '../../src/skills/errors'

type XYZ = [number, number, number]

function block (name: string, pos: Vec3, opts: { canHarvest?: (t: number | null) => boolean } = {}): any {
  const solid = name !== 'air'
  return {
    name,
    position: pos,
    stateId: name === 'air' ? 0 : name.length,
    boundingBox: solid ? 'block' : 'empty',
    shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [],
    diggable: name !== 'bedrock',
    hardness: name === 'bedrock' ? null : 1,
    canHarvest: opts.canHarvest,
    getProperties: () => ({})
  }
}

/** a bot at (0.5, 64, 0.5) on stone, with the blocks `at` names (air elsewhere above y 63) */
function mockBot (at: (pos: Vec3) => string | null = () => null, extra: Record<string, any> = {}): any {
  const bot: any = new EventEmitter()
  const controls: Record<string, boolean> = {}
  const blocks = new Map<string, any>()
  bot.username = 'diagbot'
  bot.version = '1.21.11'
  bot.game = { dimension: 'overworld' }
  bot.health = 20
  bot.food = 20
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, -0.0784, 0), onGround: true, yaw: 0, pitch: 0, eyeHeight: 1.62, isCollidedHorizontally: false }
  bot.entities = {}
  bot.getControlState = (name: string) => controls[name] === true
  bot.setControlState = (name: string, v: boolean) => { controls[name] = v }
  bot.blockAt = (pos: Vec3) => {
    const p = pos.floored()
    const k = p.toString()
    if (!blocks.has(k)) blocks.set(k, block(at(p) ?? (p.y < 64 ? 'stone' : 'air'), p))
    return blocks.get(k)
  }
  bot.heldItem = null
  Object.assign(bot, extra)
  return bot
}

/** a report with nothing in it, for diagnose */
function emptyReport (over: Partial<StuckReport> = {}): StuckReport {
  return {
    version: 1,
    kind: 'stuck',
    time: '2026-10-19T00:00:00.000Z',
    tick: 500,
    message: 'no progress',
    diagnosis: '',
    bot: { username: 'b', version: '1.21.11', dimension: 'overworld', pos: [0.5, 64, 0.5], vel: [0, 0, 0], onGround: true, collided: false, yaw: 0, pitch: 0, controls: '', health: 20, food: 20, heldItem: null, cursorBlock: null, digging: null },
    path: null,
    recent: { samples: [], events: [], mismatches: [], mismatchSince: null, mismatchSinceClass: null, stats: null },
    blocks: { origin: [0, 64, 0], radius: 3, blocks: [], air: 343, unloaded: 0, cached: 0, disagreements: [] },
    facts: { blockedAhead: null, dig: null, enclosed: { solid: false, unbreakable: [], blocks: [] }, leavesAround: 0 },
    entities: [],
    errors: [],
    ...over
  }
}

const facts = (over: Partial<StuckReport['facts']>): StuckReport['facts'] => ({ ...emptyReport().facts, ...over })
const recent = (over: Partial<StuckReport['recent']>): StuckReport['recent'] => ({ ...emptyReport().recent, ...over })

test('errorChain: the error and its causes, outermost first, with their codes', () => {
  const inner = new Error('Goto: 5 moves in a row failed')
  const err = new SkillError('NO_PATH', 'the pathfinder failed', undefined, { cause: inner })
  const chain = errorChain(err)
  assert.strictEqual(chain.length, 2)
  assert.strictEqual(chain[0].reason, 'NO_PATH')
  assert.strictEqual(chain[0].code, 'NO_PATH')
  assert.strictEqual(chain[1].message, 'Goto: 5 moves in a row failed')
  assert.deepStrictEqual(errorChain(undefined), [])
})

test('diagnose: a collision with the block ahead', () => {
  const r = emptyReport({ facts: facts({ blockedAhead: { pos: [0, 64, -1], block: 'oak_log[axis=y]#137' } }) })
  assert.strictEqual(diagnose(r), 'pushing forward into oak_log[axis=y] at (0, 64, -1): collision')
})

test('diagnose: position corrections and the prediction mismatch they start; scattered mismatches counted by class', () => {
  const r = emptyReport({
    recent: recent({
      events: [{ tick: 480, type: 'position_correction' }, { tick: 490, type: 'position_correction' }, { tick: 491, type: 'position_correction' }],
      mismatchSince: 480,
      mismatchSinceClass: 'server_correction'
    })
  })
  assert.strictEqual(diagnose(r), 'server corrected position 3 times in the last 0 ticks; prediction mismatch since tick 480: server_correction')
  const mismatch = (tick: number, cls: string): any => ({ tick, cls, delta: 0.1, velDelta: 0.1, predicted: { pos: [0, 0, 0], vel: [0, 0, 0], onGround: true }, actual: { pos: [0, 0, 0], vel: [0, 0, 0], onGround: true } })
  const scattered = emptyReport({ recent: recent({ mismatches: [mismatch(480, 'own_block_change'), mismatch(485, 'entity_push'), mismatch(490, 'entity_push'), mismatch(495, 'entity_push')] }) })
  assert.strictEqual(diagnose(scattered), 'prediction mismatches in the last 40 ticks: entity_push x3')
})

test('diagnose: the cache and the world disagree', () => {
  const blocks = { ...emptyReport().blocks!, disagreements: [{ pos: [1, 64, 0] as XYZ, cache: 'stone#1', world: 'air#0' }, { pos: [1, 65, 0] as XYZ, cache: 'stone#1', world: 'air#0' }] }
  assert.strictEqual(diagnose(emptyReport({ blocks })), 'cache says stone, world says air at (1, 64, 0) (and 1 more cells)')
})

test('diagnose: a dig not progressing, and why', () => {
  const dig = { pos: [0, 65, -2] as XYZ, block: 'stone#1', tool: null, harvestable: false, distance: 5.6, inReach: false, raycastBlockedBy: { pos: [0, 65, -1] as XYZ, block: 'dirt#10' }, face: [0, 0, 1] as XYZ, faceTowardsBot: false }
  assert.strictEqual(diagnose(emptyReport({ facts: facts({ dig }) })), 'dig of stone at (0, 65, -2) not progressing (no tool (holding nothing), wrong face, out of reach (5.6 blocks), raycast blocked by dirt at (0, 65, -1))')
  const fine = { ...dig, harvestable: true, inReach: true, raycastBlockedBy: null, faceTowardsBot: true }
  assert.strictEqual(diagnose(emptyReport({ facts: facts({ dig: fine }) })), 'dig of stone at (0, 65, -2) not progressing')
})

test('diagnose: no path, with the goal excluded, enclosed in bedrock, leaves around, digging off', () => {
  const path: any = { settings: { canDig: true, canPlace: true, maxDropDown: 3, exclusionAreas: { step: 1, break: 0, place: 0 } }, goalExclusion: { pos: [5, 64, 5], cost: 1e6, excluded: true }, lastSearch: { status: 'noPath', tick: 400 } }
  assert.strictEqual(diagnose(emptyReport({ kind: 'no_path', path })), 'goal inside excluded area ((5, 64, 5)); the last search ended: noPath')
  const enclosed = emptyReport({ kind: 'no_path', facts: facts({ enclosed: { solid: true, unbreakable: ['bedrock'], blocks: [] } }) })
  assert.strictEqual(diagnose(enclosed), 'enclosed by unbreakable bedrock: no way out')
  const leaves = emptyReport({ kind: 'no_path', facts: facts({ leavesAround: 12 }) })
  assert.strictEqual(diagnose(leaves), 'no breakable path (leaves treated as unbreakable? 12 leaves around)')
  const noDig = emptyReport({ kind: 'goto_failed', path: { ...path, goalExclusion: null, lastSearch: null, settings: { ...path.settings, canDig: false } } })
  assert.strictEqual(diagnose(noDig), 'no path with digging off (canDig false)')
})

test('diagnose: a failed move, and the fallback', () => {
  const r = emptyReport({ kind: 'move_failed', recent: recent({ events: [{ tick: 490, type: 'move_failed', move: { type: 'ForwardJump', to: [3.5, 65, 0.5] }, error: 'no progress in 60 ticks' }] }) })
  assert.strictEqual(diagnose(r), 'move ForwardJump to (3.5, 65, 0.5) failed: no progress in 60 ticks')
  assert.strictEqual(diagnose(emptyReport()), 'stuck: no rule matched (no progress)')
})

test('buildReport: the bot, the blocks around, the facts for the rules (forward into a log, a dig out of reach)', () => {
  const log = new Vec3(0, 64, -1)
  const bot = mockBot((p) => p.equals(log) ? 'oak_log' : null)
  bot.setControlState('forward', true)
  bot.entity.isCollidedHorizontally = true
  bot.entities = { 7: { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0) } }
  const report = buildReport(bot, { kind: 'stuck', message: 'no progress for 200 ticks', error: new SkillError('STUCK', 'no progress') })
  assert.deepStrictEqual(report.facts.blockedAhead?.pos, [0, 64, -1])
  assert.match(report.diagnosis, /^pushing forward into oak_log at \(0, 64, -1\): collision/)
  assert.strictEqual(report.bot.controls, 'forward')
  // the stone under the bot's 7 x 7 x 7 (3 layers), and the log
  assert.strictEqual(report.blocks?.blocks.length, 7 * 7 * 3 + 1)
  assert.deepStrictEqual(report.entities.map((e) => e.name), ['zombie'])
  assert.strictEqual(report.errors[0].reason, 'STUCK')
  assert.strictEqual(report.path, null)
  // a saved report gives the same diagnosis
  assert.strictEqual(diagnose(JSON.parse(JSON.stringify(report))), report.diagnosis)

  const digger = mockBot()
  digger.targetDigBlock = block('stone', new Vec3(0, 66, -6), { canHarvest: () => false })
  digger.targetDigFace = new Vec3(0, 0, 1)
  const dug = buildReport(digger, { kind: 'stuck' })
  assert.strictEqual(dug.facts.dig?.inReach, false)
  assert.strictEqual(dug.facts.dig?.harvestable, false)
  assert.strictEqual(dug.facts.dig?.faceTowardsBot, true)
  assert.match(dug.diagnosis, /^dig of stone at \(0, 66, -6\) not progressing \(no tool \(holding nothing\), out of reach/)
})

test('buildReport: a bot walled in with bedrock', () => {
  const feet = new Vec3(0, 64, 0)
  const bot = mockBot((p) => {
    const d = p.minus(feet)
    const side = Math.abs(d.x) + Math.abs(d.z) === 1 && (d.y === 0 || d.y === 1)
    const cap = d.x === 0 && d.z === 0 && (d.y === 2 || d.y === -1)
    return side || cap ? 'bedrock' : null
  })
  const report = buildReport(bot, { kind: 'no_path', message: 'no path to the goal' })
  assert.strictEqual(report.facts.enclosed.solid, true)
  assert.deepStrictEqual(report.facts.enclosed.unbreakable, ['bedrock'])
  assert.strictEqual(report.diagnosis, 'enclosed by unbreakable bedrock: no way out')
})

test('Diagnostics keeps the last reports, calls its listeners, and writes each to its dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-'))
  try {
    const diagnostics = new Diagnostics(mockBot(), { dir, keep: 2 })
    const seen: string[] = []
    const off = diagnostics.onReport((r, file) => { seen.push(`${r.kind} ${file != null ? 'written' : 'none'}`) })
    diagnostics.report({ kind: 'stuck', message: 'one' })
    diagnostics.report({ kind: 'no_path', message: 'two' })
    off()
    const third = diagnostics.dump()
    assert.deepStrictEqual(seen, ['stuck written', 'no_path written'])
    assert.deepStrictEqual(diagnostics.lastReports().map((r) => r.message), ['two', 'dump'])
    const file = diagnostics.fileOf(third)
    assert.ok(file != null && fs.existsSync(file))
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).kind, 'manual')
    assert.strictEqual(fs.readdirSync(dir).length, 3)
    // none written without a dir
    const quiet = new Diagnostics(mockBot(), { dir: null })
    assert.strictEqual(quiet.fileOf(quiet.dump()), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Diagnostics reports a failed move of the pathfinder, at most one in moveFailedEvery ticks', () => {
  const check = { tick: 0 }
  const bot = mockBot(() => null, { pathfinder: { diagnostics: check, lastMoveError: 'no progress in 60 ticks' } })
  const diagnostics = new Diagnostics(bot, { dir: null, moveFailedEvery: 100 })
  bot.emit('pathfinderMoveFailed', {})
  check.tick = 50
  bot.emit('pathfinderMoveFailed', {})
  check.tick = 150
  bot.emit('pathfinderMoveFailed', {})
  assert.deepStrictEqual(diagnostics.lastReports().map((r) => `${r.kind}: ${r.message}`), ['move_failed: no progress in 60 ticks', 'move_failed: no progress in 60 ticks'])
})
