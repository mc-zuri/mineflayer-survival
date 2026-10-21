import { TaskError, type TaskErrorCode } from './errors'

/** what the runner counts ticks on: the bot, whose `physicsTick` fires once per client tick */
export interface TickSource {
  on: (event: 'physicsTick', listener: () => void) => unknown
  removeListener: (event: 'physicsTick', listener: () => void) => unknown
}

export interface TaskContext<S = Record<string, unknown>> {
  /** aborted on preemption, cancel or timeout; its reason is a TaskError */
  readonly signal: AbortSignal
  /** 1 on the first run, +1 every time the task is resumed or retried */
  readonly attempt: number
  /** kept across attempts, so a preempted task can resume where it stopped */
  readonly state: S
  /** ticks this task has been the foreground task, over all attempts */
  ticks: () => number
  /** resolves after n physics ticks; rejects with the abort reason */
  waitTicks: (n: number) => Promise<void>
  /** throws the abort reason if the signal is aborted */
  throwIfAborted: () => void
}

export interface TaskOptions<S = Record<string, unknown>> {
  name: string
  /** higher runs first; a higher priority than the running task preempts it (default 0) */
  priority?: number
  /** the task fails with TIMEOUT after this many foreground ticks */
  timeoutTicks?: number
  /** what happens to the task when a higher-priority one preempts it (default 'resume') */
  onPreempt?: 'resume' | 'fail'
  /** run again this many times when the task fails with one of `retryOn` (default 0) */
  retries?: number
  retryOn?: TaskErrorCode[]
  /** initial `ctx.state` */
  state?: S
}

export type TaskFn<T, S> = (ctx: TaskContext<S>) => Promise<T>

export interface TaskHandle<T> {
  readonly id: number
  readonly name: string
  readonly priority: number
  readonly result: Promise<T>
  /** aborts the task (or drops it from the queue); the result rejects with ABORTED */
  cancel: (message?: string) => void
  /**
   * aborts the running task with `reason` (its signal's reason), not to be resumed: the result rejects with it, and
   * the task's partial result, once the task has stopped (or its grace ticks are out); a queued one is dropped
   */
  stop: (reason: TaskError) => void
}

/**
 * What a task did, for whoever watches the runner (a recorder): its attempt started, ended, failed, was preempted (to
 * run again) or failed to be retried; `attempt` 0 for a task dropped from the queue before it ran
 */
export interface TaskEvent {
  type: 'start' | 'end' | 'fail' | 'preempted' | 'retry'
  id: number
  name: string
  priority: number
  attempt: number
  /** its foreground ticks so far */
  ticks: number
  /** why it failed (fail, preempted, retry) */
  error?: TaskError
}

export interface TaskRunnerOptions {
  /** how long an aborted task may take to settle before the next one starts anyway (default 20) */
  abortGraceTicks?: number
}

interface Entry {
  id: number
  seq: number
  name: string
  priority: number
  opts: TaskOptions<any>
  fn: TaskFn<any, any>
  state: any
  attempt: number
  retriesLeft: number
  ticks: number
  resolve: (value: any) => void
  reject: (err: unknown) => void
  controller: AbortController | null
  /** why the runner aborted the running attempt */
  abortReason: TaskError | null
  settled: boolean
}

interface Waiter {
  at: number
  resolve: () => void
}

/**
 * Runs one foreground task at a time (the foreground lock), highest priority first, FIFO
 * within a priority. A task queued with a higher priority than the running one preempts it:
 * the running task is aborted with PREEMPTED and, unless it opted out, goes back to the
 * front of its priority, to run again (with `attempt` + 1 and the same `state`) once the
 * higher-priority work is done. Timeouts count physics ticks, not wall time, so they hold
 * under lockstep.
 */
export class TaskRunner {
  /** physics ticks seen since the runner was made */
  tick = 0

  private readonly queue: Entry[] = []
  private running: Entry | null = null
  /** the aborted task being given its grace ticks to settle */
  private draining: { entry: Entry, deadline: number } | null = null
  private waiters: Waiter[] = []
  private nextId = 1
  private nextSeq = 0
  private pumpQueued = false
  private readonly abortGraceTicks: number
  private readonly onTick = (): void => this.physicsTick()
  private readonly observers = new Set<(event: TaskEvent) => void>()

  constructor (private readonly ticks: TickSource, opts: TaskRunnerOptions = {}) {
    this.abortGraceTicks = opts.abortGraceTicks ?? 20
    ticks.on('physicsTick', this.onTick)
  }

