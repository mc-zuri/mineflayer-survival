import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { enterEnd, isInEnd, readPortalRoom } from '../../src/end/skills/enterEnd'
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
