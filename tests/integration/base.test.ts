// buildBase on a 1.21.11 superflat with a block of stone where the base goes (as a hillside would be, with holes in it
// where caves and ore were): the room and airlock dug out, the holes in the shell filled, the furniture placed. Then
// creepers ignited at the cells a mob reaches all around it, charged ones among them: every chest is still there with
// what was stored in it, as /data get block reads it.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { BASE_BLUEPRINT, buildBase } from '../../src/base/build'
import { generateBlueprint } from '../../src/base/blueprint'
import { Executor } from '../../src/executor/executor'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/gather'

const USER = 'builder'

/** "... has the following block data: [{count: 5, Slot: 0b, id: "minecraft:diamond"}, ...]" → item → count */
export function parseItems (answer: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of answer.matchAll(/\{([^{}]*)\}/g)) {
    const id = /id: "minecraft:([a-z_]+)"/.exec(m[1])?.[1]
    const count = Number(/count: (\d+)/.exec(m[1])?.[1] ?? 1)
    if (id != null) out[id] = (out[id] ?? 0) + count
  }
  return out
}

describe('the base on a 1.21.11 superflat, against creepers', { timeout: 60 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')

  before(async () => {
    server = await startServer({ flat: true, seed: 'base', difficulty: 'normal', gamerules: { spawn_monsters: false, advance_time: false } })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin())
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('built, recorded, valuables stored, and every chest survives the creepers', async (t) => {
    await run('time set noon')
    const kit: Array<[string, number]> = [
      ['cobblestone', 64], ['chest', 4], ['torch', 8], ['oak_door', 2], ['white_bed', 1], ['crafting_table', 1], ['furnace', 1],
      ['stone_pickaxe', 1], ['stone_shovel', 1], ['diamond', 5], ['raw_iron', 20], ['gold_ingot', 3], ['redstone', 12]
    ]
    for (const [item, n] of kit) await run(`give ${USER} ${item} ${n}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'redstone') === 12 && countItems(bot, 'cobblestone') === 64, 100))

    const start = bot.survival.tasks.tick
    const wall = Date.now()
    const executor = new Executor(bot, { log: line => t.diagnostic(line) })
    const p = bot.entity.position.floored()
    // the stone the base is dug into: the blueprint's box, its outer layer holed in a dozen places
    const origin = { x: p.x + 3, y: p.y, z: p.z + 8 }
    const { min: lo, max: hi } = generateBlueprint({ ...BASE_BLUEPRINT, origin }).bounds
    await run(`fill ${lo.x} ${lo.y} ${lo.z} ${hi.x - 1} ${hi.y - 1} ${hi.z - 1} stone`)
    const holes = [[lo.x, origin.y + 1, lo.z + 4], [hi.x - 1, origin.y, lo.z + 5], [lo.x + 3, hi.y - 1, lo.z + 6], [lo.x + 5, hi.y - 1, lo.z + 7],
      [lo.x + 4, origin.y + 2, hi.z - 1], [lo.x + 1, origin.y + 1, hi.z - 1], [hi.x - 1, origin.y + 2, hi.z - 3], [lo.x + 6, hi.y - 1, hi.z - 2]]
    for (const [x, y, z] of holes) await run(`setblock ${x} ${y} ${z} air`)
    await bot.waitForTicks(20)
    const result = await buildBase(bot, { executor, origin, gather: false })
    t.diagnostic(`built in ${bot.survival.tasks.tick - start} ticks, ${((Date.now() - wall) / 1000).toFixed(1)} s: ${result.dug} dug, ${result.placed} placed`)
    assert.deepStrictEqual(result.missing.map(m => `${m.block} ${m.pos.x} ${m.pos.y} ${m.pos.z}`), [])
    assert.strictEqual(result.chests.length, 4)
    assert.ok(result.safety.safe, result.safety.unsafe.map(u => u.reason).join('\n'))

    // recorded: the base, its chests, table, furnace and bed
    const memory = bot.survival.memory
    assert.deepStrictEqual(memory.base, { ...result.blueprint.options.origin, dimension: 'overworld' })
    assert.strictEqual(memory.knownChests().length, 4)
    for (const kind of ['base_crafting_table', 'base_furnace', 'base_bed', 'base_entrance']) assert.strictEqual(memory.getPois(kind).length, 1, kind)

    // the valuables went in
    const stored: Record<string, number> = {}
    for (const c of memory.knownChests()) for (const [n, k] of Object.entries(c.items)) stored[n] = (stored[n] ?? 0) + k
    for (const item of ['diamond', 'raw_iron', 'gold_ingot', 'redstone']) assert.ok((stored[item] ?? 0) > 0, `no ${item} stored`)
    const before: Record<string, Record<string, number>> = {}
    for (const c of result.chests) before[c.toString()] = parseItems(await run(`data get block ${c.x} ${c.y} ${c.z} Items`))
    const inChests: Record<string, number> = {}
    for (const items of Object.values(before)) for (const [n, k] of Object.entries(items)) inChests[n] = (inChests[n] ?? 0) + k
    assert.deepStrictEqual(inChests, stored, 'the memory has what the chests hold')

    // the bot well away, then a creeper at every third cell around the shell, over the roof and in the airlock
    const { min, max } = result.blueprint.bounds
    await run(`tp ${USER} ${min.x - 40} ${p.y} ${min.z - 40}`)
    await bot.waitForTicks(40)
    // the ring of cells around the box at the floor's level, every fourth (one blast's crater never meets the next
    // one's: the checker's guarantee is for one explosion at a time), and a grid over the roof
    const spots: Vec3[] = []
    const y = result.blueprint.options.origin.y
    const ring: Vec3[] = []
    for (let x = min.x - 1; x < max.x; x++) ring.push(new Vec3(x, y, min.z - 1))
    for (let z = min.z - 1; z < max.z; z++) ring.push(new Vec3(max.x, y, z))
    for (let x = max.x; x > min.x - 1; x--) ring.push(new Vec3(x, y, max.z))
    for (let z = max.z; z > min.z - 1; z--) ring.push(new Vec3(min.x - 1, y, z))
    spots.push(...ring.filter((_, i) => i % 4 === 0))
    for (let x = min.x; x < max.x; x += 4) for (let z = min.z; z < max.z; z += 4) spots.push(new Vec3(x, max.y, z))
    // last, a charged one in the airlock's tunnel between the doors (the safety model lets a mob past one door; an
    // earlier blast there would have taken the inner door with it, and the next one would be two doors in)
    const { path, innerDoor } = result.blueprint.entrance
    const tunnel = path.slice(1, path.findIndex(c => c.x === innerDoor.x && c.z === innerDoor.z))
    assert.ok(tunnel.length > 0)
    const inTunnel = tunnel[tunnel.length - 1]
    spots.push(new Vec3(inTunnel.x, inTunnel.y, inTunnel.z))
    for (const [i, s] of spots.entries()) {
      // every third one charged (power 6), and the one in the tunnel
      const nbt = i % 3 === 0 || i === spots.length - 1 ? '{ignited:1b,Fuse:0s,powered:1b}' : '{ignited:1b,Fuse:0s}'
      await run(`summon creeper ${s.x + 0.5} ${s.y} ${s.z + 0.5} ${nbt}`)
      await bot.waitForTicks(4)
      // which blast it was, if one gets through
      for (const c of result.chests) {
        if (!/Test passed/.test(await run(`execute if block ${c.x} ${c.y} ${c.z} minecraft:chest`))) {
          assert.fail(`the chest at ${c.toString()} went with creeper ${i} at ${s.toString()} (${nbt}); the earlier ones at ${spots.slice(0, i).map(p => p.toString()).join(' ')}`)
        }
      }
    }
    await bot.waitForTicks(20)
    t.diagnostic(`${spots.length} creepers blown up around the base`)

    for (const c of result.chests) {
      const block = await run(`execute if block ${c.x} ${c.y} ${c.z} minecraft:chest`)
      assert.match(block, /Test passed/, `the chest at ${c.toString()} is gone`)
      assert.deepStrictEqual(parseItems(await run(`data get block ${c.x} ${c.y} ${c.z} Items`)), before[c.toString()], `the chest at ${c.toString()} lost items`)
    }
  })
})
