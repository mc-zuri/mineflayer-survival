// A pickaxe worn out inside a long task against a real server (SURVIVAL_VERSION): the staircase down a stone mound
// (descendTo) as a milestone runs it (Executor.task), with an iron pickaxe 34 uses from breaking and the iron for
// another in the bag. The wear watch stops the staircase at 24 uses left, the executor crafts a new pickaxe, and the
// staircase goes on to the bottom.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { Executor } from '../../src/executor/executor'
import { descendTo } from '../../src/executor/explore'
import { usesLeft } from '../../src/executor/durability'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'wearbot'
// the superflat's grass is at y = -61
const GROUND = -61
// the mound: 30 high over the grass, the bot on its top
const HEIGHT = 30
// where the staircase ends: 2 over the mound's floor
const BOTTOM = GROUND + 3

describe(`a pickaxe worn out down a staircase on a ${DEFAULT_VERSION} server`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'wear',
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

  it('stops the staircase when the pickaxe is about to break, crafts another from the iron carried, and goes on to the bottom', async (t) => {
    const o = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    // a stone mound 40 long along +x, 9 wide, HEIGHT high, the air over it cleared
    await run(`fill ${xyz(-4, 0, -4)} ${xyz(36, HEIGHT - 1, 4)} stone`)
    await run(`fill ${xyz(-4, HEIGHT, -4)} ${xyz(36, HEIGHT + 4, 4)} air`)
    await run(`clear ${USERNAME}`)
    // 34 uses left (an iron pickaxe's 250)
    for (const [item, n] of [['iron_pickaxe[damage=216]', 1], ['iron_ingot', 3], ['stick', 2], ['crafting_table', 1]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    // on top, facing +x (the staircase goes along the facing)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + HEIGHT} ${o.z + 0.5} -90 0`)
    const top = o.offset(0.5, HEIGHT, 0.5)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(top) < 0.5 && countItems(bot, 'crafting_table') > 0 && countItems(bot, 'iron_pickaxe') > 0, 200))
    const lines: string[] = []
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) } })
    let runs = 0
    const reached = await executor.task('down the staircase', async (s) => { runs++; return await descendTo(bot, BOTTOM, {}, s) })
    const picks = bot.inventory.items().filter(i => i.name === 'iron_pickaxe').map(i => usesLeft(i))
    t.diagnostic(`reached ${String(reached)} at ${bot.entity.position.floored().toString()}, ${runs} runs, pickaxes' uses ${picks.join(', ')}`)
    assert.strictEqual(reached, true, lines.join(' | '))
    assert.ok(bot.entity.position.y <= BOTTOM + 0.01, `the bot at ${bot.entity.position.toString()}`)
    assert.strictEqual(runs, 2, lines.join(' | '))
    assert.ok(lines.some(l => /down the staircase: stopped, the iron_pickaxe has 2[0-4] uses left/.test(l)), lines.join(' | '))
    assert.ok(lines.some(l => /craft 1 iron_pickaxe/.test(l)), lines.join(' | '))
    // the iron went into the new one, which is held still
    assert.strictEqual(countItems(bot, 'iron_ingot'), 0)
    assert.ok(picks.some(u => u > 100), `pickaxes' uses: ${picks.join(', ')}`)
  })

  it('makes a stone pickaxe from the cobblestone carried before a staircase\'s first step when the bag has none, and digs down with it', async (t) => {
    // (26.3 run full-f: the staircase to the deep lava dug from y 12 to -50 by hand after its diamond pickaxe broke,
    // a crafting table, 17 sticks and 600 cobblestone in the bag)
    const o = new Vec3(Math.floor(bot.entity.position.x) + 60, GROUND + 1, Math.floor(bot.entity.position.z))
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-4, 0, -4)} ${xyz(36, HEIGHT - 1, 4)} stone`)
    await run(`fill ${xyz(-4, HEIGHT, -4)} ${xyz(36, HEIGHT + 4, 4)} air`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['cobblestone', 64], ['stick', 4], ['crafting_table', 1]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + HEIGHT} ${o.z + 0.5} -90 0`)
    const top = o.offset(0.5, HEIGHT, 0.5)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(top) < 0.5 && countItems(bot, 'crafting_table') > 0 && countItems(bot, 'stick') > 0, 200))
    const executor = new Executor(bot, { log: line => t.diagnostic(line) })
    const start = bot.survival.tasks.tick
    const reached = await executor.task('down the staircase', async (s) => await descendTo(bot, BOTTOM, {}, s))
    const ticks = bot.survival.tasks.tick - start
    t.diagnostic(`reached ${String(reached)} at ${bot.entity.position.floored().toString()} in ${ticks} ticks`)
    assert.strictEqual(reached, true)
    assert.strictEqual(countItems(bot, 'stone_pickaxe'), 1)
    // 27 steps of 3 blocks: by hand 150 ticks a block of stone, with the stone pickaxe some 8
    assert.ok(ticks < 4000, `${ticks} ticks`)
  })
})
