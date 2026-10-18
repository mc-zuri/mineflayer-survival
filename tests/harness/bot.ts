// A lockstep bot on a harness server, and commands run as that bot.
import type { Bot, BotOptions } from 'mineflayer'
import { createLockstepBot } from '../../src/lockstep'
import type { LockstepOptions } from '../../src/lockstep'
import type { TestServer } from './server'
import * as path from 'node:path'

/** where the integration tests' stuck reports go (bot.survival.diagnostics), unless SURVIVAL_STUCK_DIR says */
export const STUCK_DIR = path.resolve(__dirname, '..', '.stuck')

export interface ConnectOptions extends Partial<BotOptions> {
  lockstep?: LockstepOptions
  /** op the bot once it joined (default true): it runs the tests' commands */
  op?: boolean
  /** how long to wait for the first lockstep tick (default 60 s) */
  timeoutMs?: number
}

/** A bot on the server, resolved once the server ticks it (lockstepStart) */
export async function connectLockstepBot (server: TestServer, options: ConnectOptions = {}): Promise<Bot> {
  const { op = true, timeoutMs = 60000, ...botOptions } = options
  // the stuck reports of the bot's trips: a failed test's error has the diagnosis and the report's file
  if (process.env.SURVIVAL_STUCK_DIR == null || process.env.SURVIVAL_STUCK_DIR === '') process.env.SURVIVAL_STUCK_DIR = STUCK_DIR
  const bot = createLockstepBot({ host: server.host, port: server.port, username: 'Bot', version: server.version, auth: 'offline', ...botOptions })
  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => { done(); bot.end(); reject(err) }
    const onError = (err: Error): void => fail(err)
    const onKicked = (reason: unknown): void => fail(new Error(`kicked: ${JSON.stringify(reason)}`))
    const onEnd = (reason: string): void => fail(new Error(`disconnected: ${reason}`))
    const timer = setTimeout(() => fail(new Error('no lockstep tick from the server')), timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      bot.off('lockstepStart', onStart)
      bot.off('error', onError)
      bot.off('kicked', onKicked)
      bot.off('end', onEnd)
    }
    const onStart = (): void => { done(); resolve() }
    bot.on('lockstepStart', onStart)
    bot.on('error', onError)
    bot.on('kicked', onKicked)
    bot.on('end', onEnd)
  })
  if (op) await server.command(`op ${bot.username}`)
  return bot
}

/**
 * Runs a command as the bot and resolves with the first chat line that matches. A command from a player runs as a
 * server task (ServerGamePacketListenerImpl.tryHandleChat: server.execute): while the bot holds an ack (step), between
 * that tick and the next.
 */
export async function botCommand (bot: Bot, cmd: string, pattern: RegExp = /./, timeoutMs = 10000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const onMessage = (message: string): void => {
      if (!pattern.test(message)) return
      done()
      resolve(message)
    }
    const timer = setTimeout(() => { done(); reject(new Error(`no answer to /${cmd} matching ${String(pattern)}`)) }, timeoutMs)
    const done = (): void => { clearTimeout(timer); bot.off('messagestr', onMessage) }
    bot.on('messagestr', onMessage)
    bot.chat(`/${cmd.replace(/^\//, '')}`)
  })
}

/** quit, and wait for the connection to close */
export async function quitBot (bot: Bot): Promise<void> {
  if ((bot as any)._client?.ended === true) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 5000)
    bot.once('end', () => { clearTimeout(timer); resolve() })
    bot.lockstep?.resume()
    bot.quit()
  })
}
