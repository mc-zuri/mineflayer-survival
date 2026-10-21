import { test } from 'node:test'
import assert from 'node:assert'
import { NIGHT_SURFACE_TRIES, surfaceByDay } from '../../src/milestones'
import { fakeBot } from '../reflexes/fakeBot'

// a fake bot whose clock the test sets, physicsTick by hand
function clockBot (timeOfDay: number, version: string): any {
  const bot = fakeBot({ version })
  bot.time = { timeOfDay }
  bot.game.dimension = 'overworld'
  return bot
}

const tick = async (bot: any, n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) }
}

test('surfaceByDay: the nether kit\'s surface work at night waits the night out first (the runner\'s waitOutNight), by day goes at once (f9-1.21.11, t305885)', async () => {
  for (const version of ['1.21.11', '26.3']) {
    const bot = clockBot(13659, version)
    const events: string[] = []
    bot.survival = { waitOutNight: async () => { events.push(`wait at ${bot.time.timeOfDay as number}`); bot.time.timeOfDay = 23500 } }
    const lines: string[] = []
    const got = await surfaceByDay(bot, new AbortController().signal, l => lines.push(l), 'the arrows', async () => { events.push(`work at ${bot.time.timeOfDay as number}`); return 'done' })
    assert.strictEqual(got, 'done')
    assert.deepStrictEqual(events, ['wait at 13659', 'work at 23500'], version)
    assert.ok(lines.some(l => /the arrows by day: the night \(time 13659\) waited out first/.test(l)), lines.join('\n'))
    // by day: at once
    events.length = 0
    bot.time.timeOfDay = 6000
    await surfaceByDay(bot, new AbortController().signal, () => {}, 'the food', async () => { events.push('work') })
    assert.deepStrictEqual(events, ['work'], version)
    // in the nether, no night: at once
    events.length = 0
    bot.time.timeOfDay = 18000
    bot.game.dimension = 'the_nether'
    await surfaceByDay(bot, new AbortController().signal, () => {}, 'the food', async () => { events.push('work') })
    assert.deepStrictEqual(events, ['work'], version)
  }
})

test('surfaceByDay: the work cut off at the nightfall waits the night out and goes on, the last try uncut; no wait to be had, the work as it is', async () => {
  const bot = clockBot(11000, '1.21.11')
  let waits = 0
  bot.survival = { waitOutNight: async () => { waits++; bot.time.timeOfDay = 100 } }
  let tries = 0
  const work = surfaceByDay(bot, new AbortController().signal, () => {}, 'the arrows', async (s) => {
    tries++
    // each try runs into the night, the last one through it
    for (let t = 0; t < 100; t++) {
      if (s.aborted) throw s.reason
      if (t === 10) bot.time.timeOfDay = 13000
      await new Promise(resolve => setImmediate(resolve))
    }
    return tries
  })
  for (let i = 0; i < 400; i++) await tick(bot)
  assert.strictEqual(await work, NIGHT_SURFACE_TRIES)
  assert.strictEqual(waits, NIGHT_SURFACE_TRIES - 1)
  // the abort from outside is the caller's
  const ctrl = new AbortController()
  bot.time.timeOfDay = 1000
  const cut = surfaceByDay(bot, ctrl.signal, () => {}, 'the food', async (s) => await new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true })))
  ctrl.abort(new Error('stopped'))
  await assert.rejects(cut, /stopped/)
  // the wait failed (no ground for a hole), the night still on: the work as it is; no runner: the same
  const stuck = clockBot(18000, '1.21.11')
  stuck.survival = { waitOutNight: async () => {} }
  assert.strictEqual(await surfaceByDay(stuck, new AbortController().signal, () => {}, 'the food', async () => 'worked'), 'worked')
  const bare = clockBot(18000, '1.21.11')
  assert.strictEqual(await surfaceByDay(bare, new AbortController().signal, () => {}, 'the food', async () => 'worked'), 'worked')
})
