// A Fabric dedicated server for the integration tests: downloads the Fabric server launcher (which downloads the
// vanilla server and the loader's libraries) once into tests/.servers/<version>, installs the lockstep mod, and starts
// an instance in its own directory with offline mode, a free port and the test's world settings.
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

/** What each supported version's server needs */
export interface VersionSetup {
  /** the Fabric loader (meta.fabricmc.net/v2/versions/loader/<version>) */
  loader: string
  /** the Fabric installer whose server launcher is downloaded */
  installer: string
  /** the Java major version the server needs (the version json's javaVersion.majorVersion) */
  java: number
  /**
   * the game jar is obfuscated: the loader remaps it to intermediary on the first start (.fabric/remappedJars). 26.x is
   * unobfuscated (intermediary 0.0.0) and runs the vanilla jar as it is.
   */
  obfuscated: boolean
}

export const VERSIONS: Record<string, VersionSetup> = {
  '1.21.11': { loader: '0.18.4', installer: '1.1.2', java: 21, obfuscated: true },
  '26.3': { loader: '0.20.0', installer: '1.1.2', java: 25, obfuscated: false }
}

/** The integration tests' version: SURVIVAL_VERSION, else 1.21.11 */
export const DEFAULT_VERSION = process.env.SURVIVAL_VERSION ?? '1.21.11'
/** the Java major version Gradle runs on to build the lockstep mod (Fabric Loom 1.19 needs 25, for every version) */
export const GRADLE_JAVA = 25

export function versionSetup (version: string): VersionSetup {
  const setup = VERSIONS[version]
  if (setup == null) throw new Error(`no server setup for Minecraft ${version} (the harness knows ${Object.keys(VERSIONS).join(', ')})`)
  return setup
}

const REPO_DIR = path.resolve(__dirname, '..', '..')
export const SERVERS_DIR = path.join(REPO_DIR, 'tests', '.servers')
export const SERVER_MOD_DIR = path.join(REPO_DIR, 'server-mod')

// the directories of the shared install every instance links to: the launcher's (.fabric/server: the vanilla jar, the
// loader and its libraries), the loader's remapped game jar (obfuscated versions), and the vanilla bundler's extracted
// libraries
const SHARED_DIRS = [path.join('.fabric', 'server'), path.join('.fabric', 'remappedJars'), 'libraries', 'versions']

export type GameruleValue = boolean | number | string

const CLASSIC_FLAT = {
  layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 }, { block: 'minecraft:grass_block', height: 1 }],
  biome: 'minecraft:plains'
}

export interface ServerOptions {
  /** Minecraft version (default DEFAULT_VERSION: SURVIVAL_VERSION, else 1.21.11), one of VERSIONS */
  version?: string
  /** level-seed */
  seed?: string
  /** a superflat world (level-type minecraft:flat) */
  flat?: boolean
  /** default: a free port */
  port?: number
  /** default: survival */
  gamemode?: 'survival' | 'creative' | 'adventure' | 'spectator'
  /** default: easy */
  difficulty?: 'peaceful' | 'easy' | 'normal' | 'hard'
  /** set with /gamerule once the server is up (the snake_case ids, the same in 1.21.11 and 26.3: advance_time, spawn_mobs...) */
  gamerules?: Record<string, GameruleValue>
  /** extra server.properties entries (they win over the harness's) */
  properties?: Record<string, GameruleValue>
  /** install the lockstep mod (default true) */
  lockstep?: boolean
  /** the lockstep timeout in ms (the mod's -Dlockstep.timeoutMs, default the mod's 5000) */
  lockstepTimeoutMs?: number
  /** more mod jars to install */
  mods?: string[]
  /** players to op once the server is up */
  ops?: string[]
  /** the java binary; default: findJava of the version's Java (21 for 1.21.11, 25 for 26.x) */
  java?: string
  jvmArgs?: string[]
  /** how long to wait for "Done" (default 5 min: the first start downloads and remaps the server) */
  startTimeoutMs?: number
  /** every server log line (true: to stdout) */
  log?: boolean | ((line: string) => void)
  /** keep the instance directory on cleanup() */
  keep?: boolean
  /**
   * a world directory (a saved instance's `world`, a checkpoint) copied in as the instance's level before the start:
   * the run goes on from that world, its players' inventories and positions and its time (level.dat has the seed)
   */
  world?: string
}

