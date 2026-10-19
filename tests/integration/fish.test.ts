// Fishing against a real server (SURVIVAL_VERSION, default 1.21.11): a pond 9 across and 3 deep dug into a superflat's
// grass with commands, the bot on its shore with a rod. First the vanilla loot, until a few items are caught; then a data
// pack's fishing loot table that gives a book of mending in open water only (FishingHookPredicate's in_open_water) and
// a cod elsewhere, so the catch shows the casts land in open water, and the book goes on the pickaxe at an anvil.
import { describe, it, before, after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { fish, hasEnchant, mendingBooks } from '../../src/skills/fish'
import { applyBooks } from '../../src/skills/anvil'
import { countItems, inventoryItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'fishbot'
const GROUND = -61

/**
 * A data pack whose fishing loot is a book of mending in open water, a cod elsewhere. 26.x writes loot tables its own
 * way (an entry's `condition` and `modifier`, typed by `type`, the predicates' components by id) where 1.21.11 has
 * `conditions` and `functions`: each is ignored by the other's parser.
 */
function writeMendingPack (worldDir: string, version: string): void {
  const root = path.join(worldDir, 'datapacks', 'mending_fishing')
  const tables = path.join(root, 'data', 'minecraft', 'loot_table', 'gameplay')
  fs.mkdirSync(tables, { recursive: true })
  fs.writeFileSync(path.join(root, 'pack.mcmeta'), JSON.stringify({ pack: { description: 'mending in open water', min_format: 94, max_format: 200 } }))
  const legacy = /^1\./.test(version)
  const book = legacy
    ? {
        type: 'minecraft:item',
        name: 'minecraft:book',
        conditions: [{ condition: 'minecraft:entity_properties', entity: 'this', predicate: { type_specific: { type: 'minecraft:fishing_hook', in_open_water: true } } }],
        functions: [{ function: 'minecraft:set_enchantments', enchantments: { 'minecraft:mending': 1 } }]
      }
    : {
        type: 'minecraft:item',
        name: 'minecraft:book',
        condition: { type: 'minecraft:entity_properties', entity: 'this', predicate: { 'minecraft:type_specific/fishing_hook': { in_open_water: true } } },
        modifier: { type: 'minecraft:set_enchantments', enchantments: { 'minecraft:mending': 1 } }
      }
  fs.writeFileSync(path.join(tables, 'fishing.json'), JSON.stringify({
    type: 'minecraft:fishing',
    pools: [{ rolls: 1, entries: [{ type: 'minecraft:alternatives', children: [book, { type: 'minecraft:item', name: 'minecraft:cod' }] }] }]
  }))
}

describe(`fishing on a ${DEFAULT_VERSION} server`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let ticks = 0
  let startTicks = 0
  let startWall = 0
  const timings: string[] = []
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const xyz = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'fishing',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, random_tick_speed: 0 },
      properties: { 'spawn-protection': 0 }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    bot.on('physicsTick', () => { ticks++ })
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    await run('time set 1000')
    await run('weather clear')
    // the pond: 9 x 9, 3 deep, its surface at the grass's level, 4 blocks off the bot along +x
    await run(`fill ${xyz(at(-6, 0, -10))} ${xyz(at(16, 6, 10))} air`)
    await run(`fill ${xyz(at(4, -3, -4))} ${xyz(at(12, -1, 4))} water`)
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
    console.log(`fishing integration timings:\n${timings.join('\n')}`)
  })

  beforeEach(async () => {
    await run('kill @e[type=item]')
    await run(`clear ${USERNAME}`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.inventory.items().length === 0 && bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.1, 100))
    startTicks = ticks
    startWall = Date.now()
  })

  afterEach((t) => {
    const n = ticks - startTicks
    const ms = Date.now() - startWall
    timings.push(`  ${t.name}: ${n} ticks in ${(ms / 1000).toFixed(1)} s (${(n / Math.max(ms / 1000, 1e-3)).toFixed(0)} ticks/s)`)
  })

  it('fishes the pond until 4 items are caught (vanilla loot)', async () => {
    await run(`give ${USERNAME} fishing_rod[enchantments={lure:3}] 1`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'fishing_rod') === 1, 100))
    const res = await fish(bot, { catches: 4, maxTicks: 12000 })
    console.log(`fish: ${res.catches} caught in ${res.casts} casts, ${res.ticks} ticks: ${JSON.stringify(res.caught)}; stood at ${res.spot.stand.toString()}, cast into ${res.spot.landing.toString()}`)
    assert.ok(res.catches >= 4)
    assert.ok(res.spot.open)
  })

  it('catches a book of mending in open water and puts it on the pickaxe at the anvil', async () => {
    writeMendingPack(path.join(server.dir, 'world'), server.version)
    const reload = await run('reload')
    console.log(`reload: ${reload}`)
    await waitUntil(bot, () => false, 40)
    console.log(`datapacks: ${await run('datapack list enabled')}`)
    await run(`give ${USERNAME} fishing_rod 1`)
    await run(`give ${USERNAME} diamond_pickaxe[enchantments={efficiency:4,unbreaking:3}] 1`)
    await run(`give ${USERNAME} anvil 1`)
    await run(`xp set ${USERNAME} 10 levels`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'anvil') === 1, 100))
    const res = await fish(bot, { until: b => mendingBooks(b).length > 0, maxTicks: 12000 })
    console.log(`fish for mending: ${res.catches} caught in ${res.casts} casts, ${res.ticks} ticks: ${JSON.stringify(res.caught)}`)
    // every catch in open water: no cod
    assert.strictEqual(countItems(bot, 'cod'), 0, 'a cod came: a cast landed out of open water')
    assert.strictEqual(mendingBooks(bot).length, 1)
    const done = await applyBooks(bot)
    console.log(`anvil: ${JSON.stringify(done)}`)
    const pick = inventoryItems(bot).find(i => i.name === 'diamond_pickaxe')
    assert.ok(hasEnchant(pick, 'mending'), `the pickaxe has ${JSON.stringify(pick?.enchants)}`)
  })
})
