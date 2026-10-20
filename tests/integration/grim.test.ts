// The bot plays a few thousand real-time ticks on a 1.21.11 server with GrimAC (tests/harness GRIM_MODS, each
// violation an alert): it walks, sprint-jumps and pathfinds over steps, a gap and a drop, digs, crafts, places and
// pillars, eats walking, fights a zombie and swims. Grim's alerts are counted by phase and check; none is the pass.
// Grim sets a flagged move back (Simulation), undoes a flagged break (FastBreak, PositionBreak), and the bot's plans
// fail on it. GRIM_PHASES=walk,dig runs some phases only; GRIM_REPORT=1 reports the alerts without failing.
// Run alone: node --test --require ts-node/register/transpile-only tests/integration/grim.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { connectLockstepBot, grimMods, modJars, parseGrimAlert, parseLogLine, quitBot, startServer, GRIM_CONFIG, type GrimAlert, type TestServer } from '../harness'
import { collectBlock, countItems, craft, navigateNear, waitTicks, waitUntil, walkTo } from '../../src/skills/gather'
import { placeBlock } from '../../src/skills/placeBlock'
import { eat } from '../../src/skills/eat'
import { fight } from '../../src/skills/fight'
import { pillarUp } from '../../src/end/skills/world'

const VERSION = '1.21.11'
const USERNAME = 'grimbot'
const ONLY = (process.env.GRIM_PHASES ?? '').split(',').filter(p => p !== '')
const REPORT = process.env.GRIM_REPORT === '1'

