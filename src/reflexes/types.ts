import type { Bot } from 'mineflayer'
import type { Entity } from '../skills/combatUtil'
import type { ReflexConfig } from './config'

/** A task a reflex hands the runner to preempt the foreground one. */
export interface UrgentTask {
  /** the reflex's name (one urgent task per reflex at a time) */
  name: string
  /** above the foreground tasks' 0; a higher one preempts a lower one */
  priority: number
  /** what it's going to do, for logs and tests (e.g. 'fight zombie', 'flee') */
  detail?: string
  run: (signal: AbortSignal) => Promise<unknown>
}

/** What the reflexes see each tick: the bot and what the engine keeps track of between ticks. */
export interface ReflexContext {
  bot: Bot
  config: ReflexConfig
  /** physics ticks since the engine started */
  tick: number
  /** ticks since the bot last took damage (Infinity if never) */
  ticksSinceHurt: number
  /** hostile mobs within config.combat.scanRange, nearest first */
  hostiles: Entity[]
  /** a hostile within config.combat.range, or hurt within config.combat.hurtTicks */
  inCombat: boolean
  /** each creeper's swell count as the client follows it (Creeper.swell: +1 a tick swelling, -1 not, 0 - 30) */
  swell: Map<number, number>
  /** armor came into the inventory since the armor reflex last looked */
  armorChanged: boolean
  /** a task is using the off hand (a raised shield): leave it alone */
  offhandLocked: boolean
  /** the urgent task now running, if any */
  running: { name: string, priority: number, detail?: string } | null
}

/** An always-on rule, evaluated each physics tick. */
export interface Reflex {
  name: string
  /** the priority of the tasks it returns (the engine checks the higher ones first) */
  priority: number
  check: (ctx: ReflexContext) => UrgentTask | null
}

/**
 * Where urgent tasks go: core's TaskRunner fits (enqueue a higher priority than the running task and it preempts
 * it). The engine falls back to running them itself when none is given.
 */
export interface TaskSink {
  readonly current: { name: string, priority: number } | null
  enqueue: (opts: { name: string, priority?: number, onPreempt?: 'resume' | 'fail' }, fn: (ctx: { signal: AbortSignal }) => Promise<unknown>) => { result: Promise<unknown>, cancel: (message?: string) => void }
}
