import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { enterEnd, isInEnd, portalApproach, readPortalRoom } from '../../src/end/skills/enterEnd'
import { leaveEnd } from '../../src/end/skills/leaveEnd'
import { TaskError } from '../../src/core/errors'
import { fakeBot, item } from '../reflexes/fakeBot'

/** a fake bot whose world has the 12 frames round 6, 64, 8, the ones listed without an eye */
function botWithFrames (missing: number[], eyes: number): any {
  const frames = new Map<string, { facing: string, eye: boolean }>()
  let i = 0
  for (let t = -1; t <= 1; t++) {
    for (const [x, z, facing] of [[6 + t, 6, 'south'], [6 + t, 10, 'north'], [4, 8 + t, 'east'], [8, 8 + t, 'west']] as Array<[number, number, string]>) {
      frames.set(`${x},64,${z}`, { facing, eye: !missing.includes(i++) })
    }
  }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: eyes > 0 ? [item('ender_eye', eyes)] : [] })
  bot.game.dimension = 'minecraft:overworld'
  const blockAt = bot.blockAt
  bot.blockAt = (pos: Vec3) => {
    const p = pos.floored()
    const f = frames.get(`${p.x},${p.y},${p.z}`)
    if (f == null) return blockAt(p)
    return { name: 'end_portal_frame', position: p, boundingBox: 'block', getProperties: () => ({ facing: f.facing, eye: f.eye }) }
  }
  return bot
}

test('readPortalRoom finds the 3x3 inside and the frames still missing an eye from the blocks around the bot', () => {
  const room = readPortalRoom(botWithFrames([0, 5, 11], 0))
  assert.ok(room != null)
  assert.deepStrictEqual(room.center, { x: 6, y: 64, z: 8 })
  assert.strictEqual(room.missing.length, 3)
  assert.strictEqual(room.unseen.length, 0)
})

test('enterEnd: NOT_FOUND without a frame around, MISSING_ITEMS short of eyes, nothing to do in the End', async () => {
  const none = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  none.game.dimension = 'overworld'
  await assert.rejects(enterEnd(none), (err: unknown) => TaskError.is(err) && err.code === 'NOT_FOUND')
  await assert.rejects(enterEnd(botWithFrames([0, 1, 2, 3], 3)), (err: unknown) => TaskError.is(err) && err.code === 'MISSING_ITEMS')
  const there = fakeBot()
  there.game.dimension = 'minecraft:the_end'
  assert.ok(isInEnd(there))
  assert.deepStrictEqual((await enterEnd(there)).eyesPlaced, 0)
})

test('leaveEnd: NOT_FOUND outside the End, or with the exit portal shut', async () => {
  const home = fakeBot()
  home.game.dimension = 'overworld'
  await assert.rejects(leaveEnd(home), (err: unknown) => TaskError.is(err) && err.code === 'NOT_FOUND')
  // the podium's pillar at 0, 62..65, 0 and no end_portal round it
  const end = fakeBot({ world: (p) => p.x === 0 && p.z === 0 && p.y >= 61 && p.y <= 65 ? 'bedrock' : p.y < 61 ? 'stone' : 'air' })
  end.game.dimension = 'minecraft:the_end'
  await assert.rejects(leaveEnd(end), (err: unknown) => TaskError.is(err) && err.code === 'NOT_FOUND' && /shut/.test(err.message))
})

test('portalApproach: into the portal from outside a side\'s middle frame, on the frames\' level (the platform), nearest first', () => {
  const { expectedFrames } = require('../../src/end/portalRoom')
  const center = { x: 2351, y: -22, z: 1013 }
  const room: any = { center, expected: expectedFrames(center) }
  const spots = portalApproach(room, new Vec3(2349.7, -23, 1015.3))
  assert.strictEqual(spots.length, 4)
  for (const s of spots) assert.strictEqual(s.y, -22)
  // two blocks out from the middle on each side, the nearest to the bot first
  const keys = spots.map(s => `${s.x},${s.z}`)
  assert.deepStrictEqual([...keys].sort(), ['2348,1013', '2351,1010', '2351,1016', '2354,1013'].sort())
  assert.ok(['2348,1013', '2351,1016'].includes(keys[0]), keys[0])
})

