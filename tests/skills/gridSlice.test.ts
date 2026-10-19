import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { gridPath, gridPathSliced, type GridCellView } from '../../src/skills/gridWalk'
import { runSliced, SLICE_MS } from '../../src/core/slice'

/** an open floor at y 63, each lookup costing `us` µs */
function slowFloor (us: number): GridCellView {
  const spin = (): void => { const end = performance.now() + us / 1000; while (performance.now() < end) {} }
  return {
    free: p => { spin(); return p.y >= 64 },
    floor: p => { spin(); return p.y === 63 }
  }
}

/** the longest the event loop went without a 1 ms timer firing while `work` ran */
async function longestHold (work: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now }, 1)
  try {
    last = performance.now()
    await work()
    longest = Math.max(longest, performance.now() - last)
  } finally {
    clearInterval(timer)
  }
  return longest
}

test('gridPathSliced: a search of 6000 cells lets the event loop through every slice, and finds what gridPath finds', async () => {
  const view = slowFloor(2)
  const goal = (c: Vec3): boolean => c.y === 100 // never: the search looks at all its cells
  const h = (c: Vec3): number => Math.abs(c.x - 1000)
  const t0 = performance.now()
  assert.strictEqual(gridPath(view, new Vec3(0, 64, 0), goal, h, 6000), null)
  const whole = performance.now() - t0
  // (the search on its own holds the process well over a slice)
  assert.ok(whole > 4 * SLICE_MS, `the search took ${whole.toFixed(0)} ms`)
  let result: Vec3[] | null | undefined
  const hold = await longestHold(async () => { result = await gridPathSliced(view, new Vec3(0, 64, 0), goal, h, 6000) })
  assert.strictEqual(result, null)
  assert.ok(hold < SLICE_MS + 60, `the event loop was held ${hold.toFixed(0)} ms (the whole search ${whole.toFixed(0)} ms)`)

  const open: GridCellView = { free: p => p.y >= 64, floor: p => p.y === 63 }
  const sliced = await gridPathSliced(open, new Vec3(0, 64, 0), c => c.x === 30 && c.z === 4, c => Math.abs(c.x - 30) + Math.abs(c.z - 4))
  assert.deepStrictEqual(sliced?.map(String), gridPath(open, new Vec3(0, 64, 0), c => c.x === 30 && c.z === 4, c => Math.abs(c.x - 30) + Math.abs(c.z - 4))?.map(String))
})

test('gridPathSliced: an abort between slices stops the search', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(gridPathSliced(slowFloor(2), new Vec3(0, 64, 0), c => c.y === 100, c => Math.abs(c.x - 1000), 20000, {
    between: () => { if (controller.signal.aborted) throw new Error('aborted') }
  }), /aborted/)
})

test('runSliced: the generator runs to its end over several slices, its return the result', async () => {
  function * count (): Generator<void, number> {
    let n = 0
    const end = performance.now() + 60
    while (performance.now() < end) { n++; yield }
    return n
  }
  let pauses = 0
  const n = await runSliced(count(), { sliceMs: 10, between: () => { pauses++ } })
  assert.ok(n > 0)
  assert.ok(pauses >= 3, `${pauses} pauses`)
})
