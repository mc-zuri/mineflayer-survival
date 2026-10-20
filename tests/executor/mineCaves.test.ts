// A mine step under the cave rule (caveReady): an ore in a cave's wall is passed over, one in the rock taken; a bot fit
// for the caves takes either. A 26.3 bot after diamonds in plain iron was killed in a mineshaft at y 20 (ls-26.3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { fakeBot, item } from '../reflexes/fakeBot'

const diamondStep = { kind: 'mine', item: 'diamond', count: 1, block: 'deepslate_diamond_ore', blocks: ['deepslate_diamond_ore', 'diamond_ore'], blockCount: 1, tool: 'iron_pickaxe', dimension: 'overworld', cost: 8000 } as any

/** a cave of air (x 2 to 8, y 20 to 23, z -3 to 3) in the rock up to y 70; an ore in its wall at x 9, one in the rock */
const EXPOSED = new Vec3(9, 21, 0)
const ENCLOSED = new Vec3(0, 21, 10)

function botAt (ready: boolean, found: Vec3[]): any {
  const prot = [{ name: 'protection', lvl: 1 }]
  const bot = fakeBot({
    position: new Vec3(0.5, 21, 0.5),
    items: [item('iron_pickaxe'), item(ready ? 'diamond_sword' : 'stone_sword', 1, ready ? [{ name: 'sharpness', lvl: 2 }] : undefined), item('cooked_beef', 10)],
    armor: ready ? { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') } : {}
  })
  bot.game.dimension = 'overworld'
  bot.heldItem = bot.inventory.items()[0]
  bot.blockAt = (p: Vec3) => {
    const cave = p.x >= 2 && p.x <= 8 && p.y >= 20 && p.y <= 23 && Math.abs(p.z) <= 3
    const name = p.equals(EXPOSED) || p.equals(ENCLOSED) ? 'deepslate_diamond_ore' : cave || p.y > 70 ? 'air' : 'deepslate'
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  bot.findBlocks = () => found.slice()
  return bot
}

async function stubbed<T> (mod: string, name: string, fake: any, fn: () => Promise<T>): Promise<T> {
  const m = require(mod)
  const real = m[name]
  m[name] = fake
  try {
    return await fn()
  } finally {
    m[name] = real
  }
}

const ctxOf = (bot: any): any => ({ bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {} })

test('a mine step under the cave rule passes over the ore in a cave\'s wall: its tunnels go on for one in the rock', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const bot = botAt(false, [EXPOSED])
  const excluded: boolean[] = []
  let err: any = null
  await stubbed('../../src/executor/explore', 'exploreForBlocks', async (_b: any, args: any) => { excluded.push(args.exclude(EXPOSED)); return false }, async () => await runMine(diamondStep, ctxOf(bot))).catch(e => { err = e })
  assert.equal(err?.code, 'NOT_FOUND')
  assert.deepEqual(excluded, [true])
})

test('the ore in the rock is taken under the rule, and a bot fit for the caves takes the one in the cave\'s wall too', async () => {
  const { runMine } = await import('../../src/executor/steps')
  for (const ready of [false, true]) {
    const bot = botAt(ready, [EXPOSED, ENCLOSED])
    const seen: Array<{ exposed: boolean, enclosed: boolean }> = []
    const collect = async (b: any, args: any): Promise<any> => {
      seen.push({ exposed: args.exclude(EXPOSED), enclosed: args.exclude(ENCLOSED) })
      const d = item('diamond', 1)
      d.slot = 30
      b.inventory.slots[30] = d
      return { mined: 1, positions: [ENCLOSED], items: { diamond: 1 }, count: 1 }
    }
    const out = await stubbed('../../src/skills/collectBlock', 'collectBlock', collect, async () => await runMine(diamondStep, ctxOf(bot)))
    assert.equal(out.gained, 1)
    assert.deepEqual(seen, [{ exposed: !ready, enclosed: false }], ready ? 'cave-ready' : 'under the rule')
  }
})
