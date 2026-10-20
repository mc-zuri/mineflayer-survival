// The blaze fight against a real server (SURVIVAL_VERSION, default 1.21.11; the nether runs are 26.3), the tests/harness
// lockstep server and bot on seed 2, normal difficulty: the fortress spawner the 26.3 nether runs die at, (59, 64,
// -534), its throne sunk in a basalt delta's wall. The bot has the nether stage's kit (the enchanted diamond gear, a
// shield, a power bow and 128 arrows, 128 cobblestone, food) and its reflexes on, and is put on the way the runs came
// in, 26 blocks off; collectBlazeRods runs as the executor's task (the nether's path settings, resumed after a reflex
// preempts it) until it has BLAZE_RODS rods (default 6), the bot dies, or BLAZE_MAX_TICKS (default 16000) go by.
// BLAZE_RUNS runs (default 3), each from a fresh kit with the blazes, the items, the fires and the cobblestone the last
// one left taken away; each run's rods, kills, deaths, hits and ticks are logged, and every run must end with the rods
// and no death. BLAZE_START="x y z" puts the bot elsewhere, BLAZE_SPAWNER="x y z" fights at another spawner (the
// 26.3 runs' nooks at (97, 64, -515) and (925, 64, 123) killed blazes for 20000 ticks and got no rod). BLAZE_AT picks
// another seed's spawner: s7741, seed 7741's fortress spawner at (136, 77, 258) on its throne over a bridge, where a
// fresh-seed 26.3 whole game sat 20861 ticks in a nook on the bridge 10 off for no rod (full-26.3-s7741-b), the bot
// put where that run came in. BLAZE_KIT=run7741 gives that run's bag instead of the nether stage's: iron armor and
// golden boots, a plain diamond sword and bow, 12 arrows, no shield, 3 raw iron, 59 cobblestone, 6 meals; BLAZE_KIT=q3
// nether-26.3-q3's at s2fortress; BLAZE_KIT=gate the least the nether's gear gate lets in (gateBow with a plain bow and
// BLAZE_ARROWS arrows, default 16; gateIron in iron with an iron sword; gateIronBow in iron with a bow, BLAZE_ARROWS
// arrows, default 32, and BLAZE_FOOD cooked porkchops, default 10; gateDiamond in plain diamond, 64 arrows; gate2 the
// least the gate lets in since it asks for the iron armor, a bow, 64 arrows and 120 food points).
// BLAZE_HURT_LOG=1 logs each hurt: what hurt the bot, where it stood, its health, whether its shield was up.
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
/** the spawners fought at: the seed, the spawner, where the bot is put */
const PLACES: Record<string, { seed: string, spawner: Vec3, start: Vec3 }> = {
  s2: { seed: '2', spawner: new Vec3(59, 64, -534), start: new Vec3(43.5, 89, -515.5) },
  s7741: { seed: '7741', spawner: new Vec3(136, 77, 258), start: new Vec3(120.5, 61, 247.5) },
  // seed 2's fortress by the portal of the fresh-seed runs: full-26.3-fresh-d and nether-26.3-q3 died at its melee nook,
  // (-277, 77, -161), three times; the bot put where q3 came in
  s2fortress: { seed: '2', spawner: new Vec3(-277, 77, -159), start: new Vec3(-270.5, 61, -164.5) }
}
const PLACE = PLACES[process.env.BLAZE_AT ?? 's2']
assert.ok(PLACE != null, `BLAZE_AT is one of ${Object.keys(PLACES).join(', ')}`)
const SEED = PLACE.seed
const vec = (text: string): Vec3 => new Vec3(...(text.split(/[ ,]+/).map(Number) as [number, number, number]))
const SPAWNER = process.env.BLAZE_SPAWNER != null ? vec(process.env.BLAZE_SPAWNER) : PLACE.spawner
const START = process.env.BLAZE_START != null ? vec(process.env.BLAZE_START) : PLACE.start
/** the bags given */
const KITS: Record<string, Array<[string, number]>> = {
  nether: STAGES.nether.kit,
  // full-26.3-s7741-b's at seed 7741's fortress
  run7741: [
    ['diamond_sword', 1], ['diamond_pickaxe', 1], ['bow', 1], ['arrow', 12], ['iron_helmet', 1], ['iron_chestplate', 1],
    ['iron_leggings', 1], ['golden_boots', 1], ['cobblestone', 59], ['cooked_mutton', 5], ['mutton', 1], ['potato', 1],
    ['raw_iron', 3], ['coal', 16], ['furnace', 1], ['crafting_table', 1], ['oak_log', 35], ['flint_and_steel', 1],
    ['torch', 18], ['water_bucket', 1], ['raw_gold', 37]
  ],
  // nether-26.3-q3's at seed 2's fortress (-277, 77, -159): an iron chestplate, golden boots, a shield, a stone sword, no bow
  q3: [
    ['iron_chestplate', 1], ['golden_boots', 1], ['shield', 1], ['stone_sword', 1], ['iron_pickaxe', 1], ['cobblestone', 128],
    ['cooked_porkchop', 4], ['netherrack', 51], ['torch', 16], ['crafting_table', 1], ['coal', 31]
  ],
  // the least the nether's gear gate lets in (milestones' netherGearNeeds): a stone sword, an iron chestplate, golden
  // boots, a shield, 40 food points, no bow; and the nether's 64 blocks (NETHER_BLOCKS, netherrack mined there)
  gate: [
    ['stone_sword', 1], ['iron_chestplate', 1], ['golden_boots', 1], ['shield', 1], ['cooked_porkchop', 5],
    ['iron_pickaxe', 1], ['netherrack', 64]
  ],
  // the gate's least with a plain bow and BLAZE_ARROWS arrows (default 16), BLAZE_FOOD cooked porkchops (default 5); the
  // gate's least since it asks for a bow, 64 arrows and 120 food points: BLAZE_ARROWS=64 BLAZE_FOOD=15
  gateBow: [
    ['stone_sword', 1], ['iron_chestplate', 1], ['golden_boots', 1], ['shield', 1], ['bow', 1], ['arrow', Number(process.env.BLAZE_ARROWS ?? 16)],
    ['cooked_porkchop', Number(process.env.BLAZE_FOOD ?? 5)], ['iron_pickaxe', 1], ['netherrack', 64]
  ],
  // the gate's least in iron: the armor (golden boots), an iron sword, no bow
  gateIron: [
    ['iron_sword', 1], ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['golden_boots', 1], ['shield', 1],
    ['cooked_porkchop', 5], ['iron_pickaxe', 1], ['netherrack', 64]
  ],
  // the least the gear gate lets in since it asks for the iron helmet and leggings, a bow, 64 arrows and 120 food points
  gate2: [
    ['stone_sword', 1], ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['golden_boots', 1], ['shield', 1],
    ['bow', 1], ['arrow', 64], ['cooked_porkchop', 15], ['iron_pickaxe', 1], ['netherrack', 64]
  ],
  // in iron with a plain bow and BLAZE_ARROWS arrows (default 32), BLAZE_FOOD cooked porkchops (default 10: 80 food points)
  gateIronBow: [
    ['iron_sword', 1], ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['golden_boots', 1], ['shield', 1],
    ['bow', 1], ['arrow', Number(process.env.BLAZE_ARROWS ?? 32)], ['cooked_porkchop', Number(process.env.BLAZE_FOOD ?? 10)],
    ['iron_pickaxe', 1], ['netherrack', 64]
  ],
  // plain diamond (no enchantment) with a plain bow and BLAZE_ARROWS arrows (default 64), 80 food points
  gateDiamond: [
    ['diamond_sword', 1], ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['diamond_boots', 1], ['golden_boots', 1],
    ['shield', 1], ['bow', 1], ['arrow', Number(process.env.BLAZE_ARROWS ?? 64)], ['cooked_porkchop', Number(process.env.BLAZE_FOOD ?? 10)],
    ['iron_pickaxe', 1], ['netherrack', 64]
  ]
}
const KIT = KITS[process.env.BLAZE_KIT ?? 'nether']
assert.ok(KIT != null, `BLAZE_KIT is one of ${Object.keys(KITS).join(', ')}`)
const RUNS = Number(process.env.BLAZE_RUNS ?? 3)
const RODS = Number(process.env.BLAZE_RODS ?? 6)
const MAX_TICKS = Number(process.env.BLAZE_MAX_TICKS ?? 16000)

