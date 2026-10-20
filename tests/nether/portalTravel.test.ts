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

test('enterNether digs down to a remembered portal under the bot when the walk finds no way', async () => {
  const travelModule = require('../../src/skills/travel')
  const tunnelModule = require('../../src/skills/tunnel')
  const { enterNether } = await import('../../src/nether/portalTravel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const bot = fakeBot({ position: new Vec3(-27.5, 59, -38.5) })
  bot.game.dimension = 'overworld'
  const memory = new WorldMemory()
  memory.addPoi('nether_portal', { x: -27, y: 51, z: -39 }, 'overworld', 'built')
  ;(bot as any).survival = { memory }
  bot.findBlocks = () => []
  const calls: string[] = []
  const realTravel = travelModule.travel
  const realTunnel = tunnelModule.tunnelTo
  travelModule.travel = async () => { calls.push('travel'); throw new Error('NO_PATH: no way on') }
  tunnelModule.tunnelTo = async () => { calls.push('tunnel'); throw new Error('dug') }
  try {
    await assert.rejects(enterNether(bot, { build: false }), /dug/)
  } finally {
    travelModule.travel = realTravel
    tunnelModule.tunnelTo = realTunnel
  }
  assert.deepEqual(calls, ['travel', 'tunnel'])
})

test('enterPortal digs a stair to beside the portal when no path gets there', async () => {
  const navModule = require('../../src/skills/navigate')
  const tunnelModule = require('../../src/skills/tunnel')
  const { enterPortal } = await import('../../src/nether/portalTravel')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // a portal's bottom at (0, 51, 0) and (1, 51, 0) on obsidian, stone round, the bot 8 over it in its own pocket
  const portal = new Set(['0,51,0', '1,51,0', '0,52,0', '1,52,0', '0,53,0', '1,53,0'])
  const world = (p: any): string => portal.has(`${p.x},${p.y},${p.z}`) ? 'nether_portal' : (p.y === 50 ? 'obsidian' : (p.y >= 51 && p.y <= 53 && Math.abs(p.z) === 1 && p.x >= 0 && p.x <= 1) ? 'air' : (p.y >= 59 && p.y <= 60 && p.x === 0 && p.z === 0) ? 'air' : 'stone')
  const bot = fakeBot({ position: new Vec3(0.5, 59, 0.5), world })
  bot.game.dimension = 'overworld'
  const id = bot.registry.blocksByName.nether_portal.id
  bot.findBlocks = () => [...portal].map(k => new Vec3(...k.split(',').map(Number) as [number, number, number]))
  const realBlockAt = bot.blockAt.bind(bot)
  bot.blockAt = ((p: any) => { const b = realBlockAt(p); return b?.name === 'nether_portal' ? { ...b, type: id } : b }) as any
  const calls: string[] = []
  const realNav = navModule.navigate
  const realTunnel = tunnelModule.tunnelTo
  navModule.navigate = async () => { calls.push('navigate'); throw new Error('NO_PATH: timeout') }
  tunnelModule.tunnelTo = async (_b: unknown, a: any) => { calls.push(`tunnel ${a.target.toString()}`) }
  try {
    await assert.rejects(enterPortal(bot, { portal: new Vec3(0, 51, 0) }), /no way to the portal|couldn't step/)
  } finally {
    navModule.navigate = realNav
    tunnelModule.tunnelTo = realTunnel
  }
  assert.ok(calls.some(c => c.startsWith('tunnel')), calls.join(', '))
})

test('frameNear: an unlit frame (a ghast put the portal out) is found from 3 or 4 blocks off the remembered portal, a gap or two in it noted; none with its inside blocked', async () => {
  const { frameNear } = await import('../../src/nether/portalTravel')
  const { portalFrame } = await import('../../src/nether/portal')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const frame = portalFrame({ x: 10, y: 64, z: 0 }, 'x')
  const obsidian = new Set(frame.obsidian.map(p => `${p.x},${p.y},${p.z}`))
  const world = (gaps: string[] = [], inside = 'air') => (p: any) => {
    const k = `${p.x},${p.y},${p.z}`
    if (obsidian.has(k) && !gaps.includes(k)) return 'obsidian'
    if (frame.interior.some(c => c.x === p.x && c.y === p.y && c.z === p.z)) return inside
    return p.y < 64 ? 'netherrack' : 'air'
  }
  // the remembered spot 3 off along z and 1 along x
  const remembered = new Vec3(12, 65, 3)
  const found = frameNear(fakeBot({ world: world() }), remembered)
  assert.ok(found != null)
  assert.deepStrictEqual(found.frame.origin, { x: 10, y: 64, z: 0 })
  assert.deepStrictEqual(found.missing, [])
  const gap = `${frame.obsidian[3].x},${frame.obsidian[3].y},${frame.obsidian[3].z}`
  const gapped = frameNear(fakeBot({ world: world([gap]) }), remembered)
  assert.ok(gapped != null)
  assert.deepStrictEqual(gapped.missing.map(p => `${p.x},${p.y},${p.z}`), [gap])
  assert.equal(frameNear(fakeBot({ world: world([], 'netherrack') }), remembered), null)
})
