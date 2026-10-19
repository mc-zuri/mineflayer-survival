import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { getSpikesForLevel } from '../../src/end/spikes'
import { parseSeed } from '../../src/worldgen/random'
import { crystalsOnSpikes, explosionDamage, readSpikes } from '../../src/end/skills/destroyCrystals'
import type { BlockGetter } from '../../src/end/skills/world'
import { entity, fakeBot } from '../reflexes/fakeBot'
import { endIsland, world } from './endWorld'

const SEED = parseSeed('endfight')
const SPIKES = getSpikesForLevel(SEED)

test('readSpikes reads the 10 spikes from the blocks: height under the crystal, radius, cage', () => {
  const get = world(endIsland(SPIKES))
  const read = readSpikes(get)
  assert.deepStrictEqual(read, SPIKES)
  // the seed fills in for spikes whose blocks aren't loaded; a crystal seen gives the height without either
  const unloaded: BlockGetter = (pos) => Math.hypot(pos.x - 42, pos.z) < 8 ? null : get(pos)
  assert.deepStrictEqual(readSpikes(unloaded, [], SEED)[0], SPIKES[0])
  const fromCrystal = readSpikes(unloaded, [{ x: 42.5, y: SPIKES[0].height + 1, z: 0.5 }])[0]
  assert.strictEqual(fromCrystal.height, SPIKES[0].height)
  assert.strictEqual(readSpikes(unloaded).length, 9)
})

test('crystalsOnSpikes matches the end_crystal entities to the spikes they sit on', () => {
  const s = SPIKES[2]
  const on = entity({ name: 'end_crystal', position: new Vec3(s.centerX + 0.5, s.height + 1, s.centerZ + 0.5) })
  const off = entity({ name: 'end_crystal', position: new Vec3(0.5, 64, 0.5) })
  const bot = fakeBot({ entities: [on, off] })
  const map = crystalsOnSpikes(bot, SPIKES)
  assert.deepStrictEqual([...map.keys()], [2])
  assert.strictEqual(map.get(2), on)
})

test('explosionDamage: a crystal blast (power 6) at 3 blocks is lethal through diamond, nothing past 12 blocks', () => {
  // ServerExplosion: impact (1 - 3/12) = 0.75, (0.75² + 0.75) / 2 × 7 × 12 + 1 = 56.125, floored to 56
  assert.strictEqual(explosionDamage(6, 3), 56.125)
  assert.ok(explosionDamage(6, 3, 1, 20, 8) > 20)
  assert.strictEqual(explosionDamage(6, 12.5), 0)
  assert.strictEqual(explosionDamage(6, 3, 0), 1)
})

test('pillarUnderCloud: a caged crystal\'s pillar column in a cloud is passed over for the next crystal', async () => {
  const { pillarUnderCloud } = await import('../../src/end/skills/destroyCrystals')
  const { planCrystals } = await import('../../src/end/crystals')
  const { getSpikesForLevel } = await import('../../src/end/spikes')
  const { parseSeed } = await import('../../src/worldgen/random')
  const spikes = getSpikesForLevel(parseSeed('2'))
  const plan = planCrystals(spikes, { from: { x: -23.5, z: 9.5 } })
  const caged = plan.find(t => t.method === 'pillar' && t.pillar != null)
  assert.ok(caged?.pillar != null)
  const col = caged.pillar.column
  const avoid = (x: number, z: number): boolean => Math.hypot(x - (col.x + 0.5), z - (col.z + 0.5)) < 6
  assert.strictEqual(pillarUnderCloud(caged, avoid), true)
  assert.strictEqual(pillarUnderCloud(caged, () => false), false)
  assert.ok(plan.some(t => !pillarUnderCloud(t, avoid)))
})

