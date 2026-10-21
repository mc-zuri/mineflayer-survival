// Polar bears angry at the bot, against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness lockstep
// server, a superflat world, normal difficulty, no natural spawning, the reflexes on, by day), the bot busy with a task
// (a wait standing in for the work), in the kit of a 1.21.11 bot a polar bear's family killed while it explored for
// cane (f6-1.21.11, t179279: iron, a diamond sword, a shield): two adults with a cub 3 off (an adult goes for a player
// by its cub, PolarBear's PolarBearAttackPlayersGoal). A run is a pass when the bot is alive 600 ticks on.
// BEAR_RUNS=n repeats it (default 2); BEAR_HEALTH sets the bot's health at the start (default 20).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary } from './nightLog'

const USER = 'bearbot'
const RUNS = Number(process.env.BEAR_RUNS ?? 2)
const HEALTH = Number(process.env.BEAR_HEALTH ?? 20)
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

describe(`angry polar bears on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'bears',
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

  test(`two bears by their cub (${RUNS} runs)`, async () => {
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
      bot.survival.tasks.cancelAll('ABORTED', 'reset')
      if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
      const ox = 96 * runs++
      for (const cmd of ['time set 6000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 32} -32 ${ox + 32} 32`,
        `fill ${ox - 32} ${GRASS + 1} -32 ${ox + 32} ${GRASS + 8} 32 minecraft:air`]) await run(cmd)
      const at = new Vec3(ox + 0.5, GRASS + 1, 0.5)
      await run(`tp ${USER} ${at.x} ${at.y} ${at.z} 0 0`)
      await waitFor(() => bot.entity.position.distanceTo(at) < 1, 200)
      for (const [slot, it] of Object.entries({ 'armor.head': 'iron_helmet', 'armor.chest': 'iron_chestplate', 'armor.legs': 'iron_leggings', 'armor.feet': 'iron_boots', 'weapon.offhand': 'shield', 'weapon.mainhand': 'diamond_sword' })) {
        await run(`item replace entity ${USER} ${slot} with ${it}`)
      }
      await run(`give ${USER} cooked_beef 8`)
      await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
      await waitFor(() => bot.health >= 20, 40)
      if (HEALTH < 20) await run(`damage ${USER} ${20 - HEALTH} minecraft:out_of_world`)
      await bot.waitForTicks(10)
      const log = new NightLog(bot)
      const work = bot.survival.tasks.run({ name: 'step: the work', priority: 0 }, async (ctx) => { for (;;) await ctx.waitTicks(20) }).catch(() => {})
      await run(`summon minecraft:polar_bear ${at.x + 3} ${at.y} ${at.z} {Age:-24000,PersistenceRequired:1b}`)
      await run(`summon minecraft:polar_bear ${at.x + 4} ${at.y} ${at.z + 1} {PersistenceRequired:1b}`)
      await run(`summon minecraft:polar_bear ${at.x + 4} ${at.y} ${at.z - 1} {PersistenceRequired:1b}`)
      bot.survival.reflexes!.enabled = true
      let dead = false
      const onDeath = (): void => { dead = true }
      bot.once('death', onDeath)
      await waitFor(() => dead || bot.health <= 0, 600)
      bot.off('death', onDeath)
      bot.survival.reflexes!.enabled = false
      bot.survival.tasks.cancelAll('ABORTED', 'the run is over')
      await work
      const r = log.finish()
      const alive = !dead && r.deaths.length === 0 && bot.health > 0
      if (!alive) failed++
      results.push(`run ${i + 1}: ${alive ? 'alive' : 'dead'}, health ${bot.health.toFixed(1)}, ${bot.entity.position.distanceTo(at).toFixed(1)} off, ${summary(r)}`)
    }
    for (const l of results) console.log(`[bears] ${l}`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })
})
