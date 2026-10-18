// bot.survival.play(): the milestone loop. The next milestone not done, its goals planned and run through the
// executor (the base by buildBase, the enchanting by its handler), the night slept through when there's a bed, a death
// recovered from (back to the death spot while the items last, else to the base for a kit), the memory saved to a
// JSON file after each milestone so a run can resume, and an event with the tick count at each milestone reached.
// The nether, eyes and end milestones run only once a handler is registered for them (bot.survival.handlers): until
// the nether and End skills are wired, play stops there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from './core/errors'
import { Inventory, type ItemCount } from './core/inventory'
import { normalizeDimension, type WorldMemory, type WorldMemoryJSON } from './core/memory'
import { MILESTONES, type Milestone, type MilestoneId, type ProgressState } from './planner/progression'
import type { Station } from './planner/steps'
import { buildBase, type BuildBaseOptions } from './base/build'
import { baseRecord } from './base/pois'
import { Executor, type ExecutorOptions } from './executor/executor'
import { defaultKeep } from './executor/keep'
import { isAbort } from './skills/errors'
import { navigate, navigateNear } from './skills/navigate'
import { pickupDrops } from './skills/pickupDrops'
import { retrieveItems } from './skills/chest'
import { canSleepNow, sleep } from './skills/sleep'
import { enchantGear } from './skills/enchant'
import { unstick } from './executor/explore'
import { goals } from '@nxg-org/mineflayer-pathfinder'

export interface MilestoneContext {
  bot: Bot
  milestone: Milestone
  state: ProgressState
  executor: Executor
  signal: AbortSignal
  log: (line: string) => void
}

/** works on a milestone; play checks `done` again after it returns */
export type MilestoneHandler = (ctx: MilestoneContext) => Promise<void>

/** the milestones that need skills play doesn't have: a handler has to be registered for them */
export const UNWIRED: readonly MilestoneId[] = ['nether', 'eyes', 'end']

export interface MilestoneEvent {
  id: MilestoneId
  title: string
  /** the bot's physics ticks (one a server tick under lockstep), over all the runs of a resumed game */
  tick: number
  /** wall-clock milliseconds since play started (this run) */
  wallMs: number
}

export interface PlayOptions {
  /** stop once this milestone is reached */
  until?: MilestoneId
  /** milestones treated as done (not worked on) */
  skip?: MilestoneId[]
  /** handlers by milestone, over bot.survival.handlers and the defaults */
  handlers?: Partial<Record<MilestoneId, MilestoneHandler>>
  /** the memory and progress are saved here after every milestone and step, and loaded from it at the start */
  saveFile?: string
  /** sleep at night when a bed is at hand (default true) */
  sleep?: boolean
  /** go back for the items when the bot died at most this many ticks ago (default 6000: ItemEntity's 5 min lifespan) */
  deathItemTicks?: number
  /** a milestone failing this many times in a row stops play (default 5) */
  maxFailures?: number
  executor?: ExecutorOptions
  base?: Partial<Omit<BuildBaseOptions, 'executor'>>
  /** a line per milestone, plan and failure (default: console.log with a [survival] prefix) */
  log?: (line: string) => void
  signal?: AbortSignal
}

export interface PlayResult {
  reached: MilestoneEvent[]
  /** the milestone play stopped before, null when the dragon is dead or `until` was reached */
  stoppedAt: MilestoneId | null
  reason: 'until' | 'finished' | 'unwired' | 'failed' | 'aborted'
  error?: unknown
}

interface SaveFile {
  version: 1
  memory: WorldMemoryJSON
  reached: MilestoneEvent[]
  /** ticks of the earlier runs */
  ticks: number
}

/** the bot's state as the milestones read it */
export function progressState (bot: Bot, memory: WorldMemory): ProgressState {
  const items: ItemCount[] = bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
  const equipment: string[] = []
  const enchanted: string[] = []
  for (const slot of [5, 6, 7, 8, 45]) {
    const item = bot.inventory.slots[slot]
    if (item != null) equipment.push(item.name)
  }
  for (const item of [...bot.inventory.items(), ...[5, 6, 7, 8, 45].map(s => bot.inventory.slots[s])]) {
    if (item != null && (item.enchants?.length ?? 0) > 0) enchanted.push(item.name)
  }
  const base = baseRecord(memory)
  const stations: Station[] = []
  if (base?.table != null) stations.push('crafting_table')
  if ((base?.furnaces.length ?? 0) > 0) stations.push('furnace')
  return { inventory: new Inventory(bot.registry as any, items), equipment, memory, stations, enchanted, advancements: [...((bot as any).survival?.advancements ?? [])] }
}

