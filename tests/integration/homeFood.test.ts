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
import { farmCells, grownPlots, isSpring, knownFarms, spacerCells } from '../../src/skills/farm'
import { WorldMemory } from '../../src/core/memory'
import { Executor } from '../../src/executor/executor'
import { farmSpring, keepFarm, startFarm, startHerd } from '../../src/milestones'
import { fillBucket } from '../../src/skills/bucket'

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
    // (the plugin's own memory: the skills read it, keptWater's farm water among them)
    memory = (bot as any).survival.memory
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

  it('the water of the farm made a spring with the water bucket held (a 2 by 2 of sources), a bucket filled there twice and the spring whole after', async () => {
    const farm = knownFarms(memory)[0]
    assert.ok(farm != null, 'no farm from the test before')
    await run(`clear ${USERNAME} bucket`)
    await give('water_bucket', 1)
    assert.ok(await farmSpring(bot, executor, new AbortController().signal, log), lines.join(' | '))
    // (the bucket filled at it after: the taken source back a fluid tick on)
    assert.ok(await waitUntil(bot, () => isSpring(p => bot.blockAt(p), farm.water), 40), 'no spring')
    // (the fill's first source: the spring, which fills again)
    for (let i = 0; i < 2; i++) {
      await run(`clear ${USERNAME} water_bucket`)
      await run(`clear ${USERNAME} bucket`)
      await give('bucket', 1)
      await fillBucket(bot, { fluid: 'water', maxDistance: 32 })
      assert.strictEqual(countItems(bot, 'water_bucket'), 1)
      assert.ok(await waitUntil(bot, () => isSpring(p => bot.blockAt(p), farm.water), 40), `the spring not whole after fill ${i + 1}`)
    }
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
  it('no flat ground near home (boulders every few blocks): a pen of 7 built on ground flattened for it', async () => {
    await give('oak_log', 16)
    await give('dirt', 32)
    // a home 120 blocks off the farm's, its ground set with boulders and logs in a lattice (no inside of 5 by 5 free)
    const home = origin.offset(0, 0, 120)
    // (there first: the server sets blocks in loaded chunks only)
    await run(`tp ${USERNAME} ${home.x + 0.5} ${home.y} ${home.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(home.offset(0.5, 0, 0.5)) < 1, 200))
    await bot.waitForChunksToLoad()
    await run(`fill ${xyz(home.offset(-30, 0, -30))} ${xyz(home.offset(30, 4, 30))} air`)
    for (let dx = -28; dx <= 28; dx += 3) {
      for (let dz = -28; dz <= 28; dz += 4) {
        if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) continue
        await run(`setblock ${xyz(home.offset(dx, 0, dz))} ${(dx + dz) % 2 === 0 ? 'mossy_cobblestone' : 'spruce_log'}`)
      }
    }
    assert.ok(await waitUntil(bot, () => bot.blockAt(home.offset(26, 0, 24))?.name === 'mossy_cobblestone' || bot.blockAt(home.offset(26, 0, 24))?.name === 'spruce_log', 200))
    assert.ok(await waitUntil(bot, () => bot.blockAt(home.offset(2, 0, 4))?.name === 'mossy_cobblestone' || bot.blockAt(home.offset(2, 0, 4))?.name === 'spruce_log', 200))
    const { choosePenSite, herdPen, PEN_FLATTEN_SIZE } = await import('../../src/skills/pen')
    assert.strictEqual(choosePenSite(p => bot.blockAt(p) as any, home, PEN_FLATTEN_SIZE), null)
    const penMemory = new WorldMemory()
    const res = await herdPen(bot, { home, memory: penMemory, obtain: async (reqs) => { await executor.obtain(reqs, new AbortController().signal) }, size: PEN_FLATTEN_SIZE })
    console.log(`pen: ${res.pen.size} across at ${res.pen.center.toString()}, built ${String(res.built)}`)
    assert.ok(res.built)
    for (const p of res.pen.fences) assert.ok(bot.blockAt(p)?.name.endsWith('_fence'), `no fence at ${p.toString()}: ${bot.blockAt(p)?.name ?? '?'}`)
    const r = Math.floor(res.pen.size / 2)
    for (let dx = -r + 1; dx < r; dx++) {
      for (let dz = -r + 1; dz < r; dz++) {
        const cell = res.pen.center.offset(dx, 0, dz)
        assert.strictEqual(bot.blockAt(cell)?.boundingBox, 'empty', `${bot.blockAt(cell)?.name ?? '?'} inside the pen at ${cell.toString()}`)
      }
    }
  })
})
