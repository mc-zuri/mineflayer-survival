// A mine step for sugar cane judges a column at the block collectBlock cuts (its second from the bottom, the bottom one
// kept to grow back), and a column of one has none to cut. A 1.21.11 game's 'mine 3 sugar_cane' saw a column at y 63 to
// 66 from y 74 by its top, and collectBlock had none of it to take (its cut under the step's depth bound): 'no more
// sugar_cane found' 15 times with no exploring (f3-1.21.11, t129093 to t131193).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { fakeBot, item } from '../reflexes/fakeBot'

const caneStep = { kind: 'mine', item: 'sugar_cane', count: 3, block: 'sugar_cane', blocks: ['sugar_cane'], blockCount: 3, tool: null, dimension: 'overworld', cost: 638 } as any

/** grass at y 62 by water at x 21, the bot at y `botY` over it; cane columns of `columns` (x: [bottom, height]) at z 0 */
function botWith (botY: number, columns: Record<number, [number, number]>): any {
  const cane = (p: Vec3): boolean => p.z === 0 && columns[p.x] != null && p.y >= columns[p.x][0] && p.y < columns[p.x][0] + columns[p.x][1]
  const bot = fakeBot({
    position: new Vec3(0.5, botY, 0.5),
    items: [item('iron_pickaxe')],
    world: p => cane(p) ? 'sugar_cane' : p.y > 62 ? 'air' : p.x === 21 && p.y === 62 ? 'water' : 'grass_block'
  })
  bot.game.dimension = 'overworld'
  const all: Vec3[] = []
  for (const [x, [y0, h]] of Object.entries(columns)) for (let y = y0; y < y0 + h; y++) all.push(new Vec3(Number(x), y, 0))
  bot.findBlocks = () => all.slice().sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  return bot
}

async function stubbed<T> (stubs: Array<[string, string, any]>, fn: () => Promise<T>): Promise<T> {
  const saved = stubs.map(([mod, name]) => [require(mod), name, require(mod)[name]] as const)
  for (const [mod, name, fake] of stubs) require(mod)[name] = fake
  try {
    return await fn()
  } finally {
    for (const [m, name, real] of saved) m[name] = real
  }
}

const ctxOf = (bot: any): any => ({ bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {} })

test('cutAt: a cane column\'s second block from the bottom, none for a column of one, any other block itself', async () => {
  const { cutAt } = await import('../../src/executor/steps')
  const bot = botWith(64, { 20: [63, 4], 22: [63, 1] })
  const lookup = (p: Vec3): any => bot.blockAt(p)
  assert.deepEqual(cutAt(lookup, new Vec3(20, 66, 0)), new Vec3(20, 64, 0))
  assert.deepEqual(cutAt(lookup, new Vec3(20, 63, 0)), new Vec3(20, 64, 0))
  assert.equal(cutAt(lookup, new Vec3(22, 63, 0)), null)
  assert.deepEqual(cutAt(lookup, new Vec3(3, 62, 3)), new Vec3(3, 62, 3))
})

test('a cane column whose cut is under the depth bound and its top over it: taken (deeper after all), not given up with no exploring (f3-1.21.11)', async () => {
  const { runMine } = await import('../../src/executor/steps')
  // the column at y 63 to 66, the step begun at y 74 (SHALLOW_DEPTH 8: its top at 66 in, its cut at 64 out)
  const bot = botWith(74, { 20: [63, 4] })
  const cuts: boolean[] = []
  let explored = 0
  const collect = async (b: any, args: any): Promise<any> => {
    cuts.push(args.exclude(new Vec3(20, 64, 0)))
    const c = item('sugar_cane', 3)
    c.slot = 30
    b.inventory.slots[30] = c
    return { mined: 1, positions: [new Vec3(20, 64, 0)], items: { sugar_cane: 3 }, count: 3 }
  }
  const out = await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', collect],
    ['../../src/executor/explore', 'exploreForBlocks', async () => { explored++; return false }]
  ], async () => await runMine(caneStep, ctxOf(bot)))
  assert.equal(out.gained, 3)
  assert.deepEqual(cuts, [false], 'the cut is collectBlock\'s to take')
  assert.equal(explored, 0)
})

test('a cane of one block (the bottom kept) is none near: the step explores for more, and collectBlock is never sent for it', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const bot = botWith(64, { 20: [63, 1] })
  let collected = 0
  let explored = 0
  let err: any = null
  await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', async () => { collected++; throw new Error('not here') }],
    ['../../src/executor/explore', 'exploreForBlocks', async (_b: any, args: any) => { explored++; assert.equal(args.exclude(new Vec3(20, 63, 0)), true); return false }]
  ], async () => await runMine(caneStep, ctxOf(bot))).catch(e => { err = e })
  assert.equal(err?.code, 'NOT_FOUND')
  assert.match(err.message, /found exploring/)
  assert.equal(explored, 1)
  assert.equal(collected, 0)
})
