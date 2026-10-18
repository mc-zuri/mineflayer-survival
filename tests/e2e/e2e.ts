// pnpm e2e: bot.survival.play() through the whole game on a fresh world (a fixed seed, survival, normal difficulty, no
// gamerule changed, no op), under lockstep, to the ender dragon killed. Each milestone's tick and wall time is logged,
// with the ticks a wall second; it passes once the server says the player has minecraft:end/kill_dragon (1.21.11 has
// no /advancement test: `execute if entity @a[name=…,advancements={…=true}]`, "Test passed").
//
// At each milestone the world is saved (save-all flush) and copied with play's save into the checkpoint directory
// (<checkpoints>/<n>-<milestone>/: world/ and save.json), and --resume <that directory> starts a server on the copy
// and play from that save: a later stage tried again from where a real run got to it.
//
//   pnpm e2e [--seed 2] [--max-ticks 3000000] [--until <milestone>] [--resume <checkpoint dir>]
//            [--checkpoints <dir>] [--version 1.21.11] [--username player] [--server-log <file>]
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { createPlugin } from '../../src'
import type { MilestoneEvent, PlayResult } from '../../src/runner'
import type { MilestoneId } from '../../src/planner/progression'
import { connectLockstepBot, copyWorld, quitBot, startServer, DEFAULT_VERSION, type TestServer } from '../harness'

export interface E2EOptions {
  seed: string
  version: string
  username: string
  maxTicks: number
  until?: MilestoneId
  resume?: string
  checkpoints: string
  serverLog?: string
  /** a status line every this many wall ms (default 60000) */
  statusMs: number
}

export function parseArgs (argv: string[]): E2EOptions {
  const opts: E2EOptions = {
    seed: '2',
    version: DEFAULT_VERSION,
    username: 'player',
    maxTicks: 3000000,
    checkpoints: '',
    statusMs: 60000
  }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2)
    const value = (): string => {
      const v = inline ?? argv[++i]
      if (v == null) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--seed': opts.seed = value(); break
      case '--version': opts.version = value(); break
      case '--username': opts.username = value(); break
      case '--max-ticks': opts.maxTicks = Number(value()); break
      case '--until': opts.until = value() as MilestoneId; break
      case '--resume': opts.resume = value(); break
      case '--checkpoints': opts.checkpoints = value(); break
      case '--server-log': opts.serverLog = value(); break
      case '--status-ms': opts.statusMs = Number(value()); break
      default: throw new Error(`unknown option ${argv[i]}`)
    }
  }
  if (opts.checkpoints === '') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    opts.checkpoints = path.join(__dirname, '..', '.e2e', `${opts.seed}-${stamp}`)
  }
  return opts
}

