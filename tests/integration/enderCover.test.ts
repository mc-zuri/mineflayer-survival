// The enderman fight from cover against a real server (SURVIVAL_VERSION, default 1.21.11; the nether runs are 26.3), the
// tests/harness lockstep server and bot on seed 2, normal difficulty: in the seed's warped forest the nether runs go to
// (COVER_AT, default -336 304, the spot nearestBiomeSpot gives from the portal), the bot with the pearls stage's kit and
// its reflexes on, endermenFromCover digs its cover (a stair down to a pit, a two-high tunnel on from it) and fights
// the endermen there (COVER_SUMMON summoned round it, default 4, and the forest's own) till it has COVER_PEARLS pearls
// (default 6), dies, or COVER_MAX_TICKS (default 9000) go by. COVER_RUNS runs (default 2), each from a fresh kit; each
// run's pearls, kills, deaths, hits and ticks are logged, and every run must end with the pearls and no death.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { endermenFromCover, forgetCover } from '../../src/nether/endermanCover'
import { Executor } from '../../src/executor/executor'
import { countItems, waitUntil } from '../../src/skills/util'
import { STAGES } from './stageKits'

const USERNAME = 'coverbot'
const SEED = '2'
const [AT_X, AT_Z] = (process.env.COVER_AT ?? '-336 304').split(/[ ,]+/).map(Number)
const RUNS = Number(process.env.COVER_RUNS ?? 2)
const PEARLS = Number(process.env.COVER_PEARLS ?? 6)
const SUMMON = Number(process.env.COVER_SUMMON ?? 4)
const MAX_TICKS = Number(process.env.COVER_MAX_TICKS ?? 9000)

interface RunResult { run: number, pearls: number, kills: number, died: boolean, death: string, ticks: number, hurt: number, error: string }

