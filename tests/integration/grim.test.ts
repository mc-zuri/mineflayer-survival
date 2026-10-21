// The bot plays a few thousand ticks on a 1.21.11 server with GrimAC (each violation an alert): it walks, sprint-jumps
// and pathfinds over steps, a gap and a drop, digs, crafts, places and pillars, eats walking, fights a zombie and
// swims. Grim's alerts are counted by phase and check; none is the pass. Grim sets a flagged move back (Simulation),
// undoes a flagged break (FastBreak, PositionBreak), and the bot's plans fail on it.
// By default under lockstep, with the local Grim build (tests/harness grimModJar: its clock the server's ticks, so
// its Timer, FastBreak and transaction checks hold at lockstep speed); GRIM_REALTIME=1 runs it in real time, no
// lockstep mod, with the pinned Modrinth build (GRIM_MODS). Either way the bot's actions go at the start of its ticks
// (actionsInTick). GRIM_PHASES=walk,dig runs some phases only; GRIM_REPORT=1 reports the alerts without failing.
// Run alone: node --test --require ts-node/register/transpile-only tests/integration/grim.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { connectLockstepBot, grimLockstepMods, grimMods, modJars, parseGrimAlert, parseLogLine, quitBot, startServer, GRIM_CONFIG, type GrimAlert, type TestServer } from '../harness'
import { collectBlock, countItems, craft, navigateNear, waitTicks, waitUntil, walkTo } from '../../src/skills/gather'
import { placeBlock } from '../../src/skills/placeBlock'
import { eat } from '../../src/skills/eat'
import { fight } from '../../src/skills/fight'
import { pillarUp } from '../../src/end/skills/world'

const VERSION = '1.21.11'
const USERNAME = 'grimbot'
const ONLY = (process.env.GRIM_PHASES ?? '').split(',').filter(p => p !== '')
const REPORT = process.env.GRIM_REPORT === '1'
const REALTIME = process.env.GRIM_REALTIME === '1'

