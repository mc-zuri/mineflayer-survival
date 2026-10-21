// The herd kept for food against a real server (SURVIVAL_VERSION, default 1.21.11) (the tests/harness lockstep server
// and bot), on a superflat patch: the herd step builds a pen near home of fences crafted through the planner and leads
// the wild cows about into it; a herd of two cows in a pen with wheat grows over the days it's tended (bred as the
// cooldown allows) and gives cooked beef from its surplus, its breeders kept (BREEDERS_KEPT).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/gather'
import { buildPen, inPen, penFromMemory, rememberPen } from '../../src/skills/pen'
import { herdFromMemory, rememberHerd } from '../../src/skills/herd'
import { isAdult } from '../../src/skills/husbandry'
import { WorldMemory } from '../../src/core/memory'
import { Executor } from '../../src/executor/executor'
import { startHerd, tendHerd } from '../../src/milestones'

const USERNAME = 'herdbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`a herd kept for food on a ${DEFAULT_VERSION} server`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  const open = (pos: Vec3): boolean | undefined => (bot.blockAt(pos)?.getProperties() as any)?.open
  const cows = (): any[] => Object.values(bot.entities).filter(e => e.name === 'cow')
  const log = (line: string): void => { if (process.env.HERD_LOG != null) console.log(`[herd] t${(bot as any).survival?.tasks?.tick ?? 0} ${line}`) }

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'herd',
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
    await run(`fill ${xyz(at(-32, 0, -32))} ${xyz(at(32, 6, 32))} air`)
    await run(`fill ${xyz(at(-32, -1, -32))} ${xyz(at(32, -1, 32))} grass_block`)
    await run('kill @e[type=item]')
    await run('kill @e[type=cow]')
    await run(`clear ${USERNAME}`)
    await run('time set 1000')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    const settled = await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1 && bot.inventory.items().length === 0 && cows().length === 0, 100)
    assert.ok(settled, `the bot is at ${bot.entity.position.toString()}`)
  })

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 40), `no ${count} ${item} given`)
  }

  it('the herd step builds a pen near home of fences crafted through the planner and leads the wild cows in', async () => {
    await give('oak_log', 16)
    await give('crafting_table', 1)
    await give('wheat', 8)
    const memory = new WorldMemory()
    memory.setBase(origin)
    const executor = new Executor(bot, { memory, log })
    // three wild cows about home, 10 to 20 blocks off
    for (const [dx, dz] of [[-12, 4], [6, -14], [18, 10]]) await run(`summon cow ${xyz(at(dx, 0, dz))}`)
    assert.ok(await waitUntil(bot, () => cows().length === 3, 40))
    const lines: string[] = []
    const started = await startHerd(bot, executor, new AbortController().signal, l => { lines.push(l); log(l) })
    assert.ok(started, lines.join('\n'))
    const herd = herdFromMemory(memory)
    assert.ok(herd != null && herd.mob === 'cow', lines.join('\n'))
    const pen = penFromMemory(memory, herd.pos, 4)
    assert.ok(pen != null, 'the pen remembered')
    assert.ok(pen.center.distanceTo(origin) <= 24, `the pen at ${pen.center.toString()}`)
    for (const p of pen.fences) assert.ok(bot.blockAt(p)?.name.endsWith('_fence'), `no fence at ${p.toString()}: ${bot.blockAt(p)?.name}`)
    assert.strictEqual(open(pen.gate), false, 'the gate is shut')
    assert.ok(!inPen(pen, bot.entity.position), 'the bot is out')
    const inside = cows().filter(e => inPen(pen, e.position)).length
    assert.ok(inside >= 2, `${inside} cows in the pen: ${cows().map(e => e.position.floored().toString()).join(', ')}, the bot at ${bot.entity.position.floored().toString()}\n${lines.join('\n')}`)
    // they stay in (one in the gate's cell as it shut may come in after)
    await bot.waitForTicks(200)
    assert.ok(cows().filter(e => inPen(pen, e.position)).length >= inside, 'none got out')
  })

  it('from two cows in a pen with wheat, the herd grows and gives cooked beef over the days it is tended, its breeders kept', async () => {
    await give('oak_fence', 24)
    await give('oak_fence_gate', 1)
    await give('wheat', 32)
    await give('furnace', 1)
    await give('coal', 16)
    await give('iron_sword', 1)
    // (the furnace put down for the cooking is picked up again with it)
    await give('stone_pickaxe', 1)
    const memory = new WorldMemory()
    memory.setBase(origin)
    const executor = new Executor(bot, { memory, log })
    const pen = await buildPen(bot, { center: at(0, 0, 8), size: 7, side: 'north' })
    rememberPen(memory, pen)
    for (const dx of [-1, 1]) await run(`summon cow ${xyz(pen.center.offset(dx, 0, 1))}`)
    assert.ok(await waitUntil(bot, () => cows().filter(e => inPen(pen, e.position)).length === 2, 40))
    rememberHerd(memory, { pos: pen.center, mob: 'cow', adults: 2, calves: 0, bred: null })
    const lines: string[] = []
    const penned = (): { adults: number, calves: number } => {
      const inside = cows().filter(e => inPen(pen, e.position))
      return { adults: inside.filter(e => isAdult(bot, e)).length, calves: inside.filter(e => !isAdult(bot, e)).length }
    }
    let most = 0
    // a tending each breeding cooldown (the runner's between trips), wanting more food than the herd has
    for (let round = 0; round < 8 && countItems(bot, 'cooked_beef') < 2; round++) {
      await tendHerd(bot, executor, new AbortController().signal, l => { lines.push(l); log(l) }, { want: 64 })
      const now = penned()
      most = Math.max(most, now.adults + now.calves)
      assert.ok(now.adults >= 2, `${now.adults} adults left in the pen after round ${round}: ${cows().map(e => `${isAdult(bot, e) ? 'cow' : 'calf'} ${e.position.floored().toString()}`).join(', ')}, pen ${pen.center.toString()}\n${lines.join('\n')}`)
      assert.strictEqual(open(pen.gate), false, `the gate left open after round ${round}`)
      assert.ok(!inPen(pen, bot.entity.position), 'the bot is out of the pen')
      await bot.waitForTicks(6000)
    }
    assert.ok(most >= 3, `the herd grew to ${most}\n${lines.join('\n')}`)
    assert.ok(countItems(bot, 'cooked_beef') >= 2, `${countItems(bot, 'cooked_beef')} cooked beef\n${lines.join('\n')}`)
    assert.ok(penned().adults >= 2, 'the breeders kept')
  })
})