  /** calls `cb` with each task's start, end, failure, preemption and retry; returns the call to stop */
  onTask (cb: (event: TaskEvent) => void): () => void {
    this.observers.add(cb)
    return () => { this.observers.delete(cb) }
  }

  private tell (type: TaskEvent['type'], entry: Entry, error?: unknown): void {
    if (this.observers.size === 0) return
    const event: TaskEvent = { type, id: entry.id, name: entry.name, priority: entry.priority, attempt: entry.attempt, ticks: entry.ticks }
    if (error !== undefined) event.error = TaskError.from(error)
    for (const cb of this.observers) {
      try { cb(event) } catch {}
    }
  }

  /** queues a task and returns its handle; `handle.result` settles with the task */
  enqueue<T, S = Record<string, unknown>> (opts: TaskOptions<S> | string, fn: TaskFn<T, S>): TaskHandle<T> {
    const o: TaskOptions<S> = typeof opts === 'string' ? { name: opts } : opts
    let resolve!: (value: T) => void
    let reject!: (err: unknown) => void
    const result = new Promise<T>((_resolve, _reject) => { resolve = _resolve; reject = _reject })
    const entry: Entry = {
      id: this.nextId++,
      seq: this.nextSeq++,
      name: o.name,
      priority: o.priority ?? 0,
      opts: o,
      fn,
      state: o.state ?? {},
      attempt: 0,
      retriesLeft: o.retries ?? 0,
      ticks: 0,
      resolve,
      reject,
      controller: null,
      abortReason: null,
      settled: false
    }
    this.insert(entry)
    if (this.running != null && entry.priority > this.running.priority) {
      this.abortRunning(new TaskError('PREEMPTED', `${this.running.name} preempted by ${entry.name}`))
    }
    this.schedulePump()
    return {
      id: entry.id,
      name: entry.name,
      priority: entry.priority,
      result,
      cancel: (message?: string) => this.cancelEntry(entry, new TaskError('ABORTED', message ?? `${entry.name} cancelled`)),
      stop: (reason: TaskError) => {
        if (this.running === entry) this.abortRunning(reason)
        else this.cancelEntry(entry, reason)
      }
    }
  }

  /** queues a task and waits for its result */
  async run<T, S = Record<string, unknown>> (opts: TaskOptions<S> | string, fn: TaskFn<T, S>): Promise<T> {
    return await this.enqueue(opts, fn).result
  }

  /** the running foreground task, if any */
  get current (): { id: number, name: string, priority: number } | null {
    const r = this.running
    return r == null ? null : { id: r.id, name: r.name, priority: r.priority }
  }

  /** names of the queued tasks, in the order they will run */
  get pending (): string[] {
    return this.queue.map(e => e.name)
  }

  /** the running task and the queue, a preempted task (one that ran before) marked: for the stall reports */
  snapshot (): { current: { name: string, priority: number, attempt: number, ticks: number } | null, queue: Array<{ name: string, priority: number, attempt: number, preempted: boolean }> } {
    const r = this.running
    return {
      current: r == null ? null : { name: r.name, priority: r.priority, attempt: r.attempt, ticks: r.ticks },
      queue: this.queue.map(e => ({ name: e.name, priority: e.priority, attempt: e.attempt, preempted: e.attempt > 0 }))
    }
  }

  get busy (): boolean {
    return this.running != null
  }

  /** aborts the running task and rejects every queued one with `code` (e.g. DIED) */
  cancelAll (code: TaskErrorCode = 'ABORTED', message?: string): void {
    const err = (): TaskError => new TaskError(code, message ?? code)
    for (const e of this.queue.splice(0)) this.settle(e, false, err())
    if (this.running != null) this.cancelEntry(this.running, err())
  }

