// bot.survival.play() on a 1.21.11 server under lockstep: from a fresh world (a fixed seed, survival, normal
// difficulty, no gamerule changed) to the wood, stone and food milestones; in another world on to iron. Each milestone's
// tick and wall time is reported (t.diagnostic and the [survival] log).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import type { MilestoneEvent, PlayResult } from '../../src/runner'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

// seed 2: spawn in plains by a forest (oak 2 blocks off), cows, pigs, sheep and chickens about, water 11 blocks away
const SEED = process.env.PLAY_SEED ?? '2'

function report (t: { diagnostic: (msg: string) => void }, result: PlayResult): void {
  for (const r of result.reached) t.diagnostic(`${r.id}: tick ${r.tick}, ${(r.wallMs / 1000).toFixed(1)} s wall`)
  t.diagnostic(`stopped: ${result.reason}${result.stoppedAt != null ? ` at ${result.stoppedAt}` : ''}${result.error != null ? `: ${(result.error as Error).message}` : ''}`)
}

function ids (events: MilestoneEvent[]): string[] {
  return events.map(e => e.id)
}

async function freshGame (name: string): Promise<{ server: TestServer, bot: Bot, saveFile: string }> {
  const server = await startServer({ seed: SEED, difficulty: 'normal', log: process.env.PLAY_SERVER_LOG != null })
  const bot = await connectLockstepBot(server, { username: name, op: false })
  await bot.waitForChunksToLoad()
  bot.loadPlugin(createPlugin())
  const saveFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'survival-')), 'save.json')
  return { server, bot, saveFile }
}

// Each test runs on a tick budget (play's maxTicks: the game's time, whatever the machine's speed), and its wall
// timeout leaves room for that budget at about 50 ticks a second (the lockstep server runs 100 to 600 on a free
// machine): a run that goes nowhere stops at its budget, minutes in, not hours.
// (the night reflex digs in and waits for dawn without a bed: a night is about 11000 ticks of it)
const FOOD_TICKS = Number(process.env.PLAY_FOOD_TICKS ?? 40000)
const IRON_TICKS = Number(process.env.PLAY_IRON_TICKS ?? 150000)
const DIAMOND_TICKS = Number(process.env.PLAY_DIAMOND_TICKS ?? 300000)
const wallFor = (ticks: number): number => (ticks / 50 + 300) * 1000

describe('play from a fresh 1.21.11 world', { timeout: wallFor(FOOD_TICKS) }, () => {
  let server: TestServer
  let bot: Bot
  let saveFile: string

  before(async () => { ({ server, bot, saveFile } = await freshGame('player')) })
  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('wood, stone and food', async (t) => {
    const result = await bot.survival.play({ until: 'food', saveFile, maxTicks: FOOD_TICKS })
    report(t, result)
    assert.strictEqual(result.reason, 'until', `stopped: ${result.reason} ${String((result.error as Error)?.message ?? '')}`)
    for (const id of ['wood', 'stone', 'food']) assert.ok(ids(result.reached).includes(id), `${id} not reached`)
    // the progress was saved, the milestones with it
    const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'))
    assert.deepStrictEqual(saved.reached.map((r: MilestoneEvent) => r.id), ids(result.reached))
    assert.ok(saved.ticks >= result.reached[result.reached.length - 1].tick)
  })
})

describe('play on to iron', { timeout: wallFor(IRON_TICKS) }, () => {
  let server: TestServer
  let bot: Bot
  let saveFile: string

  before(async () => { ({ server, bot, saveFile } = await freshGame('miner')) })
  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('an iron pickaxe and sword, iron armor, a shield and a bucket (the base left out)', async (t) => {
    const result = await bot.survival.play({ until: 'iron', skip: ['base'], saveFile, maxTicks: IRON_TICKS })
    report(t, result)
    assert.strictEqual(result.reason, 'until', `stopped: ${result.reason} ${String((result.error as Error)?.message ?? '')}`)
    assert.ok(ids(result.reached).includes('iron'))
    const owned = [...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(s => bot.inventory.slots[s])].filter(i => i != null).map(i => i.name)
    for (const item of ['iron_pickaxe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield']) {
      assert.ok(owned.includes(item), `no ${item} (${owned.join(', ')})`)
    }
    assert.ok(owned.some(n => n.endsWith('bucket')), 'no bucket')
  })
})

// optional (PLAY_DIAMONDS=1): on to the diamonds within a tick budget (PLAY_DIAMOND_TICKS, default 200000)
describe('play on to diamonds', { timeout: wallFor(DIAMOND_TICKS), skip: process.env.PLAY_DIAMONDS == null }, () => {
  let server: TestServer
  let bot: Bot
  let saveFile: string

  before(async () => { ({ server, bot, saveFile } = await freshGame('digger')) })
  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('a diamond pickaxe and sword within the tick budget (the base left out)', async (t) => {
    const result = await bot.survival.play({ until: 'diamonds', skip: ['base'], saveFile, maxTicks: DIAMOND_TICKS })
    report(t, result)
    assert.strictEqual(result.reason, 'until', `stopped: ${result.reason} ${String((result.error as Error)?.message ?? '')}`)
    assert.ok(ids(result.reached).includes('diamonds'))
  })
})
