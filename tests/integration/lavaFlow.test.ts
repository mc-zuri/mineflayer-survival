// Lava flowing up to the bot, against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness lockstep
// server, a superflat world, no mobs, the reflexes on), the bot busy with a task (a wait standing in for the work), as
// mine-ai-mcp's scenarios/flat/flowing-lava do:
// - 'side': a lava source put 2 blocks east of the bot on the ground: its flow comes on a block every 30 ticks
//   (LavaFluid.getTickDelay), level 2 beside the bot then into its cell;
// - 'over': a source put 3 up a block east of the bot: its column falls beside the bot and spreads into its cell.
// A run is a pass when the bot never burns (no tick on fire, no damage) in 300 ticks. LAVA_RUNS=n repeats each
// (default 2).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { isOnFire } from '../../src/skills/escape'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary } from './nightLog'

const USER = 'lavabot'
const RUNS = Number(process.env.LAVA_RUNS ?? 2)
const GRASS = -61

let server: TestServer
let bot: Bot
let runs = 0

async function run (cmd: string): Promise<string[]> {
  return await server.command(cmd)
}

async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

const CASES: Array<{ name: string, lava: Vec3 }> = [
  { name: 'side', lava: new Vec3(2, 1, 0) },
  { name: 'over', lava: new Vec3(1, 4, 0) }
]

describe(`lava flowing up to the bot on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'lava',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false, respawn_radius: 0 },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
    bot.survival.reflexes!.enabled = false
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  for (const c of CASES) {
    test(`${c.name}: the bot away before the lava touches it (${RUNS} runs)`, async () => {
      const results: string[] = []
      let failed = 0
      for (let i = 0; i < RUNS; i++) {
        if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
        bot.survival.tasks.cancelAll('ABORTED', 'reset')
        const ox = 48 * runs++
        for (const cmd of ['time set 6000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 16} -16 ${ox + 16} 16`,
          `fill ${ox - 12} ${GRASS + 1} -12 ${ox + 12} ${GRASS + 12} 12 minecraft:air`,
          `fill ${ox - 12} ${GRASS} -12 ${ox + 12} ${GRASS} 12 minecraft:grass_block`]) await run(cmd)
        const at = new Vec3(ox + 0.5, GRASS + 1, 0.5)
        await run(`tp ${USER} ${at.x} ${at.y} ${at.z} -90 0`)
        await waitFor(() => bot.entity.position.distanceTo(at) < 0.5, 200)
        await run(`give ${USER} cobblestone 32`)
        await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
        await bot.waitForTicks(20)
        const log = new NightLog(bot)
        const work = bot.survival.tasks.run({ name: 'step: the work', priority: 0 }, async (ctx) => { for (;;) await ctx.waitTicks(20) }).catch(() => {})
        bot.survival.reflexes!.enabled = true
        // (the over case's source on a block, its lava falling beside the bot)
        if (c.name === 'over') await run(`setblock ${ox + c.lava.x} ${GRASS + c.lava.y - 1} ${c.lava.z} minecraft:stone`)
        await run(`setblock ${ox + c.lava.x} ${GRASS + c.lava.y} ${c.lava.z} minecraft:lava`)
        let burning = 0
        const onTick = (): void => { if (isOnFire(bot) || (bot.entity as any).isInLava === true) burning++ }
        bot.on('physicsTick', onTick)
        await waitFor(() => bot.health <= 0, 300)
        bot.off('physicsTick', onTick)
        bot.survival.reflexes!.enabled = false
        bot.survival.tasks.cancelAll('ABORTED', 'the run is over')
        await work
        const r = log.finish()
        const ok = burning === 0 && r.damageTotal === 0
        if (!ok) failed++
        results.push(`run ${i + 1}: ${burning} ticks burning, ${(bot.entity.position.x - at.x).toFixed(1)} off across, ${summary(r)}`)
        await run(`fill ${ox - 12} ${GRASS + 1} -12 ${ox + 12} ${GRASS + 12} 12 minecraft:air`)
      }
      for (const l of results) console.log(`[lava] ${c.name}: ${l}`)
      assert.strictEqual(failed, 0, results.join('\n'))
    })
  }
})
