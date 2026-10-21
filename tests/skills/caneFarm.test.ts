// The sugar cane farm and the canes seen, without a server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { fakeBot } from '../reflexes/fakeBot'

/** grass at y 62, water at x 6 and 9; cane columns (x: height) on the grass at z 0 from y 63 */
function caneBot (columns: Record<number, number>): any {
  const cane = (p: Vec3): boolean => p.z === 0 && columns[p.x] != null && p.y >= 63 && p.y < 63 + columns[p.x]
  const bot = fakeBot({ position: new Vec3(0.5, 63, 0.5), world: p => cane(p) ? 'sugar_cane' : p.y > 62 ? 'air' : p.y === 62 && (p.x === 6 || p.x === 9) && p.z === 0 ? 'water' : 'grass_block' })
  bot.game.dimension = 'overworld'
  const all: Vec3[] = []
  for (const [x, h] of Object.entries(columns)) for (let y = 63; y < 63 + h; y++) all.push(new Vec3(Number(x), y, 0))
  bot.findBlocks = () => all.slice()
  return bot
}

test('rememberCanes: each column with a block to cut noted at its cut, a column of one not; the ones remembered with nothing to cut now forgotten', async () => {
  const { rememberCanes } = await import('../../src/skills/caneFarm')
  const bot = caneBot({ 5: 3, 8: 1, 10: 2 })
  const memory = new WorldMemory()
  // remembered before: a column since cut to its bottom (8), a cane gone (12), and one far off out of the chunks loaded
  memory.rememberBlock('sugar_cane', { x: 8, y: 64, z: 0 })
  memory.rememberBlock('sugar_cane', { x: 12, y: 64, z: 0 })
  memory.rememberBlock('sugar_cane', { x: 300, y: 64, z: 0 })
  const loaded = bot.blockAt
  bot.blockAt = (p: Vec3) => p.x > 200 ? null : loaded(p)
  assert.equal(rememberCanes(bot, memory, 400), 2)
  const known = memory.findBlocks('sugar_cane').map(b => `${b.x},${b.y}`).sort()
  assert.deepEqual(known, ['10,64', '300,64', '5,64'])
  // none noted out of the overworld
  bot.game.dimension = 'the_nether'
  assert.equal(rememberCanes(bot, new WorldMemory()), 0)
})
