// The soul sand valley a 26.3 nether stage (nether-26.3-q3, seed 2) lost its 16 pearls and 10 rods in, against a real
// SURVIVAL_VERSION (default 1.21.11) server, seed 2, normal difficulty, no natural spawning, the reflexes on: the bot
// with that run's bag walks its nether trail's leg along the valley's shore of the lava sea, (-267, 35, -90) to
// (-260, 35, -110), VALLEY_SKELETONS skeletons (default 3) summoned on the slope under it about where the run's was
// (-266, 36, -93); it chased one 20 blocks across and 13 down into the lava sea and burned. VALLEY_RUNS runs (default
// 3), each must end alive and never in the lava.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { navigate } from '../../src/skills/navigate'
import { countItems } from '../../src/skills/util'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { NightLog, summary, type RunLog } from './nightLog'

const USER = 'valleybot'
const RUNS = Number(process.env.VALLEY_RUNS ?? 3)
const SKELETONS = Number(process.env.VALLEY_SKELETONS ?? 3)
// the trail's leg along the valley's shore of the lava sea
const A = new Vec3(-267, 35, -90)
const B = new Vec3(-260, 35, -110)
/** where the run's skeleton stood by the shore, and two of the trail's points up the slope over it */
const SKELETON_AT = [new Vec3(-266, 36, -93), new Vec3(-264, 47, -99), new Vec3(-266, 45, -84)]
/** nether-26.3-q3's bag on the way back to its portal */
const KIT: Array<[string, number]> = [
  ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['shield', 1], ['diamond_sword', 1], ['bow', 1],
  ['arrow', 87], ['cooked_beef', 33], ['bread', 16], ['netherrack', 64], ['cobblestone', 55], ['ender_pearl', 16], ['blaze_rod', 10], ['water_bucket', 1]
]
const WORN: Record<string, string> = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }

let server: TestServer
let bot: Bot

async function run (cmd: string): Promise<string[]> { return await server.command(cmd) }
const nether = async (cmd: string): Promise<string[]> => await run(`execute in minecraft:the_nether run ${cmd}`)
async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

function walkBetween (a: Vec3, b: Vec3): { stop: () => void } {
  let stopped = false
  const handle = bot.survival.tasks.enqueue({ name: 'walk', onPreempt: 'resume' }, async (ctx) => {
    let i = (ctx.state as any).leg ?? 0
    while (!stopped) {
      const to = i % 2 === 0 ? b : a
      try {
        await navigate(bot, { goal: new goals.GoalNear(to.x, to.y, to.z, 1) }, ctx.signal)
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
  return { stop: () => { stopped = true; handle.cancel('run over') } }
}

describe(`the soul sand valley of nether-26.3-q3 (seed 2) on ${DEFAULT_VERSION}`, { timeout: 120 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      seed: '2',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false },
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

  test(`walking the trail over the valley with ${SKELETONS} skeletons on its slope: alive, never in the lava (${RUNS} runs)`, async (t) => {
    const logs: RunLog[] = []
    for (let i = 0; i < RUNS; i++) {
      bot.survival.reflexes!.enabled = false
      bot.survival.tasks.cancelAll('ABORTED', 'reset')
      if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
      bot.clearControlStates()
      bot.deactivateItem()
      for (const cmd of ['kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`]) await run(cmd)
      await nether(`forceload add ${A.x - 32} ${A.z - 32} ${A.x + 32} ${A.z + 32}`)
      await nether(`tp ${USER} ${A.x + 0.5} ${A.y} ${A.z + 0.5}`)
      await waitFor(() => /nether/.test(String(bot.game?.dimension ?? '')) && bot.entity.position.distanceTo(A.offset(0.5, 0, 0.5)) < 3, 400)
      await bot.waitForChunksToLoad()
      await waitFor(() => bot.inventory.items().length === 0, 100)
      // (the fires of the last run's arrows, out)
      await nether(`fill ${A.x - 20} ${A.y - 20} ${A.z - 10} ${A.x + 20} ${A.y + 10} ${A.z + 30} minecraft:air replace minecraft:fire`)
      for (const [item, n] of KIT) {
        const kind = /_(helmet|chestplate|leggings|boots)$/.exec(item)?.[1]
        const slot = kind != null ? WORN[kind] : item === 'shield' ? 'weapon.offhand' : null
        await run(slot != null ? `item replace entity ${USER} ${slot} with ${item} ${n}` : `give ${USER} ${item} ${n}`)
      }
      await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
      await run(`effect give ${USER} minecraft:saturation 1 20 true`)
      await waitFor(() => countItems(bot, 'water_bucket') > 0, 200)
      for (const p of SKELETON_AT.slice(0, SKELETONS)) await nether(`summon minecraft:skeleton ${p.x + 0.5} ${p.y} ${p.z + 0.5} {PersistenceRequired:1b}`)
      await waitFor(() => Object.values(bot.entities).filter(e => e.name === 'skeleton').length >= SKELETONS, 100)
      await bot.waitForTicks(40)
      t.diagnostic(`run ${i + 1}: the bot at ${bot.entity.position.floored().toString()}, skeletons at ${Object.values(bot.entities).filter(e => e.name === 'skeleton').map(e => e.position.floored().toString()).join(' ')}`)
      const log = new NightLog(bot)
      let inLava = false
      let died = false
      const onTick = (): void => { if ((bot.entity as any).isInLava === true) inLava = true }
      const onDeath = (): void => { died = true }
      bot.on('physicsTick', onTick)
      bot.on('death', onDeath)
      bot.survival.reflexes!.enabled = true
      const task = walkBetween(A, B)
      try {
        await waitFor(() => died, 2400)
      } finally {
        task.stop()
        bot.survival.reflexes!.enabled = false
        bot.off('physicsTick', onTick)
        bot.off('death', onDeath)
      }
      const l = log.finish()
      if (inLava) l.deaths.push('in the lava')
      t.diagnostic(`run ${i + 1}: ${inLava ? 'IN THE LAVA, ' : ''}${countItems(bot, 'ender_pearl')} pearls, ${summary(l)}`)
      logs.push(l)
    }
    const failed = logs.filter(l => l.deaths.length > 0).length
    console.log(`[valley] ${RUNS - failed}/${RUNS} alive and out of the lava`)
    assert.strictEqual(failed, 0, logs.map(summary).join('\n'))
  })
})
