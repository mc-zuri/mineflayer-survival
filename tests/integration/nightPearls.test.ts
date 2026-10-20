// The overworld's endermen by night, measured, against a real server (SURVIVAL_VERSION, default 1.21.11; the nether runs
// are 26.3), the tests/harness lockstep server and bot on seed 2, normal difficulty: from the spawn at dusk, the pearls
// stage's kit and the reflexes on, pearlsByNight hunts the endermen of the night (NIGHT_TICKS of it, default 12000:
// dusk to dawn and the morning) and the pearls got, the kills, the hits and the deaths are logged (the nether's forest
// against the overworld's nights: which the pearl search should go to first). It passes with the bot alive. A 26.3
// night from seed 2's spawn: 1 enderman killed, no pearl, in 12000 ticks.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { pearlsByNight } from '../../src/milestones'
import { Executor } from '../../src/executor/executor'
import { countItems, waitUntil } from '../../src/skills/util'
import { STAGES } from './stageKits'

const USERNAME = 'nightbot'
const NIGHT_TICKS = Number(process.env.NIGHT_TICKS ?? 12000)

describe(`the overworld's endermen by night on seed 2 on a ${DEFAULT_VERSION} server`, { timeout: 60 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({
      seed: '2',
      difficulty: 'normal',
      log: process.env.SURVIVAL_SERVER_LOG != null ? line => appendFileSync(process.env.SURVIVAL_SERVER_LOG as string, `${line}\n`) : undefined
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin())
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it(`hunts the endermen of a night (${NIGHT_TICKS} ticks) without dying`, async () => {
    for (const [item, count] of STAGES.pearls.kit) await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0, 400), 'no kit')
    assert.ok(await waitUntil(bot, () => bot.inventory.slots[6]?.name === 'diamond_chestplate', 400), 'the armor isn\'t on')
    await run('time set 13000')
    let died = false
    let hurt = 0
    let last = bot.health
    let kills = 0
    const hits = new Map<string, number>()
    const onHealth = (): void => { if (bot.health < last) hurt += last - bot.health; last = bot.health }
    const onKill = (e: any): void => { if (e.name === 'enderman' && e.position.distanceTo(bot.entity.position) < 8) kills++ }
    const onHurt = (e: any, source?: any): void => { if (e === bot.entity) { const k = source?.name ?? 'none'; hits.set(k, (hits.get(k) ?? 0) + 1) } }
    const onDeath = (): void => { died = true }
    bot.on('health', onHealth)
    bot.on('entityDead', onKill)
    bot.on('entityHurt', onHurt)
    bot.on('death', onDeath)
    const lines: string[] = []
    const executor = new Executor(bot, { log: l => lines.push(l) })
    const stop = new AbortController()
    const t0 = bot.lockstep.ticks
    const onTick = (): void => { if (bot.lockstep.ticks - t0 >= NIGHT_TICKS) stop.abort(new Error('the night is measured')) }
    bot.on('physicsTick', onTick)
    let error = ''
    try {
      await pearlsByNight(bot, executor, 16, stop.signal, l => { lines.push(l); console.log(`[night] ${l}`) })
    } catch (err) {
      if (!stop.signal.aborted) error = (err as Error).message
    } finally {
      bot.off('physicsTick', onTick)
      bot.off('health', onHealth)
      bot.off('entityDead', onKill)
      bot.off('entityHurt', onHurt)
      bot.off('death', onDeath)
    }
    const ticks = bot.lockstep.ticks - t0
    const pearls = countItems(bot, 'ender_pearl')
    console.log(`night pearls: ${pearls} pearls, ${kills} endermen killed, ${died ? 'died' : 'alive'}, ${ticks} ticks, ${Math.round(hurt)} health lost${error !== '' ? `, ${error}` : ''}; hits: ${[...hits].map(([k, v]) => `${k} x${v}`).join(', ')}; ${(pearls / ticks * 10000).toFixed(1)} pearls per 10000 ticks`)
    assert.ok(!died, 'died')
  })
})
