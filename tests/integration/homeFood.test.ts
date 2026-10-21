// The home's food against a real server (SURVIVAL_VERSION, default 1.21.11), on a superflat's grass with no water
// and no animal by home: the farm started (startFarm: a water hole dug where the grass is, from the water bucket held,
// 12 plots tilled and sown), its wheat grown with the random ticks sped up (the scenario's only: random_tick_speed),
// harvested, sown again and grown from its seeds (its rows with bare farmland between), and baked (keepFarm); then two cows seen 60 blocks off (noteAnimals,
// the bot gone by them) fetched and led home into a pen built there (startHerd's fetchHerd), and bred.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/gather'
import { inPen, penFromMemory } from '../../src/skills/pen'
import { herdFromMemory, rememberedAnimals } from '../../src/skills/herd'
import { breedAnimals } from '../../src/skills/husbandry'
import { farmCells, grownPlots, knownFarms, spacerCells } from '../../src/skills/farm'
import { WorldMemory } from '../../src/core/memory'
import { Executor } from '../../src/executor/executor'
import { keepFarm, startFarm, startHerd } from '../../src/milestones'

const USERNAME = 'homebot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`the home's food on a ${DEFAULT_VERSION} server`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let memory: WorldMemory
  let executor: Executor

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  const cows = (): any[] => Object.values(bot.entities).filter(e => e.name === 'cow')
  const lines: string[] = []
  const log = (line: string): void => { lines.push(line); if (process.env.HOME_FOOD_LOG != null) console.log(`[home] t${(bot as any).survival?.tasks?.tick ?? 0} ${line}`) }

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 40), `no ${count} ${item} given`)
  }

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'homefood',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false, random_tick_speed: 0 },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    await run('kill @e[type=cow]')
    await run('time set 1000')
    memory = new WorldMemory()
    memory.setBase(origin)
    executor = new Executor(bot, { memory, log })
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it('a farm by a water hole dug in the grass, grown, harvested, sown further and baked into bread', async () => {
    await give('water_bucket', 1)
    await give('wooden_hoe', 1)
    await give('wheat_seeds', 12)
    await give('crafting_table', 1)
    assert.ok(await startFarm(bot, executor, new AbortController().signal, log), lines.join('\n'))
    const farm = knownFarms(memory)[0]
    assert.ok(farm != null, 'the farm remembered')
    assert.strictEqual(bot.blockAt(farm.water)?.name, 'water', `no water at ${farm.water.toString()}`)
    const cells = farmCells(farm)
    assert.ok(cells.length >= 10, `${cells.length} sown`)
    for (const c of cells) assert.strictEqual(bot.blockAt(c.offset(0, 1, 0))?.name, 'wheat', `nothing sown on ${c.toString()}`)
    // the rows between the crops tilled and bare
    const bare = spacerCells(farm.water)
    assert.ok(bare.every(c => bot.blockAt(c)?.name === 'farmland' && bot.blockAt(c.offset(0, 1, 0))?.name === 'air'), bare.map(c => `${c.toString()} ${bot.blockAt(c)?.name ?? '?'}`).join(', '))
    // the wheat grown (the random ticks a hundred times over, this scenario's only), with the bot by it
    await run('gamerule random_tick_speed 300')
    try {
      assert.ok(await waitUntil(bot, () => grownPlots(p => bot.blockAt(p) as any, cells, 'wheat').length === cells.length, 6000), 'the wheat never grew')
    } finally {
      await run('gamerule random_tick_speed 0')
    }
    await keepFarm(bot, executor, new AbortController().signal, log)
    const after = knownFarms(memory)[0]
    const bread = countItems(bot, 'bread')
    console.log(`farm: ${cells.length} plots grown and harvested, ${after.cells.length} plots after, ${bread} bread, ${countItems(bot, 'wheat')} wheat and ${countItems(bot, 'wheat_seeds')} seeds held`)
    for (const c of cells) assert.strictEqual(bot.blockAt(c.offset(0, 1, 0))?.name, 'wheat', `nothing sown again on ${c.toString()}`)
    assert.ok(after.cells.length > cells.length, `the farm not grown from its seeds (${after.cells.length} plots)\n${lines.join('\n')}`)
    assert.ok(bread >= 1, `no bread\n${lines.join('\n')}`)
  })

  it('two cows seen 60 blocks off with none near home: fetched, led home into a pen built there, and bred', async () => {
    await give('oak_log', 16)
    await give('wheat', 8)
    // the cows 60 off, seen as the bot goes by them (the executor's noteAnimals), then home again
    for (const dz of [0, 2]) await run(`summon cow ${xyz(at(60, 0, dz))}`)
    await run(`tp ${USERNAME} ${origin.x + 30.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => rememberedAnimals(memory, origin, 160, memory.now).length > 0, 400), 'the cows never noted')
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 1, 100))
    const started = await startHerd(bot, executor, new AbortController().signal, log)
    const herd = herdFromMemory(memory)
    const pen = herd != null ? penFromMemory(memory, herd.pos, 4) : null
    console.log(`herd: ${started ? 'started' : 'not started'} at ${herd?.pos.toString() ?? '-'}, ${cows().filter(e => pen != null && inPen(pen, e.position)).length} cows in; the cows at ${cows().map(e => e.position.floored().toString()).join(', ')}`)
    assert.ok(started, lines.join('\n'))
    assert.ok(herd != null && pen != null, 'the herd and its pen remembered')
    assert.ok(Math.hypot(pen.center.x - origin.x, pen.center.z - origin.z) <= 24, `the pen at ${pen.center.toString()}, not by home`)
    assert.ok(cows().filter(e => inPen(pen, e.position)).length >= 2, lines.join('\n'))
    // bred in the pen
    const bred = await breedAnimals(bot, { mob: 'cow', pairs: 1, radius: 16 })
    assert.strictEqual(bred.fed, 2)
    assert.ok(await waitUntil(bot, () => cows().length >= 3, 400), 'no calf')
  })
})
