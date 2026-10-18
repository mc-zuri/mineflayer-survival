// The nether skills against a real 1.21.11 server (the tests/harness lockstep server and bot), on seed 4: a portal
// cast from a lava pool and lit, the way into the nether and back; the fortress the seed puts at 18, -78 (its blaze
// spawners at 7 77 -72, 42 77 -69 and 82 70 117) found from the far end of its bridges and 2 blaze rods taken
// there with a kit; gold bartered with summoned piglins for pearls. Each scenario logs its ticks and wall time.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { buildPortal } from '../../src/nether/portalSkills'
import { enterNether, returnOverworld } from '../../src/nether/portalTravel'
import { collectBlazeRods, findBlazeSpawner, findFortress } from '../../src/nether/fortressSkills'
import { barterForPearls } from '../../src/nether/pearls'
import { equipArmor } from '../../src/skills/armor'
import { countItems, waitUntil } from '../../src/skills/gather'

const USERNAME = 'netherbot'
const SEED = '4'

describe('nether skills on a 1.21.11 server (seed 4)', { timeout: 40 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const nether = async (cmd: string): Promise<string> => await run(`execute in minecraft:the_nether run ${cmd}`)

  before(async () => {
    server = await startServer({
      seed: SEED,
      difficulty: 'easy',
      gamerules: { advance_weather: false, advance_time: false, spawn_phantoms: false, spawn_monsters: false }
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  async function kit (items: Array<[string, number]>): Promise<void> {
    await run(`clear ${USERNAME}`)
    for (const [item, count] of items) await run(`give ${USERNAME} ${item} ${count}`)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 10 true`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    const first = items[0][0].replace(/\[.*$/, '')
    assert.ok(await waitUntil(bot, () => countItems(bot, first) > 0, 40), `no ${first} given`)
  }

  async function fill (args: string, dimension = 'overworld'): Promise<void> {
    let out = ''
    // the chunks round a player who just arrived load over a few ticks on the server
    for (let i = 0; i < 20; i++) {
      out = await run(`execute in minecraft:${dimension} run fill ${args}`)
      if (!/not loaded/.test(out)) break
      await bot.waitForTicks(10)
    }
    assert.match(out, /Successfully filled|No blocks were filled/, `fill ${args}: ${out}`)
  }

  function measure (): () => { ticks: number, ms: number } {
    const t0 = Date.now()
    const k0 = bot.lockstep.ticks
    return () => ({ ticks: bot.lockstep.ticks - k0, ms: Date.now() - t0 })
  }

  it('casts a portal frame from a lava pool, lights it with flint and steel it crafts, and goes into the nether and back', async () => {
    // a stone platform over the overworld's ground, a 4 x 3 lava pool let into it
    const o = new Vec3(100, 80, 100)
    const xyz = (dx: number, dy: number, dz: number): string => `${o.x + dx} ${o.y + dy} ${o.z + dz}`
    await run('time set 1000')
    // there first: /fill only reaches loaded chunks
    await run(`effect give ${USERNAME} minecraft:slow_falling 30 0 true`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y + 2} ${o.z + 0.5}`)
    await bot.waitForChunksToLoad()
    await fill(`${xyz(-12, 0, -12)} ${xyz(12, 10, 12)} air`)
    await fill(`${xyz(-12, -2, -12)} ${xyz(12, -1, 12)} stone`)
    await fill(`${xyz(5, -1, -2)} ${xyz(8, -1, 0)} lava`)
    await run(`tp ${USERNAME} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`)
    await run(`effect clear ${USERNAME} minecraft:slow_falling`)
    await kit([['bucket', 1], ['water_bucket', 1], ['cobblestone', 32], ['iron_ingot', 1], ['gravel', 2]])
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(o.offset(0.5, 0, 0.5)) < 1 && bot.blockAt(o.offset(5, -1, -2))?.name === 'lava', 600))

    const built = measure()
    const portal = await buildPortal(bot, { method: 'cast' })
    const b = built()
    console.log(`buildPortal (cast + light): ${b.ticks} ticks, ${b.ms} ms`)
    assert.strictEqual(portal.method, 'cast')
    assert.strictEqual(portal.portal.length, 6)
    for (const p of portal.portal) assert.strictEqual(bot.blockAt(p)?.name, 'nether_portal')
    assert.strictEqual(countItems(bot, 'flint_and_steel'), 1)
    assert.strictEqual(countItems(bot, 'water_bucket'), 1)

    const went = measure()
    const into = await enterNether(bot, { build: false })
    const w = went()
    console.log(`enterNether: ${w.ticks} ticks, ${w.ms} ms`)
    assert.strictEqual(into.to, 'the_nether')
    assert.strictEqual(bot.game.dimension, 'the_nether')
    assert.ok(into.arrival != null)
    // both portals remembered, each leading to the other
    const pois = bot.survival.memory.getPois('nether_portal')
    assert.ok(pois.some(p => p.dimension === 'overworld' && /^built;link=the_nether:/.test(p.note ?? '')), JSON.stringify(pois))
    assert.ok(pois.some(p => p.dimension === 'the_nether' && /^arrival;link=overworld:/.test(p.note ?? '')), JSON.stringify(pois))

    const back = measure()
    const out = await returnOverworld(bot, { build: false })
    const r = back()
    console.log(`returnOverworld: ${r.ticks} ticks, ${r.ms} ms`)
    assert.strictEqual(out.to, 'overworld')
    assert.ok(bot.entity.position.distanceTo(portal.entrance) < 6, `back at ${bot.entity.position.toString()}, the portal at ${portal.entrance.toString()}`)
  })

  it('finds the fortress, its blaze spawner, and takes 2 blaze rods with a kit', async () => {
    await kit([
      ['diamond_sword', 1], ['iron_pickaxe', 1], ['bow', 1], ['arrow', 64], ['shield', 1], ['diamond_helmet', 1], ['diamond_chestplate', 1],
      ['diamond_leggings', 1], ['diamond_boots', 1], ['cooked_beef', 16], ['cobblestone', 64],
      ['potion[potion_contents={potion:"minecraft:long_fire_resistance"}]', 2]
    ])
    await nether('kill @e[type=blaze]')
    // the south end of the fortress's bridges, 170 blocks along them from the spawners
    await nether(`tp ${USERNAME} 20.5 60 108.5`)
    assert.ok(await waitUntil(bot, () => bot.game.dimension === 'the_nether' && bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name === 'nether_bricks', 200))
    await bot.waitForChunksToLoad()
    await equipArmor(bot)

    const all = measure()
    const found = await findFortress(bot, { seed: SEED })
    console.log(`findFortress (${found.via}): ${all().ticks} ticks, ${all().ms} ms`)
    assert.ok(found.fortress.count > 0)
    const spawner = await findBlazeSpawner(bot, { fortress: found.fortress, seed: SEED })
    console.log(`findBlazeSpawner: spawner at ${spawner.x} ${spawner.y} ${spawner.z}, ${all().ticks} ticks, ${all().ms} ms`)
    assert.strictEqual(spawner.source, 'spawner')
    assert.strictEqual(bot.blockAt(new Vec3(spawner.x, spawner.y, spawner.z))?.name, 'spawner')

    const rods = await collectBlazeRods(bot, { count: 2, spawner, eatAt: 14 })
    const t = all()
    console.log(`collectBlazeRods: ${rods.rods} rods, ${rods.kills} kills, ${t.ticks} ticks in all, ${t.ms} ms, health ${bot.health}`)
    assert.ok(countItems(bot, 'blaze_rod') >= 2)
    assert.ok(bot.health > 0)
  })

  it('barters gold ingots with summoned piglins for ender pearls', async () => {
    // a netherrack yard by the fortress, four adult piglins in it
    const x = 30
    const y = 61
    const z = 100
    await nether(`tp ${USERNAME} ${x + 0.5} ${y} ${z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.game.dimension === 'the_nether', 200))
    await bot.waitForChunksToLoad()
    await fill(`${x - 6} ${y - 1} ${z - 6} ${x + 6} ${y - 1} ${z + 6} netherrack`, 'the_nether')
    await fill(`${x - 6} ${y} ${z - 6} ${x + 6} ${y + 3} ${z + 6} air`, 'the_nether')
    await fill(`${x - 7} ${y} ${z - 7} ${x + 7} ${y + 1} ${z - 7} netherrack`, 'the_nether')
    await fill(`${x - 7} ${y} ${z + 7} ${x + 7} ${y + 1} ${z + 7} netherrack`, 'the_nether')
    await fill(`${x - 7} ${y} ${z - 7} ${x - 7} ${y + 1} ${z + 7} netherrack`, 'the_nether')
    await fill(`${x + 7} ${y} ${z - 7} ${x + 7} ${y + 1} ${z + 7} netherrack`, 'the_nether')
    await nether('kill @e[type=piglin]')
    await nether('kill @e[type=item]')
    await kit([['gold_ingot', 128], ['crafting_table', 1], ['oak_planks', 8]])
    await nether(`tp ${USERNAME} ${x + 0.5} ${y} ${z + 0.5}`)
    for (let i = 0; i < 4; i++) await nether(`summon piglin ${x + 3} ${y} ${z - 1 + i} {IsBaby:0b,PersistenceRequired:1b}`)
    assert.ok(await waitUntil(bot, () => Object.values(bot.entities).filter(e => e.name === 'piglin').length >= 4, 100), 'no piglins')

    const m = measure()
    const res = await barterForPearls(bot, { pearls: 2 })
    const t = m()
    console.log(`barterForPearls: ${res.pearls} pearls for ${res.ingots} ingots (${JSON.stringify(res.items)}), ${t.ticks} ticks, ${t.ms} ms`)
    assert.ok(countItems(bot, 'ender_pearl') >= 2)
    // the gold piece that kept them calm (crafted: golden boots, 4 ingots)
    assert.ok([5, 6, 7, 8].some(s => bot.inventory.slots[s]?.name.startsWith('golden_') === true))
    assert.ok(res.ingots > 0 && res.ingots <= 124)
  })
})
