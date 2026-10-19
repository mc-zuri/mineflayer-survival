// Pointed dripstone against a real server (SURVIVAL_VERSION): a staircase down a stone mound that comes out over a
// dripstone cave turns from its stalagmites, and a walk off a ledge with stalagmites under its edge lands beside them.
// A 26.3 bot stood on a stalagmite in a dripstone cave by its staircase to the deep lava, crit-jumped at the zombies
// there and was impaled 17 times, once a jump, till it died (run full-g).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { Executor } from '../../src/executor/executor'
import { descendTo } from '../../src/executor/explore'
import { navigate } from '../../src/skills/navigate'
import { onDripstone } from '../../src/skills/hazardCells'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'dripbot'
// the superflat's grass is at y = -61
const GROUND = -61
const TIP_UP = 'pointed_dripstone[thickness=tip,vertical_direction=up]'

const pf = require('@nxg-org/mineflayer-pathfinder')

describe(`pointed dripstone on a ${DEFAULT_VERSION} server`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'drip',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** the ticks the bot stood on a stalagmite's tip, and the hurts it took, while `fn` runs */
  async function watch<T> (fn: () => Promise<T>): Promise<{ result: T, onTip: string[], hurts: number }> {
    const onTip: string[] = []
    let hurts = 0
    const onTick = (): void => {
      const p = bot.entity.position
      if (bot.entity.onGround && p.y - Math.floor(p.y) > 0.3 && onDripstone(q => bot.blockAt(q), p.floored())) onTip.push(p.toString())
    }
    const onHurt = (e: any): void => { if (e === bot.entity) hurts++ }
    bot.on('physicsTick', onTick)
    bot.on('entityHurt', onHurt)
    try {
      return { result: await fn(), onTip, hurts }
    } finally {
      bot.off('physicsTick', onTick)
      bot.off('entityHurt', onHurt)
    }
  }

  it('turns a staircase from the stalagmites of a dripstone cave it comes out over, and gets to the bottom unhurt', async (t) => {
    const o = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    const at = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    const height = 20
    // a stone mound 30 along +x and 21 across, the air over it cleared
    await run(`fill ${at(-4, 0, -10)} ${at(30, height - 1, 10)} stone`)
    await run(`fill ${at(-4, height, -10)} ${at(30, height + 4, 10)} air`)
    // a cave 3 high on the staircase's way along +x, 8 to 7 blocks down, its floor all stalagmites' tips
    await run(`fill ${at(5, height - 10, -3)} ${at(14, height - 8, 3)} air`)
    await run(`fill ${at(5, height - 10, -3)} ${at(14, height - 10, 3)} ${TIP_UP}`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} diamond_pickaxe 1`)
    await run(`give ${USERNAME} cobblestone 64`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + height} ${o.z + 0.5} -90 0`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(o.offset(0.5, height, 0.5)) < 0.5 && countItems(bot, 'diamond_pickaxe') > 0 && bot.blockAt(o.offset(8, height - 10, 0))?.name === 'pointed_dripstone', 200))
    const executor = new Executor(bot, { log: line => t.diagnostic(line) })
    const { result, onTip, hurts } = await watch(async () => await executor.task('down the staircase', async (s) => await descendTo(bot, o.y + 3, {}, s)))
    t.diagnostic(`reached ${String(result)} at ${bot.entity.position.floored().toString()}, ${hurts} hurts`)
    assert.strictEqual(result, true)
    assert.deepStrictEqual(onTip, [], 'stood on a stalagmite')
    assert.strictEqual(hurts, 0)
  })

  it('walks off a ledge with stalagmites under its edge onto the ground beside them, not onto one', async (t) => {
    const o = new Vec3(Math.floor(bot.entity.position.x) + 40, GROUND + 1, Math.floor(bot.entity.position.z))
    const at = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${at(-6, -1, -8)} ${at(6, -1, 6)} stone`)
    await run(`fill ${at(-6, 0, -8)} ${at(6, 4, 6)} air`)
    // a ledge a block up, its -z edge over stalagmites but at x 2
    await run(`fill ${at(-2, 0, 0)} ${at(2, 0, 2)} stone`)
    await run(`fill ${at(-2, 0, -1)} ${at(1, 0, -1)} ${TIP_UP}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + 1} ${o.z + 1.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(o.offset(0.5, 1, 1.5)) < 0.5 && bot.entity.onGround && bot.blockAt(o.offset(0, 0, -1))?.name === 'pointed_dripstone', 200))
    const { onTip, hurts } = await watch(async () => await navigate(bot, { goal: new pf.goals.GoalBlock(o.x, o.y, o.z - 5) }))
    t.diagnostic(`at ${bot.entity.position.toString()}, ${hurts} hurts`)
    assert.ok(bot.entity.position.distanceTo(o.offset(0.5, 0, -4.5)) < 1.2, `at ${bot.entity.position.toString()}`)
    assert.deepStrictEqual(onTip, [], 'stood on a stalagmite')
    assert.strictEqual(hurts, 0)
  })
})