test('shotLineBlocked: a block of the world on the line from the shooting spot stops it; the cage\'s bars (to be broken) don\'t', async () => {
  const { shotLineBlocked } = await import('../../src/end/skills/destroyCrystals')
  const box = { minX: 19, minY: 80, minZ: -1, maxX: 21, maxY: 82, maxZ: 1 }
  const spot = { x: 0.5, y: 64, z: 0.5, distance: 20, pillar: 0, aim: { x: 20, y: 81, z: 0 }, shot: { yaw: 0, pitch: 0, ticks: 10 } }
  const blocks = new Map<string, string>()
  const get = world(blocks)
  assert.strictEqual(shotLineBlocked(get, spot, box), false)
  blocks.set('10,73,0', 'end_stone')
  assert.strictEqual(shotLineBlocked(get, spot, box), true)
  blocks.set('10,73,0', 'iron_bars')
  const bars: BlockGetter = (p) => { const b = get(p); return b != null && b.name === 'iron_bars' ? { ...b, boundingBox: 'block' } : b }
  assert.strictEqual(shotLineBlocked(bars, spot, box), false)
})

test('pillarToLeave: up a pillar cut short and off to another job, it is come down first; on up the same column it is not', async () => {
  const { pillarToLeave } = await import('../../src/end/skills/destroyCrystals')
  const s = SPIKES[0]
  const column = { x: 39, z: 0 }
  const pillar = { current: { column, base: 63 } }
  const same: any = { spike: s, method: 'pillar', shootFrom: null, pillar: { column, topY: 80, breakBars: [] } }
  const other: any = { spike: SPIKES[1], method: 'shoot', shootFrom: { x: 22.5, y: 63, z: 16.5 } }
  assert.deepStrictEqual(pillarToLeave(pillar, { x: 39.5, y: 84, z: 0.4 }, other), { column, base: 63 })
  assert.strictEqual(pillarToLeave(pillar, { x: 39.5, y: 84, z: 0.4 }, same), null)
  // down at its foot already, or off its column (knocked off), nothing to come down
  assert.strictEqual(pillarToLeave(pillar, { x: 39.5, y: 63, z: 0.4 }, other), null)
  assert.strictEqual(pillarToLeave(pillar, { x: 30.5, y: 63, z: 0.4 }, other), null)
  assert.strictEqual(pillarToLeave({ current: null }, { x: 39.5, y: 84, z: 0.4 }, other), null)
  // a way down that failed twice is not tried again (the loop came back to it in the same tick, forever)
  assert.strictEqual(pillarToLeave({ current: { column, base: 63, downTries: 2 } }, { x: 39.5, y: 84, z: 0.4 }, other), null)
})

test('cloudUnder: a cloud across the pillar\'s column under the bot\'s feet is waited out up there; one off it or above, not', async () => {
  const { cloudUnder } = await import('../../src/end/skills/destroyCrystals')
  const pillar = { column: { x: 39, z: 0 }, base: 62 }
  const feet = { x: 39.5, y: 82, z: 0.5 }
  const cloud = (x: number, y: number, radius = 3.3): any => ({ center: { x, z: 0.2 }, y, radius, why: 'cloud' })
  assert.ok(cloudUnder([cloud(39, 80)], feet, pillar) != null)
  // on the ground by the pillar's foot: the way down ends in it too
  assert.ok(cloudUnder([cloud(41, 62)], feet, pillar) != null)
  // off to the side, or at the bot's own feet (the watch's to get it out of), or a fireball's landing: none
  assert.strictEqual(cloudUnder([cloud(48, 80)], feet, pillar), null)
  assert.strictEqual(cloudUnder([cloud(39, 82)], feet, pillar), null)
  assert.strictEqual(cloudUnder([{ ...cloud(39, 80), why: 'fireball' }], feet, pillar), null)
})

test('readSpikes: a cage with some of its bars broken (a blast, the shot\'s line) is still a cage', () => {
  const caged = SPIKES.find(s => s.guarded) as (typeof SPIKES)[number]
  const blocks = endIsland(SPIKES)
  // the bar readSpikes once looked at alone, and the rest of that side, gone
  for (let n = -2; n <= 2; n++) for (let o = 0; o <= 3; o++) blocks.delete(`${caged.centerX + 2},${caged.height + o},${caged.centerZ + n}`)
  const read = readSpikes(world(blocks))
  assert.strictEqual(read.find(s => s.index === caged.index)?.guarded, true)
})
