// The deep dark on a SURVIVAL_VERSION (default 1.21.11) superflat world (the tests/harness lockstep server, normal difficulty, no
// natural spawning): a walk past a patch of sculk with sensors and shriekers (the route keeps out of the sensors' hearing,
// no shriek: the player's warning level stays 0).
// DEEP_RUNS=n repeats each (default 3); NIGHT_VERBOSE=1 logs each hit and reflex.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USER = 'deepbot'
const RUNS = Number(process.env.DEEP_RUNS ?? 3)
const GROUND = -60

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

/** a fresh patch of ground 96 blocks along from the last, the bot there at full health, its bag empty, no mobs, at noon */
async function freshGround (): Promise<Vec3> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  bot.clearControlStates()
  const x = 96 * runs++
  for (const cmd of ['time set noon', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `tp ${USER} ${x + 0.5} ${GROUND} 0.5`,
    `effect give ${USER} minecraft:instant_health 1 10 true`, `effect give ${USER} minecraft:saturation 1 20 true`]) {
    await run(cmd)
  }
  await waitFor(() => Math.abs(bot.entity.position.x - x - 0.5) < 1, 100)
  await bot.waitForChunksToLoad()
  await bot.waitForTicks(20)
  return new Vec3(x, GROUND, 0)
}

/** the player's warden warning level (WardenSpawnTracker: up one a shriek it set off, the warden at 4) */
async function warningLevel (): Promise<number> {
  const lines = await run(`data get entity ${USER} warden_spawn_tracker.warning_level`)
  const m = /data: (\d+)/.exec(lines.join(' '))
  return m == null ? 0 : Number(m[1])
}

describe(`the deep dark on ${DEFAULT_VERSION} (normal difficulty)`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'deepdark',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false, respawn_radius: 0 },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
    bot.survival.reflexes!.enabled = false
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test(`a walk past sculk: the route keeps out of the sensors' hearing, nothing set off (${RUNS} runs)`, async (t) => {
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      const home = await freshGround()
      // a patch of sculk 9 wide across the straight way, 12 to 20 blocks along: sensors and shriekers in it
      await run(`fill ${home.x + 12} ${GROUND - 1} -4 ${home.x + 20} ${GROUND - 1} 4 minecraft:sculk`)
      const sensors = [new Vec3(home.x + 14, GROUND, -2), new Vec3(home.x + 14, GROUND, 2), new Vec3(home.x + 18, GROUND, 0)]
      for (const s of sensors) await run(`setblock ${s.x} ${s.y} ${s.z} minecraft:sculk_sensor`)
      await run(`setblock ${home.x + 16} ${GROUND - 1} 0 minecraft:sculk_shrieker[can_summon=true]`)
      await run(`setblock ${home.x + 16} ${GROUND - 1} 3 minecraft:sculk_shrieker[can_summon=true]`)
      // (the scan's look about, every 100 ticks)
      await bot.waitForTicks(120)
      let nearest = Infinity
      const watch = (): void => { for (const s of sensors) nearest = Math.min(nearest, bot.entity.position.distanceTo(s.offset(0.5, 0.5, 0.5))) }
      bot.on('physicsTick', watch)
      let reached = true
      try {
        await navigate(bot, { goal: new goals.GoalBlock(home.x + 34, GROUND, 0) })
      } catch (err) {
        reached = false
        results.push(`no way: ${(err as Error).message}`)
      } finally {
        bot.off('physicsTick', watch)
      }
      const level = await warningLevel()
      const ok = reached && level === 0 && nearest > 8
      if (!ok) failed++
      t.diagnostic(`run ${i + 1}: ${ok ? 'kept off' : 'SET OFF'}, nearest a sensor ${nearest.toFixed(1)}, warning level ${level}, ${reached ? 'there' : 'NOT THERE'}`)
    }
    t.diagnostic(`past sculk: ${RUNS - failed}/${RUNS} kept off`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })
})
