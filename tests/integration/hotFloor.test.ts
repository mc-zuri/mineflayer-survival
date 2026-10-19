// Off a magma block against a real server (SURVIVAL_VERSION), the hazard reflex's escapeHazard: a pocket like seed 2's
// basalt delta's by the lava sea (the magma with lava on two sides and a wall two high on the others) gets a block put
// on the magma by a pillar's jump, and the bot stands on it (a 26.3 bot stood in one 170 ticks till it died); a magma
// block with ground beside it is stepped off, no block put.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { escapeHazard, onHotFloor } from '../../src/skills/escape'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'magmabot'

describe(`off a magma block on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'magma', difficulty: 'peaceful', gamerules: { advance_time: false, spawn_mobs: false, advance_weather: false } })
    bot = await connectLockstepBot(server, { username: USERNAME, op: true } as any)
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })
  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** the bot on the magma at the origin's floor, hot floor hits counted while `fn` runs */
  async function onMagma (o: { x: number, y: number, z: number }, fn: () => Promise<void>): Promise<number> {
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} cobblestone 16`)
    await run(`effect clear ${USERNAME}`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') > 0 && bot.entity.onGround && onHotFloor(bot), 100), `not on the magma at ${bot.entity.position.toString()}`)
    let hits = 0
    const onHurt = (e: any): void => { if (e === bot.entity) hits++ }
    bot.on('entityHurt', onHurt)
    try {
      await fn()
    } finally {
      bot.off('entityHurt', onHurt)
    }
    return hits
  }

  it('in a pocket with lava on two sides and walls two high on the others, puts a block on the magma and stands on it', async () => {
    const o = bot.entity.position.floored()
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} stone`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`setblock ${xyz(0, -1, 0)} magma_block`)
    // the lava west, south-west and south (sources at the floor's level: they stay), the walls north and east
    for (const [dx, dz] of [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]]) await run(`setblock ${xyz(dx, -1, dz)} lava`)
    await run(`fill ${xyz(0, 0, -1)} ${xyz(1, 1, -1)} stone`)
    await run(`fill ${xyz(1, 0, 0)} ${xyz(1, 1, 0)} stone`)
    let lava = 0
    const onTick = (): void => { if ((bot.entity as any).isInLava === true) lava++ }
    bot.on('physicsTick', onTick)
    const hits = await onMagma(o, async () => {
      await escapeHazard(bot, { maxTicks: 200, waterRadius: 0 })
    }).finally(() => bot.off('physicsTick', onTick))
    assert.equal(lava, 0, 'in the lava')
    assert.ok(!onHotFloor(bot), `still on the magma at ${bot.entity.position.toString()}`)
    assert.equal(bot.blockAt(bot.entity.position.offset(0, -0.2, 0).floored())?.name, 'cobblestone')
    assert.equal(countItems(bot, 'cobblestone'), 15)
    assert.ok(hits <= 2, `${hits} hits`)
  })

  it('with ground beside it, steps off, no block put', async () => {
    const o = bot.entity.position.floored().offset(20, 0, 0)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run(`fill ${xyz(-6, -1, -6)} ${xyz(6, -1, 6)} stone`)
    await run(`fill ${xyz(-6, 0, -6)} ${xyz(6, 4, 6)} air`)
    await run(`setblock ${xyz(0, -1, 0)} magma_block`)
    const hits = await onMagma(o, async () => {
      await escapeHazard(bot, { maxTicks: 200, waterRadius: 0 })
    })
    assert.ok(!onHotFloor(bot), `still on the magma at ${bot.entity.position.toString()}`)
    assert.equal(countItems(bot, 'cobblestone'), 16)
    assert.ok(hits <= 1, `${hits} hits`)
  })
})
