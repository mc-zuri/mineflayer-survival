// The nether's biomes from the seed (NetherBiomeSource) against the server's: biomes a 26.3 server's generator puts at
// these blocks (read with packages/minecraft-java-worldgen's getBiome, which matches the server chunk for chunk), and
// the bastions it builds, which never stand in a basalt delta.
import { describe, test } from 'node:test'
import assert from 'node:assert'
import { NetherBiomeSource } from '../../src/worldgen/netherBiomes'
import { netherComplexes } from '../../src/nether/fortress'

/** [x, z, biome] from the server's generator, three of each biome */
const ORACLE: Record<string, Array<[number, number, string]>> = {
  2: [[3, -5, 'nether_wastes'], [-21, -64, 'crimson_forest'], [3, -69, 'crimson_forest'], [-88, -96, 'crimson_forest'], [131, -5, 'basalt_deltas'], [121, 44, 'basalt_deltas'], [94, 86, 'basalt_deltas'], [139, -141, 'soul_sand_valley'], [184, -186, 'soul_sand_valley'], [-119, -301, 'soul_sand_valley'], [-314, 312, 'warped_forest'], [-359, 357, 'warped_forest'], [476, -201, 'warped_forest']],
  '-4172144997902289642': [[3, -5, 'crimson_forest'], [131, -5, 'nether_wastes'], [121, 44, 'nether_wastes'], [94, 86, 'nether_wastes'], [139, 131, 'warped_forest'], [76, 172, 'warped_forest'], [184, 176, 'warped_forest'], [259, -5, 'basalt_deltas'], [240, 93, 'basalt_deltas'], [101, 232, 'basalt_deltas'], [184, -186, 'soul_sand_valley'], [240, -103, 'soul_sand_valley'], [125, -301, 'soul_sand_valley']]
}

describe('the nether\'s biomes from the seed', () => {
  for (const [seed, samples] of Object.entries(ORACLE)) {
    test(`seed ${seed}: the server's biome at each sample`, () => {
      const source = new NetherBiomeSource(seed)
      for (const [x, z, biome] of samples) assert.strictEqual(source.biomeAt(x, z), biome, `(${x}, ${z})`)
    })
  }

  test('the same at every height and within a quart', () => {
    const source = new NetherBiomeSource(2)
    assert.strictEqual(source.biomeAt(-314, 312), source.biomeAt(-313.4, 314.9))
    assert.deepStrictEqual(source.climate(-316, 312), source.climate(-313, 315))
  })

  test('seed 2\'s complexes: a bastion rolled in a basalt delta is a fortress (the server\'s at 234..422, -339..-151), the bastions where it has them', () => {
    const source = new NetherBiomeSource(2)
    const deltas = (cx: number, cz: number): boolean => source.biomeAt(cx * 16 + 8, cz * 16 + 8) === 'basalt_deltas'
    const at = (list: ReturnType<typeof netherComplexes>, x: number, z: number): string | undefined => list.find(c => c.chunkX * 16 === x && c.chunkZ * 16 === z)?.structure
    const blind = netherComplexes(2, { x: 0, z: 0 }, { radius: 2 })
    const seen = netherComplexes(2, { x: 0, z: 0 }, { radius: 2, isBasaltDeltas: deltas })
    for (const [x, z] of [[80, 768], [1072, 672]]) {
      assert.strictEqual(at(blind, x, z), 'bastion_remnant')
      assert.strictEqual(at(seen, x, z), 'fortress')
    }
    // the server's bastions at 289..344, 80..143 and 443..482, -213..-138
    assert.strictEqual(at(seen, 320, 96), 'bastion_remnant')
    assert.strictEqual(at(seen, 480, -176), 'bastion_remnant')
  })
})

test('seededComplexes: seed 2\'s fortresses with the deltas known, the bastions by a delta maybe fortresses, the rest bastions', async () => {
  const { seededComplexes } = await import('../../src/nether/fortress')
  const list = seededComplexes(2, { x: 0, z: 0 }, { radius: 2 })
  const at = (x: number, z: number): any => list.find(c => c.chunkX * 16 === x && c.chunkZ * 16 === z)
  assert.strictEqual(at(80, 768).structure, 'fortress')
  assert.strictEqual(at(1072, 672).structure, 'fortress')
  // the server's bastion at -568..-513, 33..96: no delta near; at 289..344, 80..143 one by a delta, a maybe
  assert.deepStrictEqual([at(-544, 80).structure, at(-544, 80).maybe], ['bastion_remnant', false])
  assert.deepStrictEqual([at(320, 96).structure, at(320, 96).maybe], ['bastion_remnant', true])
  assert.ok(list.filter(c => c.maybe).every(c => c.structure === 'bastion_remnant'))
})
