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
    const o = parseArgs(['--seed', '7', '--max-ticks=500000', '--until', 'nether', '--resume', 'cp/06-diamonds', '--checkpoints', 'out'])
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
