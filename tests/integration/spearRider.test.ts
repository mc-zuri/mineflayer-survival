// A zombie on a zombie horse with a spear, against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness
// lockstep server, a superflat world, normal difficulty, no natural spawning, the reflexes on, at night), the bot busy
// with a task (a wait standing in for the work), in the kit of a 26.3 bot speared from 12.4 to 2.1 in one charge
// (f7-26.3: a diamond sword, an iron chestplate and leggings): the rider summoned 14 off on open ground.
// - 'shield': the kit and a shield: the shield up to the charge, the swings as it passes;
// - 'bare': no shield, 64 cobblestone: a block on its line, or a step aside.
// A run is a pass when the bot is alive 600 ticks on. SPEAR_RUNS=n repeats each (default 2); SPEAR_CASES picks some.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary } from './nightLog'

const USER = 'spearbot'
const RUNS = Number(process.env.SPEAR_RUNS ?? 2)
const CASES = (process.env.SPEAR_CASES ?? 'shield,bare').split(',')
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

describe(`a mounted spear zombie on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'spears',
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
    test(`${c}: the rider survived (${RUNS} runs)`, async () => {
      const results: string[] = []
      let failed = 0
      for (let i = 0; i < RUNS; i++) {
        if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
        bot.survival.tasks.cancelAll('ABORTED', 'reset')
        if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
        const ox = 96 * runs++
        for (const cmd of ['time set 18000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 32} -32 ${ox + 32} 32`,
          `fill ${ox - 32} ${GRASS + 1} -32 ${ox + 32} ${GRASS + 8} 32 minecraft:air`]) await run(cmd)
        const at = new Vec3(ox + 0.5, GRASS + 1, 0.5)
        await run(`tp ${USER} ${at.x} ${at.y} ${at.z} 0 0`)
        await waitFor(() => bot.entity.position.distanceTo(at) < 1, 200)
        const kit: Record<string, string> = { 'armor.chest': 'iron_chestplate', 'armor.legs': 'iron_leggings', 'weapon.mainhand': 'diamond_sword' }
        if (c === 'shield') kit['weapon.offhand'] = 'shield'
        for (const [slot, it] of Object.entries(kit)) await run(`item replace entity ${USER} ${slot} with ${it}`)
        await run(`give ${USER} cooked_beef 8`)
        if (c === 'bare') await run(`give ${USER} cobblestone 64`)
        await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
        await waitFor(() => bot.health >= 20, 40)
        await bot.waitForTicks(10)
        const log = new NightLog(bot)
        const work = bot.survival.tasks.run({ name: 'step: the work', priority: 0 }, async (ctx) => { for (;;) await ctx.waitTicks(20) }).catch(() => {})
        await run(`summon minecraft:zombie_horse ${at.x + 14} ${at.y} ${at.z} {PersistenceRequired:1b,Passengers:[{id:"minecraft:zombie",PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:iron_spear",count:1}}}]}`)
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
        const zombies = Object.values(bot.entities).filter(e => e.name === 'zombie').length
        results.push(`run ${i + 1}: ${alive ? 'alive' : 'dead'}, health ${bot.health.toFixed(1)}, ${zombies} zombies left, ${summary(r)}`)
      }
      for (const l of results) console.log(`[spear] ${c}: ${l}`)
      assert.strictEqual(failed, 0, results.join('\n'))
    })
  }
})
