import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LegacyRandomSource, parseSeed, shuffledRange } from '../../src/worldgen/random'
import { NETHER_COMPLEXES, STRONGHOLDS, getPotentialStructureChunk, ringPositions, selectStructure } from '../../src/worldgen/placement'

// printed by a harness running the 1.21.11 server classes (mojmap), after Bootstrap:
// for region (rx, rz) in -2..1, RandomSpreadStructurePlacement(27, 4, LINEAR, 30084232)
// .getPotentialStructureChunk(seed, rx * 27, rz * 27), then WorldgenRandom.setLargeFeatureSeed(seed,
// chunk) and nextInt(5) as ChunkGenerator.createStructures rolls: [rx, rz, chunkX, chunkZ, roll]
const VANILLA_NETHER: Array<[string, string]> = [
  ['0', '[-2,-2,-32,-45,0][-2,-1,-38,-16,3][-2,0,-39,18,0][-2,1,-45,29,1][-1,-2,-12,-52,0][-1,-1,-27,-10,3][-1,0,-27,11,3][-1,1,-20,46,0][0,-2,4,-36,0][0,-1,11,-14,2][0,0,15,2,1][0,1,0,44,0][1,-2,33,-36,0][1,-1,45,-15,3][1,0,46,9,0][1,1,31,38,2]'],
  ['1', '[-2,-2,-35,-47,4][-2,-1,-50,-9,0][-2,0,-41,16,0][-2,1,-38,41,3][-1,-2,-14,-54,0][-1,-1,-16,-27,4][-1,0,-6,9,3][-1,1,-13,35,1][0,-2,2,-38,3][0,-1,21,-8,1][0,0,12,0,2][0,1,7,33,0][1,-2,31,-44,1][1,-1,33,-9,2][1,0,44,7,1][1,1,39,28,3]'],
  ['12345', '[-2,-2,-52,-38,2][-2,-1,-41,-14,3][-2,0,-42,1,3][-2,1,-33,47,1][-1,-2,-13,-37,0][-1,-1,-17,-8,4][-1,0,-21,8,2][-1,1,-17,44,4][0,-2,6,-32,0][0,-1,11,-16,4][0,0,12,20,2][0,1,7,42,1][1,-2,44,-53,0][1,-1,49,-11,1][1,0,28,1,4][1,1,47,32,3]'],
  ['-4172144997902289642', '[-2,-2,-52,-46,1][-2,-1,-46,-15,3][-2,0,-47,12,1][-2,1,-43,48,2][-1,-2,-25,-43,3][-1,-1,-25,-5,0][-1,0,-13,12,3][-1,1,-16,32,1][0,-2,20,-35,3][0,-1,3,-27,4][0,0,14,0,3][0,1,9,28,4][1,-2,39,-48,2][1,-1,36,-23,0][1,0,37,16,0][1,1,36,35,2]'],
  ['8091867987493326313', '[-2,-2,-40,-35,4][-2,-1,-49,-12,1][-2,0,-50,10,4][-2,1,-50,45,4][-1,-2,-9,-49,2][-1,-1,-22,-17,3][-1,0,-5,4,3][-1,1,-6,30,3][0,-2,3,-45,3][0,-1,14,-7,2][0,0,12,10,0][0,1,22,31,0][1,-2,32,-36,3][1,-1,45,-26,2][1,0,36,19,4][1,1,43,44,4]'],
  ['404', '[-2,-2,-39,-48,1][-2,-1,-51,-15,2][-2,0,-49,22,0][-2,1,-50,41,4][-1,-2,-16,-32,3][-1,-1,-24,-16,0][-1,0,-17,12,1][-1,1,-14,39,2][0,-2,20,-40,4][0,-1,17,-21,3][0,0,17,19,1][0,1,18,33,1][1,-2,36,-42,4][1,-1,29,-23,0][1,0,30,2,1][1,1,34,33,4]']
]

