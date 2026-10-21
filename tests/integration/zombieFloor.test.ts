// Zombies about the bot on a cave's open floor, against a real server (SURVIVAL_VERSION, default 1.21.11; the
// tests/harness lockstep server, a superflat world, normal difficulty, no natural spawning, the reflexes on), the bot
// busy with a task (a wait standing in for the work), in the kit of a 26.3 bot slain so at y -58 (ls4-26.3, t386611:
// an iron chestplate, an iron sword, cobblestone): a room of cave_air 15 by 15 and 6 high in a block of stone, the bot
// in its middle at ZOMBIE_HEALTH health (default 9), four zombies 3 off round it. A run is a pass when the bot is alive
// 600 ticks on. ZOMBIE_RUNS=n repeats it (default 2); ZOMBIE_ARCHER=bogged (or skeleton) adds one 6 off
// (f4-26.3, t92144: pillared in a cave, shot on its top by two bogged and a skeleton).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary } from './nightLog'

const USER = 'floorbot'
const RUNS = Number(process.env.ZOMBIE_RUNS ?? 2)
const HEALTH = Number(process.env.ZOMBIE_HEALTH ?? 9)
const ARCHER = process.env.ZOMBIE_ARCHER
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

async function fresh (): Promise<Vec3> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  const ox = 64 * runs++
  const oz = 0
  // the block of stone (its floor the superflat's grass level), the room of cave_air in it
  for (const cmd of ['time set 18000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 16} -16 ${ox + 32} 32`,
    `fill ${ox - 2} ${GRASS} ${oz - 2} ${ox + 16} ${GRASS + 10} ${oz + 16} minecraft:stone`,
    `fill ${ox} ${GRASS + 1} ${oz} ${ox + 14} ${GRASS + 6} ${oz + 14} minecraft:cave_air`]) await run(cmd)
  const at = new Vec3(ox + 7.5, GRASS + 1, oz + 7.5)
  await run(`tp ${USER} ${at.x} ${at.y} ${at.z} 0 0`)
  await waitFor(() => bot.entity.position.distanceTo(at) < 1 && bot.inventory.items().length === 0, 200)
  await bot.waitForChunksToLoad()
  await run(`item replace entity ${USER} armor.chest with iron_chestplate`)
  await run(`item replace entity ${USER} weapon.mainhand with iron_sword`)
  await run(`give ${USER} cobblestone 64`)
  await run(`give ${USER} cooked_beef 8`)
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await waitFor(() => bot.inventory.items().some(i => i.name === 'cooked_beef'), 200)
  // (the instant health's heal in first: a damage before it left a run at 12)
  await waitFor(() => bot.health >= 20, 40)
  // (the void's damage: no armor takes from it)
  if (HEALTH < 20) await run(`damage ${USER} ${20 - HEALTH} minecraft:out_of_world`)
  await waitFor(() => bot.health <= HEALTH + 0.5, 40)
  await bot.waitForTicks(10)
  return at
}

describe(`zombies about the bot on a cave's open floor on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'floor',
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

  test(`four zombies${ARCHER != null ? ` and a ${ARCHER}` : ''} survived (${RUNS} runs)`, async () => {
    const results: string[] = []
    let failed = 0
    for (let i = 0; i < RUNS; i++) {
      const at = await fresh()
      const log = new NightLog(bot)
      const work = bot.survival.tasks.run({ name: 'step: the work', priority: 0 }, async (ctx) => { for (;;) await ctx.waitTicks(20) }).catch(() => {})
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) await run(`summon minecraft:zombie ${at.x + dx} ${at.y} ${at.z + dz} {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}`)
      if (ARCHER != null) await run(`summon minecraft:${ARCHER} ${at.x + 5} ${at.y} ${at.z + 4} {PersistenceRequired:1b}`)
      bot.survival.reflexes!.enabled = true
      let dead = false
      let top = at.y
      const onDeath = (): void => { dead = true }
      const onTick = (): void => { top = Math.max(top, bot.entity.position.y) }
      bot.once('death', onDeath)
      bot.on('physicsTick', onTick)
      await waitFor(() => dead || bot.health <= 0, 600)
      bot.off('death', onDeath)
      bot.off('physicsTick', onTick)
      bot.survival.reflexes!.enabled = false
      bot.survival.tasks.cancelAll('ABORTED', 'the run is over')
      await work
      const r = log.finish()
      const alive = !dead && r.deaths.length === 0 && bot.health > 0
      const zombies = Object.values(bot.entities).filter(e => e.name === 'zombie').length
      if (!alive) failed++
      results.push(`run ${i + 1}: ${alive ? 'alive' : 'dead'}, health ${bot.health.toFixed(1)}, ${zombies} zombies left, highest ${(top - at.y).toFixed(1)} up, ${summary(r)}`)
    }
    for (const l of results) console.log(`[zombies] ${l}`)
    assert.strictEqual(failed, 0, results.join('\n'))
  })
})
