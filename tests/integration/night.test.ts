// Nights in the open on a 1.21.11 normal-seed world (the tests/harness lockstep server, normal difficulty, real mob
// spawning, the reflexes on): from dusk (13000) to dawn (23500) with a kit, the bot doing a simple foreground task.
// NIGHT_RUNS=n repeats each night (default 1); NIGHT_VERBOSE=1 logs each hit, kill and reflex; NIGHT_SEED picks the world (default
// 'survival': the spawn on open grass; '1234567890' spawns on a jungle's canopy).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { isEnclosed, shelterToLeave } from '../../src/skills/shelter'
import { outInTheNight } from '../../src/reflexes/rules'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'

const USER = 'nightbot'
const RUNS = Number(process.env.NIGHT_RUNS ?? 1)
const DUSK = 13000
const DAWN = 23500

let server: TestServer
let bot: Bot
let spawn: Vec3

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

/** the bot back at spawn with full health and food, an empty inventory, no mobs about, at noon */
async function reset (): Promise<void> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  bot.clearControlStates()
  bot.deactivateItem()
  for (const cmd of ['time set noon', 'weather clear', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`,
    `tp ${USER} ${spawn.x} ${spawn.y} ${spawn.z}`, `effect give ${USER} minecraft:instant_health 1 10 true`,
    `effect give ${USER} minecraft:saturation 1 20 true`]) {
    await run(cmd)
  }
  await waitFor(() => bot.entity.position.distanceTo(spawn) < 1 && bot.inventory.items().length === 0, 100)
  await bot.waitForTicks(20)
}

async function give (item: string, count = 1): Promise<void> {
  await run(`give ${USER} ${item} ${count}`)
}

/** walks back and forth between two points near spawn as the foreground task (reflexes preempt it and it resumes) */
function walkBetween (a: Vec3, b: Vec3): { stop: () => void } {
  let stopped = false
  const handle = bot.survival.tasks.enqueue({ name: 'walk', onPreempt: 'resume' }, async (ctx) => {
    let i = (ctx.state as any).leg ?? 0
    while (!stopped) {
      const to = i % 2 === 0 ? b : a
      try {
        await navigate(bot, { goal: new goals.GoalNearXZ(to.x, to.z, 1) }, ctx.signal)
      } catch (err) {
        if (ctx.signal.aborted) throw err
        await ctx.waitTicks(20)
      }
      i++
      ;(ctx.state as any).leg = i
      await ctx.waitTicks(20)
    }
  })
  handle.result.catch(() => {})
  return { stop: () => { stopped = true; handle.cancel('night over') } }
}

/** past dawn: the morning's time of day reached (a time set to 13000 runs on to 23999 and around to 0) */
function morning (time: number): () => boolean {
  let wrapped = false
  return () => {
    const t = bot.time.timeOfDay
    if (t < DUSK) wrapped = true
    return time >= DUSK ? t >= time || wrapped : wrapped && t >= time
  }
}

/** from dusk to dawn (or the bot's death) with the reflexes on; the log of the night */
// NIGHT_START=k starts at the k-th patch of ground (to replay one night's spot)
let nights = Number(process.env.NIGHT_START ?? 0)

/**
 * Where the night's run starts: a fresh patch of ground each night, 48 blocks along from the last (spreadplayers puts
 * the bot on the top block), so no night finds the holes and pillars of the one before.
 */
async function goHome (): Promise<Vec3> {
  const x = spawn.x + 48 * nights++
  await run(`spreadplayers ${x} ${spawn.z} 0 8 false ${USER}`)
  await waitFor(() => Math.abs(bot.entity.position.x - x) <= 9, 100)
  await bot.waitForChunksToLoad()
  await waitFor(() => bot.entity.onGround, 100)
  return bot.entity.position.clone()
}

async function night (setup: () => Promise<void>, foreground: (home: Vec3) => { stop: () => void } = () => ({ stop: () => {} }), until: () => boolean = morning(DAWN)): Promise<RunLog> {
  await reset()
  const home = await goHome()
  await setup()
  await bot.waitForTicks(40)
  await run(`time set ${DUSK}`)
  await waitFor(() => bot.time.timeOfDay >= DUSK && bot.time.timeOfDay < DUSK + 100, 100)
  const log = new NightLog(bot)
  const feet = bot.blockAt(bot.entity.position.floored()) as any
  log.note(`dusk at ${bot.entity.position.toString()} in ${String(feet?.name)}, sky light ${String(feet?.skyLight)}, on ${String(bot.blockAt(bot.entity.position.offset(0, -0.5, 0).floored())?.name)}`)
  bot.survival.reflexes!.enabled = true
  const task = foreground(home)
  let died = false
  const onDeath = (): void => { died = true }
  bot.on('death', onDeath)
  try {
    await waitFor(() => died || until(), 14000)
  } finally {
    bot.off('death', onDeath)
    task.stop()
    bot.survival.reflexes!.enabled = false
  }
  // the death message comes after the death
  if (died) await bot.waitForTicks(5)
  return log.finish()
}

describe('nights in the open on 1.21.11 (normal difficulty, real spawning)', { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      seed: process.env.NIGHT_SEED ?? 'survival',
      difficulty: 'normal',
      gamerules: { advance_weather: false, respawn_radius: 0 },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    // NIGHT_NO_SHELTER=1: the night reflex off (the bot out in the open whatever its kit, as before it had one)
    bot.loadPlugin(createPlugin(process.env.NIGHT_NO_SHELTER != null ? { reflexes: { config: { night: { enabled: false } } } } : {}))
    bot.survival.reflexes!.enabled = false
    spawn = bot.entity.position.floored().offset(0.5, 0, 0.5)
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test(`early kit (a stone sword, no armor): sheltered in the ground, alive and out by day (${RUNS} night${RUNS > 1 ? 's' : ''})`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      let out = false
      const day = morning(1500)
      const log = await night(async () => {
        await give('stone_sword')
        await give('cooked_beef', 16)
        await give('torch', 2)
      }, (home) => walkBetween(home, home.offset(12, 0, 0)), () => {
        // the morning, and the bot out of its hole (not down a shelter's column, and the sky over its head)
        out = day() && shelterToLeave(bot) == null && outInTheNight(bot) && !isEnclosed((p) => bot.blockAt(p) as any, bot.entity.position)
        return out
      })
      t.diagnostic(`night ${i + 1}: ${out ? 'out by day, ' : 'NOT OUT, '}${summary(log)}`)
      if (!out) log.deaths.push('still in the shelter')
      logs.push(log)
    }
    const failed = logs.filter(l => l.deaths.length > 0).length
    t.diagnostic(`early kit: ${RUNS - failed}/${RUNS} nights survived`)
    assert.strictEqual(failed, 0, logs.map(summary).join('\n'))
  })

  test(`a bed in the bag (a stone sword, no armor): placed at dusk and slept in, the bed taken back (${RUNS} night${RUNS > 1 ? 's' : ''})`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      let slept = false
      const onSleep = (): void => { slept = true }
      bot.on('sleep', onSleep)
      const log = await night(async () => {
        await give('stone_sword')
        await give('cooked_beef', 16)
        await give('white_bed')
      }, (home) => walkBetween(home, home.offset(12, 0, 0)), morning(1000))
      bot.off('sleep', onSleep)
      const bed = await waitFor(() => bot.inventory.items().some(i => i.name === 'white_bed'), 400)
      t.diagnostic(`night ${i + 1}: ${slept ? 'slept' : 'NEVER SLEPT'}, ${bed ? 'bed back' : 'BED LEFT'}, ${summary(log)}`)
      if (!slept) log.deaths.push('never slept')
      logs.push(log)
    }
    const failed = logs.filter(l => l.deaths.length > 0).length
    t.diagnostic(`bed: ${RUNS - failed}/${RUNS} nights slept through`)
    assert.strictEqual(failed, 0, logs.map(summary).join('\n'))
  })

  test(`iron kit: alive at dawn (${RUNS} night${RUNS > 1 ? 's' : ''})`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      const log = await night(async () => {
        for (const item of ['iron_sword', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await give(item)
        await give('cooked_beef', 32)
      }, (home) => walkBetween(home, home.offset(12, 0, 0)))
      t.diagnostic(`night ${i + 1}: ${summary(log)}`)
      logs.push(log)
    }
    const deaths = logs.filter(l => l.deaths.length > 0).length
    t.diagnostic(`iron kit: ${RUNS - deaths}/${RUNS} nights survived`)
    assert.strictEqual(deaths, 0, logs.map(summary).join('\n'))
  })
})