test('portalRoomNear: the room\'s 12 frames in reach; 26 blocks off (mining gold for the stock) it isn\'t, and the End handler goes back first', async () => {
  const { portalRoomNear } = await import('../../src/milestones')
  const { expectedFrames } = require('../../src/end/portalRoom')
  const center = { x: 2351, y: -22, z: 1013 }
  const frames = new Map<string, any>(expectedFrames(center).map((f: any) => [`${f.pos.x},${f.pos.y},${f.pos.z}`, f]))
  const mk = (pos: Vec3): any => {
    const bot = fakeBot({ position: pos })
    bot.blockAt = (p: Vec3) => {
      const f = frames.get(`${p.x},${p.y},${p.z}`)
      return f != null
        ? { name: 'end_portal_frame', position: p, boundingBox: 'block', getProperties: () => ({ facing: f.facing, eye: false }) }
        : { name: 'air', position: p, boundingBox: 'empty' }
    }
    return bot
  }
  assert.strictEqual(portalRoomNear(mk(new Vec3(2351.5, -22, 1016.5))), true)
  assert.strictEqual(portalRoomNear(mk(new Vec3(2377.5, -27, 1017.5))), false)
})

test('frameStandSpot: outside the ring on the frames\' level (the platform), not down by the room\'s floor where the top face is out of sight', async () => {
  const { frameStandSpot } = await import('../../src/end/skills/enterEnd')
  const { world } = await import('./endWorld')
  // a frame at (10, 64, 10) facing south (+z into the room); the platform at its level is 1 out only, then a step down
  const blocks = new Map<string, string>()
  for (let x = 5; x <= 15; x++) for (let z = 0; z <= 12; z++) blocks.set(`${x},61,${z}`, 'obsidian')
  for (let x = 5; x <= 15; x++) blocks.set(`${x},63,9`, 'obsidian')
  blocks.set('10,64,10', 'obsidian')
  const spot = frameStandSpot(world(blocks), new Vec3(10, 64, 10), { x: 0, z: 1 })
  assert.deepStrictEqual(spot, { x: 10, y: 64, z: 9 })
  // no platform: 2 out on the ground there
  const low = new Map<string, string>()
  for (let x = 5; x <= 15; x++) for (let z = 0; z <= 12; z++) low.set(`${x},61,${z}`, 'obsidian')
  assert.deepStrictEqual(frameStandSpot(world(low), new Vec3(10, 64, 10), { x: 0, z: 1 }), { x: 10, y: 62, z: 8 })
})

test('frameStandSpot: no platform outside the ring, the floor 2 under the frames: the stairs\' top by it, or the ring\'s next frame', async () => {
  const { frameStandSpot } = await import('../../src/end/skills/enterEnd')
  const { world } = await import('./endWorld')
  const blocks = new Map<string, string>()
  for (let x = 5; x <= 15; x++) for (let z = 0; z <= 12; z++) blocks.set(`${x},61,${z}`, 'obsidian')
  // the ring's frames at 64 (9 to 11 along x at z 10), a stair block's top at 64 two to the side outside the ring
  for (const x of [9, 10, 11]) blocks.set(`${x},64,10`, 'end_portal_frame')
  for (let y = 62; y <= 63; y++) blocks.set(`13,${y},9`, 'obsidian')
  const get = (pos: Vec3): any => {
    const b = world(blocks)(pos)
    return b != null && b.name === 'end_portal_frame' ? { ...b, boundingBox: 'block' } : b
  }
  assert.deepStrictEqual(frameStandSpot(get, new Vec3(11, 64, 10), { x: 0, z: 1 }), { x: 13, y: 64, z: 9 })
  // no stair: on the next frame
  blocks.delete('13,62,9'); blocks.delete('13,63,9')
  assert.deepStrictEqual(frameStandSpot(get, new Vec3(11, 64, 10), { x: 0, z: 1 }), { x: 10, y: 65, z: 10 })
})
