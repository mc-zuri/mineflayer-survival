import type { Bot } from 'mineflayer'
import { creeperSwelling } from '../skills/fight'
import { armorPiece } from '../skills/armor'
import { type Entity, isAlive, TaskError } from '../skills/combatUtil'
import { reflexConfig, type ReflexConfig, type ReflexConfigInput } from './config'
import { DEFAULT_REFLEXES, isHostile } from './rules'
import type { Reflex, ReflexContext, TaskSink, UrgentTask } from './types'

export interface ReflexEngineOptions {
  config?: ReflexConfigInput
  reflexes?: Reflex[]
  /** where urgent tasks go (core's TaskRunner); without one the engine runs them itself */
  sink?: TaskSink
  /** start evaluating at once (default true) */
  enabled?: boolean
}

interface Running {
  task: UrgentTask
  cancel: (message?: string) => void
}

/**
 * Evaluates the reflexes each physics tick and hands the most urgent task to the runner, preempting the foreground
 * task (and any less urgent reflex task). A reflex fires again only once its task is done; one whose task failed
 * waits config.retryCooldownTicks.
 */
export class ReflexEngine {
  config: ReflexConfig
  reflexes: Reflex[]
  enabled: boolean
  tick = 0
  /** a task is using the off hand: the totem reflex waits */
  offhandLocked = false
  private lastHurtTick = -Infinity
  private armorChanged = true
  private readonly swell = new Map<number, number>()
  private running: Running | null = null
  private readonly cooldownUntil = new Map<string, number>()
  /** reflexes kept from firing (inhibit), with how many holds each has */
  private readonly inhibited = new Map<string, number>()
  /** mobs the reflexes leave to a skill (leaveAlone), with how many holds each has */
  private readonly leftAlone = new Map<string, number>()
  private readonly onTick = (): void => this.physicsTick()
  /** the tick each entity last hurt the bot at (the damage event's cause) */
  private readonly attackers = new Map<number, number>()
  private readonly onHurt = (entity: Entity, source?: Entity): void => {
    if (entity !== this.bot.entity) return
    this.lastHurtTick = this.tick
    if (source != null && source !== this.bot.entity) this.attackers.set(source.id, this.tick)
  }
  private readonly onCollect = (collector: Entity): void => { if (collector === this.bot.entity) this.armorChanged = true }
  private readonly onSlot = (_slot: number, _old: unknown, item: { name: string } | null): void => {
    if (item != null && armorPiece(item.name) != null) this.armorChanged = true
  }

  constructor (private readonly bot: Bot, opts: ReflexEngineOptions = {}) {
    this.config = reflexConfig(opts.config)
    this.reflexes = opts.reflexes ?? DEFAULT_REFLEXES
    this.enabled = opts.enabled !== false
    this.sink = opts.sink
    bot.on('physicsTick', this.onTick)
    bot.on('entityHurt', this.onHurt)
    bot.on('playerCollect', this.onCollect)
    ;(bot.inventory as any).on('updateSlot', this.onSlot)
  }

  sink: TaskSink | undefined

  /** a mob of the retaliate list (not a hostile) that hurt the bot within retaliateTicks */
  private provokedNeutral (e: { id: number, name?: string }): boolean {
    if (!this.config.hostiles.retaliate.includes(e.name ?? '')) return false
    const at = this.attackers.get(e.id)
    return at != null && this.tick - at <= this.config.hostiles.retaliateTicks
  }

  /** what the reflexes see now */
  context (): ReflexContext {
    const bot = this.bot
    const pos = bot.entity.position
    const scan = this.config.combat.scanRange
    const hostiles = Object.values(bot.entities)
      // a mob killed stays in the world for its death animation (LivingEntity.tickDeath, 20 ticks) at health 0: no threat
      // and a neutral mob that hurt the bot lately (a polar bear by its cub, a wolf hit by mistake), to be fought back:
      // on seed 4 a polar bear killed the bot, which never looked at it, not being a hostile
      // (and the mobs a skill fights itself: leaveAlone)
      .filter(e => (isHostile(bot, e) || this.provokedNeutral(e)) && isAlive(bot, e) && e.position.distanceTo(pos) <= scan && !this.leftAlone.has(e.name ?? ''))
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    const ticksSinceHurt = this.tick - this.lastHurtTick
    const inCombat = ticksSinceHurt < this.config.combat.hurtTicks || hostiles.some(e => e.position.distanceTo(pos) <= this.config.combat.range)
    return {
      bot,
      config: this.config,
      tick: this.tick,
      ticksSinceHurt,
      attackers: this.attackers,
      hostiles,
      inCombat,
      swell: this.swell,
      armorChanged: this.armorChanged,
      offhandLocked: this.offhandLocked || ((bot as any).usingHeldItem === true && bot.inventory.slots[45]?.name === 'shield'),
      running: this.running == null ? null : { name: this.running.task.name, priority: this.running.task.priority, detail: this.running.task.detail }
    }
  }

