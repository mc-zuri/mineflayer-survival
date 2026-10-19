// The blaze fight against a real server (SURVIVAL_VERSION, default 1.21.11; the nether runs are 26.3), the tests/harness
// lockstep server and bot on seed 2, normal difficulty: the fortress spawner the 26.3 nether runs die at, (59, 64,
// -534), its throne sunk in a basalt delta's wall. The bot has the nether stage's kit (the enchanted diamond gear, a
// shield, a power bow and 128 arrows, 128 cobblestone, food) and its reflexes on, and is put on the way the runs came
// in, 26 blocks off; collectBlazeRods runs as the executor's task (the nether's path settings, resumed after a reflex
// preempts it) until it has BLAZE_RODS rods (default 6), the bot dies, or BLAZE_MAX_TICKS (default 16000) go by.
// BLAZE_RUNS runs (default 3), each from a fresh kit with the blazes, the items, the fires and the cobblestone the last
// one left taken away; each run's rods, kills, deaths, hits and ticks are logged, and every run must end with the rods
// and no death. BLAZE_START="x y z" puts the bot elsewhere.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { collectBlazeRods } from '../../src/nether/fortressSkills'
import { Executor } from '../../src/executor/executor'
import { countItems, waitUntil } from '../../src/skills/util'
import { STAGES } from './stageKits'

const USERNAME = 'blazebot'
const SEED = '2'
const SPAWNER = new Vec3(59, 64, -534)
const START = process.env.BLAZE_START != null ? new Vec3(...(process.env.BLAZE_START.split(/[ ,]+/).map(Number) as [number, number, number])) : new Vec3(43.5, 89, -515.5)
const RUNS = Number(process.env.BLAZE_RUNS ?? 3)
const RODS = Number(process.env.BLAZE_RODS ?? 6)
const MAX_TICKS = Number(process.env.BLAZE_MAX_TICKS ?? 16000)

interface RunResult { run: number, rods: number, kills: number, died: boolean, death: string, ticks: number, hurt: number, health: number, error: string }

describe(`the blaze fight at seed 2's fortress spawner on a ${DEFAULT_VERSION} server`, { timeout: 120 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const nether = async (cmd: string): Promise<string> => await run(`execute in minecraft:the_nether run ${cmd}`)

  before(async () => {
    server = await startServer({
      seed: SEED,
      difficulty: 'normal',
      gamerules: { advance_weather: false, advance_time: false },
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

  /** the area round the throne as it was: no blazes, items, fires or cobblestone the last run left */
  async function resetArea (): Promise<void> {
    const cmds = ['kill @e[type=blaze]', 'kill @e[type=item]', 'kill @e[type=small_fireball]']
    // (in slabs under /fill's 32768 blocks)
    for (let y = 55; y < 91; y += 8) for (const b of ['fire', 'cobblestone']) cmds.push(`fill 29 ${y} -566 89 ${y + 7} -504 air replace ${b}`)
    for (const cmd of cmds) {
      for (let i = 0; i < 20; i++) {
        const out = await nether(cmd)
        if (!/not loaded/.test(out)) break
        await bot.waitForTicks(10)
      }
    }
  }

  async function oneRun (n: number): Promise<RunResult> {
    // into the nether at the start (from the overworld after a death too), the kit given, healed and fed
    await run(`effect give ${USERNAME} minecraft:slow_falling 20 0 true`)
    await nether(`tp ${USERNAME} ${START.x} ${START.y + 1} ${START.z}`)
    assert.ok(await waitUntil(bot, () => inNether() && bot.entity.position.distanceTo(START) < 3, 1200), `at ${bot.entity.position.toString()} in ${bot.game.dimension}`)
    await bot.waitForChunksToLoad()
    await resetArea()
    await run(`clear ${USERNAME}`)
    for (const [item, count] of STAGES.nether.kit) await run(`give ${USERNAME} ${item} ${count}`)
    await run(`effect clear ${USERNAME}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    await nether(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.entity.onGround, 400), 'no kit')
    // the armor reflex puts it on
    assert.ok(await waitUntil(bot, () => bot.inventory.slots[6]?.name === 'diamond_chestplate', 400), 'the armor isn\'t on')
    await bot.waitForTicks(20)

    let died = false
    let death = ''
    let hurt = 0
    let last = bot.health
    let rods = 0
    let kills = 0
    const onHealth = (): void => { if (bot.health < last) hurt += last - bot.health; last = bot.health; if (bot.health > 0) rods = Math.max(rods, countItems(bot, 'blaze_rod')) }
    const onKill = (e: any): void => { if (e.name === 'blaze') kills++ }
    bot.on('entityDead', onKill)
    // what hurt it (the damage event's source: none for the fire's burning) and the reflexes that fired
    const hits = new Map<string, number>()
    const onHurt = (e: any, source?: any): void => { if (e === bot.entity) { const k = source?.name ?? 'none'; hits.set(k, (hits.get(k) ?? 0) + 1) } }
    const reflexes = new Map<string, number>()
    const onReflex = (name: string, detail?: string): void => { const k = detail != null ? `${name} (${detail})` : name; reflexes.set(k, (reflexes.get(k) ?? 0) + 1) }
    bot.on('entityHurt', onHurt)
    bot.on('reflex' as any, onReflex)
    const onDeath = (): void => { died = true }
    const onMessage = (m: string): void => { if (typeof m === 'string' && m.startsWith(`${USERNAME} `)) death = m }
    bot.on('health', onHealth)
    bot.on('death', onDeath)
    bot.on('messagestr' as any, onMessage)
    const executor = new Executor(bot, { log: () => {} })
    const t0 = bot.lockstep.ticks
    let result = { rods: 0, kills: 0 }
    let error = ''
    try {
      result = await executor.task('blaze rods', async (s) => await collectBlazeRods(bot, { count: RODS, spawner: SPAWNER, maxTicks: MAX_TICKS }, s))
    } catch (err) {
      error = (err as Error).message
    } finally {
      bot.off('health', onHealth)
      bot.off('entityDead', onKill)
      bot.off('entityHurt', onHurt)
      bot.off('reflex' as any, onReflex)
      bot.off('death', onDeath)
      bot.off('messagestr' as any, onMessage)
    }
    const ticks = bot.lockstep.ticks - t0
    const out: RunResult = { run: n, rods: died ? Math.max(rods, result.rods) : countItems(bot, 'blaze_rod'), kills: Math.max(kills, result.kills), died, death, ticks, hurt: Math.round(hurt), health: Math.round(bot.health), error }
    const list = (m: Map<string, number>): string => [...m].map(([k, v]) => `${k} x${v}`).join(', ')
    console.log(`blaze run ${n}: ${out.rods} rods, ${out.kills} kills, ${died ? `died (${death})` : 'alive'}, ${ticks} ticks, ${out.hurt} health lost, health ${out.health}${error !== '' ? `, ${error}` : ''}; hits: ${list(hits)}; reflexes: ${list(reflexes)}`)
    if (died) await waitUntil(bot, () => bot.health > 0 && bot.entity != null, 400)
    return out
  }

  it(`gets ${RODS} blaze rods without dying, ${RUNS} runs in a row`, async () => {
    const results: RunResult[] = []
    for (let n = 1; n <= RUNS; n++) results.push(await oneRun(n))
    const passed = results.filter(r => !r.died && r.rods >= RODS).length
    console.log(`blaze runs: ${passed} of ${results.length} passed; deaths ${results.filter(r => r.died).length}; ticks ${results.map(r => r.ticks).join(', ')}`)
    assert.strictEqual(passed, results.length, JSON.stringify(results))
  })
})
