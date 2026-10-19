// A staircase down through the night against a real server (SURVIVAL_VERSION), the reflexes on: a long staircase
// down a stone mound (descendTo, as a milestone runs it: Executor.task) started at dusk with a bed in the bag. Below
// the surface the night is work: no shelter and no bed till it's at the bottom. With the rest due (the phantoms'
// Stats.TIME_SINCE_REST) the bed's room is dug beside the staircase, the bed put down, slept in and taken back, and the
// staircase goes on. A 26.3 whole game's staircase to the deep lava (run full-26.3-f) lost some 40000 ticks to nights:
// no room for the bed in the 1-wide staircase, so the night reflex dug a shelter and waited the night out there, or
// tried the bed again every 200 ticks, each try cutting off a 300-tick dig by hand.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { Executor } from '../../src/executor/executor'
import { descendTo } from '../../src/executor/explore'
import * as shelterSkills from '../../src/skills/shelter'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'stairbot'
// the superflat's grass is at y = -61
const GROUND = -61
// the mound: 48 high over the grass, the bot on its top
const HEIGHT = 48
// where the staircase ends: 2 over the mound's floor
const BOTTOM = GROUND + 3
// the schedule's dusk (planner/schedule's DUSK_START): the night (12542) falls some 25 steps down
const DUSK = 11500

describe(`a staircase down through the night on a ${DEFAULT_VERSION} server`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'stairs',
      // (peaceful: a bed works, and no monster keeps the bot from it)
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, spawn_phantoms: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** a stone mound HEIGHT high, 60 along +x from `dz` across, the bot on top facing +x at dusk with a bed and torches */
  async function mound (dz: number): Promise<Vec3> {
    const o = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z) + dz)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-4, 0, -4)} ${xyz(56, HEIGHT - 1, 4)} stone`)
    await run(`fill ${xyz(-4, HEIGHT, -4)} ${xyz(56, HEIGHT + 4, 4)} air`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['iron_pickaxe', 1], ['white_bed', 1], ['torch', 16], ['cooked_beef', 8]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + HEIGHT} ${o.z + 0.5} -90 0`)
    const top = o.offset(0.5, HEIGHT, 0.5)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(top) < 0.5 && countItems(bot, 'white_bed') > 0 && countItems(bot, 'iron_pickaxe') > 0, 200))
    await run(`time set ${DUSK}`)
    assert.ok(await waitUntil(bot, () => bot.time.timeOfDay >= DUSK && bot.time.timeOfDay < DUSK + 200, 100))
    return o
  }

  /** the staircase to BOTTOM as a milestone's task, the reflexes that fired on the way, and its ticks */
  async function descend (t: any): Promise<{ reached: boolean, ticks: number, reflexes: string[], slept: number, lines: string[] }> {
    const reflexes: string[] = []
    let slept = 0
    const onReflex = (name: string, detail?: string): void => { reflexes.push(detail == null ? name : `${name} (${detail})`) }
    const onSleep = (): void => { slept++ }
    bot.on('reflex' as any, onReflex)
    bot.on('sleep', onSleep)
    const lines: string[] = []
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    const start = bot.survival.tasks.tick
    try {
      const reached = await executor.task('down the staircase', async (s) => await descendTo(bot, BOTTOM, {}, s))
      const ticks = bot.survival.tasks.tick - start
      t.diagnostic(`reached ${String(reached)} at ${bot.entity.position.floored().toString()} in ${ticks} ticks, time of day ${bot.time.timeOfDay}; reflexes: ${reflexes.join(', ')}; slept ${slept}`)
      return { reached, ticks, reflexes, slept, lines }
    } finally {
      bot.off('reflex' as any, onReflex)
      bot.off('sleep', onSleep)
    }
  }

  it('works on through the night below the surface: no shelter, no bed, to the bottom', async (t) => {
    await mound(0)
    const { reached, ticks, reflexes, slept } = await descend(t)
    assert.strictEqual(reached, true)
    assert.ok(bot.entity.position.y <= BOTTOM + 0.01, `the bot at ${bot.entity.position.toString()}`)
    assert.deepStrictEqual(reflexes.filter(r => /^night/.test(r)), [])
    assert.strictEqual(slept, 0)
    // 45 steps of 3 blocks of stone with an iron pickaxe: some 2000 ticks (before: the shelter's night, 12000 and more)
    assert.ok(ticks < 5000, `${ticks} ticks`)
    assert.strictEqual(countItems(bot, 'white_bed'), 1)
  })

  it('with the rest due (the phantoms), digs the bed\'s room beside the staircase, sleeps, takes the bed back and goes on', async (t) => {
    await mound(20)
    const sinceRest = (shelterSkills as any).setTicksSinceRest
    assert.strictEqual(typeof sinceRest, 'function', 'no setTicksSinceRest')
    sinceRest(bot, 60000)
    const { reached, ticks, reflexes, slept } = await descend(t)
    assert.strictEqual(reached, true)
    assert.ok(bot.entity.position.y <= BOTTOM + 0.01, `the bot at ${bot.entity.position.toString()}`)
    assert.strictEqual(slept, 1)
    assert.deepStrictEqual(reflexes.filter(r => /^night/.test(r)), ['night (sleep)'])
    assert.ok(await waitUntil(bot, () => countItems(bot, 'white_bed') === 1, 100), 'the bed left behind')
    assert.ok(ticks < 6000, `${ticks} ticks`)
    // the night skipped
    assert.ok(bot.time.timeOfDay < 12000, `time of day ${bot.time.timeOfDay}`)
  })
})