export interface TestServer extends EventEmitter {
  readonly host: string
  readonly port: number
  readonly version: string
  /** the instance's directory (the server's working directory) */
  readonly dir: string
  /**
   * Runs a console command and resolves with the lines it logged. The console's commands run during a tick
   * (DedicatedServer.handleConsoleInputs from tickConnection): under lockstep, once the bots ack the current tick.
   */
  command: (cmd: string) => Promise<string[]>
  /** resolves with the first log message (the text after "[thread/LEVEL]: ") that matches */
  waitForLine: (pattern: RegExp, timeoutMs?: number) => Promise<string>
  /** /stop, then waits for the process to exit (kills it after 60 s) */
  stop: () => Promise<void>
  /** stop() if it runs, then removes the instance directory (unless keep) */
  cleanup: () => Promise<void>
}

/** A log line: "[10:26:16] [Server thread/INFO]: message" */
const LOG_LINE = /^\[[^\]]*\] \[([^\]/]+)\/([A-Z]+)\]: (.*)$/
/**
 * 26.x logs what the server sends itself (MinecraftServer.sendSystemMessage: the console's command feedback, the chat
 * broadcasts) as "System chat: <message>"; 1.21.11 logs the message alone
 */
const SYSTEM_CHAT = /^System chat: /

/** The thread, the level and the message of a log line, the message without 26.x's "System chat: " */
export function parseLogLine (line: string): { thread: string, level: string, message: string } | null {
  const m = LOG_LINE.exec(line)
  return m == null ? null : { thread: m[1], level: m[2], message: m[3].replace(SYSTEM_CHAT, '') }
}

/** whether a JDK directory's name is of that major version: jdk-21.0.11, jdk-25.0.3, temurin-21-jdk, zulu21... */
export function isJdkOfMajor (name: string, major: number): boolean {
  const m = /(\d+)/.exec(name)
  return m != null && Number(m[1]) === major
}

/**
 * A java binary of that major version (default the integration version's): LOCKSTEP_JAVA (any version), JAVA<n>_HOME,
 * JAVA_HOME_<n>_X64, a JDK <n> in the usual places, then java on PATH
 */
export function findJava (major: number = versionSetup(DEFAULT_VERSION).java): string {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java'
  if (process.env.LOCKSTEP_JAVA != null) return process.env.LOCKSTEP_JAVA
  for (const home of [process.env[`JAVA${major}_HOME`], process.env[`JAVA_HOME_${major}_X64`]]) {
    if (home != null && fs.existsSync(path.join(home, 'bin', exe))) return path.join(home, 'bin', exe)
  }
  const roots = process.platform === 'win32'
    ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const name of fs.readdirSync(root).filter(n => isJdkOfMajor(n, major)).sort().reverse()) {
      for (const bin of [path.join(root, name, 'bin', exe), path.join(root, name, 'Contents', 'Home', 'bin', exe)]) {
        if (fs.existsSync(bin)) return bin
      }
    }
  }
  return 'java'
}

export async function freePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

