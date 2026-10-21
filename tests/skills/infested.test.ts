import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { isInfested } from '../../src/skills/util'
import { dig } from '../../src/core/actions'
import { collectBlock } from '../../src/skills/collectBlock'
import { breakKept, unsafeStep } from '../../src/executor/explore'
import { fakeBot, item } from '../reflexes/fakeBot'

// No infested block is broken (its silverfish, and the nest a hurt one wakes): a 26.3 bot mining iron at y 29 broke
// into a nest and was slain by 9 silverfish (f5-26.3).

const lookupOf = (blocks: Record<string, string>) => (pos: Vec3): { name: string, boundingBox: string } => {
  const name = blocks[`${pos.x},${pos.y},${pos.z}`] ?? 'stone'
  return { name, boundingBox: name === 'air' ? 'empty' : 'block' }
}

test('every infested block is one: stone, cobblestone, deepslate, the stone bricks and their mossy, cracked and chiseled kinds', () => {
  for (const name of ['infested_stone', 'infested_cobblestone', 'infested_deepslate', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks', 'infested_chiseled_stone_bricks']) {
    assert.ok(isInfested(name), name)
  }
  for (const name of ['stone', 'stone_bricks', 'deepslate', 'iron_ore', undefined, null]) assert.ok(!isInfested(name as any), String(name))
})

test('a dig of an infested block is refused, before it starts', async () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  let digs = 0
  bot.dig = async () => { digs++ }
  await assert.rejects(dig(bot, { name: 'infested_stone', position: new Vec3(1, 64, 0) } as any), /infested/)
  assert.strictEqual(digs, 0)
})

test('collectBlock breaks no infested block: one asked for by its place is refused (REFUSED), nothing dug', async () => {
  const blocks: Record<string, string> = { '2,63,0': 'infested_stone' }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('stone_pickaxe')], world: (pos: Vec3) => blocks[`${pos.x},${pos.y},${pos.z}`] ?? (pos.y < 64 ? 'stone' : 'air') })
  let digs = 0
  bot.dig = async () => { digs++ }
  await assert.rejects(collectBlock(bot, { positions: [new Vec3(2, 63, 0)], pickup: false, anyTool: true }), (err: any) => /infested/.test(err.message))
  assert.strictEqual(digs, 0)
})

test('a staircase\'s or tunnel\'s step that would open an infested block is unsafe, and a climb out doesn\'t dig one (breakKept)', () => {
  const step = { open: [new Vec3(1, 20, 0), new Vec3(1, 21, 0)], floor: new Vec3(1, 19, 0) }
  assert.strictEqual(unsafeStep(lookupOf({ '1,20,0': 'air', '1,21,0': 'air' }) as any, step), null)
  assert.match(unsafeStep(lookupOf({ '1,20,0': 'air', '1,21,0': 'infested_deepslate' }) as any, step) ?? '', /infested_deepslate at \(1, 21, 0\)/)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world: (pos: Vec3) => pos.x === 1 ? 'infested_stone' : (pos.y < 64 ? 'stone' : 'air') })
  bot.blockAt = (pos: Vec3) => { const p = pos.floored(); const name = p.x === 1 ? 'infested_stone' : 'air'; return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' } }
  assert.strictEqual(breakKept(bot, new Vec3(1, 64, 0)), true)
  assert.strictEqual(breakKept(bot, new Vec3(2, 63, 0)), false)
})