describe(`the enderman fight from cover in seed 2's warped forest on a ${DEFAULT_VERSION} server`, { timeout: 60 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const nether = async (cmd: string): Promise<string> => await run(`execute in minecraft:the_nether run ${cmd}`)

  before(async () => {
    server = await startServer({
      seed: SEED,
      difficulty: 'normal',
      gamerules: { advance_weather: false },
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

  const inNether = (): boolean => /nether/.test(String(bot.game?.dimension ?? ''))

  async function oneRun (n: number): Promise<RunResult> {
    // into the forest, on its floor (spreadplayers under the roof), each run a few blocks on from the last's cover
    await run(`effect give ${USERNAME} minecraft:slow_falling 30 0 true`)
    await nether(`tp ${USERNAME} ${AT_X} 100 ${AT_Z}`)
    assert.ok(await waitUntil(bot, () => inNether(), 1200), `in ${bot.game.dimension}`)
    await bot.waitForChunksToLoad()
    await nether(`spreadplayers ${AT_X + (n - 1) * 24} ${AT_Z} 0 6 under 90 false ${USERNAME}`)
    await bot.waitForTicks(20)
    await bot.waitForChunksToLoad()
    await run(`clear ${USERNAME}`)
    for (const [item, count] of STAGES.pearls.kit) await run(`give ${USERNAME} ${item} ${count}`)
    await run(`effect clear ${USERNAME}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.entity.onGround, 400), 'no kit')
    assert.ok(await waitUntil(bot, () => bot.inventory.slots[6]?.name === 'diamond_chestplate', 400), 'the armor isn\'t on')
    // endermen round the bot, on the forest's floor
    const p = bot.entity.position.floored()
    for (let i = 0; i < SUMMON; i++) await nether(`summon enderman ${p.x} ${p.y + 1} ${p.z} {Tags:["cover"]}`)
    await nether(`spreadplayers ${p.x} ${p.z} 6 20 under ${p.y + 8} false @e[type=enderman,tag=cover]`)
    console.log(`cover run ${n}: from ${bot.entity.position.floored().toString()}`)
    forgetCover(bot)

    let died = false
    let death = ''
    let hurt = 0
    let last = bot.health
    let pearls = 0
    let kills = 0
    const onHealth = (): void => { if (bot.health < last) hurt += last - bot.health; last = bot.health; if (bot.health > 0) pearls = Math.max(pearls, countItems(bot, 'ender_pearl')) }
    const onKill = (e: any): void => { if (e.name === 'enderman' && e.position.distanceTo(bot.entity.position) < 8) kills++ }
    const hits = new Map<string, number>()
    const onHurt = (e: any, source?: any): void => { if (e === bot.entity) { const k = source?.name ?? 'none'; hits.set(k, (hits.get(k) ?? 0) + 1) } }
    const onDeath = (): void => { died = true }
    const onMessage = (m: string): void => { if (typeof m === 'string' && m.startsWith(`${USERNAME} `)) death = m }
    bot.on('health', onHealth)
    bot.on('entityDead', onKill)
    bot.on('entityHurt', onHurt)
    bot.on('death', onDeath)
    bot.on('messagestr' as any, onMessage)
    const executor = new Executor(bot, { log: () => {} })
    const t0 = bot.lockstep.ticks
    let error = ''
    try {
      for (let round = 0; round < 10 && countItems(bot, 'ender_pearl') < PEARLS && bot.lockstep.ticks - t0 < MAX_TICKS && !died; round++) {
        // a round that fails is tried again, as the nether milestone's pearl search does (another cover the next time
        // when there was no way to this one); no ground about for one ends the run
        try {
          const res = await executor.task('endermen from cover', async (s) => await endermenFromCover(bot, { pearls: PEARLS - countItems(bot, 'ender_pearl'), maxTicks: MAX_TICKS - (bot.lockstep.ticks - t0) }, s))
          console.log(`cover run ${n} round ${round}: ${res.pearls} pearls, ${res.kills} kills, ${res.ticks} ticks, ${res.reason}`)
        } catch (err) {
          console.log(`cover run ${n} round ${round}: ${(err as Error).message}`)
          if (/no ground for an enderman cover/.test((err as Error).message)) throw err
        }
      }
    } catch (err) {
      error = (err as Error).message
      if (/no ground for an enderman cover/.test(error)) {
        // no ground for a cover: the ground about printed, a slice every 3 z (rows of y, a char a block along x)
        const p = bot.entity.position.floored()
        const ch = (n: string): string => n === 'air' || n === 'cave_air' ? '.' : /nylium/.test(n) ? 'n' : n === 'netherrack' ? '#' : /stem|hyphae/.test(n) ? 'S' : /wart/.test(n) ? 'W' : /lava/.test(n) ? 'L' : /vines|roots|sprouts|fungus/.test(n) ? ',' : n === 'shroomlight' ? 'o' : '?'
        for (let dz = -6; dz <= 6; dz += 3) {
          const rows: string[] = []
          for (let y = p.y + 4; y >= p.y - 7; y--) {
            let row = ''
            for (let dx = -12; dx <= 12; dx++) row += ch(bot.blockAt(p.offset(dx, y - p.y, dz))?.name ?? '?')
            rows.push(`${String(y).padStart(3)} ${row}`)
          }
          console.log(`z ${p.z + dz}:`)
          for (const r of rows) console.log(r)
        }
      }
    } finally {
      bot.off('health', onHealth)
      bot.off('entityDead', onKill)
      bot.off('entityHurt', onHurt)
      bot.off('death', onDeath)
      bot.off('messagestr' as any, onMessage)
    }
    const ticks = bot.lockstep.ticks - t0
    const out: RunResult = { run: n, pearls: died ? pearls : countItems(bot, 'ender_pearl'), kills, died, death, ticks, hurt: Math.round(hurt), error }
    console.log(`cover run ${n}: ${out.pearls} pearls, ${out.kills} kills, ${died ? `died (${death})` : 'alive'}, ${ticks} ticks, ${out.hurt} health lost${error !== '' ? `, ${error}` : ''}; hits: ${[...hits].map(([k, v]) => `${k} x${v}`).join(', ')}`)
    if (died) await waitUntil(bot, () => bot.health > 0 && bot.entity != null, 400)
    return out
  }

  it(`gets ${PEARLS} ender pearls from cover without dying, ${RUNS} runs in a row`, async () => {
    const results: RunResult[] = []
    for (let n = 1; n <= RUNS; n++) results.push(await oneRun(n))
    const passed = results.filter(r => !r.died && r.pearls >= PEARLS).length
    console.log(`cover runs: ${passed} of ${results.length} passed; pearls ${results.map(r => r.pearls).join(', ')}; ticks ${results.map(r => r.ticks).join(', ')}`)
    assert.strictEqual(passed, results.length, JSON.stringify(results))
  })
})
