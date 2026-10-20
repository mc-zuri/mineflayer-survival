// A mine step's exploring for the food that grows (kelp, berries, melons, a village's crops): FOOD_EXPLORE_TICKS of its
// own at most across its preemptions, then NOT_FOUND (the plans go for another food a while), its spiral kept across
// the plans. rt-1's 'mine 10 kelp' on a snowy spruce land explored 166 blocks over 29000 ticks, resumed after 7 reflexes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { FOOD_EXPLORE_TICKS, foodExploreProgress, withinOwnTicks } from '../../src/executor/steps'
import { fakeBot, item } from '../reflexes/fakeBot'

const kelpStep = { kind: 'mine', item: 'kelp', count: 10, block: 'kelp_plant', blocks: ['kelp_plant', 'kelp'], blockCount: 10, tool: null, dimension: 'overworld', cost: 1000 } as any

/** an exploring that walks a leg every 100 ticks and finds nothing, until aborted or out of `legs` */
function walkingExplore (bot: any, calls: Array<{ startLeg: number }>, legs = Infinity): (b: any, args: any, signal?: AbortSignal) => Promise<boolean> {
  return async (_b, args, signal) => {
    calls.push({ startLeg: args.progress.leg })
    for (let t = 0; ; t++) {
      if (signal?.aborted === true) throw signal.reason
      if (args.progress.leg >= legs) return false
      bot.emit('physicsTick')
      if (t % 100 === 99) args.progress.leg++
      await Promise.resolve()
    }
  }
}

test(`withinOwnTicks: the ticks of each run add up in the state; 'timeout' once ${FOOD_EXPLORE_TICKS} are spent, at once on a run after; an outer abort is thrown`, async () => {
  const bot = fakeBot()
  const state: Record<string, any> = {}
  const tick = async (n: number, s: AbortSignal): Promise<string> => {
    for (let i = 0; i < n; i++) {
      if (s.aborted) throw s.reason
      bot.emit('physicsTick')
      await Promise.resolve()
    }
    return 'done'
  }
  assert.equal(await withinOwnTicks(bot, state, 'ticks', 100, new AbortController().signal, async s => await tick(60, s)), 'done')
  assert.equal(state.ticks, 60)
  assert.equal(await withinOwnTicks(bot, state, 'ticks', 100, new AbortController().signal, async s => await tick(60, s)), 'timeout')
  assert.equal(state.ticks, 100)
  let ran = false
  assert.equal(await withinOwnTicks(bot, state, 'ticks', 100, new AbortController().signal, async () => { ran = true }), 'timeout')
  assert.equal(ran, false)
  // a reflex's preemption (the task's signal aborted) is the caller's to handle, its ticks counted so far
  const outer = new AbortController()
  const fresh: Record<string, any> = {}
  await assert.rejects(withinOwnTicks(bot, fresh, 'ticks', 100, outer.signal, async s => { await tick(30, s); outer.abort(new Error('preempted')); return await tick(10, s) }), /preempted/)
  assert.equal(fresh.ticks, 30)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})

test('foodExploreProgress: the executor\'s by the names (sorted), else the step\'s own', () => {
  const kept = new Map<string, { leg: number }>()
  const progress = (key: string): { leg: number } => kept.get(key) ?? kept.set(key, { leg: 0 }).get(key) as { leg: number }
  const a = foodExploreProgress({ progress, state: {} }, ['kelp_plant', 'kelp'])
  a.progress.leg = 7
  assert.equal(a.key, 'explore:kelp,kelp_plant')
  assert.equal(foodExploreProgress({ progress, state: {} }, ['kelp', 'kelp_plant']).progress.leg, 7)
  const state: Record<string, any> = {}
  foodExploreProgress({ state }, ['kelp']).progress.leg = 3
  assert.deepEqual(state.explore, { leg: 3 })
})