/** whether a death spot is worth going back to: in this dimension, not in lava or the void, the items not gone yet */
export function deathSpotWorthIt (death: { x: number, y: number, z: number, dimension: string, seen: number } | null, now: { tick: number, dimension: string, position: Vec3, minY: number, blockAt: (pos: Vec3) => { name: string } | null }, maxTicks: number): boolean {
  if (death == null || death.dimension !== now.dimension) return false
  if (death.y < now.minY + 1) return false
  const age = now.tick - death.seen
  if (age < 0 || age > maxTicks) return false
  // the way there, at walking speed, before the items despawn
  const travel = now.position.distanceTo(new Vec3(death.x, death.y, death.z)) * 5
  if (age + travel > maxTicks) return false
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const name = now.blockAt(new Vec3(death.x + dx, death.y + dy, death.z + dz))?.name
      if (name === 'lava' || name === 'fire') return false
    }
  }
  return true
}

const DEFAULT_LOG = (line: string): void => console.log(`[survival] ${line}`)

/** gets the goals of a milestone through the executor */
const obtainGoals: MilestoneHandler = async ({ milestone, state, executor, signal }) => {
  await executor.obtain(milestone.goals(state), signal)
}

const defaultHandlers: Partial<Record<MilestoneId, MilestoneHandler>> = {
  base: async ({ bot, executor, signal, log }) => {
    const opts = (bot as any).survival?.playOptions?.base ?? {}
    await buildBase(bot, { ...opts, executor, signal, log })
  },
  enchanting: async ({ bot, milestone, state, executor, signal }) => {
    await executor.obtain(milestone.goals(state), signal)
    await enchantGear(bot, { executor, signal })
  }
}

export class Runner {
  readonly executor: Executor
  readonly reached: MilestoneEvent[] = []
  private ticksBefore = 0
  private readonly started = Date.now()
  private readonly log: (line: string) => void
  private sleepCooldownUntil = 0

  constructor (readonly bot: Bot, readonly options: PlayOptions = {}) {
    this.log = options.log ?? DEFAULT_LOG
    this.executor = new Executor(bot, {
      log: this.log,
      home: () => this.home(),
      ...options.executor,
      hooks: {
        ...options.executor?.hooks,
        beforeStep: async (step) => {
          await options.executor?.hooks?.beforeStep?.(step)
          await this.nightCheck()
        }
      }
    })
  }

  get memory (): WorldMemory {
    return this.executor.memory
  }

  /** ticks over all runs of this game */
  get tick (): number {
    return this.ticksBefore + this.bot.survival.tasks.tick
  }

  private home (): Vec3 | null {
    const base = this.memory.base
    if (base != null) return new Vec3(base.x, base.y, base.z)
    const spawn = (this.bot as any).spawnPoint as Vec3 | undefined
    return spawn ?? null
  }

