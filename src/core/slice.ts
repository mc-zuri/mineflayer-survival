// Long synchronous work (a search over many cells, a scan of the loaded chunks) cut into slices with the event loop let
// through between them: the lockstep client acks each server tick after physicsTick and a setImmediate round, and a
// connection that hears nothing for 30 s is dropped (the server's keep-alive), so no slice may hold the process long.

/** ms of computing a slice may take before it lets the event loop through (the pathfinder's searchTickBudgetMs) */
export const SLICE_MS = 40

/** lets the event loop through: its I/O (a lockstep tick, a keep-alive), its timers and the setImmediate queue */
export async function yieldToEventLoop (): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

export interface SliceOptions {
  /** ms a slice computes for at most (default SLICE_MS) */
  sliceMs?: number
  /** after each pause (an abort's check: it throws to stop the work) */
  between?: () => void
}

/**
 * Runs a generator to its end, a slice of at most `sliceMs` ms at a time with the event loop let through between
 * slices; the generator yields at the points it may be cut, and its return is the result
 */
export async function runSliced<T> (work: Generator<unknown, T>, opts: SliceOptions = {}): Promise<T> {
  const sliceMs = opts.sliceMs ?? SLICE_MS
  let start = performance.now()
  for (;;) {
    const step = work.next()
    if (step.done === true) return step.value
    if (performance.now() - start >= sliceMs) {
      await yieldToEventLoop()
      opts.between?.()
      start = performance.now()
    }
  }
}

/** runs a generator to its end at once (runSliced without the pauses) */
export function runToEnd<T> (work: Generator<unknown, T>): T {
  for (;;) {
    const step = work.next()
    if (step.done === true) return step.value
  }
}
