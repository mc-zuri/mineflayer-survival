// A lava source in the rock scooped from a tunnel (scoopByTunnel): a 1.21.11 bot's casts at home went for sources at
// (-82, 46, 152) and (-111, 17, 174), 'no spot found to see' either from, and its portal frame never got its obsidian
// (f3-1.21.11, t86275 to t268827).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { scoopStands } from '../../src/skills/lavaScoop'
import { fakeBot, item } from '../reflexes/fakeBot'

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`
function lookup (cells: Record<string, string>): (p: Vec3) => any {
  return (p: Vec3) => {
    const name = cells[key(p)] ?? 'stone'
    return { name, boundingBox: name === 'stone' ? 'block' : 'empty' }
  }
}

test('scoopStands: beside the cell over a source in the rock, on its solid floor; none by a fluid, none for a source under lava', () => {
  const source = new Vec3(6, 40, 0)
  const stands = scoopStands(lookup({ '6,40,0': 'lava' }), source)
  assert.deepEqual(stands.map(s => s.stand.toArray()).sort(), [[5, 41, 0], [6, 41, -1], [6, 41, 1], [7, 41, 0]].sort())
  assert.ok(stands.every(s => s.opening.equals(new Vec3(6, 41, 0))))
  // a pool: the sources beside it no floor, so only the stands over the rock
  const pool = scoopStands(lookup({ '6,40,0': 'lava', '7,40,0': 'lava', '6,40,1': 'lava' }), source)
  assert.deepEqual(pool.map(s => s.stand.toArray()).sort(), [[5, 41, 0], [6, 41, -1]].sort())
  // lava over the source, or against the cell over it: none
  assert.deepEqual(scoopStands(lookup({ '6,40,0': 'lava', '6,41,0': 'lava' }), source), [])
  assert.deepEqual(scoopStands(lookup({ '6,40,0': 'lava', '6,42,0': 'lava' }), source), [])
  assert.deepEqual(scoopStands(lookup({ '6,40,0': 'lava', '7,41,0': 'water' }), source), [])
  // water against a stand's head: that stand passed over
  const wet = scoopStands(lookup({ '6,40,0': 'lava', '5,43,0': 'water' }), source)
  assert.ok(!wet.some(s => s.stand.equals(new Vec3(5, 41, 0))))
  assert.equal(wet.length, 3)
})

test('scoopByTunnel: the tunnel to the nearest stand, the cell over the source dug, the bucket filled through it, the cell closed again', async () => {
  const tunnel = require('../../src/skills/tunnel')
  const bucket = require('../../src/skills/bucket')
  const actions = require('../../src/core/actions')
  const place = require('../../src/skills/placeBlock')
  const { scoopByTunnel } = await import('../../src/skills/lavaScoop')
  const cells: Record<string, string> = { '6,40,0': 'lava' }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('bucket', 1), item('cobblestone', 8), item('diamond_pickaxe', 1)], world: p => cells[key(p)] ?? (p.y < 64 ? 'stone' : 'air') })
  const calls: string[] = []
  const real = { tunnelTo: tunnel.tunnelTo, fillBucket: bucket.fillBucket, dig: actions.dig, placeBlock: place.placeBlock }
  tunnel.tunnelTo = async (_b: any, args: any) => { calls.push(`tunnel ${key(args.target)}`); bot.entity.position = args.target.offset(0.5, 0, 0.5) }
  actions.dig = async (_b: any, block: any) => { calls.push(`dig ${key(block.position)}`); cells[key(block.position)] = 'air' }
  bucket.fillBucket = async (_b: any, args: any) => { calls.push(`fill ${key(args.pos)}`); bot.inventory.slots[9] = Object.assign(item('lava_bucket', 1), { slot: 9 }) }
  place.placeBlock = async (_b: any, args: any) => { calls.push(`place ${args.item} ${key(args.pos)}`); cells[key(args.pos)] = args.item }
  const ticks = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await scoopByTunnel(bot, new Vec3(6, 40, 0))
  } finally {
    clearInterval(ticks)
    Object.assign(tunnel, { tunnelTo: real.tunnelTo })
    Object.assign(bucket, { fillBucket: real.fillBucket })
    Object.assign(actions, { dig: real.dig })
    Object.assign(place, { placeBlock: real.placeBlock })
  }
  // (the stand nearest the bot at (0.5, 64, 0.5): (5, 41, 0))
  assert.deepEqual(calls, ['tunnel 5,41,0', 'dig 6,41,0', 'fill 6,40,0', 'place cobblestone 6,41,0'])
})

test('scoopByTunnel: no stand (lava over the source), NO_PATH and no digging', async () => {
  const { scoopByTunnel } = await import('../../src/skills/lavaScoop')
  const cells: Record<string, string> = { '6,40,0': 'lava', '6,41,0': 'lava' }
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('bucket', 1)], world: p => cells[key(p)] ?? (p.y < 64 ? 'stone' : 'air') })
  await assert.rejects(scoopByTunnel(bot, new Vec3(6, 40, 0)), (err: any) => err.reason === 'NO_PATH')
})