test(`a mine step for kelp explores ${FOOD_EXPLORE_TICKS} ticks of its own at most, across a reflex's preemption, then NOT_FOUND; the next step for it goes on from its leg; one whose spiral ran out starts over (rt-1)`, async () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('iron_pickaxe', 1)] })
  bot.findBlocks = () => []
  bot.game.dimension = 'overworld'
  const exploreModule = require('../../src/executor/explore')
  const real = exploreModule.exploreForBlocks
  const calls: Array<{ startLeg: number }> = []
  exploreModule.exploreForBlocks = walkingExplore(bot, calls)
  const kept = new Map<string, { leg: number }>()
  const forgotten: string[] = []
  const memory = new WorldMemory()
  const ctxOf = (state: Record<string, any>, signal: AbortSignal): any => ({
    bot, memory, signal, state, log: () => {},
    progress: (key: string) => kept.get(key) ?? kept.set(key, { leg: 0 }).get(key),
    forgetProgress: (key: string) => { forgotten.push(key); kept.delete(key) }
  })
  try {
    const { runMine } = await import('../../src/executor/steps')
    // the first run cut off by a reflex 2000 ticks in
    const state: Record<string, any> = {}
    const reflex = new AbortController()
    let n = 0
    const preempt = (): void => { if (++n === 2000) reflex.abort(new Error('preempted by reflex:night')) }
    bot.on('physicsTick', preempt)
    await assert.rejects(runMine(kelpStep, ctxOf(state, reflex.signal)), /preempted/)
    bot.off('physicsTick', preempt)
    assert.equal(state.exploreTicks, 2000)
    // resumed: the rest of its ticks, then NOT_FOUND
    let err: any = null
    await runMine(kelpStep, ctxOf(state, new AbortController().signal)).catch(e => { err = e })
    assert.equal(err?.code, 'NOT_FOUND')
    assert.match(String(err?.message), new RegExp(`no kelp_plant, kelp found exploring in its ${FOOD_EXPLORE_TICKS} ticks`))
    assert.equal(state.exploreTicks, FOOD_EXPLORE_TICKS)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].startLeg, 20)
    // its spiral kept: the next plan's step goes on from where it got to
    assert.deepEqual(forgotten, [])
    const leg = kept.get('explore:kelp,kelp_plant')?.leg
    assert.equal(leg, FOOD_EXPLORE_TICKS / 100)
    exploreModule.exploreForBlocks = walkingExplore(bot, calls, (leg ?? 0) + 5)
    err = null
    await runMine(kelpStep, ctxOf({}, new AbortController().signal)).catch(e => { err = e })
    assert.equal(calls[2].startLeg, leg)
    // and this time its spiral ran out: NOT_FOUND, the progress forgotten
    assert.equal(err?.code, 'NOT_FOUND')
    assert.doesNotMatch(String(err?.message), /in its/)
    assert.deepEqual(forgotten, ['explore:kelp,kelp_plant'])
  } finally {
    exploreModule.exploreForBlocks = real
  }
})

test('a mine step for stone or logs explores as before: no tick limit of the food\'s', async () => {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('iron_pickaxe', 1)] })
  bot.findBlocks = () => []
  bot.game.dimension = 'overworld'
  const exploreModule = require('../../src/executor/explore')
  const real = exploreModule.exploreForBlocks
  const calls: Array<{ startLeg: number }> = []
  exploreModule.exploreForBlocks = walkingExplore(bot, calls, FOOD_EXPLORE_TICKS / 100 + 10)
  const state: Record<string, any> = {}
  try {
    const { runMine } = await import('../../src/executor/steps')
    const step = { kind: 'mine', item: 'sand', count: 4, block: 'sand', blocks: ['sand'], blockCount: 4, tool: null, dimension: 'overworld', cost: 300 } as any
    await assert.rejects(runMine(step, { bot, memory: new WorldMemory(), signal: new AbortController().signal, state, log: () => {} } as any), (err: any) => err.code === 'NOT_FOUND' && !/in its/.test(err.message))
    assert.equal(state.explore.leg, FOOD_EXPLORE_TICKS / 100 + 10)
    assert.equal(state.exploreTicks, undefined)
  } finally {
    exploreModule.exploreForBlocks = real
  }
})
