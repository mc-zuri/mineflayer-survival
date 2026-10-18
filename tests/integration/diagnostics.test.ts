// Stuck reports and the movement check against a real server (SURVIVAL_VERSION, default 1.21.11, the tests/harness
// lockstep server): a clean walk matches the physics' prediction tick for tick; a floor taken from under the bot
// mid-path is a block_change; a bot the server keeps teleporting back gets stuck, and a bot walled in with bedrock
// finds no path, each with its report written and its diagnosis.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { isSkillError } from '../../src/skills/errors'
import { waitUntil } from '../../src/skills/gather'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USERNAME = 'diagbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`stuck reports on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  const faults = (): string[] => bot.pathfinder.diagnostics.mismatches.toArray().filter((m) => m.cls !== 'own_block_change').map((m) => `${m.cls} at ${m.tick} (${m.delta.toFixed(5)})`)

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'diagnostics',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  beforeEach(async () => {
    await run(`fill ${xyz(at(-12, 0, -12))} ${xyz(at(16, 8, 12))} air`)
    await run(`fill ${xyz(at(-12, -1, -12))} ${xyz(at(16, -1, 12))} grass_block`)
    await run(`fill ${xyz(at(-12, -2, -12))} ${xyz(at(16, -2, 12))} dirt`)
    await run('time set 1000')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.entity.onGround, 100))
    await bot.waitForTicks(5)
    bot.pathfinder.diagnostics.mismatches.clear()
    bot.pathfinder.diagnostics.events.clear()
  })

  it('a clean walk matches the prediction every tick', async () => {
    const before = { ...bot.pathfinder.diagnostics.stats }
    await navigate(bot, { goal: new goals.GoalBlock(origin.x + 12, origin.y, origin.z + 4) })
    const stats = bot.pathfinder.diagnostics.stats
    const checked = stats.checked - before.checked
    assert.ok(checked >= 30, `checked ${checked} ticks`)
    assert.deepStrictEqual(faults(), [])
    const ms = (stats.ms - before.ms) / (stats.ticks - before.ticks)
    console.log(`[diagnostics] ${checked} ticks checked, ${ms.toFixed(4)} ms a tick (max ${stats.maxMs.toFixed(3)} ms)`)
  })

  it('a floor taken from under the bot mid-path is a block_change, and the walk goes on', async () => {
    let taken = false
    const onTick = (): void => {
      // once the bot is 4 blocks along, the 3 x 3 of grass under it goes (a server's change, not the bot's)
      if (taken || bot.entity.position.x < origin.x + 4.5) return
      taken = true
      const feet = bot.entity.position.floored()
      void run(`fill ${xyz(feet.offset(-1, -1, -1))} ${xyz(feet.offset(1, -1, 1))} air`)
    }
    bot.on('physicsTick', onTick)
    try {
      await navigate(bot, { goal: new goals.GoalBlock(origin.x + 12, origin.y, origin.z) })
    } finally {
      bot.off('physicsTick', onTick)
    }
    assert.ok(taken)
    const mismatches = bot.pathfinder.diagnostics.mismatches.toArray()
    const change = mismatches.find((m) => m.cls === 'block_change')
    assert.ok(change != null, `mismatches: ${JSON.stringify(mismatches)}`)
    assert.ok(change.changed?.some((c) => c.to === 'air' && c.pos[1] === GROUND), JSON.stringify(change.changed))
    assert.ok(bot.pathfinder.diagnostics.events.toArray().some((e) => e.type === 'block_update' && e.to === 'air'))
    // nothing else was off
    assert.deepStrictEqual(faults().filter((f) => !f.startsWith('block_change')), [])
  })

  it('a bot the server keeps putting back gets stuck, its report saying the server corrected it', async () => {
    let ticks = 0
    const start = origin.offset(0.5, 0, 0.5)
    const onTick = (): void => {
      // every 10 ticks the server puts the bot back where it started (as an anticheat's setback)
      if (++ticks % 10 === 0) void run(`tp ${USERNAME} ${start.x} ${start.y} ${start.z}`)
    }
    bot.on('physicsTick', onTick)
    let error: unknown
    try {
      await navigate(bot, { goal: new goals.GoalBlock(origin.x + 12, origin.y, origin.z), stuckTicks: 60, unstick: 0 })
    } catch (err) {
      error = err
    } finally {
      bot.off('physicsTick', onTick)
    }
    // navigate's own stuck check, or the pathfinder's (its moves fail one after another there, and goto gives up)
    assert.ok(isSkillError(error, 'STUCK') || isSkillError(error, 'NO_PATH'), `navigate ended with ${String(error)}`)
    const { diagnosis, reportFile } = error as any
    console.log(`[diagnostics] ${(error as any).reason as string}: ${String(diagnosis)} (${String(reportFile)})`)
    assert.match(diagnosis, /server corrected position \d+ times/)
    assert.ok(reportFile != null && fs.existsSync(reportFile), `no report file ${String(reportFile)}`)
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    assert.ok(report.kind === 'stuck' || report.kind === 'goto_failed', report.kind)
    assert.strictEqual(report.diagnosis, diagnosis)
    assert.ok(report.recent.samples.length > 50)
    assert.ok(report.recent.events.filter((e: any) => e.type === 'position_correction').length >= 2)
    assert.ok(report.recent.mismatches.some((m: any) => m.cls === 'server_correction'))
    assert.strictEqual(report.path.goal.type, 'GoalBlock')
    assert.strictEqual(report.blocks.radius, 3)
    assert.deepStrictEqual(report.blocks.disagreements, [])
    const reports = bot.survival.diagnostics.lastReports()
    assert.strictEqual(reports[reports.length - 1].diagnosis, diagnosis)
    // a move that failed on the way was reported with the path it was on
    const moveFailed = reports.find((r) => r.kind === 'move_failed')
    assert.ok(moveFailed != null && (moveFailed.path?.remaining.length ?? 0) > 0, JSON.stringify(moveFailed?.path))
    assert.ok(moveFailed.path?.currentMove != null)
  })

  it('a bot walled in with bedrock finds no path, its report saying so', async () => {
    // a bedrock box round the bot's two blocks
    await run(`fill ${xyz(at(-1, -1, -1))} ${xyz(at(1, 2, 1))} bedrock hollow`)
    await run(`fill ${xyz(at(0, 0, 0))} ${xyz(at(0, 1, 0))} air`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(at(1, 0, 0))?.name === 'bedrock' && bot.blockAt(at(0, 2, 0))?.name === 'bedrock', 40))
    let error: unknown
    try {
      await navigate(bot, { goal: new goals.GoalBlock(origin.x + 8, origin.y, origin.z) })
    } catch (err) {
      error = err
    }
    assert.ok(isSkillError(error, 'NO_PATH'), `navigate ended with ${String(error)}`)
    const { diagnosis, reportFile } = error as any
    console.log(`[diagnostics] no path: ${String(diagnosis)} (${String(reportFile)})`)
    assert.match(diagnosis, /enclosed by unbreakable bedrock: no way out/)
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    assert.strictEqual(report.kind, 'no_path')
    assert.deepStrictEqual(report.facts.enclosed.unbreakable, ['bedrock'])
  })
})
