// Slime chunks from the seed against the server's own code: tests/fixtures/slime-chunks-26.3.txt is what 26.3's
// WorldgenRandom.seedSlimeChunk(x, z, seed, 987234911).nextInt(10) gives (run from its server jar), each seed's slime
// chunks in x, z -20 to 20 and the draw at three far chunks, where the int products wrap.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSlimeChunk, seedSlimeChunk, slimeChunksNear } from '../../src/worldgen/slime'

const lines = readFileSync(join(__dirname, '../fixtures/slime-chunks-26.3.txt'), 'utf8').trim().split(/\r?\n/)

test('isSlimeChunk: the 26.3 server\'s slime chunks for 5 seeds, x and z -20 to 20, and its draws at far chunks', () => {
  assert.strictEqual(lines.length, 5)
  for (const line of lines) {
    const [seed, rest] = line.split(':')
    const want = new Set<string>()
    for (const tok of rest.trim().split(' ')) {
      const far = /^far(-?\d+),(-?\d+)=(\d+)$/.exec(tok)
      if (far != null) {
        assert.strictEqual(seedSlimeChunk(Number(far[1]), Number(far[2]), seed).nextInt(10), Number(far[3]), `${seed} ${tok}`)
        continue
      }
      want.add(tok)
    }
    const got = new Set<string>()
    for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) if (isSlimeChunk(seed, x, z)) got.add(`${x},${z}`)
    assert.deepStrictEqual([...got].sort(), [...want].sort(), `seed ${seed}`)
    // about a tenth
    assert.ok(got.size > 41 * 41 * 0.07 && got.size < 41 * 41 * 0.13, `${got.size}`)
  }
})

test('slimeChunksNear: the slime chunks round a block, nearest first', () => {
  const near = slimeChunksNear('2', 0, 0, 4)
  assert.ok(near.length > 0)
  for (const c of near) assert.ok(isSlimeChunk('2', c.x, c.z))
  for (let i = 1; i < near.length; i++) assert.ok(near[i].distance >= near[i - 1].distance)
  const all = []
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (isSlimeChunk('2', x, z)) all.push(`${x},${z}`)
  assert.deepStrictEqual(near.map(c => `${c.x},${c.z}`).sort(), all.sort())
})