interface RunResult { run: number, rods: number, kills: number, died: boolean, death: string, ticks: number, hurt: number, health: number, error: string }

describe(`the blaze fight at seed ${SEED}'s fortress spawner ${SPAWNER.toString()} on a ${DEFAULT_VERSION} server`, { timeout: 120 * 60 * 1000 }, () => {
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
    for (let y = SPAWNER.y - 9; y < SPAWNER.y + 27; y += 8) for (const b of ['fire', 'cobblestone']) cmds.push(`fill ${SPAWNER.x - 30} ${y} ${SPAWNER.z - 32} ${SPAWNER.x + 30} ${y + 7} ${SPAWNER.z + 30} air replace ${b}`)
    for (const cmd of cmds) {
      for (let i = 0; i < 20; i++) {
        const out = await nether(cmd)
        if (!/not loaded/.test(out)) break
        await bot.waitForTicks(10)
      }
    }
    // the spawner put back when the last run's left it broken (a blaze spawner mined is gone for good)
    const at = bot.blockAt(SPAWNER)
    if (at != null && at.name !== 'spawner') {
      console.log(`blaze runs: the spawner at ${SPAWNER.toString()} is ${at.name}: put back`)
      await nether(`setblock ${SPAWNER.x} ${SPAWNER.y} ${SPAWNER.z} spawner{SpawnData:{entity:{id:"minecraft:blaze"}}}`)
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
    for (const [item, count] of KIT) await run(`give ${USERNAME} ${item} ${count}`)
    await run(`effect clear ${USERNAME}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    await nether(`tp ${USERNAME} ${START.x} ${START.y} ${START.z}`)
    // (the kit's last item in: they're given in order)
    const lastItem = KIT[KIT.length - 1][0].replace(/\[.*$/, '')
    assert.ok(await waitUntil(bot, () => countItems(bot, lastItem) > 0 && bot.entity.onGround, 400), 'no kit')
    // the armor reflex puts it on
    assert.ok(await waitUntil(bot, () => /_chestplate$/.test(bot.inventory.slots[6]?.name ?? ''), 400), 'the armor isn\'t on')
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
    const onHurt = (e: any, source?: any): void => {
      if (e !== bot.entity) return
      const k = source?.name ?? 'none'
      hits.set(k, (hits.get(k) ?? 0) + 1)
      if (process.env.BLAZE_HURT_LOG != null) {
        const fire = ['fire', 'soul_fire'].filter(n => [0, 1].some(dy => bot.blockAt(bot.entity.position.offset(0, dy, 0))?.name === n))
        console.log(`hurt ${bot.lockstep.ticks} ${k} at ${bot.entity.position.toString()} health ${bot.health.toFixed(1)} shield ${String((bot as any).usingHeldItem)} yaw ${bot.entity.yaw.toFixed(2)}${source?.position != null ? ` from ${source.position.toString()}` : ''}${fire.length > 0 ? ' in fire' : ''}`)
      }
    }
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
    // where the blazes were at the end, and the bot (a spawner makes none with 6 of them in its box: a run of no kills)
    const left = Object.values(bot.entities).filter((e: any) => e.name === 'blaze' && e.position.distanceTo(SPAWNER) <= 32)
    console.log(`blaze run ${n} end: bot at ${bot.entity.position.floored().toString()}; blazes ${left.map((e: any) => e.position.floored().toString()).join(' ')}`)
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
