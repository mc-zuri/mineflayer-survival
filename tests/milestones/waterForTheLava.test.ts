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

test('lavaPoolOrder: the pool under the sky first, then the one in the rock; the one in a cave last, and none for a bot not fit for the caves (ls4-26.3)', async () => {
  const { lavaPoolOrder } = await import('../../src/milestones')
  // the surface at y 63 (rock under it); a cave of air round (40, 20, 0); pools at the surface, in the rock and in the cave
  const world = (p: Vec3): string => p.x >= 36 && p.x <= 44 && p.y >= 18 && p.y <= 23 && Math.abs(p.z) <= 4 && p.y !== 18 ? 'air' : p.y <= 63 ? 'stone' : 'air'
  const pools = [{ x: 40, y: 18, z: 0 }, { x: 10, y: 30, z: 0 }, { x: 60, y: 63, z: 0 }]
  const plain = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  plain.game.dimension = 'overworld'
  assert.deepEqual(lavaPoolOrder(plain, pools), [{ x: 60, y: 63, z: 0 }, { x: 10, y: 30, z: 0 }])
  const prot = [{ name: 'protection', lvl: 1 }]
  const ready = fakeBot({
    position: new Vec3(0.5, 64, 0.5),
    world,
    armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 10)]
  })
  ready.game.dimension = 'overworld'
  assert.deepEqual(lavaPoolOrder(ready, pools), [{ x: 60, y: 63, z: 0 }, { x: 10, y: 30, z: 0 }, { x: 40, y: 18, z: 0 }])
})
