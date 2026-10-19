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
