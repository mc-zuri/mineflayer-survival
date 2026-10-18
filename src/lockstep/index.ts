// The client side of the lockstep protocol. The bot runs with physicsManual: on each tick{n} from the server it runs one
// client tick (bot.physicsTick()), lets the promise continuations of that tick's listeners settle, and answers ack{n};
// the server waits for the ack before its next tick. Without an answer from the server the bot ticks on its own every
// 50 ms, as mineflayer's physics timer does.
import { performance } from 'node:perf_hooks'
import type { Bot, BotOptions } from 'mineflayer'
import { createBot } from 'mineflayer'
import { CHANNEL, PROTOCOL_VERSION, decode, encode } from './protocol'

export * from './protocol'

/** mineflayer's physics timer: 50 ms a tick, at most 4 ticks caught up per run (physics.js doPhysics) */
const TICK_MS = 50
const MAX_CATCHUP_TICKS = 4

export interface LockstepOptions {
  /** how long after hello to wait for the server's answer before ticking on the 50 ms timer for good (default 3000) */
  helloTimeoutMs?: number
  /** setImmediate rounds to let a tick's async work settle before the ack (default 1; 0: only the microtasks) */
  settleRounds?: number
}

export type LockstepMode = 'realtime' | 'lockstep'

export interface Lockstep {
  readonly options: Required<LockstepOptions>
  /** 'lockstep' once the server sent a tick; 'realtime' while the bot ticks on its own timer */
  readonly mode: LockstepMode
  /** the server answered hello */
  readonly available: boolean
  /** the client ticks run (both modes) */
  readonly ticks: number
  /** the client ticks run for a server tick */
  readonly lockstepTicks: number
  /** the last server tick the bot ran its tick for (MinecraftServer.tickCount), or null */
  readonly serverTick: number | null
  /** whether the acks are held back (the server stays on the tick until resume(), or the mod's timeout) */
  readonly paused: boolean
  /** hold the ack of the next tick run: the server waits on that tick */
  pause: () => void
  /** send the held ack, if any, and ack every tick again */
  resume: () => void
  /**
   * Runs n more server ticks (resuming if paused) and holds the ack of the n-th: the server waits between that tick
   * and the next, while a test reads or sets up the world. Resolves with that tick's number.
   */
  step: (n?: number) => Promise<number>
  /** resolves once the bot has run n more client ticks (either mode) */
  waitTicks: (n: number) => Promise<void>
  /** resolves with the next server tick the bot runs (and holds the ack of, when paused) */
  nextTick: () => Promise<number>
}

declare module 'mineflayer' {
  interface Bot {
    lockstep: Lockstep
  }
  interface BotEvents {
    /** a client tick ran for server tick n; its async work settled, the ack goes next */
    lockstepTick: (n: number) => void
    /** the first tick message arrived: the timer stopped */
    lockstepStart: () => void
    /** the server did not answer hello in time: the bot keeps ticking on its own */
    lockstepUnavailable: () => void
  }
}

