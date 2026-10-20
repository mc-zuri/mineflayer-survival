// The stone dug with a stone pickaxe, the iron one saved for the ores (skills/digTool.ts), against a real server
// (SURVIVAL_VERSION): a staircase down a deepslate mound (descendTo, as a mine step's exploring digs it) with an iron
// and a stone pickaxe leaves the iron one as it was; with no stone one, the route makes one from the cobblestone
// first. In rt-1 and grim-2 (1.21.11) the iron pickaxe dug the staircase to the diamonds' level and broke on the way.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { Executor } from '../../src/executor/executor'
import { descendTo } from '../../src/executor/explore'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'digbot'
// the superflat's grass is at y = -61
const GROUND = -61
const HEIGHT = 12
const BOTTOM = GROUND + 3

describe(`the stone dug with a stone pickaxe, the iron one saved, on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'digtool',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
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

  /** a deepslate mound HEIGHT high, 30 along +x from `dz` across, the bot on top facing +x with the kit */
  async function mound (dz: number, kit: ReadonlyArray<readonly [string, number]>): Promise<void> {
    const o = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z) + dz)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-4, 0, -4)} ${xyz(30, HEIGHT - 1, 4)} deepslate`)
    await run(`fill ${xyz(-4, HEIGHT, -4)} ${xyz(30, HEIGHT + 4, 4)} air`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of kit) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + HEIGHT} ${o.z + 0.5} -90 0`)
    const top = o.offset(0.5, HEIGHT, 0.5)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(top) < 0.5 && kit.every(([item]) => countItems(bot, item) > 0), 200))
  }

  const used = (name: string): number[] => bot.inventory.items().filter(i => i.name === name).map(i => i.durabilityUsed ?? 0)

  async function descend (t: any): Promise<boolean> {
    const executor = new Executor(bot, { log: line => t.diagnostic(line) })
    const reached = await executor.task('down the staircase', async (s) => await descendTo(bot, BOTTOM, {}, s))
    t.diagnostic(`reached ${String(reached)} at ${bot.entity.position.floored().toString()}; iron used ${used('iron_pickaxe').join(',')}, stone used ${used('stone_pickaxe').join(',')}`)
    return reached
  }

  it('digs the staircase\'s deepslate with the stone pickaxe, the iron one not worn', async (t) => {
    await mound(0, [['iron_pickaxe', 1], ['stone_pickaxe', 1], ['torch', 16]])
    assert.strictEqual(await descend(t), true)
    assert.deepStrictEqual(used('iron_pickaxe'), [0])
    // some 3 blocks a step, 9 steps
    assert.ok(used('stone_pickaxe')[0] >= 18, `stone used ${used('stone_pickaxe').join(',')}`)
  })

  it('with no stone pickaxe, makes one from the cobblestone before the first step, and digs with it', async (t) => {
    await mound(12, [['iron_pickaxe', 1], ['cobblestone', 16], ['stick', 4], ['crafting_table', 1], ['torch', 16]])
    assert.strictEqual(await descend(t), true)
    assert.strictEqual(countItems(bot, 'stone_pickaxe'), 1)
    assert.ok(used('stone_pickaxe')[0] >= 18, `stone used ${used('stone_pickaxe').join(',')}`)
    assert.ok(used('iron_pickaxe')[0] <= 3, `iron used ${used('iron_pickaxe').join(',')}`)
  })
})