  load (): void {
    const file = this.options.saveFile
    if (file == null || !fs.existsSync(file)) return
    const data: SaveFile = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version !== 1) throw new Error(`unknown save file version ${String(data.version)}`)
    this.memory.restore(data.memory)
    this.reached.push(...data.reached)
    this.ticksBefore = data.ticks
    this.log(`resumed from ${file}: ${data.reached.length > 0 ? data.reached.map(r => r.id).join(', ') : 'no milestones yet'}`)
  }

  save (): void {
    const file = this.options.saveFile
    if (file == null) return
    const data: SaveFile = { version: 1, memory: this.memory.toJSON(), reached: this.reached, ticks: this.tick }
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  }

  private handlerFor (id: MilestoneId): MilestoneHandler | null {
    const registered = (this.bot as any).survival?.handlers?.[id] as MilestoneHandler | undefined
    const handler = this.options.handlers?.[id] ?? registered ?? defaultHandlers[id]
    if (handler != null) return handler
    if (UNWIRED.includes(id)) return null
    return obtainGoals
  }

  /** the milestones done now that weren't before: their events */
  private noteReached (state: ProgressState): void {
    for (const m of MILESTONES) {
      if (this.reached.some(r => r.id === m.id)) continue
      if (!m.done(state)) continue
      const event: MilestoneEvent = { id: m.id, title: m.title, tick: this.tick, wallMs: Date.now() - this.started }
      this.reached.push(event)
      this.log(`milestone ${m.id} reached at tick ${event.tick} (${(event.wallMs / 1000).toFixed(1)} s)`)
      this.bot.emit('survivalMilestone' as any, event)
    }
  }

  async play (): Promise<PlayResult> {
    const signal = this.options.signal
    const skip = new Set(this.options.skip ?? [])
    const failures = new Map<MilestoneId, number>()
    const maxFailures = this.options.maxFailures ?? 5
    const stopped = (): boolean => signal?.aborted === true
    this.load()
    for (;;) {
      if (stopped()) return this.stop(null, 'aborted')
      if (this.bot.health <= 0 || (this.bot as any).isAlive === false) await this.recoverFromDeath()
      const state = progressState(this.bot, this.memory)
      this.noteReached(state)
      if (this.options.until != null && this.reached.some(r => r.id === this.options.until)) return this.stop(null, 'until')
      const m = MILESTONES.find(x => !skip.has(x.id) && !x.done(state)) ?? null
      if (m == null) return this.stop(null, 'finished')
      const handler = this.handlerFor(m.id)
      if (handler == null) {
        this.log(`milestone ${m.id} needs skills that aren't wired yet: stopping (register bot.survival.handlers.${m.id})`)
        return this.stop(m.id, 'unwired')
      }
      this.log(`working on ${m.id}: ${m.title}`)
      try {
        await handler({ bot: this.bot, milestone: m, state, executor: this.executor, signal: signal ?? new AbortController().signal, log: this.log })
        failures.delete(m.id)
      } catch (err) {
        if (stopped()) return this.stop(m.id, 'aborted', err)
        if (TaskError.is(err, 'DIED') || this.bot.health <= 0) {
          this.log(`died working on ${m.id}: ${(err as Error).message}`)
          await this.recoverFromDeath()
          continue
        }
        const n = (failures.get(m.id) ?? 0) + 1
        failures.set(m.id, n)
        this.log(`milestone ${m.id} failed (${n}): ${(err as Error).message}`)
        if (n >= maxFailures) return this.stop(m.id, 'failed', err)
      }
      await this.afterTrip(signal)
      this.save()
    }
  }

  private stop (at: MilestoneId | null, reason: PlayResult['reason'], error?: unknown): PlayResult {
    this.save()
    const result: PlayResult = { reached: [...this.reached], stoppedAt: at, reason }
    if (error !== undefined) result.error = error
    this.bot.emit('survivalStopped' as any, result)
    return result
  }

  /** the valuables into the base's chests when the bot is back near it */
  private async afterTrip (signal?: AbortSignal): Promise<void> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    const p = this.bot.entity.position
    if (Math.hypot(p.x - base.origin.x, p.y - base.origin.y, p.z - base.origin.z) > 96) return
    try {
      await this.executor.storeAtBase({}, signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || isAbort(err)) throw err
      this.log(`storing failed: ${(err as Error).message}`)
    }
  }

  /** sleeps through the night when a bed is at hand: one held, the base's when near, or one standing nearby */
  async nightCheck (signal?: AbortSignal): Promise<void> {
    if (this.options.sleep === false) return
    const bot = this.bot
    const thundering = bot.isRaining && ((bot as any).thunderState ?? 0) > 0
    if (!canSleepNow(bot.time.timeOfDay, thundering)) return
    if (this.bot.survival.tasks.tick < this.sleepCooldownUntil) return
    if (normalizeDimension(bot.game?.dimension) !== 'overworld') return
    const base = baseRecord(this.memory)
    const baseBed = base?.bed != null && bot.entity.position.distanceTo(new Vec3(base.bed.x, base.bed.y, base.bed.z)) <= 64 ? new Vec3(base.bed.x, base.bed.y, base.bed.z) : null
    const held = bot.inventory.items().some(i => i.name.endsWith('_bed'))
    const near = bot.findBlock({ matching: (b: any) => b.name.endsWith('_bed'), maxDistance: 32 }) != null
    if (baseBed == null && !held && !near) return
    this.log(`night (time ${bot.time.timeOfDay}): sleeping`)
    try {
      await this.executor.task('sleep', async (s) => await sleep(bot, { bed: near ? undefined : baseBed ?? undefined, pickUpBed: !near && baseBed == null }, s), signal)
    } catch (err) {
      if (TaskError.is(err, 'DIED') || (isAbort(err) && signal?.aborted === true)) throw err
      // monsters nearby, the bed taken: try again in a while
      this.sleepCooldownUntil = this.bot.survival.tasks.tick + 400
      this.log(`couldn't sleep: ${(err as Error).message}`)
    }
  }

  /** after a death: respawned, then back for the items, or to the base for a kit */
  async recoverFromDeath (signal?: AbortSignal): Promise<void> {
    const bot = this.bot
    if (bot.health <= 0 || (bot as any).isAlive === false) {
      await new Promise<void>(resolve => {
        const done = (): void => { bot.off('spawn', done); resolve() }
        bot.on('spawn', done)
        if ((bot as any).isAlive !== false && bot.health > 0) done()
      })
    }
    // the respawn's position and chunks come a few ticks after
    await bot.waitForTicks(20)
    this.save()
    const death = this.memory.death
    const worth = deathSpotWorthIt(death, {
      tick: bot.survival.tasks.tick,
      dimension: normalizeDimension(bot.game?.dimension),
      position: bot.entity.position,
      minY: (bot.game as any)?.minY ?? -64,
      blockAt: pos => bot.blockAt(pos)
    }, this.options.deathItemTicks ?? 6000)
    if (death != null && worth) {
      this.log(`back to the death spot at ${death.x} ${death.y} ${death.z}`)
      try {
        const spot = new Vec3(death.x, death.y, death.z)
        await this.executor.task('to the death spot', async (s) => {
          // a long trip the pathfinder may plan short of: a few tries, getting moving by hand between them
          for (let i = 0; ; i++) {
            try {
              await navigateNear(bot, spot, 3, s)
              break
            } catch (err) {
              if (isAbort(err) || i >= 3) throw err
              await unstick(bot, s)
            }
          }
          return await pickupDrops(bot, { near: spot.offset(0.5, 0.5, 0.5), radius: 10 }, s)
        }, signal)
        this.memory.death = null
        return
      } catch (err) {
        if (TaskError.is(err, 'DIED')) return await this.recoverFromDeath(signal)
        this.log(`couldn't get the items back: ${(err as Error).message}`)
      }
    }
    await this.rekit(signal)
  }

  /** takes the kit (what the keep rule keeps: tools, armor, food, torches...) out of the base's chests */
  async rekit (signal?: AbortSignal): Promise<void> {
    const base = baseRecord(this.memory)
    if (base == null || base.chests.length === 0) return
    const bot = this.bot
    const dimension = this.memory.base?.dimension ?? 'overworld'
    this.log('to the base for a kit')
    if (base.entrance != null) {
      const e = base.entrance
      await this.executor.task('to the base', async (s) => await navigate(bot, { goal: new goals.GoalNear(e.x, e.y, e.z, 2) }, s), signal).catch(err => {
        if (TaskError.is(err, 'DIED')) throw err
      })
    }
    for (const chest of base.chests) {
      const known = this.memory.chestAt(chest, dimension)
      const wanted = Object.keys(known?.items ?? {}).filter(name => (defaultKeep(name) ?? 0) > 0)
      if (wanted.length === 0) continue
      try {
        const res = await this.executor.task('kit', async (s) => await retrieveItems(bot, { chest: new Vec3(chest.x, chest.y, chest.z), filter: wanted }, s), signal)
        const items = { ...(known?.items ?? {}) }
        for (const [name, n] of Object.entries(res.moved)) items[name] = Math.max(0, (items[name] ?? 0) - n)
        this.memory.rememberChest(chest, items, dimension)
      } catch (err) {
        if (TaskError.is(err, 'DIED')) throw err
        this.log(`kit from ${chest.x} ${chest.y} ${chest.z} failed: ${(err as Error).message}`)
      }
    }
  }
}

/** plays the game from where the bot is; see PlayOptions */
export async function play (bot: Bot, options: PlayOptions = {}): Promise<PlayResult> {
  ;(bot as any).survival.playOptions = options
  return await new Runner(bot, options).play()
}
