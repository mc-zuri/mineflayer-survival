import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { CHANNEL, decode, encode, enableLockstep } from '../../src/lockstep'
import type { LockstepMessage } from '../../src/lockstep'

// A bot of the parts the lockstep client uses: its client's custom_payload packets in and out, and physicsTick
function fakeBot (): any {
  const bot: any = new EventEmitter()
  bot.ticks = 0
  bot.physicsTick = () => {
    bot.ticks++
    bot.emit('physicsTick')
  }
  bot._client = new EventEmitter()
  bot.sent = [] as LockstepMessage[]
  bot._client.write = (name: string, params: { channel: string, data: Buffer }) => {
    assert.strictEqual(name, 'custom_payload')
    assert.strictEqual(params.channel, CHANNEL)
    bot.sent.push(decode(params.data))
  }
  bot.receive = (message: LockstepMessage) => bot._client.emit('custom_payload', { channel: CHANNEL, data: encode(message) })
  bot.acks = () => bot.sent.filter((m: LockstepMessage) => m.type === 'ack').map((m: { tick: number }) => m.tick)
  return bot
}

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))
const until = async (condition: () => boolean, ms = 1000): Promise<void> => {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('hello goes once the bot spawned, and after every spawn (a reconfigured player is a new one to the server)', () => {
  const bot = fakeBot()
  enableLockstep(bot)
  assert.deepStrictEqual(bot.sent, [])
  bot.emit('spawn')
  assert.deepStrictEqual(bot.sent, [{ type: 'hello', version: 1 }])
  bot.emit('spawn')
  assert.deepStrictEqual(bot.sent, [{ type: 'hello', version: 1 }, { type: 'hello', version: 1 }])
  bot.emit('end')
})

test('a tick runs one client tick, then the ack goes once the tick\'s async work settled', async () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot.emit('spawn')
  const done: number[] = []
  bot.on('physicsTick', async () => {
    // a task's continuation a few promises deep (the pathfinder's, a skill's)
    await Promise.resolve()
    await Promise.resolve()
    done.push(bot.ticks)
  })
  let ackedAfter: number[] | null = null
  const write = bot._client.write
  bot._client.write = (name: string, params: { channel: string, data: Buffer }) => {
    if (decode(params.data)?.type === 'ack') ackedAfter = [...done]
    write(name, params)
  }
  bot.receive({ type: 'hello', version: 1 })
  bot.receive({ type: 'tick', tick: 41 })
  assert.strictEqual(bot.ticks, 1)
  assert.deepStrictEqual(bot.acks(), [])
  await until(() => bot.acks().length === 1)
  assert.deepStrictEqual(bot.acks(), [41])
  assert.deepStrictEqual(ackedAfter, [1])
  assert.strictEqual(bot.lockstep.mode, 'lockstep')
  assert.strictEqual(bot.lockstep.available, true)
  assert.strictEqual(bot.lockstep.serverTick, 41)
  assert.strictEqual(bot.lockstep.lockstepTicks, 1)
  bot.emit('end')
})

test('ticks that come together run one after another, each acked in order', async () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot.emit('spawn')
  for (const tick of [7, 8, 9]) bot.receive({ type: 'tick', tick })
  await until(() => bot.acks().length === 3)
  assert.deepStrictEqual(bot.acks(), [7, 8, 9])
  assert.strictEqual(bot.ticks, 3)
  bot.emit('end')
})

test('until the first tick the bot ticks on a 50 ms timer from login; the first tick stops it', async () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot.emit('login')
  await sleep(230)
  const timerTicks = bot.ticks
  assert.ok(timerTicks >= 2 && timerTicks <= 6, `${timerTicks as number} ticks in 230 ms`)
  bot.emit('spawn')
  bot.receive({ type: 'tick', tick: 1 })
  await until(() => bot.acks().length === 1)
  await sleep(150)
  assert.strictEqual(bot.ticks, timerTicks + 1)
  assert.strictEqual(bot.lockstep.ticks, timerTicks + 1)
  assert.strictEqual(bot.lockstep.lockstepTicks, 1)
  bot.emit('end')
})

test('without an answer to hello the bot keeps its timer and says so (lockstepUnavailable)', async () => {
  const bot = fakeBot()
  enableLockstep(bot, { helloTimeoutMs: 20 })
  let unavailable = false
  bot.on('lockstepUnavailable', () => { unavailable = true })
  bot.emit('login')
  bot.emit('spawn')
  await sleep(120)
  assert.strictEqual(unavailable, true)
  assert.strictEqual(bot.lockstep.mode, 'realtime')
  assert.ok(bot.ticks >= 1)
  bot.emit('end')
  const ticks = bot.ticks
  await sleep(120)
  assert.strictEqual(bot.ticks, ticks, 'the timer stops when the bot ends')
})

test('pause holds the next ack (the server stays on that tick); resume sends it', async () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot.emit('spawn')
  bot.lockstep.pause()
  const next = bot.lockstep.nextTick()
  bot.receive({ type: 'tick', tick: 5 })
  assert.strictEqual(await next, 5)
  await sleep(20)
  assert.deepStrictEqual(bot.acks(), [])
  assert.strictEqual(bot.lockstep.paused, true)
  bot.lockstep.resume()
  assert.deepStrictEqual(bot.acks(), [5])
  bot.receive({ type: 'tick', tick: 6 })
  await until(() => bot.acks().length === 2)
  assert.deepStrictEqual(bot.acks(), [5, 6])
  bot.emit('end')
})

test('step runs n ticks and holds the n-th\'s ack', async () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot.emit('spawn')
  const stepped = bot.lockstep.step(3)
  for (const tick of [10, 11, 12]) bot.receive({ type: 'tick', tick })
  assert.strictEqual(await stepped, 12)
  await sleep(10)
  assert.deepStrictEqual(bot.acks(), [10, 11])
  assert.strictEqual(bot.lockstep.paused, true)
  // the next step sends the held ack first
  const next = bot.lockstep.step()
  assert.deepStrictEqual(bot.acks(), [10, 11, 12])
  bot.receive({ type: 'tick', tick: 13 })
  assert.strictEqual(await next, 13)
  bot.lockstep.resume()
  assert.deepStrictEqual(bot.acks(), [10, 11, 12, 13])
  bot.emit('end')
})

test('waitTicks resolves after that many client ticks', async () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot.emit('spawn')
  const waited = bot.lockstep.waitTicks(3)
  let resolved = false
  void waited.then(() => { resolved = true })
  for (const tick of [1, 2]) bot.receive({ type: 'tick', tick })
  await until(() => bot.acks().length === 2)
  assert.strictEqual(resolved, false)
  bot.receive({ type: 'tick', tick: 3 })
  await waited
  bot.emit('end')
  await assert.rejects(bot.lockstep.waitTicks(1), /disconnected/)
})

test('other channels are left alone', () => {
  const bot = fakeBot()
  enableLockstep(bot)
  bot._client.emit('custom_payload', { channel: 'minecraft:brand', data: Buffer.from([1, 2]) })
  assert.strictEqual(bot.ticks, 0)
  bot.emit('end')
})
