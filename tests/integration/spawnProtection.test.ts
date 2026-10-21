// Spawn protection on a real server (SURVIVAL_VERSION, default 1.21.11): spawn-protection 16 and an op on the server
// (ops.json: vanilla keeps the square only while the server has one, DedicatedServer.isUnderSpawnProtection), the bot
// no op at the world spawn. A row of stone in the square by it and another out of it: collectBlock's first targets are
// refused and put back (26.3 says so on the action bar, 1.21.11 nothing), the square learnt, and the stone got from
// the row outside, the one in the square left. Then a crafting table for a wooden pickaxe goes down out of the square.
// A bot in the browser on a server with spawn protection was stuck at 'survival: stone (step:kill 2 cow for 4 beef)'.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { collectBlock } from '../../src/skills/collectBlock'
import { craft } from '../../src/skills/craft'
import { countItems, waitUntil } from '../../src/skills/util'
import { spawnDistance, spawnProtectionState } from '../../src/skills/spawnProtection'

const USERNAME = 'protbot'
const RADIUS = 16

/** an offline player's UUID (UUIDUtil.createOfflinePlayerUUID: a name-based v3 UUID of "OfflinePlayer:<name>") */
function offlineUuid (name: string): string {
  const b = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  b[6] = (b[6] & 0x0f) | 0x30
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

describe(`spawn protection on a ${DEFAULT_VERSION} server`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    const ops = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spawnprot-')), 'ops.json')
    fs.writeFileSync(ops, JSON.stringify([{ uuid: offlineUuid('admin'), name: 'admin', level: 4, bypassesPlayerLimit: false }]))
    server = await startServer({
      flat: true,
      seed: 'spawnprot',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
      properties: { 'spawn-protection': RADIUS },
      files: { 'ops.json': ops }
    })
    bot = await connectLockstepBot(server, { username: USERNAME, op: false })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('gets its stone out of the square, the stone in it left, and puts its crafting table down out of it', async () => {
    const spawn = (bot as any).spawnPoint as Vec3
    const ground = Math.floor(bot.entity.position.y)
    const inside = [3, 4, 5, 6].map(dx => new Vec3(spawn.x + dx, ground, spawn.z))
    const outside = [24, 25, 26, 27, 28].map(dx => new Vec3(spawn.x + dx, ground, spawn.z))
    for (const p of [...inside, ...outside]) await run(`setblock ${p.x} ${p.y} ${p.z} minecraft:stone`)
    await run(`give ${USERNAME} wooden_pickaxe 1`)
    await run(`tp ${USERNAME} ${spawn.x + 0.5} ${ground} ${spawn.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'wooden_pickaxe') > 0 && bot.blockAt(outside[0])?.name === 'stone', 200), 'no kit')

    const res = await collectBlock(bot, { names: ['stone'], count: 3, maxDistance: 40 })
    const state = spawnProtectionState(bot)
    console.log(`spawn protection: ${res.mined} mined at ${res.positions.map(p => p.toString()).join(' ')}; the square learnt: radius ${String(state?.radius)}; ${countItems(bot, 'cobblestone')} cobblestone`)
    assert.ok((state?.radius ?? 0) >= RADIUS, 'the square not learnt')
    assert.ok(countItems(bot, 'cobblestone') >= 3, `${countItems(bot, 'cobblestone')} cobblestone`)
    for (const p of res.positions) assert.ok(spawnDistance(bot, p) > RADIUS, `${p.toString()} mined in the square`)
    // the server's world: the stone in the square still there
    const left = await run(`execute if block ${inside[0].x} ${inside[0].y} ${inside[0].z} minecraft:stone`)
    assert.match(left, /passed/i)

    // a crafting table for a wooden pickaxe, from the spawn: down out of the square
    await run(`give ${USERNAME} oak_planks 8`)
    await run(`give ${USERNAME} stick 4`)
    await run(`give ${USERNAME} crafting_table 1`)
    await run(`tp ${USERNAME} ${spawn.x + 0.5} ${ground} ${spawn.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'crafting_table') > 0 && bot.entity.position.distanceTo(spawn.offset(0.5, 0, 0.5)) < 4, 200), 'no planks')
    const before = countItems(bot, 'wooden_pickaxe')
    const made = await craft(bot, { item: 'wooden_pickaxe' })
    console.log(`spawn protection: the table at ${String(made.table)} (placed ${String(made.placedTable)}), ${made.crafted} crafted`)
    assert.ok(made.table != null && spawnDistance(bot, made.table) > RADIUS + 1, `the table at ${String(made.table)}`)
    assert.ok(countItems(bot, 'wooden_pickaxe') > before)
  })
})
