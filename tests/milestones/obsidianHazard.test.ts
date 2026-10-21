// The obsidian in sight a milestone mines (naturalObsidian): none by lava or on a ruined portal's magma, none under the
// rock for a bot not fit for the caves. A 26.3 bot went for a ruined portal's underground at y 46, stood on its magma,
// and burned to death there (ls4-26.3, t54809 to t57447).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { obsidianHazard } from '../../src/skills/hazardCells'
import { fakeBot, item } from '../reflexes/fakeBot'

test('obsidianHazard: lava within 2, magma within 1, or under the rock for a bot not fit for the caves', () => {
  const world = (over: Record<string, string>, roofY = 70) => (p: Vec3): string => over[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 || p.y > roofY && p.y <= roofY + 4 ? 'stone' : 'air')
  // the obsidian on the open ground at (5, 64, 0)
  const at = new Vec3(5, 64, 0)
  const open = { '5,64,0': 'obsidian' }
  const plain = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: world(open, 400) })
  plain.game.dimension = 'overworld'
  assert.equal(obsidianHazard(plain, at), false)
  const lava = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: world({ ...open, '7,64,1': 'lava' }, 400) })
  assert.equal(obsidianHazard(lava, at), true)
  const magma = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: world({ ...open, '6,63,0': 'magma_block' }, 400) })
  assert.equal(obsidianHazard(magma, at), true)
  const magmaFar = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: world({ ...open, '7,63,0': 'magma_block' }, 400) })
  assert.equal(obsidianHazard(magmaFar, at), false)
  // under rock (stone from 71 up): the rule's, not a bot fit for the caves'
  const under = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: world(open) })
  under.game.dimension = 'overworld'
  assert.equal(obsidianHazard(under, at), true)
  const prot = [{ name: 'protection', lvl: 1 }]
  const ready = fakeBot({
    position: new Vec3(0.5, 64, 0.5),
    world: world(open),
    armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 10)]
  })
  ready.game.dimension = 'overworld'
  assert.equal(obsidianHazard(ready, at), false)
})
