// Leaves on a real server (SURVIVAL_VERSION, default 1.21.11): the bot's world, and the pathfinder's cache of it,
// against the server's blocks. A tree's leaves decaying once its trunk is gone (LeavesBlock.randomTick, many a tick
// at a high random_tick_speed: the server sends them in section updates, ClientboundSectionBlocksUpdatePacket, as much
// as one by one), and leaves the server won't let be broken (spawn protection: a dig's START answered with the block
// as it is, its STOP with the acknowledgement alone) dug by hand and with shears (an instant break, the client's
// prediction put back by the acknowledgement), with mineflayer's dig and with mineflayer-mouse's left click. Each
// cell is checked on the server (execute if block). A bot in the browser was stuck on leaves.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { dig } from '../../src/core/actions'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { waitUntil } from '../../src/skills/util'

// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61
const RADIUS = 16
const LEAVES = 'oak_leaves[persistent=true]'

/** an offline player's UUID (UUIDUtil.createOfflinePlayerUUID: a name-based v3 UUID of "OfflinePlayer:<name>") */
function offlineUuid (name: string): string {
  const b = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  b[6] = (b[6] & 0x0f) | 0x30
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

describe(`leaves on a ${DEFAULT_VERSION} server`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    // spawn protection is kept only while the server has an op (DedicatedServer.isUnderSpawnProtection)
    const ops = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leaves-')), 'ops.json')
    fs.writeFileSync(ops, JSON.stringify([{ uuid: offlineUuid('admin'), name: 'admin', level: 4, bypassesPlayerLimit: false }]))
    server = await startServer({
      flat: true,
      seed: 'leaves',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
      properties: { 'spawn-protection': RADIUS },
      files: { 'ops.json': ops }
    })
  })

  after(async () => {
    if (server != null) await server.cleanup()
  })

  for (const [mouse, tool] of [[false, ''], [false, 'shears'], [true, ''], [true, 'shears']] as Array<[boolean, string]>) {
    const how = tool === '' ? 'by hand' : 'with shears'
    describe(`${mouse ? 'with mineflayer-mouse' : 'with mineflayer\'s dig'}, ${how}`, () => {
      // (a bot for each: what one learns of the refusals, skills/spawnProtection, the next doesn't know)
      const username = `${mouse ? 'mouse' : 'dig'}${tool === '' ? 'hand' : 'shears'}`
      let bot: Bot
      let spawn: Vec3

      /** the cells of the box from `a` to `b` whose block the bot's world, the cache or the server has otherwise */
      const disagreements = async (a: Vec3, b: Vec3): Promise<string[]> => {
        const out: string[] = []
        for (let x = a.x; x <= b.x; x++) {
          for (let y = a.y; y <= b.y; y++) {
            for (let z = a.z; z <= b.z; z++) {
              const pos = new Vec3(x, y, z)
              const mine = bot.blockAt(pos)?.name ?? 'none'
              const cached = (bot.pathfinder.world as any).peekBlockInfo?.(pos)?.block?.name
              if (cached != null && cached !== mine) out.push(`${pos.toString()}: the cache's ${String(cached)}, the world's ${mine}`)
              if (!/passed/i.test(await run(`execute if block ${xyz(pos)} minecraft:${mine}`))) out.push(`${pos.toString()}: the bot's ${mine}, not the server's`)
            }
          }
        }
        return out
      }

      /** every cell of the box read into the pathfinder's cache, as a search reads them */
      const readIntoCache = (a: Vec3, b: Vec3): void => {
        for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) for (let z = a.z; z <= b.z; z++) bot.pathfinder.world.getBlockInfo(new Vec3(x, y, z))
      }

      const give = async (item: string): Promise<void> => {
        await run(`clear ${username}`)
        if (item !== '') {
          await run(`give ${username} ${item} 1`)
          assert.ok(await waitUntil(bot, () => bot.inventory.items().some(i => i.name === item), 40), `no ${item}`)
          await bot.equip(bot.inventory.items().find(i => i.name === item) as any, 'hand')
        }
      }

      before(async () => {
        bot = await connectLockstepBot(server, { username, op: false })
        await bot.waitForChunksToLoad()
        if (mouse) {
          const { createMouse } = require('mineflayer-mouse')
          bot.loadPlugin(createMouse({}))
        }
        bot.loadPlugin(createPlugin({ reflexes: false }))
        spawn = (bot as any).spawnPoint as Vec3
      })

      after(async () => {
        if (bot != null) await quitBot(bot)
      })

      it('a tree\'s leaves decaying once its trunk is gone: the bot\'s world and the cache as the server\'s', { skip: tool !== '' }, async () => {
        const base = new Vec3(spawn.x + 40 + (mouse ? 20 : 0), GROUND + 1, spawn.z)
        const lo = base.offset(-3, 0, -3)
        const hi = base.offset(3, 7, 3)
        await run(`tp ${username} ${base.x + 6.5} ${base.y} ${base.z + 0.5}`)
        assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(base.offset(6.5, 0, 0.5)) < 1 && bot.blockAt(base) != null, 200), 'not there')
        // a trunk and a canopy round it, its leaves' distance from the log as LeavesBlock.updateDistance has it
        await run(`fill ${xyz(base)} ${xyz(base.offset(0, 5, 0))} oak_log`)
        await run(`fill ${xyz(base.offset(-2, 3, -2))} ${xyz(base.offset(2, 4, 2))} oak_leaves replace air`)
        await run(`fill ${xyz(base.offset(-1, 5, -1))} ${xyz(base.offset(1, 6, 1))} oak_leaves replace air`)
        assert.ok(await waitUntil(bot, () => bot.blockAt(base.offset(2, 4, 2))?.name === 'oak_leaves' && bot.blockAt(base.offset(0, 6, 0))?.name === 'oak_leaves', 100), 'no tree')
        // (the leaves' distances settle: a leaf set by /fill is 7 till its scheduled tick)
        await bot.waitForTicks(20)
        assert.deepStrictEqual(await disagreements(lo, hi), [])
        readIntoCache(lo, hi)

        let sections = 0
        let singles = 0
        const onSections = (): void => { sections++ }
        const onSingle = (): void => { singles++ }
        bot._client.on('multi_block_change', onSections)
        bot._client.on('block_change', onSingle)
        try {
          await run('gamerule random_tick_speed 1000')
          await run(`fill ${xyz(base)} ${xyz(base.offset(0, 5, 0))} air`)
          const leaves = (): number => {
            let n = 0
            for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) if (bot.blockAt(new Vec3(x, y, z))?.name === 'oak_leaves') n++
            return n
          }
          assert.ok(await waitUntil(bot, () => leaves() === 0, 1200), `${leaves()} leaves left`)
        } finally {
          await run('gamerule random_tick_speed 3')
          bot._client.off('multi_block_change', onSections)
          bot._client.off('block_change', onSingle)
        }
        console.log(`leaves: decayed in ${sections} section updates and ${singles} block updates`)
        await bot.waitForTicks(10)
        assert.deepStrictEqual(await disagreements(lo, hi), [])
      })

      it(`leaves the server won't let be broken (spawn protection), dug ${how}: put back in the bot's world and the cache`, async () => {
        const at = (dx: number, dy: number, dz: number): Vec3 => new Vec3(spawn.x + dx, GROUND + 1 + dy, spawn.z + dz)
        await run(`fill ${xyz(at(-6, 0, -6))} ${xyz(at(10, 6, 6))} air`)
        await run(`tp ${username} ${spawn.x + 0.5} ${GROUND + 1} ${spawn.z + 0.5} -90 0`)
        assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(at(0.5, 0, 0.5)) < 0.5 && bot.entity.onGround, 200), 'not at the spawn')
        await give(tool)
        // a room of leaves about the goal, too high to jump over; a leaf beside the bot
        await run(`fill ${xyz(at(5, 0, -2))} ${xyz(at(9, 3, 2))} ${LEAVES} hollow`)
        await run(`setblock ${xyz(at(2, 1, -3))} ${LEAVES}`)
        assert.ok(await waitUntil(bot, () => bot.blockAt(at(2, 1, -3))?.name === 'oak_leaves' && bot.blockAt(at(9, 3, 2))?.name === 'oak_leaves', 100), 'no leaves')
        readIntoCache(at(-1, 0, -4), at(10, 4, 4))
        // the room's leaves the bot's world had broken, and had back
        let gone = 0
        let back = 0
        const onBlock = (old: any, now: any): void => {
          if (old?.name === 'oak_leaves' && now?.name === 'air') gone++
          if (old?.name === 'air' && now?.name === 'oak_leaves') back++
        }
        bot.on('blockUpdate', onBlock)

        // the pathfinder's way into the room: its breaks refused, the walk fails, the leaves where they were
        const goal = new goals.GoalBlock(at(7, 0, 0).x, at(7, 0, 0).y, at(7, 0, 0).z)
        const failed: string[] = []
        const onFail = (info: any): void => { failed.push(String(info?.error)) }
        ;(bot as any).on('pathfinderMoveFailed', onFail)
        let walked: unknown
        try {
          const walk = bot.pathfinder.goto(goal).then(() => 'resolved', (err: unknown) => err)
          await Promise.race([walk.then(r => { walked = r }), waitUntil(bot, () => failed.length >= 3, 1200)])
          await bot.pathfinder.cancel()
          await Promise.race([walk, bot.waitForTicks(200)])
        } finally {
          ;(bot as any).off('pathfinderMoveFailed', onFail)
        }
        console.log(`leaves: the walk ${how} ended with ${String((walked as any)?.message ?? walked)}, ${failed.length} moves failed: ${failed.slice(0, 3).join('; ')}`)

        // the survival's own dig of the leaf: refused, the leaf back
        let digError: unknown = null
        try {
          await dig(bot, bot.blockAt(at(2, 1, -3)) as any)
        } catch (err) {
          digError = err
        }
        await bot.waitForTicks(10)
        bot.off('blockUpdate', onBlock)
        console.log(`leaves: the dig ${how} ended with ${digError == null ? 'no error' : String((digError as Error).message ?? digError)}; ${gone} leaves broken in the bot's world, ${back} put back`)
        assert.ok(!goal.isEnd(bot.entity.position.floored() as any), `in the room at ${bot.entity.position.toString()}`)
        assert.deepStrictEqual(await disagreements(at(1, 0, -3), at(9, 3, 2)), [])
      })
    })
  }
})
