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
import { buildPen, herdPen, inPen, leadIntoPen, planPen } from '../../src/skills/pen'
import { placeBlock } from '../../src/skills/placeBlock'
import { WorldMemory } from '../../src/core/memory'
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
    await run(`fill ${xyz(at(-24, 0, -24))} ${xyz(at(24, 6, 24))} air`)
    await run(`fill ${xyz(at(-24, -1, -24))} ${xyz(at(24, -1, 24))} grass_block`)
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
    // (at the block or overlapping it, as navigate takes a goal reached)
    const p = bot.entity.position
    assert.ok(Math.abs(p.x - (pos.x + 0.5)) < 0.8 && Math.abs(p.z - (pos.z + 0.5)) < 0.8 && Math.floor(p.y) === pos.y, `the bot is at ${p.toString()}, not ${pos.toString()}`)
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

  it('herdPen: a pen built near the herd home and remembered, the cows led in; again, the same pen', async () => {
    await give('oak_fence', 32)
    await give('oak_fence_gate', 1)
    await give('wheat', 8)
    const memory = new WorldMemory()
    const home = at(0, 0, 0)
    for (let i = 0; i < 2; i++) await run(`summon cow ${xyz(at(-3 + 6 * i, 0, 3))}`)
    assert.ok(await waitUntil(bot, () => Object.values(bot.entities).filter(e => e.name === 'cow').length === 2, 40))
    const first = await herdPen(bot, { home, memory })
    assert.strictEqual(first.built, true)
    assert.ok(first.inside >= 1, `${first.inside} cows in the pen`)
    assert.strictEqual(open(first.pen.gate), false)
    assert.ok(first.pen.center.distanceTo(home) <= 20)
    const again = await herdPen(bot, { home, memory })
    assert.strictEqual(again.built, false)
    assert.deepStrictEqual(again.pen.gate.toArray(), first.pen.gate.toArray())
    assert.ok(again.inside >= first.inside)
  })

  it('puts the gate in with the bot standing half in its cell (26.3: the gate refused 3 times, no pen)', async () => {
    // the ring up but for the gate, which goes in leaf litter; the bot as it stood on 26.3: its feet's cell the gate's,
    // its box 0.05 into the cell beside it (the reach goal took it as out of the gate's cell)
    await give('oak_fence_gate', 1)
    const center = at(0, 0, 8)
    const plan = planPen(p => bot.blockAt(p) as any, center, 5, 'east')
    for (const p of plan.fences) await run(`setblock ${xyz(p)} oak_fence`)
    await run(`setblock ${xyz(plan.gate)} leaf_litter`)
    assert.ok(await waitUntil(bot, () => plan.fences.every(p => bot.blockAt(p)?.name === 'oak_fence') && bot.blockAt(plan.gate)?.name === 'leaf_litter', 40))
    await run(`tp ${USERNAME} ${plan.gate.x + 0.75} ${plan.gate.y} ${plan.gate.z + 0.67}`)
    assert.ok(await waitUntil(bot, () => Math.abs(bot.entity.position.x - (plan.gate.x + 0.75)) < 0.01, 40))
    // the gate as buildPen puts it (facing out of the pen), then the pen finished: the ring begun kept, nothing on it
    await placeBlock(bot, { pos: plan.gate, item: 'oak_fence_gate', facing: new Vec3(1, 0, 0) })
    const pen = await buildPen(bot, { center, size: 5, side: 'east' })
    assert.strictEqual(pen.placed, 15)
    for (const p of pen.fences) assert.ok(bot.blockAt(p.offset(0, 1, 0))?.name === 'air', `a fence on the fence at ${p.toString()}`)
    assert.ok(pen.gate.equals(plan.gate))
    assert.ok(fenceGates().includes(bot.blockAt(pen.gate)?.name ?? ''), `no gate at ${pen.gate.toString()}: ${bot.blockAt(pen.gate)?.name}`)
    assert.strictEqual(open(pen.gate), false, 'the gate is shut')
  })

  it('puts the gate on another side when a cow stands in its cell and won\'t be pushed off, and the fence there once it can be', async () => {
    await give('oak_fence', 16)
    await give('oak_fence_gate', 1)
    const center = at(0, 0, 8)
    const north = center.offset(0, 0, -2)
    // the cow stands in the gate's cell (NoAI: it neither wanders nor is pushed), till the gate is in elsewhere
    await run(`summon cow ${north.x + 0.5} ${north.y} ${north.z + 0.5} {NoAI:1b}`)
    assert.ok(await waitUntil(bot, () => Object.values(bot.entities).some(e => e.name === 'cow'), 40))
    const middles = [center.offset(2, 0, 0), center.offset(-2, 0, 0), center.offset(0, 0, 2)]
    let freed = false
    const watch = (): void => {
      if (freed || !middles.some(p => fenceGates().includes(bot.blockAt(p)?.name ?? ''))) return
      freed = true
      void run('data merge entity @e[type=cow,limit=1] {NoAI:0b}')
    }
    bot.on('physicsTick', watch)
    try {
      const pen = await buildPen(bot, { center, size: 5, side: 'north' })
      assert.ok(freed, 'the gate went in on another side')
      assert.notStrictEqual(pen.side, 'north')
      assert.ok(fenceGates().includes(bot.blockAt(pen.gate)?.name ?? ''), `no gate at ${pen.gate.toString()}`)
      assert.strictEqual(pen.fences.length, 15)
      for (const p of pen.fences) assert.ok(bot.blockAt(p)?.name.endsWith('_fence'), `no fence at ${p.toString()}: ${bot.blockAt(p)?.name}`)
      assert.ok(pen.fences.some(p => p.equals(north)), 'a fence where the gate was to go')
    } finally {
      bot.removeListener('physicsTick', watch)
    }
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