/** "1h02m03s" */
export function formatWall (ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h > 0 ? `${h}h` : ''}${h > 0 ? String(m).padStart(2, '0') : m}m${String(s % 60).padStart(2, '0')}s`
}

/** the summary table: each milestone's tick and wall time, the ticks a wall second over the run */
export function summary (reached: readonly MilestoneEvent[], totalTicks: number, wallMs: number): string[] {
  const lines = reached.map(r => `  ${r.id.padEnd(10)} tick ${String(r.tick).padStart(8)}  wall ${formatWall(r.wallMs).padStart(9)}`)
  lines.push(`  total      tick ${String(totalTicks).padStart(8)}  wall ${formatWall(wallMs).padStart(9)}  ${(totalTicks / Math.max(1, wallMs / 1000)).toFixed(1)} ticks/s`)
  return lines
}

/** the console's `execute if entity` answer: "Test passed" (with a count from some versions) */
export function testPassed (lines: readonly string[]): boolean {
  return lines.some(l => /^Test passed/.test(l))
}

export async function hasKillDragon (server: TestServer, username: string): Promise<boolean> {
  return testPassed(await server.command(`execute if entity @a[name=${username},advancements={minecraft:end/kill_dragon=true}]`))
}

function where (bot: Bot): string {
  const p = bot.entity?.position
  const inv = bot.inventory?.items().map(i => `${i.count} ${i.name}`).join(', ') ?? ''
  return `${bot.game?.dimension ?? '?'} ${p != null ? `${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}` : '?'}, health ${bot.health?.toFixed(0)}, food ${bot.food}, xp ${bot.experience?.level ?? 0}${inv !== '' ? `; ${inv}` : ''}`
}

export async function runE2E (opts: E2EOptions): Promise<boolean> {
  fs.mkdirSync(opts.checkpoints, { recursive: true })
  const saveFile = path.join(opts.checkpoints, 'save.json')
  const resumeWorld = opts.resume != null ? path.join(opts.resume, 'world') : undefined
  if (opts.resume != null) fs.copyFileSync(path.join(opts.resume, 'save.json'), saveFile)
  const log = (line: string): void => console.log(`[e2e] ${line}`)
  // the stuck reports (bot.survival.diagnostics) next to the checkpoints
  if (process.env.SURVIVAL_STUCK_DIR == null || process.env.SURVIVAL_STUCK_DIR === '') process.env.SURVIVAL_STUCK_DIR = path.join(opts.checkpoints, 'stuck')
  log(`seed ${opts.seed}, ${opts.version}, normal difficulty, survival, ${opts.maxTicks} ticks at most${opts.resume != null ? `, resumed from ${opts.resume}` : ''}; checkpoints in ${opts.checkpoints}, stuck reports in ${process.env.SURVIVAL_STUCK_DIR}`)
  const serverLog = opts.serverLog
  const server = await startServer({
    version: opts.version,
    seed: opts.seed,
    difficulty: 'normal',
    world: resumeWorld,
    log: serverLog != null ? line => fs.appendFileSync(serverLog, `${line}\n`) : undefined
  })
  let bot: Bot | null = null
  const wall0 = Date.now()
  let status: NodeJS.Timeout | null = null
  try {
    bot = await connectLockstepBot(server, { username: opts.username, op: false, timeoutMs: 120000 })
    const b = bot
    await b.waitForChunksToLoad()
    b.loadPlugin(createPlugin())
    log(`the advancement check at the start: ${(await server.command(`execute if entity @a[name=${opts.username},advancements={minecraft:end/kill_dragon=true}]`)).join(' | ')}`)
    const k0 = b.lockstep.ticks
    let lastK = k0
    let lastWall = wall0
    status = setInterval(() => {
      const k = b.lockstep.ticks
      const now = Date.now()
      log(`status: ${formatWall(now - wall0)} wall, ${k - k0} ticks, ${((k - lastK) / Math.max(0.001, (now - lastWall) / 1000)).toFixed(1)} ticks/s now; ${where(b)}`)
      lastK = k
      lastWall = now
    }, opts.statusMs)
    status.unref()
    let checkpointSeq = 0
    let checkpointing: Promise<void> = Promise.resolve()
    const reached: MilestoneEvent[] = []
    b.on('survivalMilestone' as any, (event: MilestoneEvent) => {
      reached.push(event)
      log(`milestone ${event.id} at tick ${event.tick}, ${formatWall(event.wallMs)} wall (${(event.tick / Math.max(1, (Date.now() - wall0) / 1000)).toFixed(1)} ticks/s so far); ${where(b)}`)
      // the world as it is now and play's save with this milestone in it
      const dir = path.join(opts.checkpoints, `${String(++checkpointSeq).padStart(2, '0')}-${event.id}`)
      checkpointing = checkpointing.then(async () => {
        const saved = fs.existsSync(saveFile) ? JSON.parse(fs.readFileSync(saveFile, 'utf8')) : null
        await server.command('save-all flush')
        copyWorld(path.join(server.dir, 'world'), path.join(dir, 'world'))
        if (saved != null) {
          const ids = new Set(saved.reached.map((r: MilestoneEvent) => r.id))
          for (const r of reached) if (!ids.has(r.id)) saved.reached.push(r)
          saved.ticks = Math.max(saved.ticks, event.tick)
          fs.writeFileSync(path.join(dir, 'save.json'), JSON.stringify(saved))
        }
        log(`checkpoint ${dir}`)
      }).catch(err => log(`checkpoint ${dir} failed: ${(err as Error).message}`))
    })
    const result: PlayResult = await b.survival.play({ saveFile, maxTicks: opts.maxTicks, until: opts.until })
    await checkpointing
    const ticks = b.lockstep.ticks - k0
    const wallMs = Date.now() - wall0
    log(`play stopped: ${result.reason}${result.stoppedAt != null ? ` at ${result.stoppedAt}` : ''}${result.error != null ? `: ${(result.error as Error).message}` : ''}`)
    log(`${where(b)}`)
    for (const line of summary(result.reached, result.reached.length > 0 ? Math.max(ticks, result.reached[result.reached.length - 1].tick) : ticks, wallMs)) log(line)
    if (opts.until != null) {
      const ok = result.reason === 'until'
      log(ok ? `PASS: ${opts.until} reached` : `FAIL: ${opts.until} not reached`)
      return ok
    }
    const killed = await hasKillDragon(server, opts.username)
    log(killed ? 'PASS: minecraft:end/kill_dragon granted' : 'FAIL: no minecraft:end/kill_dragon')
    return killed
  } finally {
    if (status != null) clearInterval(status)
    if (bot != null) {
      bot.survival?.reflexes?.stop()
      await quitBot(bot)
    }
    await server.cleanup()
  }
}

if (require.main === module || process.env.E2E_MAIN === '1') {
  runE2E(parseArgs(process.argv.slice(2))).then(ok => process.exit(ok ? 0 : 1), err => {
    console.error(err)
    process.exit(2)
  })
}
