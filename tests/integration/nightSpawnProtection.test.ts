// The night at the world spawn of a real server with spawn protection (SURVIVAL_VERSION, default 1.21.11):
// spawn-protection 16 and an op on the server (ops.json: vanilla keeps the square only while the server has one,
// DedicatedServer.isUnderSpawnProtection), the bot no op, bare, at the spawn at midnight on a superflat of grass, 3 dirt
// and 10 stone. The night reflex's shelter is dug out of the square (26.3 learns it from the action bar's first
// refusal, 1.21.11 from two digs put back), its blocks on the server. The bot in the browser on a server with spawn
// protection stood the night at the spawn in the open and died: its shelter's digs there were refused every 20 ticks.
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
import { isEnclosed } from '../../src/skills/shelter'
import { waitUntil } from '../../src/skills/util'
import { spawnDistance, spawnProtectionState } from '../../src/skills/spawnProtection'

const USERNAME = 'nightprot'
const RADIUS = 16

/** an offline player's UUID (UUIDUtil.createOfflinePlayerUUID: a name-based v3 UUID of "OfflinePlayer:<name>") */
function offlineUuid (name: string): string {
  const b = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  b[6] = (b[6] & 0x0f) | 0x30
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

describe(`the night at the spawn of a ${DEFAULT_VERSION} server with spawn protection`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    const ops = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nightprot-')), 'ops.json')
    fs.writeFileSync(ops, JSON.stringify([{ uuid: offlineUuid('admin'), name: 'admin', level: 4, bypassesPlayerLimit: false }]))
    server = await startServer({
      flat: true,
      seed: 'nightprot',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
      properties: {
        'spawn-protection': RADIUS,
        // (a shelter's column: 3 blocks dug and 3 solid under its floor, more than the classic superflat's 3)
        'generator-settings': JSON.stringify({
          layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:stone', height: 10 }, { block: 'minecraft:dirt', height: 3 }, { block: 'minecraft:grass_block', height: 1 }],
          biome: 'minecraft:plains'
        })
      },
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

  it('digs its night\'s shelter out of the square, not stood at the spawn', async () => {
    const spawn = (bot as any).spawnPoint as Vec3
    const ground = Math.floor(bot.entity.position.y)
    await run(`tp ${USERNAME} ${spawn.x + 0.5} ${ground} ${spawn.z + 0.5}`)
    await run('time set 18000')
    const lookup = (p: Vec3): any => bot.blockAt(p)
    const shut = await waitUntil(bot, () => isEnclosed(lookup, bot.entity.position.floored()), 3000)
    const feet = bot.entity.position.floored()
    const state = spawnProtectionState(bot)
    console.log(`night at the spawn: ${shut ? 'shut in' : 'not shut in'} at ${feet.toString()}, ${spawnDistance(bot, feet)} off the spawn ${String(spawn)}; the square learnt: radius ${String(state?.radius)}`)
    assert.ok(shut, `not in a shelter at ${feet.toString()}`)
    assert.ok(spawnDistance(bot, feet) > RADIUS, `the shelter at ${feet.toString()} in the square`)
    // the server's world: the hole dug and sealed there
    assert.match(await run(`execute if block ${feet.x} ${feet.y} ${feet.z} minecraft:air`), /passed/i)
    assert.doesNotMatch(await run(`execute if block ${feet.x} ${feet.y + 2} ${feet.z} minecraft:air`), /passed/i)
  })
})