// ChunkGeneratorStructureState.generateRingPositions's arithmetic on vanilla's RandomSource
// (the biome snap left out): chunks 0-11 and 127
const VANILLA_RINGS: Array<[string, string]> = [
  ['0', '[-13,-106][121,52][-92,69][-75,-342][223,-203][278,89][69,316][-213,194][-298,-95][-138,-492][185,-498][449,-299][455,1402]'],
  ['1', '[-14,-120][105,45][-71,53][-170,-313][163,-266][303,8][138,254][-174,284][-310,-8][-356,401][-502,110][-443,-194][-19,1462]'],
  ['12345', '[-105,124][-39,-107][114,21][293,0][178,308][-172,299][-307,0][-177,-306][144,-249][437,329][144,471][-155,450][-1163,868]'],
  ['-4172144997902289642', '[-42,87][-81,-118][132,-11][295,-118][229,181][-44,305][-297,118][-240,-189][42,-285][204,-451][474,-270][492,54][1452,-168]'],
  ['8091867987493326313', '[-90,11][40,-93][71,95][322,-111][240,208][-64,334][-273,94][-228,-198][56,-293][369,409][54,511][-267,462][489,1375]'],
  ['404', '[10,-96][121,88][-144,64][-329,-135][-47,-347][269,-208][269,110][39,291][-242,187][-222,-467][100,-535][389,-368][-1091,-988]']
]

function rows (s: string): number[][] {
  return s.slice(1, -1).split('][').map(r => r.split(',').map(Number))
}

test("LegacyRandomSource is java.util.Random's LCG", () => {
  const r = new LegacyRandomSource(0)
  assert.equal(r.nextInt(), -1155484576)
  assert.equal(r.nextInt(), -723955400)
  assert.equal(new LegacyRandomSource(0).nextLong(), -4962768465676381896n)
  // shuffling is Util.toShuffledList: Fisher-Yates from the top
  assert.deepEqual(shuffledRange(10, new LegacyRandomSource(42)).slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('seeds parse as vanilla WorldOptions.parseSeed does', () => {
  assert.equal(parseSeed('12345'), 12345n)
  assert.equal(parseSeed('-4172144997902289642'), -4172144997902289642n)
  assert.equal(parseSeed('hello'), 99162322n)
  assert.equal(parseSeed('99999999999999999999'), BigInt(Array.from('99999999999999999999').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)))
})

test('nether complex candidate chunks and the fortress/bastion roll match vanilla', () => {
  for (const [seed, data] of VANILLA_NETHER) {
    for (const [rx, rz, cx, cz, roll] of rows(data)) {
      const chunk = getPotentialStructureChunk(NETHER_COMPLEXES.placement, seed, rx * 27, rz * 27)
      assert.deepEqual(chunk, { x: cx, z: cz }, `seed ${seed} region ${rx},${rz}`)
      // any chunk of the region gives the same candidate
      assert.deepEqual(getPotentialStructureChunk(NETHER_COMPLEXES.placement, seed, rx * 27 + 26, rz * 27 + 13), chunk)
      const pick = selectStructure(NETHER_COMPLEXES, seed, cx, cz)
      assert.equal(pick.roll, roll)
      assert.equal(pick.structure, roll < 2 ? 'fortress' : 'bastion_remnant')
    }
  }
})

test('a bastion rolled in basalt deltas falls back to the fortress', () => {
  const pick = selectStructure(NETHER_COMPLEXES, 0, -38, -16, s => s !== 'bastion_remnant')
  assert.deepEqual(pick, { structure: 'fortress', roll: 3 })
})

test('stronghold ring chunks match vanilla', () => {
  for (const [seed, data] of VANILLA_RINGS) {
    const mine = ringPositions(STRONGHOLDS.placement, seed)
    assert.equal(mine.length, 128)
    const want = rows(data)
    assert.deepEqual([...mine.slice(0, 12), mine[127]].map(p => [p.x, p.z]), want, `seed ${seed}`)
    assert.deepEqual(mine.slice(0, 3).map(p => p.ring), [0, 0, 0])
    assert.equal(mine[3].ring, 1)
  }
})
