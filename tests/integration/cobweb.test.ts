// A bow from a mineshaft's cobwebs against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness lockstep
// server, a superflat world, no mobs): the bot in a 1-wide tunnel through a block of stone with 4 cobwebs in it 8 to
// 20 blocks on (a mineshaft's corridor), an iron sword (enchanted), 3 sticks and a crafting table, no string and no spider in the
// world, the reflexes on, the bot fit for the caves (enchanted iron and a sword, cooked food: caveReady, the cobweb's
// string planned for no other). The executor's look round notes the webs (COBWEB_CHECK_TICKS), and obtain asks for a bow:
// the plan takes the string from the webs (planner/sources' cobweb, broken with the sword: blocks/cobweb drops string
// to anything but shears) and crafts it. COBWEB_RUNS runs (default 2), each with a fresh tunnel; every one must end
// with the bow. COBWEB_SHEARS=1 gives shears too (the sword is taken for the webs all the same).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { Executor } from '../../src/executor/executor'
import { COBWEB_CHECK_TICKS } from '../../src/executor/executor'
import { countItems, waitUntil } from '../../src/skills/util'
import { caveReady, caveUnreadiness } from '../../src/skills/caves'

const USER = 'webbot'
const GROUND = -60
const RUNS = Number(process.env.COBWEB_RUNS ?? 2)
const KIT: Array<[string, number]> = [['iron_sword[enchantments={sharpness:1}]', 1], ['cooked_beef', 8], ['stick', 3], ['crafting_table', 1], ...(process.env.COBWEB_SHEARS != null ? [['shears', 1] as [string, number]] : [])]
/**
 * the armor of a bot fit for the caves (skills/caves caveReady: the cobweb's string is planned for no other), worn
 * with the enchanted sword and the cooked food of KIT
 */
const ARMOR: Array<[string, string]> = [['armor.head', 'iron_helmet[enchantments={protection:1}]'], ['armor.chest', 'iron_chestplate[enchantments={protection:1}]'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']]

interface RunResult { run: number, bow: boolean, string: number, webs: number, ticks: number, plan: string, error: string }

describe(`a bow from a tunnel's cobwebs on a ${DEFAULT_VERSION} server`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let runs = 0
  const run = async (cmd: string): Promise<string[]> => await server.command(cmd)

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'webs',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** a block of stone with a tunnel along +x (1 wide, 2 high, 30 long), 4 cobwebs in it; the bot 2 in from its west end */
  async function freshTunnel (): Promise<Vec3[]> {
    const x = 64 * runs++
    for (const cmd of ['time set 6000', 'kill @e[type=!player]', `clear ${USER}`, `forceload add ${x - 16} -16 ${x + 48} 16`,
      `fill ${x - 2} ${GROUND - 3} -3 ${x + 32} ${GROUND + 4} 3 minecraft:stone`, `fill ${x} ${GROUND} 0 ${x + 30} ${GROUND + 1} 0 minecraft:air`]) await run(cmd)
    // (a torch at the bot's end: its light)
    await run(`setblock ${x + 1} ${GROUND} 0 minecraft:torch`)
    const webs = [new Vec3(x + 10, GROUND, 0), new Vec3(x + 14, GROUND + 1, 0), new Vec3(x + 18, GROUND, 0), new Vec3(x + 22, GROUND + 1, 0)]
    for (const w of webs) await run(`setblock ${w.x} ${w.y} ${w.z} minecraft:cobweb`)
    await run(`tp ${USER} ${x + 2.5} ${GROUND} 0.5 -90 0`)
    assert.ok(await waitUntil(bot, () => Math.abs(bot.entity.position.x - x - 2.5) < 0.6 && bot.inventory.items().length === 0, 200), 'not in the tunnel')
    await bot.waitForChunksToLoad()
    return webs
  }

  async function oneRun (n: number): Promise<RunResult> {
    const webs = await freshTunnel()
    for (const [item, count] of KIT) await run(`give ${USER} ${item} ${count}`)
    for (const [slot, item] of ARMOR) await run(`item replace entity ${USER} ${slot} with ${item}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, KIT[KIT.length - 1][0]) > 0, 200), 'no kit')
    assert.ok(await waitUntil(bot, () => caveReady(bot), 100), `not cave-ready: ${caveUnreadiness(bot) ?? ''}`)
    const executor = new Executor(bot, { log: line => console.log(`  [executor] ${line}`) })
    // the look round for the webs (every COBWEB_CHECK_TICKS)
    await bot.waitForTicks(COBWEB_CHECK_TICKS + 20)
    const known = executor.memory.findBlocks('cobweb', { dimension: 'overworld' }).length
    const plan = executor.plan([{ item: 'bow', count: 1 }])
    const describe = plan.ok ? plan.steps.map(s => `${s.kind} ${String((s as any).block ?? (s as any).mob ?? '')} ${s.item}`.replace(/ +/g, ' ')).join(', ') : 'no plan'
    const t0 = bot.lockstep.ticks
    let error = ''
    try {
      await executor.obtain([{ item: 'bow', count: 1 }])
    } catch (err) {
      error = (err as Error).message
    }
    const left = webs.filter(w => bot.blockAt(w)?.name === 'cobweb').length
    const out: RunResult = { run: n, bow: countItems(bot, 'bow') > 0, string: countItems(bot, 'string'), webs: known, ticks: bot.lockstep.ticks - t0, plan: describe, error }
    console.log(`cobweb run ${n}: ${out.bow ? 'a bow' : 'no bow'}, ${out.string} string over, ${known} webs remembered, ${4 - left} of 4 broken, ${out.ticks} ticks; the plan: ${describe}${error !== '' ? `; ${error}` : ''}`)
    return out
  }

  it(`gets 3 string from the cobwebs and crafts a bow, ${RUNS} runs`, async () => {
    const results: RunResult[] = []
    for (let n = 1; n <= RUNS; n++) results.push(await oneRun(n))
    const passed = results.filter(r => r.bow).length
    console.log(`cobweb runs: ${passed} of ${results.length} passed; ticks ${results.map(r => r.ticks).join(', ')}`)
    assert.strictEqual(passed, results.length, JSON.stringify(results))
  })
})
