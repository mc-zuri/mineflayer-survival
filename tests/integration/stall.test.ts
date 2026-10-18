// The stall watchdog and the death reports against a real server (SURVIVAL_VERSION, the tests/harness lockstep
// server): play on a superflat world, where the diamonds milestone's ore doesn't exist, gets nowhere and makes a stall
// report (and the skill reports of its failed steps); a /kill on the way makes a death report with the server's
// message and what dropped, written again once the recovery went back for the items. Each report has its log line,
// "[survival] <kind> report: <diagnosis> (<file>)", and the save keeps their summaries.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import type { SurvivalReport } from '../../src/diagnostics'
import { parseLogLine } from '../harness/server'
import { DEFAULT_VERSION, STUCK_DIR, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USERNAME = 'stallbot'
const MAX_TICKS = Number(process.env.STALL_TICKS ?? 4000)
const KILL_AT = 1500

describe(`stall and death reports on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const lines: string[] = []
  const serverDeaths: string[] = []
  const dir = path.join(STUCK_DIR, `stall-${DEFAULT_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}`)

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'stall',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
      properties: { 'spawn-protection': 0 },
      // the server's own death message ("stallbot was killed"), to check the report's against
      log: (line) => {
        const message = parseLogLine(line)?.message
        if (message?.startsWith(`${USERNAME} `) === true && !/ joined| left| lost connection|logged in|\[/.test(message)) serverDeaths.push(message)
      }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false, diagnostics: { dir, log: (line) => { lines.push(line); console.error(line) } } }))
    await server.command('time set 1000')
    // the kit of a bot past the iron: what the diamonds milestone plans from (and what drops at the death)
    for (const [item, n] of [['iron_pickaxe', 1], ['iron_sword', 1], ['stick', 8], ['crafting_table', 1], ['cobblestone', 32], ['torch', 16], ['bread', 16]] as const) {
      await server.command(`give ${USERNAME} ${item} ${n}`)
    }
    await bot.waitForTicks(20)
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('a milestone whose ore the world hasn\'t gets a stall report; a /kill a death report with its recovery', async () => {
    const saveFile = path.join(dir, 'save.json')
    let ticks = 0
    let killed = false
    const onTick = (): void => {
      if (++ticks !== KILL_AT) return
      killed = true
      void server.command(`kill ${USERNAME}`)
    }
    bot.on('physicsTick', onTick)
    let result
    try {
      result = await bot.survival.play({
        skip: ['wood', 'stone', 'food', 'base', 'iron'],
        until: 'diamonds',
        saveFile,
        maxTicks: MAX_TICKS,
        sleep: false,
        nightMining: false,
        watchdog: { stallTicks: 600, maxRepeats: 3, maxReplans: 8 }
      })
    } finally {
      bot.off('physicsTick', onTick)
    }
    console.log(`[stall] play stopped: ${result.reason}${result.error != null ? `: ${(result.error as Error).message}` : ''}`)
    assert.ok(killed)
    assert.notStrictEqual(result.reason, 'until', 'the diamonds milestone was reached on a superflat world')
    const records = bot.survival.diagnostics.lastRecords()
    for (const r of records) console.log(`[stall] ${r.report.kind}: ${r.report.diagnosis}`)

    // the stall: the diamonds milestone, its plan and step, and why
    const stalls = records.filter(r => r.report.kind === 'stall')
    assert.ok(stalls.length > 0, `no stall report: ${records.map(r => r.report.kind).join(', ')}`)
    const stall = stalls[0].report as SurvivalReport
    assert.strictEqual(stall.work.milestone?.id, 'diamonds')
    assert.match(stall.diagnosis, /^milestone diamonds: no progress in \d+ ticks; mine (deepslate_)?diamond_ore: no known (deepslate_)?diamond_ore, explored \d+ blocks$/)
    assert.ok(stall.memory != null && Object.keys(stall.memory.needed).some(n => /diamond_ore/.test(n)), JSON.stringify(stall.memory?.needed))
    assert.ok(stall.bot.inventory.some(i => i.name === 'iron_pickaxe') || stall.tick > KILL_AT)

    // the death: the server's message, what dropped, and the recovery that went back for it
    const deaths = records.filter(r => r.report.kind === 'death')
    assert.strictEqual(deaths.length, 1, records.map(r => r.report.kind).join(', '))
    const death = deaths[0].report as SurvivalReport
    const facts = death.death!
    console.log(`[stall] the server said: ${serverDeaths.join(' | ')}`)
    assert.ok(facts.message != null && serverDeaths.includes(facts.message), `the report's ${String(facts.message)}, the server's ${serverDeaths.join(' | ')}`)
    assert.ok(facts.dropped.some(i => i.name === 'iron_pickaxe'), JSON.stringify(facts.dropped))
    assert.strictEqual(facts.dimension?.replace('minecraft:', ''), 'overworld')
    assert.ok(facts.health.some(h => h.health <= 0), JSON.stringify(facts.health))
    // (written again with the recovery)
    const onDisk = JSON.parse(fs.readFileSync(deaths[0].file!, 'utf8'))
    assert.ok(onDisk.death.recovery?.done != null, JSON.stringify(onDisk.death.recovery))
    assert.strictEqual(onDisk.death.recovery.deathSpot, 'went', JSON.stringify(onDisk.death.recovery))
    assert.ok((onDisk.death.recovery.picked.iron_pickaxe ?? 0) >= 1, JSON.stringify(onDisk.death.recovery.picked))
    assert.match(onDisk.diagnosis, /^died: .+; recovery: back to the death spot \(picked up .*iron_pickaxe/)
    assert.ok(bot.inventory.items().some(i => i.name === 'iron_pickaxe'), 'the pickaxe wasn\'t picked up again')

    // a log line for each report, with its file
    assert.strictEqual(lines.length, bot.survival.diagnostics.history.length)
    for (const r of records) {
      assert.ok(r.file != null && fs.existsSync(r.file), `no file for ${r.report.kind}`)
      assert.ok(lines.some(l => l.startsWith(`[survival] ${r.report.kind} report: `) && l.endsWith(`(${r.file})`)), `no log line for ${r.file}`)
    }
    // the save has them
    const save = JSON.parse(fs.readFileSync(saveFile, 'utf8'))
    assert.ok(save.reports.some((s: any) => s.kind === 'stall') && save.reports.some((s: any) => s.kind === 'death'), JSON.stringify(save.reports))
  })
})
