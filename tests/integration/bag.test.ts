// The bag down a mine against a real server (SURVIVAL_VERSION): what the bot stores, stashes and throws away when its
// inventory fills with the stone of its own route, and what it never picks up again.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { storeItems } from '../../src/skills/chest'
import { countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'bagbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`the bag down a mine on a ${DEFAULT_VERSION} server`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'bag',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  beforeEach(async () => {
    await run(`fill ${xyz(at(-12, 0, -12))} ${xyz(at(12, 10, 12))} air`)
    await run(`fill ${xyz(at(-12, -1, -12))} ${xyz(at(12, -1, 12))} grass_block`)
    await run('kill @e[type=item]')
    await run(`clear ${USERNAME}`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.inventory.items().length === 0, 100))
  })

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 40), `no ${count} ${item} given`)
  }

  async function setblock (pos: Vec3, block: string): Promise<void> {
    await run(`setblock ${xyz(pos)} ${block}`)
    const name = block.replace(/^minecraft:/, '').replace(/\[.*$/, '')
    assert.ok(await waitUntil(bot, () => bot.blockAt(pos)?.name === name, 40), `no ${name} at ${pos.toString()}`)
  }

  it('stores into a chest with stone over it, the stone broken first (ChestBlock.isChestBlockedAt)', async () => {
    // (26.3 seed 2: the base's one chest under its wall's stone, every store 'windowOpen did not fire')
    await give('cobblestone', 64)
    await give('iron_pickaxe', 1)
    const chest = at(3, 0, 0)
    await setblock(chest, 'chest[facing=west]')
    await setblock(chest.offset(0, 1, 0), 'stone')
    const res = await storeItems(bot, { chest, filter: ['cobblestone'] })
    assert.deepStrictEqual(res.moved, { cobblestone: 64 })
    assert.strictEqual(countItems(bot, 'cobblestone'), 0)
    assert.notStrictEqual(bot.blockAt(chest.offset(0, 1, 0))?.name, 'stone')
  })
})
