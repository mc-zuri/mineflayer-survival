// pnpm e2e's pieces without a server: its options, the summary of the milestones' ticks and wall time, the
// `execute if entity` answer it passes on, and the world copy a checkpoint and --resume use.
import { describe, test } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { formatWall, parseArgs, summary, testPassed } from '../e2e/e2e'
import { copyWorld } from '../harness/server'

describe('pnpm e2e', () => {
  test('options: a seed, a tick budget, a milestone to stop at, a checkpoint to resume from', () => {
    const o = parseArgs(['--seed', '7', '--max-ticks=500000', '--until', 'nether', '--resume', 'cp/06-diamonds', '--checkpoints', 'out', '--stage', 'dragon'])
    assert.strictEqual(o.stage, 'dragon')
    assert.strictEqual(o.seed, '7')
    assert.strictEqual(o.maxTicks, 500000)
    assert.strictEqual(o.until, 'nether')
    assert.strictEqual(o.resume, 'cp/06-diamonds')
    assert.strictEqual(o.checkpoints, 'out')
    const d = parseArgs([])
    assert.strictEqual(d.seed, '2')
    assert.strictEqual(d.username, 'player')
    assert.match(d.checkpoints, /[\\/]\.e2e[\\/]2-\d{4}-/)
    assert.throws(() => parseArgs(['--seed']), /--seed needs a value/)
    assert.throws(() => parseArgs(['--fast']), /unknown option --fast/)
  })

  test('the summary has each milestone\'s tick and wall time and the ticks a wall second', () => {
    assert.strictEqual(formatWall(61000), '1m01s')
    assert.strictEqual(formatWall(3723000), '1h02m03s')
    const lines = summary([{ id: 'wood', title: '', tick: 1200, wallMs: 4000 }, { id: 'stone', title: '', tick: 3000, wallMs: 10000 }], 6000, 20000)
    assert.match(lines[0], /wood +tick +1200 +wall +0m04s/)
    assert.match(lines[1], /stone +tick +3000 +wall +0m10s/)
    assert.match(lines[2], /total +tick +6000 +wall +0m20s +300\.0 ticks\/s/)
    // a resumed run: the rate of its own ticks
    assert.match(summary([], 53716, 72000, 8900)[0], /total +tick +53716 +wall +1m12s +123\.6 ticks\/s \(8900 ticks this run\)/)
  })

  test('the advancement check passes on the console\'s "Test passed" only', () => {
    assert.ok(testPassed(['Test passed']))
    assert.ok(testPassed(['Test passed, count: 1']))
    assert.ok(!testPassed(['Test failed']))
    assert.ok(!testPassed([]))
  })

  test('a world is copied without the session.lock its server holds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-world-'))
    const from = path.join(root, 'world')
    fs.mkdirSync(path.join(from, 'region'), { recursive: true })
    fs.writeFileSync(path.join(from, 'level.dat'), 'level')
    fs.writeFileSync(path.join(from, 'session.lock'), 'lock')
    fs.writeFileSync(path.join(from, 'region', 'r.0.0.mca'), 'region')
    const to = path.join(root, 'copy')
    copyWorld(from, to)
    assert.strictEqual(fs.readFileSync(path.join(to, 'level.dat'), 'utf8'), 'level')
    assert.strictEqual(fs.readFileSync(path.join(to, 'region', 'r.0.0.mca'), 'utf8'), 'region')
    assert.ok(!fs.existsSync(path.join(to, 'session.lock')))
    fs.rmSync(root, { recursive: true, force: true })
  })
})

test('watchTicks: tells once of no tick for the time given, again only after ticks ran', async () => {
  const { watchTicks } = await import('../e2e/e2e')
  let ticks = 0
  const stalls: number[] = []
  const timer = watchTicks(() => ticks, 0.05, s => stalls.push(s), 10)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(stalls.length, 1)
  ticks++
  await new Promise(resolve => setTimeout(resolve, 30))
  ticks++
  await new Promise(resolve => setTimeout(resolve, 150))
  clearInterval(timer)
  assert.equal(stalls.length, 2)
})

test('watchEventLoop: tells of a synchronous hold-up over the threshold', async () => {
  const { watchEventLoop } = await import('../e2e/e2e')
  const late: number[] = []
  const timer = watchEventLoop(100, ms => late.push(ms), 20)
  await new Promise(resolve => setTimeout(resolve, 60))
  const until = Date.now() + 250
  while (Date.now() < until) { /* held */ }
  await new Promise(resolve => setTimeout(resolve, 60))
  clearInterval(timer)
  assert.equal(late.length, 1)
  assert.ok(late[0] >= 100, String(late[0]))
})

test('playOptions passes the world\'s seed on to play', async () => {
  const { playOptions, parseArgs } = await import('../e2e/e2e')
  const opts = parseArgs(['--seed', '7', '--max-ticks', '1000'])
  assert.deepEqual(playOptions(opts, 'save.json'), { saveFile: 'save.json', maxTicks: 1000, until: undefined, seed: '7' })
})

test('--grim is a real-time run (no lockstep mod) with GrimAC; --seed random a 64-bit seed of its own', async () => {
  const { parseArgs } = await import('../e2e/e2e')
  const d = parseArgs([])
  assert.equal(d.realtime, false)
  assert.equal(d.grim, false)
  const g = parseArgs(['--grim'])
  assert.equal(g.grim, true)
  assert.equal(g.realtime, true)
  const r = parseArgs(['--realtime'])
  assert.equal(r.realtime, true)
  assert.equal(r.grim, false)
  const a = parseArgs(['--seed', 'random'])
  const b = parseArgs(['--seed', 'random'])
  assert.match(a.seed, /^-?\d+$/)
  assert.notEqual(a.seed, b.seed)
  assert.ok(BigInt(a.seed) >= -(2n ** 63n) && BigInt(a.seed) < 2n ** 63n)
  // the checkpoints named by the seed drawn
  assert.ok(path.basename(a.checkpoints).startsWith(`${a.seed}-`))
})

test('GrimFlags counts the alerts in the server log by check', async () => {
  const { GrimFlags } = await import('../e2e/e2e')
  const flags = new GrimFlags()
  assert.equal(flags.toString(), 'no Grim flags')
  assert.ok(flags.add('[20:01:44] [Netty NIO IO #1/INFO]: Grim » player failed Simulation (x1) 2.882000 /gl 1'))
  assert.ok(flags.add('[20:01:44] [Netty NIO IO #1/INFO]: Grim » player failed Simulation (x2) .115440 /gl 2'))
  assert.ok(flags.add('[20:01:45] [Netty NIO IO #2/INFO]: Grim » player failed GroundSpoof (x1) claimed true'))
  assert.ok(!flags.add('[20:01:35] [Server thread/INFO]: player joined the game'))
  assert.equal(flags.total, 3)
  assert.equal(flags.toString(), '3 Grim flags: Simulation 2, GroundSpoof 1')
})
