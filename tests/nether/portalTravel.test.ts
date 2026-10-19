// Into the nether through a remembered portal: walked to at its height (a cave's portal lies under the ground).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'

test('enterNether walks to a remembered portal at its height (exactY), not to the ground over it', async () => {
  const travelModule = require('../../src/skills/travel')
  const { enterNether } = await import('../../src/nether/portalTravel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(-140, 63, -70) })
  bot.game.dimension = 'overworld'
  const memory = new WorldMemory()
  memory.addPoi('nether_portal', { x: 35, y: -43, z: -54 }, 'overworld', 'built')
  ;(bot as any).survival = { memory }
  bot.findBlocks = () => []
  const calls: any[] = []
  const real = travelModule.travel
  travelModule.travel = async (_bot: unknown, args: any) => { calls.push(args); throw new Error('walked') }
  try {
    await assert.rejects(enterNether(bot, { build: false }), /walked/)
  } finally {
    travelModule.travel = real
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].exactY, true)
  assert.equal(calls[0].target.y, -43)
})

test('unlitFrameAt: the whole obsidian frame with nothing in it round a remembered portal cell', async () => {
  const { unlitFrameAt } = await import('../../src/nether/portalTravel')
  const { portalFrame } = await import('../../src/nether/portal')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const frame = portalFrame({ x: 10, y: 50, z: 5 }, 'x')
  const obsidian = new Set(frame.obsidian.map(p => `${p.x},${p.y},${p.z}`))
  const bot = fakeBot({ world: (p: any) => obsidian.has(`${p.x},${p.y},${p.z}`) ? 'obsidian' : 'air' })
  const found = unlitFrameAt(bot, new Vec3(11, 51, 5))
  assert.ok(found != null)
  assert.deepEqual(found.origin, { x: 10, y: 50, z: 5 })
  assert.equal(unlitFrameAt(fakeBot({ world: () => 'air' }), new Vec3(11, 51, 5)), null)
})