  /** the most urgent task the reflexes want now, if it beats the one running */
  evaluate (ctx: ReflexContext = this.context()): UrgentTask | null {
    let best: UrgentTask | null = null
    for (const reflex of this.reflexes) {
      if ((this.cooldownUntil.get(reflex.name) ?? -Infinity) > this.tick) continue
      if (this.running?.task.name === reflex.name) continue
      if (this.inhibited.has(reflex.name)) continue
      const task = reflex.check(ctx)
      if (task != null && (best == null || task.priority > best.priority)) best = task
    }
    if (best == null) return null
    if (this.running != null && this.running.task.priority >= best.priority) return null
    // a foreground task above the reflexes (none should be) keeps the bot
    const current = this.sink?.current
    if (current != null && this.running == null && current.priority >= best.priority) return null
    return best
  }

  physicsTick (): void {
    this.tick++
    if (this.bot.entity == null || this.bot.entities == null) return
    this.updateSwell()
    if (!this.enabled || this.bot.health <= 0) return
    const ctx = this.context()
    const task = this.evaluate(ctx)
    if (ctx.armorChanged && !this.reflexes.some(r => r.name === 'armor' && r.check(ctx) != null)) this.armorChanged = false
    if (task == null) return
    if (task.name === 'armor') this.armorChanged = false
    this.dispatch(task)
  }

  private updateSwell (): void {
    for (const e of Object.values(this.bot.entities)) {
      if (e.name !== 'creeper') continue
      const s = Math.max(0, Math.min(30, (this.swell.get(e.id) ?? 0) + (creeperSwelling(this.bot, e) ? 1 : -1)))
      this.swell.set(e.id, s)
    }
    for (const id of this.swell.keys()) if (this.bot.entities[id] == null) this.swell.delete(id)
  }

  private dispatch (task: UrgentTask): void {
    const previous = this.running
    let settled: Promise<unknown>
    let cancel: (message?: string) => void
    if (this.sink != null) {
      // the runner aborts the lower task (PREEMPTED) and runs this one; reflex tasks aren't resumed
      const handle = this.sink.enqueue({ name: `reflex:${task.name}`, priority: task.priority, onPreempt: 'fail' }, async (ctx) => await task.run(ctx.signal))
      settled = handle.result
      cancel = handle.cancel
    } else {
      previous?.cancel(`preempted by ${task.name}`)
      const controller = new AbortController()
      settled = task.run(controller.signal)
      cancel = (message) => controller.abort(new Error(message ?? 'cancelled'))
    }
    const entry: Running = { task, cancel }
    this.running = entry
    this.bot.emit('reflex' as any, task.name, task.detail)
    settled.then(
      () => { if (this.running === entry) this.running = null },
      (err) => {
        if (this.running === entry) this.running = null
        // preempted by a more urgent reflex: free to fire again; a real failure waits
        if (!TaskError.is(err, 'PREEMPTED')) this.cooldownUntil.set(task.name, this.tick + this.config.retryCooldownTicks)
        this.bot.emit('reflexFailed' as any, task.name, err)
      }
    )
  }

  /**
   * Keeps the named reflexes from firing until the returned release is called (each hold released once; the holds
   * count): for a skill that sees to their work itself, at the times it knows are safe. The dragon fight eats only out
   * of the dragon's reach: the eat reflex fired at a 26.3 bot hitting the perched dragon at 7.7 health, and it stood
   * eating under the head until it died.
   */
  inhibit (names: string[]): () => void {
    for (const n of names) this.inhibited.set(n, (this.inhibited.get(n) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const n of names) {
        const k = (this.inhibited.get(n) ?? 1) - 1
        if (k <= 0) this.inhibited.delete(n)
        else this.inhibited.set(n, k)
      }
    }
  }

  /**
   * Leaves the named mobs out of what the reflexes see (their context's hostiles) until the returned release is called
   * (each hold released once; the holds count): for a skill that fights them its own way. The blaze fight holds the
   * blazes: the hostiles reflex took them over each time one came in range and fought them in melee by the spawner,
   * chasing them about the throne under the others' fireballs (every blaze death of 26.3 runs as to av was in it).
   */
  leaveAlone (names: string[]): () => void {
    for (const n of names) this.leftAlone.set(n, (this.leftAlone.get(n) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const n of names) {
        const k = (this.leftAlone.get(n) ?? 1) - 1
        if (k <= 0) this.leftAlone.delete(n)
        else this.leftAlone.set(n, k)
      }
    }
  }

  /** the mobs left to a skill now (leaveAlone) */
  get leftAloneNames (): string[] {
    return [...this.leftAlone.keys()]
  }

  /** the reflexes held back now (inhibit) */
  get inhibitedNames (): string[] {
    return [...this.inhibited.keys()]
  }

  /** the urgent task running, if any */
  get current (): { name: string, priority: number } | null {
    return this.running == null ? null : { name: this.running.task.name, priority: this.running.task.priority }
  }

  stop (): void {
    this.running?.cancel('reflexes stopped')
    this.bot.off('physicsTick', this.onTick)
    this.bot.off('entityHurt', this.onHurt)
    this.bot.off('playerCollect', this.onCollect)
    ;(this.bot.inventory as any).off('updateSlot', this.onSlot)
  }
}
