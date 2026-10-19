// The bag down a mine against a real server (SURVIVAL_VERSION): what the bot stores, stashes and throws away when its
// inventory fills with the stone of its own route, and what it never picks up again.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { storeItems } from '../../src/skills/chest'
import { countItems, emptySlots, waitUntil } from '../../src/skills/util'
import { DEPOT_POI, Executor } from '../../src/executor/executor'

const USERNAME = 'bagbot'

/** a chest's items from `data get block ... Items` */
function parseItems (answer: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of answer.matchAll(/\{([^{}]*)\}/g)) {
    const id = /id: "minecraft:([a-z_]+)"/.exec(m[1])?.[1]
    const count = Number(/count: (\d+)/.exec(m[1])?.[1] ?? 1)
    if (id != null) out[id] = (out[id] ?? 0) + count
  }
  return out
}
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

  /** solid stone round the origin (a mine), with a two-high tunnel along +x from it, `length` long */
  async function mine (length: number): Promise<void> {
    await run(`fill ${xyz(at(-6, -1, -6))} ${xyz(at(26, 5, 6))} stone`)
    await run(`fill ${xyz(at(0, 0, 0))} ${xyz(at(length, 1, 0))} air`)
    await run('kill @e[type=item]')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(at(1, 2, 0))?.name === 'stone' && bot.blockAt(at(length, 0, 0))?.name === 'air', 100))
  }

  it('puts down a depot chest in a nook off a one-wide tunnel (a chest crafted from the bag\'s logs) and stashes what isn\'t kept in it', async (t) => {
    await mine(10)
    await run(`tp ${USERNAME} ${origin.x + 5.5} ${origin.y} ${origin.z + 0.5} -90 0`)
    // 35 slots: the bag a slot short of its 2 free
    for (const [item, n] of [['cobblestone', 64], ['oak_log', 4], ['crafting_table', 1], ['diamond_pickaxe', 1], ['leather', 5], ['white_wool', 3], ['diamond', 2], ['raw_iron', 28 * 64]] as const) await give(item, n)
    assert.strictEqual(emptySlots(bot), 1)
    const lines: string[] = []
    const executor = new Executor(bot, { log: line => { lines.push(line); t.diagnostic(line) }, stocked: () => false })
    await executor.makeRoom()
    const depots = bot.survival.memory.getPois(DEPOT_POI)
    assert.strictEqual(depots.length, 1, lines.join(' | '))
    const d = depots[0]
    assert.strictEqual(bot.blockAt(new Vec3(d.x, d.y, d.z))?.name, 'chest')
    // in the wall beside the tunnel, not in it
    assert.notStrictEqual(d.z, origin.z)
    const inChest = parseItems(await run(`data get block ${d.x} ${d.y} ${d.z} Items`))
    assert.deepStrictEqual(inChest, bot.survival.memory.chestAt(d)?.items, 'the memory has what the chest holds')
    assert.ok((inChest.raw_iron ?? 0) >= 20 * 64, JSON.stringify(inChest))
    assert.ok(emptySlots(bot) >= 2, `${emptySlots(bot)} slots free`)
    // (and what digging the nook dropped)
    assert.ok(countItems(bot, 'cobblestone') >= 64)
    assert.strictEqual(countItems(bot, 'diamond_pickaxe'), 1)
  })
})