describe(`a ${REALTIME ? 'real-time' : 'lockstep'} ${VERSION} server with GrimAC`, { timeout: 20 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  const alerts: GrimAlert[] = []
  const byPhase = new Map<string, GrimAlert[]>()
  let phase = 'join'
  let wall0 = 0
  let ticks0 = 0

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`

  before(async () => {
    server = await startServer({
      version: VERSION,
      lockstep: !REALTIME,
      flat: true,
      seed: 'grim',
      difficulty: 'easy',
      mods: REALTIME ? await modJars(grimMods(VERSION)) : await grimLockstepMods(VERSION),
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
    bot = await connectLockstepBot(server, { username: USERNAME, realtime: REALTIME, op: false, actionsInTick: true })
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
    wall0 = Date.now()
    ticks0 = bot.lockstep.ticks
  })

  after(async () => {
    const lines = [...byPhase].map(([p, list]) => `${p}: ${list.length} (${[...new Set(list.map(a => a.check))].join(', ')})`)
    const ticks = bot != null ? bot.lockstep.ticks - ticks0 : 0
    const rate = ticks / Math.max(0.001, (Date.now() - wall0) / 1000)
    console.log(`[grim] ${REALTIME ? 'real time' : 'lockstep'}: ${ticks} ticks, ${rate.toFixed(1)} ticks/s; ${alerts.length} alerts${lines.length > 0 ? `; ${lines.join('; ')}` : ''}`)
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
    // (the count is the inventory's gain: the stone the path broke on its way counts too)
    assert.ok(got.count >= 8, `mined ${got.mined}, ${got.count} items gained`)
    await fill(at(-3, 0, 5), at(-3, 3, 5), 'oak_log')
    await collectBlock(bot, { names: ['oak_log'], count: 4 })
  })

  step('craft', async () => {
    await give('oak_log', 6)
    // a bag all but full, as one late in a game: a stack the server can't put back drops (InventoryMenu.removed)
    await run(`give ${USERNAME} cobblestone ${64 * 30}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'cobblestone') >= 64 * 30, 60))
    // in the inventory's grid with a key down (the edge guard's sneak: its clicks wait for a tick with the keys let go,
    // the menu's close after them; GRIM_CRAFT_KEY=forward walks)
    await bot.look(Math.PI / 4, 0, true)
    bot.setControlState(process.env.GRIM_CRAFT_KEY as any ?? 'sneak', true)
    const planks = countItems(bot, 'oak_planks')
    try {
      await craft(bot, { item: 'oak_planks', count: 8 })
      assert.strictEqual(countItems(bot, 'oak_planks'), planks + 8)
      const tables = countItems(bot, 'crafting_table')
      await craft(bot, { item: 'crafting_table', count: 1 })
      assert.strictEqual(countItems(bot, 'crafting_table'), tables + 1)
      assert.strictEqual(countItems(bot, 'oak_planks'), planks + 4)
    } finally {
      bot.clearControlStates()
    }
    await run(`clear ${USERNAME} cobblestone`)
    await craft(bot, { item: 'crafting_table', count: 1 })
    await craft(bot, { item: 'wooden_pickaxe', count: 1 })
    assert.strictEqual(countItems(bot, 'wooden_pickaxe'), 1)
  })

  step('table', async () => {
    // a table behind gravel on the side the bot stands and on top (the server opens it all the same: its use checks no
    // line of sight), used sneaking with a shield in the off hand, as grimfix-3's bot did: the server passes a use with
    // the shift key down and an item in a hand over for the item's (Player.isSecondaryUseActive) and no menu opened,
    // 20 s a craft and the base milestone stalled; mineflayer lets go of the shift key for the use (7a2a9b88)
    const table = at(8, 0, -12)
    await fill(table, table, 'crafting_table')
    for (const [dx, dy, dz] of [[0, 0, 1], [0, 1, 1], [-1, 0, 0], [1, 0, 0], [-1, 1, 0], [1, 1, 0], [0, 1, 0], [-1, 0, 1], [1, 0, 1]]) {
      await fill(table.offset(dx, dy, dz), table.offset(dx, dy, dz), 'gravel')
    }
    await give('oak_planks', 3)
    await give('stick', 2)
    await navigateNear(bot, at(8, 0, -6), 0)
    // the bot within reach of it, the gravel between
    await run(`tp ${USERNAME} ${table.x + 0.5} ${table.y} ${table.z + 3.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.position.distanceTo(table.offset(0.5, 0, 3.5)) < 0.1, 40))
    // a shield in the off hand and the shift key down (as the edge guard holds it)
    await give('shield', 1)
    await bot.equip(bot.inventory.items().find(i => i.name === 'shield') as any, 'off-hand')
    const had = countItems(bot, 'wooden_axe')
    bot.setControlState('sneak', true)
    await waitTicks(bot, 2)
    try {
      await craft(bot, { item: 'wooden_axe', count: 1, table })
    } finally {
      bot.setControlState('sneak', false)
    }
    assert.strictEqual(countItems(bot, 'wooden_axe'), had + 1)
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

  step('respawn', async () => {
    // a pickaxe held in a slot other than the first, a death, the respawn's new player (slot 0 on the server and in
    // the client: mineflayer c2bc9037), then a pickaxe crafted and the stone dug with it. Grim times a dig by the item
    // in the hand as its inventory has it, which its Fabric build synced from the dead player's emptied inventory after
    // a respawn: every dig by hand, 'diff=6350ms', the break cancelled (grimls-2 after a drowning; GrimAC 7f2b78e14)
    await give('stone_pickaxe', 1)
    const pick = bot.inventory.items().find(i => i.name === 'stone_pickaxe')
    if (pick != null && pick.slot !== 39) await bot.moveSlotItem(pick.slot, 39)
    bot.setQuickBarSlot(3)
    await waitTicks(bot, 5)
    const respawned = new Promise(resolve => bot.once('respawn', resolve))
    await run(`kill ${USERNAME}`)
    await respawned
    assert.ok(await waitUntil(bot, () => bot.health > 0, 100))
    assert.strictEqual(bot.quickBarSlot, 0)
    await waitTicks(bot, 20)
    await give('oak_log', 3)
    await craft(bot, { item: 'wooden_pickaxe', count: 1 })
    const p = bot.entity.position.floored()
    await fill(p.offset(2, 0, 0), p.offset(2, 1, 1), 'stone')
    const got = await collectBlock(bot, { names: ['stone'], count: 3 })
    assert.ok(got.count >= 3, `mined ${got.mined}, ${got.count} gained`)
  })

  it('no Grim alerts at all', { skip: REPORT }, () => {
    assert.deepStrictEqual(alerts.map(a => `${a.check} ${a.verbose}`), [])
  })
})
