// bot.survival.play() from a late stage of the game to the dragon, on a fresh world under lockstep (a fixed seed,
// survival, normal difficulty, the bot not op), SURVIVAL_VERSION's server (default 1.21.11; 26.3 too). The stages go
// backwards from the end: the bot starts at the spawn with the kit a run has by then (STAGES: the items and enchantments
// the rest of the game needs, given from the console), the milestones before the stage in play's save as reached, and
// play runs to the dragon killed, checked against the server's minecraft:end/kill_dragon. Each milestone's tick and
// wall time are reported.
//
//   PLAY_STAGES=dragon  (the stages to run; none by default: each is a long game)
//   PLAY_SEED (default 2), PLAY_STAGE_TICKS (each stage's budget, default 400000)
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { MILESTONES } from '../../src/planner/progression'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { STAGES, giveKit, stageSave } from './stageKits'

const SEED = process.env.PLAY_SEED ?? '2'
const RUN = new Set((process.env.PLAY_STAGES ?? '').split(',').filter(s => s !== ''))
const STAGE_TICKS = Number(process.env.PLAY_STAGE_TICKS ?? 400000)
const wallFor = (ticks: number): number => (ticks / 40 + 300) * 1000
const USERNAME = 'player'

for (const [name, stage] of Object.entries(STAGES)) {
  describe(`play's ${name} stage (from ${stage.from}) on a ${DEFAULT_VERSION} server, seed ${SEED}`, { timeout: wallFor(STAGE_TICKS), skip: !RUN.has(name) }, () => {
    let server: TestServer
    let bot: Bot
    let saveFile: string

    before(async () => {
      // the stuck reports (bot.survival.diagnostics) in a folder of the stage's own
      const out = path.join(__dirname, '..', '.e2e', 'stages', `${name}-${DEFAULT_VERSION}-${SEED}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
      process.env.SURVIVAL_STUCK_DIR = path.join(out, 'stuck')
      console.log(`[stage] ${name}: stuck reports in ${process.env.SURVIVAL_STUCK_DIR}`)
      server = await startServer({
        seed: SEED,
        difficulty: 'normal',
        log: process.env.PLAY_SERVER_LOG != null ? line => fs.appendFileSync(process.env.PLAY_SERVER_LOG as string, `${line}\n`) : undefined
      })
      bot = await connectLockstepBot(server, { username: USERNAME, op: false, timeoutMs: 120000 })
      await bot.waitForChunksToLoad()
      // for reading the log: where the nearest stronghold is (the server's /locate; the bot finds it by its eyes)
      if (stage.until === 'end') console.log(`[stage] ${(await server.command('locate structure minecraft:stronghold')).join(' | ')}`)
      await giveKit(server, bot, USERNAME, stage)
      bot.loadPlugin(createPlugin())
      saveFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'survival-stage-')), 'save.json')
      fs.writeFileSync(saveFile, stageSave(stage.from))
    })
    after(async () => {
      bot?.survival?.reflexes?.stop()
      if (bot != null) await quitBot(bot)
      if (server != null) await server.cleanup()
    })

    test(`reaches ${stage.until}${stage.until === 'end' ? ' (the dragon killed)' : ''}`, async (t) => {
      const t0 = Date.now()
      const k0 = bot.lockstep.ticks
      const result = await bot.survival.play({ until: stage.until, saveFile, maxTicks: STAGE_TICKS })
      const ticks = bot.lockstep.ticks - k0
      const wall = (Date.now() - t0) / 1000
      for (const r of result.reached) if (r.tick > MILESTONES.length) t.diagnostic(`${r.id}: tick ${r.tick}, ${(r.wallMs / 1000).toFixed(1)} s wall`)
      t.diagnostic(`${ticks} ticks in ${wall.toFixed(0)} s (${(ticks / Math.max(1, wall)).toFixed(0)} ticks/s); stopped: ${result.reason}${result.stoppedAt != null ? ` at ${result.stoppedAt}` : ''}${result.error != null ? `: ${(result.error as Error).message}` : ''}`)
      assert.strictEqual(result.reason, 'until', `stopped: ${result.reason} ${String((result.error as Error)?.message ?? '')}`)
      if (stage.until === 'end') {
        const out = await server.command(`execute if entity @a[name=${USERNAME},advancements={minecraft:end/kill_dragon=true}]`)
        assert.ok(out.some(l => /^Test passed/.test(l)), `no minecraft:end/kill_dragon: ${out.join(' | ')}`)
      }
    })
  })
}
