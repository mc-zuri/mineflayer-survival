// A nether portal put out on the bot's way home (a ghast's fireball breaks the portal blocks, not the obsidian), against
// a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness lockstep server and bot): the bot builds a portal
// of obsidian, goes in, its arrival portal's blocks are set to air (as the blast leaves them) and one of the frame's
// obsidian too, and it's sent 4 blocks off; returnOverworld finds the frame, puts the obsidian back, lights it with
// its flint and steel and goes home. full-1.21.11-fresh-l built another by a lava cast in the nether and was lost.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { buildPortal } from '../../src/nether/portalSkills'
import { enterNether, returnOverworld } from '../../src/nether/portalTravel'
import { countItems, waitUntil } from '../../src/skills/gather'

const USERNAME = 'relightbot'

describe(`a nether portal put out is lit again on the way home, ${DEFAULT_VERSION}`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({
      seed: '4',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_phantoms: false, spawn_monsters: false }
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  async function fill (args: string, dimension = 'overworld'): Promise<void> {
    let out = ''
    for (let i = 0; i < 20; i++) {
      out = await run(`execute in minecraft:${dimension} run fill ${args}`)
      if (!/not loaded/.test(out)) break
      await bot.waitForTicks(10)
    }
    assert.match(out, /Successfully filled|No blocks were filled/, `fill ${args}: ${out}`)
  }

  it('finds its arrival portal\'s frame out and a block short from 4 blocks off, puts the obsidian back, lights it and goes home', async () => {
    const o = new Vec3(100, 80, 100)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`effect give ${USERNAME} minecraft:slow_falling 30 0 true`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + 2} ${o.z + 0.5}`)
    await bot.waitForChunksToLoad()
    await fill(`${xyz(-8, 0, -8)} ${xyz(8, 8, 8)} air`)
    await fill(`${xyz(-8, -2, -8)} ${xyz(8, -1, 8)} stone`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    await run(`clear ${USERNAME}`)
    for (const [item, n] of [['obsidian', 11], ['flint_and_steel', 1], ['cobblestone', 16]] as const) await run(`give ${USERNAME} ${item} ${n}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'flint_and_steel') > 0 && countItems(bot, 'cobblestone') >= 16 && countItems(bot, 'obsidian') >= 11 && bot.entity.onGround, 200))

    const portal = await buildPortal(bot, { method: 'obsidian' })
    assert.strictEqual(portal.portal.length, 6)
    const into = await enterNether(bot, { build: false })
    assert.strictEqual(into.to, 'the_nether')
    const arrival = bot.survival.memory.getPois('nether_portal', { dimension: 'the_nether' })[0]
    assert.ok(arrival != null, 'the arrival portal remembered')
    const a = new Vec3(arrival.x, arrival.y, arrival.z)
    // a ghast's blast: the portal blocks gone round the arrival, the obsidian kept but one (taken by the 'blast' here)
    await fill(`${a.x - 4} ${a.y - 4} ${a.z - 4} ${a.x + 4} ${a.y + 4} ${a.z + 4} air replace minecraft:nether_portal`, 'the_nether')
    assert.ok(await waitUntil(bot, () => bot.blockAt(a)?.name !== 'nether_portal', 100), 'the portal put out')
    let gap: Vec3 | null = null
    for (let dy = -1; dy <= 0 && gap == null; dy++) {
      for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const p = a.offset(d[0], dy - 1, d[1])
        if (bot.blockAt(p)?.name === 'obsidian') { gap = p; break }
      }
    }
    if (gap != null) await fill(`${gap.x} ${gap.y} ${gap.z} ${gap.x} ${gap.y} ${gap.z} air`, 'the_nether')
    // 4 blocks off it, on a floor of its own
    await fill(`${a.x + 2} ${a.y - 1} ${a.z + 3} ${a.x + 6} ${a.y - 1} ${a.z + 6} netherrack`, 'the_nether')
    await fill(`${a.x + 2} ${a.y} ${a.z + 3} ${a.x + 6} ${a.y + 2} ${a.z + 6} air`, 'the_nether')
    await run(`execute in minecraft:the_nether run tp ${USERNAME} ${a.x + 4.5} ${a.y} ${a.z + 4.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(a.offset(4.5, 0, 4.5)) < 1.5, 200))

    const t0 = bot.lockstep.ticks
    const out = await returnOverworld(bot, {})
    console.log(`returnOverworld through the frame lit again${gap != null ? ', a gap put back' : ''}: ${bot.lockstep.ticks - t0} ticks`)
    assert.strictEqual(out.to, 'overworld')
    assert.strictEqual(bot.game.dimension, 'overworld')
  })
})
