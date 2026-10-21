// A drowned with a trident in a pond by the bot, against a real server (SURVIVAL_VERSION, default 1.21.11; the
// tests/harness lockstep server, a superflat world, normal difficulty, no natural spawning, the reflexes on, by day),
// the bot busy with a task (a wait standing in for the work), in the kit of a 1.21.11 bot that fought a drowned off the
// shore into the sea and was impaled there (ls3b-1.21.11, t401692: a diamond sword, a shield, iron but golden boots).
// The pond is 9 by 9 and 3 deep (water y -63 to -61), its shore the superflat's grass.
// - 'shore': the bot 3 blocks off the pond's west edge, the drowned in its middle: never into the water after it, out
//   of its reach or sight;
// - 'swim': the bot in the pond's west half: out of the water first.
// Each run is a pass when the bot is alive 400 ticks on and spent no tick with its head under the water after the
// first 40 (the swim's way out). DROWNED_RUNS=n repeats each (default 2); DROWNED_CASES picks some (shore,swim);
// DROWNED_HEALTH sets the bot's health at the start (default 20; the death's was 6.3).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { headInWater } from '../../src/skills/escape'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary } from './nightLog'

const USER = 'pondbot'
const RUNS = Number(process.env.DROWNED_RUNS ?? 2)
const CASES = (process.env.DROWNED_CASES ?? 'shore,swim').split(',')
const HEALTH = Number(process.env.DROWNED_HEALTH ?? 20)
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

interface Case { name: string, bot: Vec3 }
// (in the pond's coordinates: its west edge at x 0, its middle at (4.5, 4.5))
const CASES_ALL: Case[] = [
  { name: 'shore', bot: new Vec3(-2.5, GRASS + 1, 4.5) },
  { name: 'swim', bot: new Vec3(1.5, GRASS, 4.5) }
]

async function fresh (c: Case): Promise<Vec3> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  const ox = 64 * runs++
  const oz = 0
  for (const cmd of ['time set 6000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 16} -16 ${ox + 32} 32`,
    `fill ${ox - 12} ${GRASS + 1} ${oz - 12} ${ox + 20} ${GRASS + 10} ${oz + 20} minecraft:air`,
    `fill ${ox - 12} ${GRASS} ${oz - 12} ${ox + 20} ${GRASS} ${oz + 20} minecraft:grass_block`,
    `fill ${ox} ${GRASS - 2} ${oz} ${ox + 8} ${GRASS} ${oz + 8} minecraft:water`]) await run(cmd)
  const at = c.bot.offset(ox, 0, oz)
  await run(`tp ${USER} ${at.x} ${at.y} ${at.z} -90 0`)
  await waitFor(() => bot.entity.position.distanceTo(at) < 1 && bot.inventory.items().length === 0, 200)
  await bot.waitForChunksToLoad()
  for (const [slot, item] of Object.entries({ 'armor.head': 'iron_helmet', 'armor.chest': 'iron_chestplate', 'armor.legs': 'iron_leggings', 'armor.feet': 'golden_boots', 'weapon.offhand': 'shield', 'weapon.mainhand': 'diamond_sword' })) {
    await run(`item replace entity ${USER} ${slot} with ${item}`)
  }
  await run(`give ${USER} cooked_beef 8`)
  await run(`give ${USER} cobblestone 64`)
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await run(`effect give ${USER} minecraft:saturation 1 20 true`)
  await waitFor(() => bot.inventory.items().some(i => i.name === 'cooked_beef'), 200)
  if (HEALTH < 20) await run(`damage ${USER} ${20 - HEALTH} minecraft:generic`)
  await bot.waitForTicks(10)
  return new Vec3(ox + 4.5, GRASS - 1, oz + 4.5)
}

describe(`a trident drowned in a pond by the bot on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'pond',
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

  for (const c of CASES_ALL.filter(c => CASES.includes(c.name))) {
    test(`${c.name}: the drowned survived, out of the water (${RUNS} runs)`, async () => {
      const results: string[] = []
      let failed = 0
      for (let i = 0; i < RUNS; i++) {
        const middle = await fresh(c)
        const log = new NightLog(bot)
        const work = bot.survival.tasks.run({ name: 'step: the work', priority: 0 }, async (ctx) => { for (;;) await ctx.waitTicks(20) }).catch(() => {})
        await run(`summon minecraft:drowned ${middle.x} ${middle.y} ${middle.z} {PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:trident",count:1}}}`)
        bot.survival.reflexes!.enabled = true
        let dead = false
        let under = 0
        let wet = 0
        let t = 0
        const onDeath = (): void => { dead = true }
        const onTick = (): void => {
          t++
          if (t > 40 && headInWater(bot)) under++
          if (bot.blockAt(bot.entity.position.floored())?.name === 'water') wet++
        }
        bot.once('death', onDeath)
        bot.on('physicsTick', onTick)
        await waitFor(() => dead || bot.health <= 0, 400)
        bot.off('death', onDeath)
        bot.off('physicsTick', onTick)
        bot.survival.reflexes!.enabled = false
        bot.survival.tasks.cancelAll('ABORTED', 'the run is over')
        await work
        const r = log.finish()
        const alive = !dead && r.deaths.length === 0 && bot.health > 0
        const ok = alive && under === 0
        if (!ok) failed++
        results.push(`run ${i + 1}: ${alive ? 'alive' : 'dead'}, health ${bot.health.toFixed(1)}, ${wet} ticks in the water, ${under} with the head under after 40, ${summary(r)}`)
      }
      for (const l of results) console.log(`[drowned] ${c.name}: ${l}`)
      assert.strictEqual(failed, 0, results.join('\n'))
    })
  }
})