  /** resolves after n physics ticks */
  async waitTicks (n: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw abortError(signal)
    if (n <= 0) return
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { at: this.tick + n, resolve: () => { signal?.removeEventListener('abort', onAbort); resolve() } }
      const onAbort = (): void => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        reject(abortError(signal as AbortSignal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** stops listening to ticks and cancels everything */
  destroy (): void {
    this.cancelAll('ABORTED', 'task runner destroyed')
    this.ticks.removeListener('physicsTick', this.onTick)
  }

  private insert (entry: Entry): void {
    // higher priority first, then by seq (a resumed task keeps its old seq, so it goes back in front)
    let i = this.queue.findIndex(e => e.priority < entry.priority || (e.priority === entry.priority && e.seq > entry.seq))
    if (i < 0) i = this.queue.length
    this.queue.splice(i, 0, entry)
  }

  private schedulePump (): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    // a microtask, so tasks queued in the same tick start by priority, not by call order
    queueMicrotask(() => { this.pumpQueued = false; this.pump() })
  }

  private pump (): void {
    if (this.running != null) return
    const entry = this.queue.shift()
    if (entry == null) return
    this.start(entry)
  }

  private start (entry: Entry): void {
    const controller = new AbortController()
    entry.controller = controller
    entry.abortReason = null
    entry.attempt++
    this.running = entry
    this.tell('start', entry)
    const ctx: TaskContext<any> = {
      signal: controller.signal,
      attempt: entry.attempt,
      state: entry.state,
      ticks: () => entry.ticks,
      waitTicks: async (n: number) => await this.waitTicks(n, controller.signal),
      throwIfAborted: () => { if (controller.signal.aborted) throw abortError(controller.signal) }
    }
    let promise: Promise<unknown>
    try {
      promise = Promise.resolve(entry.fn(ctx))
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise.then(
      value => this.finish(entry, controller, true, value),
      err => this.finish(entry, controller, false, err)
    )
  }

  private finish (entry: Entry, controller: AbortController, ok: boolean, value: unknown): void {
    // a late settle of an attempt the runner already gave up on
    if (entry.controller !== controller) return
    entry.controller = null
    if (this.running === entry) this.running = null
    if (this.draining?.entry === entry) this.draining = null
    const reason = entry.abortReason
    if (ok) {
      // finished even though it was aborted: the work is done, keep the result
      this.settle(entry, true, value)
    } else if (reason?.code === 'PREEMPTED' && entry.opts.onPreempt !== 'fail') {
      this.tell('preempted', entry, reason)
      this.insert(entry)
    } else if (reason != null) {
      this.settle(entry, false, TaskError.is(value) && value.partial !== undefined ? reason.withPartial(value.partial) : reason)
    } else {
      const err = TaskError.from(value)
      if (entry.retriesLeft > 0 && (entry.opts.retryOn == null || entry.opts.retryOn.includes(err.code))) {
        entry.retriesLeft--
        this.tell('retry', entry, err)
        this.insert(entry)
      } else {
        this.settle(entry, false, err)
      }
    }
    this.schedulePump()
  }

  private settle (entry: Entry, ok: boolean, value: unknown): void {
    if (entry.settled) return
    entry.settled = true
    this.tell(ok ? 'end' : 'fail', entry, ok ? undefined : value)
    if (ok) entry.resolve(value)
    else entry.reject(value)
  }

  private cancelEntry (entry: Entry, err: TaskError): void {
    const i = this.queue.indexOf(entry)
    if (i >= 0) {
      this.queue.splice(i, 1)
      this.settle(entry, false, err)
    } else if (this.running === entry) {
      // the handle rejects now; the lock is held until the task stops or its grace runs out
      this.abortRunning(err)
      this.settle(entry, false, err)
    }
  }

  private abortRunning (reason: TaskError): void {
    const entry = this.running
    if (entry?.controller == null || entry.abortReason != null) return
    entry.abortReason = reason
    const controller = entry.controller
    controller.abort(reason)
    // give the task some ticks to stop cleanly; after that the next task starts anyway
    if (this.abortGraceTicks <= 0) this.finish(entry, controller, false, reason)
    else this.draining = { entry, deadline: this.tick + this.abortGraceTicks }
  }

  private physicsTick (): void {
    this.tick++
    const running = this.running
    if (running != null && running.abortReason == null) {
      running.ticks++
      const timeout = running.opts.timeoutTicks
      if (timeout != null && running.ticks >= timeout) {
        this.abortRunning(new TaskError('TIMEOUT', `${running.name} timed out after ${timeout} ticks`))
      }
    }
    const draining = this.draining
    if (draining != null && this.tick >= draining.deadline && draining.entry.controller != null) {
      this.finish(draining.entry, draining.entry.controller, false, draining.entry.abortReason)
    }
    if (this.waiters.length === 0) return
    const due = this.waiters.filter(w => w.at <= this.tick)
    if (due.length === 0) return
    this.waiters = this.waiters.filter(w => w.at > this.tick)
    for (const w of due) w.resolve()
  }
}

function abortError (signal: AbortSignal): unknown {
  return signal.reason ?? new TaskError('ABORTED')
}
