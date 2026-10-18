import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cageBars, exitPortal, getSpikesForLevel, spikeCenters, spikeColumns, spikeCrystal, spikeSeed } from '../../src/end/spikes'

// SpikeFeature.SpikeCacheLoader.load (called by reflection on the 1.21.11 server classes) for
// RandomSource.create(seed).nextLong() & 65535: [centerX, centerZ, radius, height, guarded]
const VANILLA_SPIKES: Array<[string, string, string]> = [
  ['0', '20792', '[42,0,4,94,false][33,24,3,91,false][12,39,2,79,true][-13,39,4,97,false][-34,24,3,85,false][-42,-1,5,103,false][-34,-25,2,76,false][-13,-40,2,82,true][12,-40,3,88,false][33,-25,4,100,false]'],
  ['1', '40152', '[42,0,3,85,false][33,24,4,94,false][12,39,2,76,false][-13,39,2,82,true][-34,24,4,100,false][-42,-1,3,91,false][-34,-25,5,103,false][-13,-40,3,88,false][12,-40,4,97,false][33,-25,2,79,true]'],
  ['12345', '45873', '[42,0,4,97,false][33,24,5,103,false][12,39,3,91,false][-13,39,2,76,false][-34,24,4,94,false][-42,-1,4,100,false][-34,-25,2,79,true][-13,-40,3,88,false][12,-40,3,85,false][33,-25,2,82,true]'],
  ['-4172144997902289642', '51261', '[42,0,4,94,false][33,24,3,88,false][12,39,2,82,true][-13,39,3,91,false][-34,24,2,79,true][-42,-1,5,103,false][-34,-25,2,76,false][-13,-40,4,100,false][12,-40,3,85,false][33,-25,4,97,false]'],
  ['8091867987493326313', '8690', '[42,0,3,85,false][33,24,5,103,false][12,39,4,100,false][-13,39,4,97,false][-34,24,2,79,true][-42,-1,3,91,false][-34,-25,2,76,false][-13,-40,2,82,true][12,-40,3,88,false][33,-25,4,94,false]'],
  ['404', '21960', '[42,0,5,103,false][33,24,4,100,false][12,39,2,79,true][-13,39,4,94,false][-34,24,3,91,false][-42,-1,3,88,false][-34,-25,2,76,false][-13,-40,2,82,true][12,-40,3,85,false][33,-25,4,97,false]']
]

test('the spikes for a seed match vanilla SpikeFeature.getSpikesForLevel', () => {
  for (const [seed, key, data] of VANILLA_SPIKES) {
    assert.equal(spikeSeed(seed), BigInt(key))
    const want = data.slice(1, -1).split('][').map(r => {
      const [x, z, radius, height, guarded] = r.split(',')
      return { centerX: Number(x), centerZ: Number(z), radius: Number(radius), height: Number(height), guarded: guarded === 'true' }
    })
    assert.deepEqual(getSpikesForLevel(seed).map(({ index, ...s }) => s), want, `seed ${seed}`)
  }
})

test('the spikes sit on the radius-42 circle, two caged, heights 76-103', () => {
  assert.deepEqual(spikeCenters(), [
    { x: 42, z: 0 }, { x: 33, z: 24 }, { x: 12, z: 39 }, { x: -13, z: 39 }, { x: -34, z: 24 },
    { x: -42, z: -1 }, { x: -34, z: -25 }, { x: -13, z: -40 }, { x: 12, z: -40 }, { x: 33, z: -25 }
  ])
  const spikes = getSpikesForLevel(12345)
  assert.deepEqual(spikes.filter(s => s.guarded).map(s => s.height).sort(), [79, 82])
  assert.deepEqual(spikes.map(s => s.height).sort((a, b) => a - b), [76, 79, 82, 85, 88, 91, 94, 97, 100, 103])
  for (const s of spikes) assert.equal(s.radius, 2 + Math.trunc((s.height - 76) / 9))
})

test('crystals sit on bedrock on top, cages are 5x5x4 shells with a roof', () => {
  const spike = getSpikesForLevel(0).find(s => s.guarded)
  assert.ok(spike != null)
  const c = spikeCrystal(spike)
  assert.deepEqual(c.position, { x: spike.centerX + 0.5, y: spike.height + 1, z: spike.centerZ + 0.5 })
  assert.deepEqual(c.bedrock, { x: spike.centerX, y: spike.height, z: spike.centerZ })
  assert.equal(c.center.y, spike.height + 2)
  // 3 rings of 16 and a 25-block roof
  assert.equal(cageBars(spike).length, 16 * 3 + 25)
  assert.equal(cageBars({ ...spike, guarded: false }).length, 0)
  // radius 2: the 5x5 square without its corners (d² at most 5)
  assert.equal(spikeColumns(spike).length, 21)
})

test('the exit portal: 20 portal cells round the 4-high bedrock pillar, the perch on top', () => {
  const p = exitPortal(63)
  assert.equal(p.portal.length, 20)
  assert.ok(p.portal.every(c => c.x * c.x + c.z * c.z < 6.25 && c.y === 63))
  assert.deepEqual(p.pillar.map(c => c.y), [63, 64, 65, 66])
  assert.deepEqual(p.perch, { x: 0.5, y: 67, z: 0.5 })
})
