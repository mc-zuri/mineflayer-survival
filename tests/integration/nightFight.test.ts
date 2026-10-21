// A creeper and a zombie at night against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness
// lockstep server, a superflat world, normal difficulty, no natural spawning, the reflexes on), the bot as a 1.21.11
// game's was when a creeper blew it up (f9-1.21.11, t305885): in full iron with a shield in its off hand, a bow in hand
// with 11 arrows, a diamond sword carried, at 10.5 health with its food bar at 16 and nothing to eat, its work
// exploring for a chicken (a walk east standing in for it, toward the creeper, preempted by the reflexes):
// - 'f9': a zombie 3 off to the west, a creeper 9 off to the east;
// - 'f9skeleton': and a skeleton 12 off to the south.
// Each run is a pass when the bot is alive RUN_TICKS on. NIGHTFIGHT_RUNS=n repeats each (default 2); NIGHTFIGHT_CASES
// picks some (f9,f9skeleton).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { isAlive } from '../../src/skills/combatUtil'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary } from './nightLog'

const USER = 'nightfighter'
const RUNS = Number(process.env.NIGHTFIGHT_RUNS ?? 2)
const CASES = (process.env.NIGHTFIGHT_CASES ?? 'f9,f9skeleton').split(',')
const RUN_TICKS = 800
// the superflat's grass
const GRASS = -61

interface Case {
  name: string
  /** the mobs, off the bot's spot */
  mobs: Array<{ type: string, at: Vec3 }>
}

const CASES_ALL: Case[] = [
  { name: 'f9', mobs: [{ type: 'zombie', at: new Vec3(-3, 0, 0) }, { type: 'creeper', at: new Vec3(9, 0, 0) }] },
  { name: 'f9skeleton', mobs: [{ type: 'zombie', at: new Vec3(-3, 0, 0) }, { type: 'creeper', at: new Vec3(9, 0, 0) }, { type: 'skeleton', at: new Vec3(0, 0, 12) }] }
]

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

/** a fresh spot on the superflat, the bot there as the game's was, at night */
async function fresh (): Promise<Vec3> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  const ox = 96 * runs++
  for (const cmd of ['time set 18000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 32} -32 ${ox + 32} 32`,
    `fill ${ox - 32} ${GRASS + 1} -32 ${ox + 32} ${GRASS + 12} 32 minecraft:air`]) await run(cmd)
  const at = new Vec3(ox + 0.5, GRASS + 1, 0.5)
  await run(`tp ${USER} ${at.x} ${at.y} ${at.z} -90 0`)
  await waitFor(() => bot.entity.position.distanceTo(at) < 0.5 && bot.inventory.items().length === 0, 200)
  await bot.waitForChunksToLoad()
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await waitFor(() => bot.health >= 20, 100)
  // the food bar to 16, its saturation gone (no healing: FoodData.tick's from 18), and the health to 10.5
  await run(`effect give ${USER} minecraft:hunger 30 250 true`)
  await waitFor(() => (bot.food ?? 20) <= 16, 600)
  await run(`effect clear ${USER} minecraft:hunger`)
  await run(`damage ${USER} 9.5 minecraft:generic`)
  await waitFor(() => bot.health <= 11, 100)
  for (const [slot, item] of Object.entries({ 'armor.head': 'iron_helmet', 'armor.chest': 'iron_chestplate', 'armor.legs': 'iron_leggings', 'armor.feet': 'iron_boots', 'weapon.offhand': 'shield', 'weapon.mainhand': 'bow' })) {
    await run(`item replace entity ${USER} ${slot} with ${item}`)
  }
  for (const [item, count] of [['arrow', 11], ['diamond_sword', 1], ['cobblestone', 45], ['dirt', 47], ['torch', 16], ['iron_pickaxe', 1], ['stone_shovel', 1]] as Array<[string, number]>) await run(`give ${USER} ${item} ${count}`)
  await waitFor(() => bot.inventory.items().some(i => i.name === 'stone_shovel'), 200)
  await bot.waitForTicks(10)
  return at
}

describe(`a creeper and a zombie at night, hurt, on ${DEFAULT_VERSION} (f9-1.21.11, t305885)`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'nightfight',
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
    test(`${c.name}: survived (${RUNS} runs)`, async () => {
      const results: string[] = []
      let failed = 0
      for (let i = 0; i < RUNS; i++) {
        const at = await fresh()
        const log = new NightLog(bot)
        // the work going on: a walk east, toward the creeper, as the exploring for a chicken went (preempted by the reflexes)
        const work = bot.survival.tasks.run({ name: 'step: kill 3 chicken for 3 feather', priority: 0 }, async (ctx) => {
          try {
            for (;;) {
              await bot.look(-Math.PI / 2, 0, true)
              bot.setControlState('forward', true)
              await ctx.waitTicks(1)
            }
          } finally {
            bot.clearControlStates()
          }
        }).catch(() => {})
        for (const m of c.mobs) await run(`summon minecraft:${m.type} ${at.x + m.at.x} ${at.y + m.at.y} ${at.z + m.at.z} {PersistenceRequired:1b}`)
        bot.survival.reflexes!.enabled = true
        let dead = false
        const onDeath = (): void => { dead = true }
        bot.once('death', onDeath)
        await waitFor(() => dead || bot.health <= 0, RUN_TICKS)
        bot.off('death', onDeath)
        bot.survival.reflexes!.enabled = false
        bot.survival.tasks.cancelAll('ABORTED', 'the run is over')
        await work
        const r = log.finish()
        const alive = !dead && r.deaths.length === 0 && bot.health > 0
        if (!alive) failed++
        const creeper = Object.values(bot.entities).some(e => e.name === 'creeper' && isAlive(bot, e))
        results.push(`run ${i + 1}: ${alive ? 'alive' : 'dead'}, health ${bot.health.toFixed(1)}, the creeper ${creeper ? 'about' : 'gone'}, ${summary(r)}`)
      }
      for (const l of results) console.log(`[nightfight] ${c.name}: ${l}`)
      assert.strictEqual(failed, 0, results.join('\n'))
    })
  }
})
