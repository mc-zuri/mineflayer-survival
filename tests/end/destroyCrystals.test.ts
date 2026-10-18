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
