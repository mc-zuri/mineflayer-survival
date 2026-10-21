// No trip to the lava for its obsidian without a water bucket (waterForTheLava): a 26.3 bot's hazard reflex poured its
// water in a deep pool's lava, and with none left it went on mining the pool's obsidian at y -29 and swam into the lava
// (ls4-26.3, t188337 to t188576).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { waterForTheLava } from '../../src/milestones'
import { fakeBot, item } from '../reflexes/fakeBot'

test('waterForTheLava: a water bucket held goes; none, one planned (a bucket and the water); none to be had, no trip', async () => {
  const signal = new AbortController().signal
  const lines: string[] = []
  const log = (l: string): void => { lines.push(l) }
  const held = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('water_bucket')] })
  let asked = 0
  assert.equal(await waterForTheLava(held, { obtain: async () => { asked++; return { plans: 0, steps: 0 } } } as any, signal, log), true)
  assert.equal(asked, 0)
  // none: the planner's water bucket got
  const none = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [] })
  const obtain = async (reqs: any[]): Promise<any> => {
    asked++
    assert.equal(reqs[0].item, 'water_bucket')
    const w = item('water_bucket')
    w.slot = 20
    none.inventory.slots[20] = w
    return { plans: 1, steps: 2 }
  }
  assert.equal(await waterForTheLava(none, { obtain } as any, signal, log), true)
  assert.equal(asked, 1)
  // none to be had: no trip
  const dry = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [] })
  assert.equal(await waterForTheLava(dry, { obtain: async () => { throw new Error('no water found') } } as any, signal, log), false)
  assert.match(lines.join('\n'), /no trip to the lava/)
})