describe(`a real-time ${VERSION} server with GrimAC`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  const alerts: GrimAlert[] = []
  const byPhase = new Map<string, GrimAlert[]>()
  let phase = 'join'

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    server = await startServer({
      version: VERSION,
      lockstep: false,
      flat: true,
      seed: 'grim',
      difficulty: 'easy',
      mods: await modJars(grimMods(VERSION)),
      files: GRIM_CONFIG,
      gamerules: { advance_weather: false, spawn_mobs: false, spawn_monsters: false, advance_time: false },
      log: (line) => {
        const alert = parseGrimAlert(parseLogLine(line)?.message ?? line)
        if (alert == null) return
        alerts.push(alert)
        byPhase.set(phase, [...(byPhase.get(phase) ?? []), alert])
        console.log(`[grim] ${phase}: ${alert.check} (x${alert.vl}) ${alert.verbose}`)
      }
    })
    // (not an op: Grim may exempt one; the console sets the scene)
    bot = await connectLockstepBot(server, { username: USERNAME, realtime: true, op: false })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    // where the bot stands: a clear patch of grass around it (a superflat makes structures: a trial chamber's blocks)
    origin = bot.entity.position.floored()
    await run(`fill ${xyz(at(-16, 0, -16))} ${xyz(at(16, 8, 16))} air`)
    await run(`fill ${xyz(at(-16, -1, -16))} ${xyz(at(16, -1, 16))} grass_block`)
    await run(`fill ${xyz(at(-16, -3, -16))} ${xyz(at(16, -2, 16))} dirt`)
    await run('kill @e[type=!player]')
    await run('time set 1000')
    await waitTicks(bot, 40)
  })

  after(async () => {
    const lines = [...byPhase].map(([p, list]) => `${p}: ${list.length} (${[...new Set(list.map(a => a.check))].join(', ')})`)
    console.log(`[grim] ${alerts.length} alerts${lines.length > 0 ? `; ${lines.join('; ')}` : ''}`)
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  async function give (item: string, count: number): Promise<void> {
    const had = countItems(bot, item)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, item) >= had + count, 60), `no ${count} ${item} given`)
  }

  async function fill (from: Vec3, to: Vec3, block: string): Promise<void> {
    await run(`fill ${xyz(from)} ${xyz(to)} ${block}`)
    await waitTicks(bot, 5)
  }

  // a phase: its alerts are its own
  function step (name: string, body: () => Promise<void>): void {
    const skip = ONLY.length > 0 && !ONLY.includes(name)
    it(name, { skip }, async () => {
      phase = name
      const before = alerts.length
      await body()
      // the alerts of the phase's last packets come a few ticks later
      await waitTicks(bot, 20)
      const own = alerts.slice(before)
      if (!REPORT) assert.deepStrictEqual(own.map(a => `${a.check} ${a.verbose}`), [])
    })
  }

  step('walk', async () => {
    // a step up of 1 and 2, a gap of 1 and a drop of 2 on the way east, and back
    await fill(at(4, 0, -2), at(5, 0, 2), 'stone')
    await fill(at(6, 0, -2), at(7, 1, 2), 'stone')
    await fill(at(8, 0, -2), at(8, 1, 2), 'air')
    await fill(at(8, -1, -2), at(8, -1, 2), 'air')
    await fill(at(9, 0, -2), at(10, 1, 2), 'stone')
    for (const goal of [at(14, 0, 0), at(0, 0, 0), at(14, 0, 6), at(0, 0, -6)]) await navigateNear(bot, goal, 1)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    bot.setControlState('jump', true)
    await bot.look(Math.PI / 2, 0, true)
    await waitTicks(bot, 30)
    bot.clearControlStates()
  })

  step('dig', async () => {
    await give('stone_pickaxe', 1)
    await fill(at(-6, 0, -3), at(-4, 2, 3), 'stone')
    const got = await collectBlock(bot, { names: ['stone'], count: 8 })
    assert.ok(got.mined >= 8, `mined ${got.mined}`)
    await fill(at(-3, 0, 5), at(-3, 3, 5), 'oak_log')
    await collectBlock(bot, { names: ['oak_log'], count: 4 })
  })

  step('craft', async () => {
    await give('oak_log', 4)
    await craft(bot, { item: 'crafting_table', count: 1 })
    await craft(bot, { item: 'wooden_pickaxe', count: 1 })
    assert.strictEqual(countItems(bot, 'wooden_pickaxe'), 1)
  })

  step('place', async () => {
    await give('cobblestone', 16)
    for (let dz = -1; dz <= 1; dz++) await placeBlock(bot, { pos: at(3, 0, 8 + dz), item: 'cobblestone' })
    await pillarUp(bot, { x: origin.x + 1, z: origin.z + 10 }, origin.y + 3)
    await navigateNear(bot, at(0, 0, 0), 1)
  })

  step('eat', async () => {
    await give('bread', 4)
    await run(`effect give ${USERNAME} hunger 10 100 true`)
    assert.ok(await waitUntil(bot, () => bot.food <= 14, 400), `food ${bot.food}`)
    await run(`effect clear ${USERNAME}`)
    // eating as it walks
    const walking = walkTo(bot, at(10, 0, 12), { within: 0.5, maxTicks: 200 })
    await eat(bot, { food: 'bread' })
    await walking
  })

  step('fight', async () => {
    await give('stone_sword', 1)
    await run(`summon zombie ${xyz(at(5, 0, -8))}`)
    const zombie = await waitUntil(bot, () => Object.values(bot.entities).some(e => e.name === 'zombie'), 40)
    assert.ok(zombie)
    const target = Object.values(bot.entities).find(e => e.name === 'zombie')
    if (target != null) await fight(bot, target, {})
  })

  step('swim', async () => {
    // a pool 2 deep across the way back from the corner
    await fill(at(-12, -2, -12), at(-6, -1, -6), 'water')
    await navigateNear(bot, at(-14, 0, -14), 1)
    await navigateNear(bot, at(0, 0, 0), 1)
  })

  it('no Grim alerts at all', { skip: REPORT }, () => {
    assert.deepStrictEqual(alerts.map(a => `${a.check} ${a.verbose}`), [])
  })
})