async function download (url: string, file: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.part`
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  fs.renameSync(tmp, file)
}

function installDir (version: string): string {
  return path.join(SERVERS_DIR, version)
}

function launcherJar (version: string): string {
  const { loader, installer } = versionSetup(version)
  return path.join(installDir(version), `fabric-server-launch-${loader}-${installer}.jar`)
}

/**
 * The file the first start leaves once the install is complete: the remapped game jar of an obfuscated version, the
 * loader's server jar of an unobfuscated one (the vanilla jar runs as it is)
 */
function installedMarker (version: string): string {
  const { loader, obfuscated } = versionSetup(version)
  return obfuscated
    ? path.join(installDir(version), '.fabric', 'remappedJars', `minecraft-${version}-${loader}`)
    : path.join(installDir(version), '.fabric', 'server', `fabric-loader-server-${loader}-minecraft-${version}.jar`)
}

const installs = new Map<string, Promise<void>>()

/**
 * The shared install of a version: the Fabric server launcher from meta.fabricmc.net, run once with --initSettings,
 * which downloads the vanilla server and the loader, and has the loader remap the game (obfuscated versions).
 */
export async function ensureInstalled (version: string = DEFAULT_VERSION, java: string = findJava(versionSetup(version).java)): Promise<string> {
  const { loader, installer } = versionSetup(version)
  const dir = installDir(version)
  let install = installs.get(version)
  if (install == null) {
    install = (async () => {
      const jar = launcherJar(version)
      if (!fs.existsSync(jar)) {
        await download(`https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`, jar)
      }
      const marker = installedMarker(version)
      if (!fs.existsSync(marker)) {
        const run = spawnSync(java, ['-jar', jar, '--initSettings', '--nogui'], { cwd: dir, encoding: 'utf8', timeout: 10 * 60 * 1000 })
        if (!fs.existsSync(marker)) throw new Error(`the Fabric ${version} install failed:\n${run.stdout ?? ''}${run.stderr ?? ''}${String(run.error ?? '')}`)
      }
    })()
    installs.set(version, install)
    install.catch(() => installs.delete(version))
  }
  await install
  return dir
}

function newestMtime (p: string): number {
  if (!fs.existsSync(p)) return 0
  const stat = fs.statSync(p)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    if (entry.name === 'build' || entry.name === '.gradle') continue
    newest = Math.max(newest, newestMtime(path.join(p, entry.name)))
  }
  return newest
}

/**
 * The version's lockstep mod jar (server-mod/versions/<version>/build/libs/lockstep-<mod>+<version>.jar), built with
 * the Gradle wrapper when missing or out of date. Gradle runs on Java 25 (GRADLE_JAVA) for every version.
 */
export function lockstepModJar (version: string = DEFAULT_VERSION, java: string = findJava(GRADLE_JAVA)): string {
  const project = path.join(SERVER_MOD_DIR, 'versions', version)
  if (!fs.existsSync(path.join(project, 'build.gradle'))) throw new Error(`the lockstep mod has no ${version} project (server-mod/versions/${version})`)
  const libs = path.join(project, 'build', 'libs')
  const find = (): string | undefined => fs.existsSync(libs)
    ? fs.readdirSync(libs).filter(n => n.startsWith('lockstep-') && n.endsWith(`+${version}.jar`)).map(n => path.join(libs, n))[0]
    : undefined
  let jar = find()
  const sources = Math.max(
    newestMtime(path.join(SERVER_MOD_DIR, 'common')), newestMtime(project),
    ...['build.gradle', 'settings.gradle', 'gradle.properties'].map(f => newestMtime(path.join(SERVER_MOD_DIR, f))))
  if (jar == null || fs.statSync(jar).mtimeMs < sources) {
    const win = process.platform === 'win32'
    const javaHome = java === 'java' ? process.env.JAVA_HOME : path.dirname(path.dirname(java))
    // the wrapper by its full path (cmd may not look in the working directory: NoDefaultCurrentDirectoryInExePath)
    const gradlew = path.join(SERVER_MOD_DIR, win ? 'gradlew.bat' : 'gradlew')
    const task = [`:${version}:build`, '--no-daemon', '-q']
    const [cmd, args] = win ? ['cmd.exe', ['/d', '/c', gradlew, ...task]] : [gradlew, task]
    const run = spawnSync(cmd, args, {
      cwd: SERVER_MOD_DIR, encoding: 'utf8', env: { ...process.env, ...(javaHome != null ? { JAVA_HOME: javaHome } : {}) }
    })
    jar = find()
    if (run.status !== 0 || jar == null) throw new Error(`building the ${version} lockstep mod failed:\n${run.stdout ?? ''}${run.stderr ?? ''}`)
  }
  return jar
}

function link (target: string, at: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  fs.symlinkSync(target, at, 'junction')
}

/** removes the links first: a recursive delete must not go through them into the shared install */
export function removeInstance (dir: string): void {
  for (const rel of SHARED_DIRS) {
    const p = path.join(dir, rel)
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

function propertiesFile (props: Record<string, GameruleValue>): string {
  return Object.entries(props).map(([k, v]) => `${k}=${String(v)}`).join('\n') + '\n'
}

/**
 * Copies a world directory (a running server's after save-all flush, or a stopped one's) without its session.lock,
 * which the server that has the world open holds (LevelStorageSource.LevelStorageAccess) and a new server makes again
 */
export function copyWorld (from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, filter: src => path.basename(src) !== 'session.lock' })
}

let instanceSeq = 0

export async function startServer (options: ServerOptions = {}): Promise<TestServer> {
  const version = options.version ?? DEFAULT_VERSION
  const java = options.java ?? findJava(versionSetup(version).java)
  const shared = await ensureInstalled(version, java)
  const port = options.port ?? await freePort()
  const host = '127.0.0.1'
  const dir = path.join(shared, 'instances', `${Date.now()}-${process.pid}-${++instanceSeq}`)
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
  for (const rel of SHARED_DIRS) link(path.join(shared, rel), path.join(dir, rel))
  const mods = [...(options.lockstep ?? true ? [lockstepModJar(version)] : []), ...(options.mods ?? [])]
  for (const mod of mods) fs.copyFileSync(mod, path.join(dir, 'mods', path.basename(mod)))
  if (options.world != null) copyWorld(options.world, path.join(dir, 'world'))

  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  fs.writeFileSync(path.join(dir, 'server.properties'), propertiesFile({
    'online-mode': false,
    'enforce-secure-profile': false,
    // 26.x turns the allowlist on by default (DedicatedServerProperties: white-list true; false in 1.21.11)
    'white-list': false,
    'server-ip': host,
    'server-port': port,
    'level-name': 'world',
    'level-seed': options.seed ?? '',
    'level-type': options.flat === true ? 'minecraft:flat' : 'minecraft:normal',
    // the classic superflat (FlatLevelGeneratorSettings.getDefault): bedrock, 2 dirt, grass, plains
    ...(options.flat === true ? { 'generator-settings': JSON.stringify(CLASSIC_FLAT) } : {}),
    gamemode: options.gamemode ?? 'survival',
    difficulty: options.difficulty ?? 'easy',
    'spawn-protection': 0,
    // an empty server keeps ticking (MinecraftServer.tickServer pauses after pause-when-empty-seconds otherwise)
    'pause-when-empty-seconds': 0,
    // ServerWatchdog would kill a server blocked longer than this on a lockstep client (with a long timeout)
    'max-tick-time': -1,
    'view-distance': 6,
    'simulation-distance': 6,
    'sync-chunk-writes': false,
    'network-compression-threshold': -1,
    'enable-rcon': false,
    'enable-query': false,
    'log-ips': false,
    motd: 'mineflayer-survival test server',
    ...options.properties
  }))

  const jvmArgs = ['-Xmx2G', ...(options.lockstepTimeoutMs != null ? [`-Dlockstep.timeoutMs=${options.lockstepTimeoutMs}`] : []), ...(options.jvmArgs ?? [])]
  const child: ChildProcessWithoutNullStreams = spawn(java, [...jvmArgs, '-jar', launcherJar(version), '--nogui'], { cwd: dir, stdio: 'pipe' })
  const killOnExit = (): void => { child.kill('SIGKILL') }
  process.on('exit', killOnExit)

  const emitter = new EventEmitter()
  let exited = false
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; process.off('exit', killOnExit); resolve() }))
  const output: string[] = []
  const logFn = options.log === true ? (l: string) => console.log(`[server] ${l}`) : (typeof options.log === 'function' ? options.log : null)
  let partial = ''
  const onData = (chunk: Buffer): void => {
    partial += chunk.toString('utf8')
    const lines = partial.split(/\r?\n/)
    partial = lines.pop() ?? ''
    for (const line of lines) {
      output.push(line)
      if (output.length > 2000) output.shift()
      logFn?.(line)
      emitter.emit('line', line)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const waitForLine = async (pattern: RegExp, timeoutMs = 60000): Promise<string> => await new Promise((resolve, reject) => {
    const onLine = (line: string): void => {
      const message = parseLogLine(line)?.message ?? line
      if (!pattern.test(message)) return
      done()
      resolve(message)
    }
    const onExit = (): void => { done(); reject(new Error(`the server exited while waiting for ${String(pattern)}:\n${output.slice(-40).join('\n')}`)) }
    const timer = setTimeout(() => { done(); reject(new Error(`timed out waiting for ${String(pattern)}:\n${output.slice(-40).join('\n')}`)) }, timeoutMs)
    const done = (): void => { clearTimeout(timer); emitter.off('line', onLine); child.off('exit', onExit) }
    emitter.on('line', onLine)
    child.once('exit', onExit)
  })

  // A console command, then an unknown one as the end marker: the console runs its queue in order within a tick, so
  // the server thread's lines between the two are the command's ("Unknown or incomplete command" ends the output).
  let queue: Promise<unknown> = Promise.resolve()
  let markerSeq = 0
  const command = async (cmd: string): Promise<string[]> => {
    const run = async (): Promise<string[]> => {
      if (exited) throw new Error('the server is not running')
      const marker = `harness_marker_${process.pid}_${++markerSeq}`
      const lines: string[] = []
      const collect = (line: string): void => {
        const parsed = parseLogLine(line)
        if (parsed?.thread === 'Server thread') lines.push(parsed.message)
      }
      emitter.on('line', collect)
      try {
        child.stdin.write(`${cmd.replace(/^\//, '')}\n${marker}\n`)
        await waitForLine(new RegExp(`${marker}<--\\[HERE\\]`))
      } finally {
        emitter.off('line', collect)
      }
      const end = lines.findIndex(l => l.includes(marker))
      const out = lines.slice(0, end)
      if (out.length > 0 && /^Unknown or incomplete command/.test(out[out.length - 1])) out.pop()
      return out
    }
    const result = queue.then(run, run)
    queue = result.catch(() => {})
    return await result
  }

  const stop = async (): Promise<void> => {
    if (exited) return
    child.stdin.write('stop\n')
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    await exit
    clearTimeout(timer)
  }

  const cleanup = async (): Promise<void> => {
    await stop()
    if (options.keep !== true) removeInstance(dir)
  }

  try {
    await waitForLine(/^Done \(/, options.startTimeoutMs ?? 5 * 60 * 1000)
    for (const [rule, value] of Object.entries(options.gamerules ?? {})) {
      const out = await command(`gamerule ${rule} ${String(value)}`)
      // "Gamerule x is now set to: v" (1.21.11), "Game rule x is now set to v" (26.x), which refuses a value the rule already
      // has: "Game rule x is already set to v" (GameRuleCommand ERROR_GAME_RULE_NOT_SET)
      if (!out.some(l => /^Game ?rule .* is (now|already) set to/i.test(l))) throw new Error(`gamerule ${rule} ${String(value)}: ${out.join(' | ')}`)
    }
    for (const name of options.ops ?? []) await command(`op ${name}`)
  } catch (err) {
    child.kill('SIGKILL')
    await exit
    if (options.keep !== true) removeInstance(dir)
    throw err
  }

  return Object.assign(emitter, { host, port, version, dir, command, waitForLine, stop, cleanup })
}
