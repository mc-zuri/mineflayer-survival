// The barter loop against a real server (SURVIVAL_VERSION, default 1.21.11; the nether runs are 26.3), the
// tests/harness lockstep server and bot on seed 2: in a closed room of cobblestone in the nether (BARTER_PIGLINS adult
// piglins, default 3), the bot in its gold boots with BARTER_INGOTS gold ingots (default 64) runs barterForPearls till
// the gold is gone, and what the piglins threw back is counted (each ingot is one roll of piglin_bartering: about 3
// pearls in 47, 10/469 of the rolls 2 to 4 pearls). It passes once most of the gold went to the piglins, no
// pearl is left on the floor and the bot is never hurt by them. A 26.3 run:
// 57 ingots taken, 8 pearls among the rolls, in 3524 ticks.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { appendFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { barterForPearls } from '../../src/nether/pearls'
import { inventoryCounts, countItems, waitUntil } from '../../src/skills/util'

const USERNAME = 'barterbot'
const PIGLINS = Number(process.env.BARTER_PIGLINS ?? 3)
const INGOTS = Number(process.env.BARTER_INGOTS ?? 64)
// a room high in the nether over seed 2's spawn portal
const X = 8
const Y = 100
const Z = 8

describe(`the barter loop with summoned piglins on a ${DEFAULT_VERSION} server`, { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' | ')
  const nether = async (cmd: string): Promise<string> => await run(`execute in minecraft:the_nether run ${cmd}`)

  before(async () => {
    server = await startServer({
      seed: '2',
      difficulty: 'normal',
      log: process.env.SURVIVAL_SERVER_LOG != null ? line => appendFileSync(process.env.SURVIVAL_SERVER_LOG as string, `${line}\n`) : undefined
    })
    bot = await connectLockstepBot(server, { username: USERNAME, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin())
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  it(`barters ${INGOTS} ingots with ${PIGLINS} piglins, the pearls among the rolls picked up`, async () => {
    await nether(`tp ${USERNAME} ${X + 0.5} ${Y + 1} ${Z + 0.5}`)
    assert.ok(await waitUntil(bot, () => /nether/.test(String(bot.game?.dimension)), 1200), 'not in the nether')
    // the room: 11 x 5 x 11 of cobblestone, hollow, lit
    for (let i = 0; i < 20; i++) {
      if (!/not loaded/.test(await nether(`fill ${X - 5} ${Y - 1} ${Z - 5} ${X + 5} ${Y + 4} ${Z + 5} cobblestone hollow`))) break
      await bot.waitForTicks(10)
    }
    await nether(`fill ${X - 4} ${Y + 3} ${Z - 4} ${X + 4} ${Y + 3} ${Z + 4} glowstone`)
    await nether(`tp ${USERNAME} ${X + 0.5} ${Y} ${Z + 0.5}`)
    await run(`clear ${USERNAME}`)
    await run(`give ${USERNAME} golden_boots 1`)
    await run(`give ${USERNAME} gold_ingot ${INGOTS}`)
    await run(`give ${USERNAME} cooked_beef 16`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'gold_ingot') >= INGOTS, 200), 'no gold')
    for (let i = 0; i < PIGLINS; i++) await nether(`summon piglin ${X - 3 + i * 3} ${Y} ${Z - 3} {IsImmuneToZombification:1b,PersistenceRequired:1b}`)
    await bot.waitForTicks(20)
    let hurt = 0
    let last = bot.health
    const onHealth = (): void => { if (bot.health < last) hurt += last - bot.health; last = bot.health }
    bot.on('health', onHealth)
    const before = inventoryCounts(bot)
    const t0 = bot.lockstep.ticks
    let error = ''
    let res: { pearls: number, ingots: number } = { pearls: 0, ingots: 0 }
    try {
      // (all the gold, pearls wanted beyond what it can give: it barters till the gold's gone)
      res = await barterForPearls(bot, { pearls: 1000, range: 12, keep: [] }, undefined)
    } catch (err) {
      error = (err as Error).message
      res = { ...res, ...((err as any).partial ?? (err as any).result ?? {}) }
    } finally {
      bot.off('health', onHealth)
    }
    // what came back, everything walked over: picked up by walking the room's floor
    const after = inventoryCounts(bot)
    const got = Object.entries(after).filter(([n, c]) => n !== 'gold_ingot' && c > (before[n] ?? 0)).map(([n, c]) => `${c - (before[n] ?? 0)} ${n}`)
    const ingots = (before.gold_ingot ?? 0) - (after.gold_ingot ?? 0)
    // what lies on the room's floor, by name (an item's name unknown till its metadata comes)
    const floor = new Map<string, number>()
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'item' || e.position.distanceTo(bot.entity.position) > 12) continue
      let name = '?'
      try { const item = (e as any).getDroppedItem?.(); name = item != null ? `${item.name} x${item.count}` : '?' } catch {}
      floor.set(name, (floor.get(name) ?? 0) + 1)
    }
    const ground = [...floor].map(([n, c]) => `${c} of ${n}`).join(', ')
    console.log(`barter: ${ingots} ingots given, ${countItems(bot, 'ender_pearl')} pearls, ${bot.lockstep.ticks - t0} ticks, ${Math.round(hurt)} health lost${error !== '' ? `, ${error}` : ''}; got ${got.join(', ')}; on the floor: ${ground}`)
    assert.strictEqual(hurt, 0, 'hurt by the piglins')
    // (an ingot dropped for a piglin busy with another is picked up again: most, not all, go)
    assert.ok(ingots >= INGOTS * 0.8, `${ingots} of ${INGOTS} ingots given`)
    assert.ok(![...floor.keys()].some(n => n.startsWith('ender_pearl')), 'a pearl left on the floor')
  })
})