async function settle (rounds: number): Promise<void> {
  await Promise.resolve()
  for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

/**
 * Ticks the bot from the server's lockstep messages. The bot must have been created with physicsManual: true (no
 * mineflayer timer of its own); createLockstepBot does that.
 */
export function enableLockstep (bot: Bot, opts: LockstepOptions = {}): Lockstep {
  const options: Required<LockstepOptions> = { helloTimeoutMs: 3000, settleRounds: 1, ...opts }
  let mode: LockstepMode = 'realtime'
  let available = false
  let ticks = 0
  let lockstepTicks = 0
  let serverTick: number | null = null
  let paused = false
  let heldAck: number | null = null
  let timer: NodeJS.Timeout | null = null
  let helloTimer: NodeJS.Timeout | null = null
  let ended = false
  const pending: number[] = []
  let draining = false
  const tickWaiters: Array<(n: number) => void> = []
  let stepping: { remaining: number, resolve: (n: number) => void } | null = null
  const countWaiters: Array<{ target: number, resolve: () => void, reject: (err: Error) => void }> = []

  function runTick (): void {
    ticks++
    bot.physicsTick()
    for (let i = countWaiters.length - 1; i >= 0; i--) {
      if (ticks >= countWaiters[i].target) countWaiters.splice(i, 1)[0].resolve()
    }
  }

  // the 50 ms timer, as physics.js doPhysics: the elapsed time in whole ticks, a few caught up at most
  let lastFrame = 0
  let accumulator = 0
  function startTimer (): void {
    if (timer != null || ended) return
    lastFrame = performance.now()
    accumulator = 0
    timer = setInterval(() => {
      const now = performance.now()
      accumulator += now - lastFrame
      lastFrame = now
      let caughtUp = 0
      while (accumulator >= TICK_MS && caughtUp < MAX_CATCHUP_TICKS) {
        runTick()
        accumulator -= TICK_MS
        caughtUp++
      }
      if (caughtUp >= MAX_CATCHUP_TICKS) accumulator = 0
    }, TICK_MS)
  }
  function stopTimer (): void {
    if (timer != null) clearInterval(timer)
    timer = null
  }

  function send (data: Buffer): void {
    if (ended) return
    bot._client.write('custom_payload', { channel: CHANNEL, data })
  }

  function ack (n: number): void {
    send(encode({ type: 'ack', tick: n }))
  }

  async function drain (): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (pending.length > 0) {
        if (ended) return
        const n = pending.shift() as number
        runTick()
        lockstepTicks++
        serverTick = n
        // the pathfinder's and the tasks' continuations from this tick's physicsTick listeners run within the tick
        await settle(options.settleRounds)
        if (ended) return
        bot.emit('lockstepTick', n)
        for (const resolve of tickWaiters.splice(0)) resolve(n)
        if (stepping != null && --stepping.remaining === 0) {
          paused = true
          stepping.resolve(n)
          stepping = null
        }
        if (paused) heldAck = n
        else ack(n)
      }
    } finally {
      draining = false
    }
  }

  function onTick (n: number): void {
    if (mode !== 'lockstep') {
      mode = 'lockstep'
      stopTimer()
      if (helloTimer != null) clearTimeout(helloTimer)
      bot.emit('lockstepStart')
    }
    pending.push(n)
    void drain()
  }

  bot._client.on('custom_payload', (packet: { channel: string, data: Buffer }) => {
    if (packet.channel !== CHANNEL) return
    let message
    try {
      message = decode(packet.data)
    } catch (err) {
      bot.emit('error', err as Error)
      return
    }
    if (message == null) return
    if (message.type === 'hello') {
      available = true
      if (helloTimer != null) clearTimeout(helloTimer)
    } else if (message.type === 'tick') {
      onTick(message.tick)
    }
  })

  // mineflayer starts its timer at login (physics.js): until the server's first tick the bot ticks on this one
  bot.on('login', () => startTimer())
  // hello after every spawn: a player the server sends back to configuration leaves its player list (switchToConfig:
  // removePlayerFromWorld), which forgets its hello; the server answers a hello it already has again, and nothing more
  let helloSent = false
  bot.on('spawn', () => {
    send(encode({ type: 'hello', version: PROTOCOL_VERSION }))
    if (helloSent) return
    helloSent = true
    helloTimer = setTimeout(() => {
      if (!available && mode === 'realtime') bot.emit('lockstepUnavailable')
    }, options.helloTimeoutMs)
  })
  bot.on('end', () => {
    ended = true
    stopTimer()
    if (helloTimer != null) clearTimeout(helloTimer)
    for (const waiter of countWaiters.splice(0)) waiter.reject(new Error('the bot disconnected'))
  })

  const lockstep: Lockstep = {
    options,
    get mode () { return mode },
    get available () { return available },
    get ticks () { return ticks },
    get lockstepTicks () { return lockstepTicks },
    get serverTick () { return serverTick },
    get paused () { return paused },
    pause () { paused = true },
    resume () {
      paused = false
      if (heldAck != null) {
        const n = heldAck
        heldAck = null
        ack(n)
      }
    },
    async waitTicks (n: number) {
      if (n <= 0) return
      if (ended) throw new Error('the bot disconnected')
      await new Promise<void>((resolve, reject) => countWaiters.push({ target: ticks + n, resolve, reject }))
    },
    async nextTick () {
      return await new Promise<number>(resolve => tickWaiters.push(resolve))
    },
    async step (n = 1) {
      if (stepping != null) throw new Error('a step is running')
      if (ended) throw new Error('the bot disconnected')
      const done = new Promise<number>(resolve => { stepping = { remaining: n, resolve } })
      lockstep.resume()
      return await done
    }
  }
  bot.lockstep = lockstep
  return lockstep
}

/** mineflayer.createBot with physicsManual (the server's ticks run the bot), then enableLockstep */
export function createLockstepBot (options: BotOptions & { lockstep?: LockstepOptions }): Bot {
  const { lockstep, ...botOptions } = options
  const bot = createBot({ ...botOptions, physicsManual: true })
  enableLockstep(bot, lockstep)
  return bot
}
