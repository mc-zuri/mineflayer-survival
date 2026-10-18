import { test } from 'node:test'
import assert from 'node:assert'
import { chooseFuel, cookFood } from '../../src/skills/cookFood'
import { TaskError } from '../../src/core/errors'
import { fakeBot, item } from '../reflexes/fakeBot'

test('chooseFuel: enough of the longest burner, else what there is', () => {
  // 8 beef in a furnace: 1600 ticks, one coal
  assert.deepStrictEqual(chooseFuel([{ name: 'oak_planks', count: 10 }, { name: 'coal', count: 3 }], 1600), { name: 'coal', count: 1 })
  // planks burn 300: six for 1600
  assert.deepStrictEqual(chooseFuel([{ name: 'oak_planks', count: 10 }, { name: 'dirt', count: 64 }], 1600), { name: 'oak_planks', count: 6 })
  // not enough of anything: all of the best
  assert.deepStrictEqual(chooseFuel([{ name: 'stick', count: 2 }], 1600), { name: 'stick', count: 2 })
  assert.strictEqual(chooseFuel([{ name: 'dirt', count: 64 }], 200), null)
  // never the lava bucket (the bucket's wanted)
  assert.strictEqual(chooseFuel([{ name: 'lava_bucket', count: 1 }], 200), null)
})

test('cookFood smelts each raw food with the smelter and reports what came out', async () => {
  const bot = fakeBot({ items: [item('beef', 5), item('porkchop', 2), item('bread', 3)] })
  const calls: Array<{ input: string, count?: number }> = []
  const result = await cookFood(bot, {
    smelt: async (_bot, args) => {
      calls.push(args)
      return { output: args.input === 'beef' ? 'cooked_beef' : 'cooked_porkchop', count: args.count ?? 0 }
    }
  })
  assert.deepStrictEqual(calls, [{ input: 'beef', count: 5 }, { input: 'porkchop', count: 2 }])
  assert.deepStrictEqual(result.cooked, { cooked_beef: 5, cooked_porkchop: 2 })
  // a count caps the lot
  const calls2: Array<{ input: string, count?: number }> = []
  await cookFood(bot, { count: 6, smelt: async (_b, args) => { calls2.push(args); return { output: 'x', count: args.count ?? 0 } } })
  assert.deepStrictEqual(calls2, [{ input: 'beef', count: 5 }, { input: 'porkchop', count: 1 }])
  await assert.rejects(cookFood(fakeBot({ items: [item('bread')] })), (err: unknown) => TaskError.is(err, 'MISSING_ITEMS'))
})
