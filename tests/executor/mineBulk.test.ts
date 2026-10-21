// A mine step's bulk: with its plan's count got, the stock's working set carried that it is short of, from the step's
// blocks in sight (the trees it is at), with the block's tool and within the ticks the stock gives it. A 1.21.11 bot's
// steps mined just the logs they needed, 'mine 1 oak_log' for each of its pickaxe, bucket, sword and chestplate after a
// death and for the planks of their smelts, a walk to the trees each (f2-1.21.11 t49300 to t54752).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { BULK_RANGE, MIN_TOOL_USES } from '../../src/executor/steps'
import { fakeBot, item as itemOf } from '../reflexes/fakeBot'
import { VERSIONS } from '../versions'

const logStep = { kind: 'mine', item: 'oak_log', count: 1, block: 'oak_log', blocks: ['oak_log'], blockCount: 1, tool: 'stone_axe', dimension: 'overworld', cost: 100 } as any

/** a bot on grass at y 64 with oak logs at `logs` (their trunks), carrying `items` */
function botWith (version: string, items: any[], logs: Vec3[]): any {
  const standing = new Set(logs.map(p => p.toString()))
  const bot = fakeBot({ version, position: new Vec3(0.5, 64, 0.5), items, world: p => standing.has(p.toString()) ? 'oak_log' : p.y < 64 ? 'grass_block' : 'air' })
  bot.game.dimension = 'overworld'
  bot.findBlocks = (opts: any) => logs.filter(p => standing.has(p.toString()) && p.distanceTo(bot.entity.position) <= (opts.maxDistance ?? 16))
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, opts.count ?? 1)
  bot.standing = standing
  bot.version = version
  return bot
}

/** collectBlock cutting the nearest logs within its maxDistance, `ticks` physics ticks a log, the logs into a stack */
function cutting (bot: any, calls: any[], ticks = 0): (b: any, args: any, signal?: AbortSignal) => Promise<any> {
  return async (_b, args, signal) => {
    calls.push(args)
    const found: Vec3[] = bot.findBlocks({ maxDistance: args.maxDistance, count: args.count })
    const positions: Vec3[] = []
    for (const pos of found) {
      for (let t = 0; t < ticks; t++) {
        if (signal?.aborted === true) throw signal.reason
        bot.emit('physicsTick')
        await Promise.resolve()
      }
      bot.standing.delete(pos.toString())
      positions.push(pos)
      const stack = bot.inventory.slots.find((s: any) => s?.name === 'oak_log')
      if (stack != null) stack.count++
      else { const it = itemOf('oak_log', 1, undefined, bot.version); it.slot = 30; bot.inventory.slots[30] = it }
    }
    return { mined: positions.length, positions, items: { oak_log: positions.length }, count: positions.length }
  }
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

const ctxOf = (bot: any, extra: Record<string, unknown> = {}): any => ({ bot, memory: new WorldMemory(), signal: new AbortController().signal, state: {}, log: () => {}, ...extra })

const grove = (n: number, off = 3): Vec3[] => Array.from({ length: n }, (_, i) => new Vec3(off + (i % 4), 64 + Math.floor(i / 16), off + Math.floor(i / 4) % 4))

async function mine (bot: any, ctx: any, ticks = 0, step = logStep): Promise<{ out: any, calls: any[], explored: number }> {
  const { runMine } = await import('../../src/executor/steps')
  const calls: any[] = []
  let explored = 0
  const out = await stubbed([
    ['../../src/skills/collectBlock', 'collectBlock', cutting(bot, calls, ticks)],
    ['../../src/executor/explore', 'ensureSurface', async () => true],
    ['../../src/executor/explore', 'exploreForBlocks', async () => { explored++; return false }]
  ], async () => await runMine(step, ctx))
  return { out, calls, explored }
}

for (const version of VERSIONS) {
  const item = (name: string): any => itemOf(name, 1, undefined, version)

  test(`${version}: a mine step at the trees takes the stock's bulk of logs after its own, from the trees in sight only, and says so`, async () => {
    const bot = botWith(version, [item('stone_axe')], grove(30))
    const lines: string[] = []
    const { out, calls, explored } = await mine(bot, ctxOf(bot, { bulk: (name: string) => name === 'oak_log' ? { count: 20, ticksPerUnit: 60 } : null, log: (l: string) => lines.push(l) }))
    assert.equal(out.gained, 21)
    assert.equal(explored, 0)
    // the step's own block, then the bulk's within BULK_RANGE
    assert.ok(calls.slice(1).every(c => c.maxDistance === BULK_RANGE), JSON.stringify(calls.map(c => c.maxDistance)))
    assert.match(lines.join('\n'), /mine oak_log: 20 more for the stock while here/)
  })

  test(`${version}: a mine step's bulk takes no more than the trees in sight give: none explored for, no failure`, async () => {
    // 4 logs by the bot, 6 more 40 blocks off
    const bot = botWith(version, [item('stone_axe')], [...grove(4), ...grove(6, 40)])
    const { out, explored } = await mine(bot, ctxOf(bot, { bulk: () => ({ count: 20, ticksPerUnit: 60 }) }))
    assert.equal(out.gained, 4)
    assert.equal(explored, 0)
  })

  test(`${version}: a mine step takes no bulk by hand, while making a new tool, nor with none asked`, async () => {
    for (const [items, extra] of [[[], { bulk: () => ({ count: 20, ticksPerUnit: 60 }) }], [[item('stone_axe')], { bulk: () => ({ count: 20, ticksPerUnit: 60 }), replacingTools: true }], [[item('stone_axe')], { bulk: () => null }], [[item('stone_axe')], {}]] as const) {
      const bot = botWith(version, [...items], grove(30))
      const { out } = await mine(bot, ctxOf(bot, extra))
      assert.equal(out.gained, 1, JSON.stringify(extra))
    }
  })

  test(`${version}: a mine step's bulk leaves its tool ${MIN_TOOL_USES} uses: never worn down to its replacement by it`, async () => {
    const axe = item('stone_axe')
    // 40 uses left: the bulk 16 at most
    axe.durabilityUsed = axe.maxDurability - 40
    const bot = botWith(version, [axe], grove(40))
    const { out } = await mine(bot, ctxOf(bot, { bulk: () => ({ count: 30, ticksPerUnit: 60 }) }))
    assert.equal(out.gained, 1 + 40 - MIN_TOOL_USES)
  })

  test(`${version}: a mine step's bulk stops at its ticks (the stock's a unit), the step done with what it got`, async () => {
    const bot = botWith(version, [item('stone_axe')], grove(40))
    // 10 logs at 20 ticks: 200 ticks; each log takes 50
    const { out } = await mine(bot, ctxOf(bot, { bulk: () => ({ count: 10, ticksPerUnit: 20 }) }), 50)
    assert.equal(out.gained, 1 + 4)
  })
}
