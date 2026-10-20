// A mine step's tool watched as the step wears it, its exploring's digging too (the staircase down to the ore's level,
// the tunnels, the pathfinder's digs on the way): in rt-1 and grim-2 (1.21.11) the iron pickaxe broke down the
// staircase of 'mine 5 diamond' with no warning, NO_TOOL at y 46 and y 3, the check between batches never reached.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { MIN_TOOL_USES } from '../../src/executor/steps'
import { usesLeft } from '../../src/executor/durability'
import { fakeBot, item } from '../reflexes/fakeBot'

const diamondStep = { kind: 'mine', item: 'diamond', count: 5, block: 'deepslate_diamond_ore', blocks: ['deepslate_diamond_ore', 'diamond_ore'], blockCount: 5, tool: 'iron_pickaxe', dimension: 'overworld', cost: 8000 } as any

/** an exploring that digs a block a tick with the held tool (its wear), for `ticks`, finding nothing */
function diggingExplore (bot: any, ticks: number): (b: any, args: any, signal?: AbortSignal) => Promise<boolean> {
  return async (_b, _args, signal) => {
    for (let t = 0; t < ticks; t++) {
      if (signal?.aborted === true) throw signal.reason
      if (bot.heldItem != null && usesLeft(bot.heldItem) > 0) bot.heldItem.durabilityUsed++
      bot.emit('physicsTick')
      await Promise.resolve()
    }
    return false
  }
}

function pickaxe (used: number): any {
  const it = item('iron_pickaxe')
  it.durabilityUsed = used
  return it
}

async function withExplore<T> (fake: (b: any, args: any, signal?: AbortSignal) => Promise<boolean>, fn: () => Promise<T>): Promise<T> {
  const exploreModule = require('../../src/executor/explore')
  const real = exploreModule.exploreForBlocks
  exploreModule.exploreForBlocks = fake
  try {
    return await fn()
  } finally {
    exploreModule.exploreForBlocks = real
  }
}

function botWith (items: any[]): any {
  const bot = fakeBot({ position: new Vec3(0.5, 40, 0.5), items })
  bot.findBlocks = () => []
  bot.game.dimension = 'overworld'
  bot.heldItem = items[0]
  return bot
}

const ctxOf = (bot: any, extra: Record<string, unknown> = {}): any => ({ bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {}, ...extra })

test(`a mine step's exploring wears its pickaxe to ${MIN_TOOL_USES} uses with no spare: the step hands back for another (replan) then, before it breaks (rt-1, grim-2)`, async () => {
  const pick = pickaxe(200)
  const bot = botWith([pick, item('stone_pickaxe'), item('cobblestone', 64)])
  const lines: string[] = []
  const { runMine } = await import('../../src/executor/steps')
  const out = await withExplore(diggingExplore(bot, 400), async () => await runMine(diamondStep, ctxOf(bot, { log: (l: string) => lines.push(l) })))
  assert.deepEqual(out, { gained: 0, replan: true })
  assert.equal(usesLeft(pick), MIN_TOOL_USES)
  assert.match(lines.join('\n'), /the iron_pickaxe has 24 uses left and no spare/)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})

test('a mine step\'s pickaxe with a spare of its tier carried, or muted (no new one could be made), is used on: no hand back', async () => {
  const { runMine } = await import('../../src/executor/steps')
  // the spare: the worn one used till it breaks, the spare after it
  const pick = pickaxe(200)
  const bot = botWith([pick, pickaxe(0)])
  let err: any = null
  await withExplore(diggingExplore(bot, 60), async () => await runMine(diamondStep, ctxOf(bot))).catch(e => { err = e })
  assert.equal(err?.code, 'NOT_FOUND')
  assert.equal(usesLeft(pick), 0)
  // muted: no stop, the check before each batch no hand back either
  const worn = pickaxe(200)
  const lone = botWith([worn])
  err = null
  const muted: any[] = []
  await withExplore(diggingExplore(lone, 60), async () => await runMine(diamondStep, ctxOf(lone, { toolMuted: (t: any) => { muted.push(t.name); return true } }))).catch(e => { err = e })
  assert.equal(err?.code, 'NOT_FOUND')
  assert.equal(usesLeft(worn), 0)
  assert.ok(muted.includes('iron_pickaxe'))
})

test('a mine step started with its pickaxe worn hands back at once, unless it is part of making a new one (replacingTools)', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const bot = botWith([pickaxe(240)])
  let explored = 0
  const counting = async (): Promise<boolean> => { explored++; return false }
  assert.deepEqual(await withExplore(counting, async () => await runMine(diamondStep, ctxOf(bot))), { gained: 0, replan: true })
  assert.equal(explored, 0)
  await withExplore(counting, async () => await runMine(diamondStep, ctxOf(bot, { replacingTools: true }))).catch(() => {})
  assert.equal(explored, 1)
})

test('a reflex\'s preemption of a watched mine step is thrown, not taken for a worn tool', async () => {
  const { runMine } = await import('../../src/executor/steps')
  const bot = botWith([pickaxe(0)])
  const outer = new AbortController()
  let n = 0
  const preempt = (): void => { if (++n === 10) outer.abort(new Error('preempted by reflex:fall')) }
  bot.on('physicsTick', preempt)
  await assert.rejects(withExplore(diggingExplore(bot, 100), async () => await runMine(diamondStep, ctxOf(bot, { signal: outer.signal }))), /preempted/)
  bot.off('physicsTick', preempt)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})
