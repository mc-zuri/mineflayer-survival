// A pen and a house door against a real server (SURVIVAL_VERSION, default 1.21.11) (the tests/harness lockstep server
// and bot), on a superflat patch: the pen built of fences crafted through the planner, walked into and out of by its
// gate (opened and shut behind the bot by the pathfinder), the cows led in and shut in; a house walked into and out of
// by its door.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, navigate, waitUntil } from '../../src/skills/gather'
import { buildPen, inPen, leadIntoPen } from '../../src/skills/pen'
import { Executor } from '../../src/executor/executor'

const USERNAME = 'penbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`a pen and a door on a ${DEFAULT_VERSION} server`, { timeout: 15 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  const open = (pos: Vec3): boolean | undefined => (bot.blockAt(pos)?.getProperties() as any)?.open
  const fenceGates = (): string[] => bot.registry.itemsArray.map(i => i.name).filter(n => n.endsWith('_fence_gate'))

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'pen',
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
    await run(`fill ${xyz(at(-16, 0, -16))} ${xyz(at(16, 6, 16))} air`)
    await run(`fill ${xyz(at(-16, -1, -16))} ${xyz(at(16, -1, 16))} grass_block`)
    await run('kill @e[type=item]')
    await run('kill @e[type=cow]')
    await run(`clear ${USERNAME}`)
    await run('time set 1000')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    const settled = await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.inventory.items().length === 0, 100)
    assert.ok(settled, `the bot is at ${bot.entity.position.toString()}`)
  })

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 40), `no ${count} ${item} given`)
  }

  async function goTo (pos: Vec3): Promise<void> {
    await navigate(bot, { goal: new goals.GoalBlock(pos.x, pos.y, pos.z) })
    const feet = bot.entity.position.floored()
    assert.ok(feet.equals(pos), `the bot is at ${bot.entity.position.toString()}, not ${pos.toString()}`)
  }

  it('builds a pen of fences crafted through the planner, walks in and out by its gate and shuts it behind it each time', async () => {
    // the planks of the fences and the gate (a 7 × 7 ring: 23 fences, 8 crafts of 3 from 4 planks and 2 sticks)
    await give('oak_log', 16)
    await give('crafting_table', 1)
    const executor = new Executor(bot, { log: () => {} })
    const center = at(0, 0, 8)
    const pen = await buildPen(bot, { center, size: 7, side: 'north', obtain: async (reqs, s) => await executor.obtain(reqs, s) })
    assert.strictEqual(pen.fences.length, 23)
    for (const p of pen.fences) assert.ok(bot.blockAt(p)?.name.endsWith('_fence'), `no fence at ${p.toString()}: ${bot.blockAt(p)?.name}`)
    assert.ok(fenceGates().includes(bot.blockAt(pen.gate)?.name ?? ''), `no gate at ${pen.gate.toString()}`)
    assert.strictEqual(open(pen.gate), false, 'the gate is shut')

    // in by the gate, shut behind the bot
    await goTo(center)
    assert.ok(inPen(pen, bot.entity.position))
    assert.strictEqual(open(pen.gate), false, 'the gate is shut behind the bot going in')
    for (const p of pen.fences) assert.ok(bot.blockAt(p)?.name.endsWith('_fence'), `the fence at ${p.toString()} was broken`)

    // and out again
    await goTo(at(0, 0, 0))
    assert.ok(!inPen(pen, bot.entity.position))
    assert.strictEqual(open(pen.gate), false, 'the gate is shut behind the bot going out')
    for (const p of pen.fences) assert.ok(bot.blockAt(p)?.name.endsWith('_fence'), `the fence at ${p.toString()} was broken`)
  })

  it('leads the cows into the pen with wheat and shuts them in', async () => {
    await give('oak_fence', 24)
    await give('oak_fence_gate', 1)
    await give('wheat', 8)
    const center = at(0, 0, 8)
    const pen = await buildPen(bot, { center, size: 7, side: 'north' })
    for (let i = 0; i < 3; i++) await run(`summon cow ${xyz(at(-6 + 6 * i, 0, -6))}`)
    assert.ok(await waitUntil(bot, () => Object.values(bot.entities).filter(e => e.name === 'cow').length === 3, 40))
    const inside = await leadIntoPen(bot, pen, { mob: 'cow' })
    assert.ok(inside >= 2, `${inside} cows in the pen`)
    assert.strictEqual(open(pen.gate), false, 'the gate is shut on them')
    assert.ok(!inPen(pen, bot.entity.position), 'the bot is out')
    // they stay in
    await bot.waitForTicks(200)
    const still = Object.values(bot.entities).filter(e => e.name === 'cow' && inPen(pen, e.position)).length
    assert.strictEqual(still, inside)
  })

  it('walks into a house by its door and out again; the door is shut behind it by night', async () => {
    // a 5 × 5 stone hut at (-2..2, 8..12), its floor the ground, its door in the north wall at (0, 8)
    const lo = at(-2, -1, 8)
    const hi = at(2, 3, 12)
    await run(`fill ${xyz(lo)} ${xyz(hi)} stone hollow`)
    const door = at(0, 0, 8)
    await run(`setblock ${xyz(door)} oak_door[facing=south,half=lower,hinge=left,open=false]`)
    await run(`setblock ${xyz(door.offset(0, 1, 0))} oak_door[facing=south,half=upper,hinge=left,open=false]`)
    assert.ok(await waitUntil(bot, () => bot.blockAt(door)?.name === 'oak_door' && bot.blockAt(door.offset(0, 1, 0))?.name === 'oak_door', 40), `the door: ${bot.blockAt(door)?.name}, ${bot.blockAt(door.offset(0, 1, 0))?.name}`)
    await bot.waitForTicks(5)
    // stone can't be dug without a pickaxe in reasonable time: the way in is the door
    const inside = at(0, 0, 10)
    await goTo(inside)
    assert.strictEqual(bot.blockAt(door)?.name, 'oak_door', 'the door is not dug')
    assert.strictEqual(open(door), true, 'left open by day')

    await goTo(at(0, 0, 5))
    assert.strictEqual(bot.blockAt(door)?.name, 'oak_door')

    // by night, the door shut again: opened, and shut behind the bot, each way
    await run('time set 18000')
    await run(`setblock ${xyz(door)} oak_door[facing=south,half=lower,hinge=left,open=false]`)
    await run(`setblock ${xyz(door.offset(0, 1, 0))} oak_door[facing=south,half=upper,hinge=left,open=false]`)
    assert.ok(await waitUntil(bot, () => (bot.time as any).isDay === false && open(door) === false, 40))
    await goTo(inside)
    assert.strictEqual(open(door), false, 'shut behind the bot going in by night')
    await goTo(at(0, 0, 5))
    assert.strictEqual(bot.blockAt(door)?.name, 'oak_door')
    assert.strictEqual(open(door), false, 'shut behind it going out by night')
  })
})
