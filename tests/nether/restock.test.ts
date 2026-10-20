import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WorldMemory } from '../../src/core/memory'
import { extendTrail } from '../../src/nether/trail'
import { NETHER_SCAFFOLD_KEEP } from '../../src/executor/keep'
import { crossingBlocks, landAt, scaffoldShort, turnBackPoint } from '../../src/nether/restock'
import { fakeBot, item } from '../reflexes/fakeBot'

// the lava sea of full-26.3-fresh-t, laid out along x: a netherrack shore to x -1 (its floor at y 36, the bot's feet at
// 37), the sea's lava at y 31 from x 0 to 59, land again from x 60 (its floor at y 43); the bot's own bridge of
// cobblestone 1 wide at y 43 along z 0 from x 0 to 30, a tower up to it at the shore
function sea (name: string, p: Vec3): string {
  if (p.x < 0) return p.y <= 36 ? 'netherrack' : 'air'
  if (p.x >= 60) return p.y <= 43 ? 'netherrack' : 'air'
  if (p.y <= 30) return 'netherrack'
  if (p.y === 31) return 'lava'
  if (p.y === 43 && p.z === 0 && p.x <= 30) return name
  return 'air'
}
const SOLID = new Set(['netherrack', 'cobblestone'])
const lookup = (p: Vec3): { name: string, boundingBox: string } => { const name = sea('cobblestone', p.floored()); return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' } }

test('crossingBlocks: a block for each column of the way ahead with no floor within SAFE_DROP, as far as the lookahead; a wall none', () => {
  // from the bridge's end toward the land beyond: x 31 to 59 open over the lava 12 down
  assert.equal(crossingBlocks(lookup, new Vec3(30.5, 44, 0.5), new Vec3(94.5, 44, 0.5)), 29)
  // along the bridge back to the shore: its floor the whole way
  assert.equal(crossingBlocks(lookup, new Vec3(30.5, 44, 0.5), new Vec3(1.5, 44, 0.5)), 0)
  // a lookahead of 10: 10
  assert.equal(crossingBlocks(lookup, new Vec3(30.5, 44, 0.5), new Vec3(94.5, 44, 0.5), 10), 10)
  // on the far land, nothing to cross; the chunks not loaded (null) end the count
  assert.equal(crossingBlocks(lookup, new Vec3(61.5, 44, 0.5), new Vec3(90.5, 44, 0.5)), 0)
  const unloaded = (p: Vec3): { name: string, boundingBox: string } | null => p.x > 40 ? null : lookup(p)
  assert.equal(crossingBlocks(unloaded, new Vec3(30.5, 44, 0.5), new Vec3(94.5, 44, 0.5)), 10)
  // a wall at the feet is dug through, not built over
  const walled = (p: Vec3): { name: string, boundingBox: string } => p.x >= 31 && p.x <= 40 && p.y >= 44 && p.y <= 46 ? { name: 'netherrack', boundingBox: 'block' } : lookup(p)
  assert.equal(crossingBlocks(walled, new Vec3(30.5, 44, 0.5), new Vec3(94.5, 44, 0.5)), 19)
})

test('landAt: the shore is firm ground; the 1-wide bridge and its end are not', () => {
  assert.equal(landAt(lookup, new Vec3(-4.5, 37, 0.5)), true)
  assert.equal(landAt(lookup, new Vec3(15.5, 44, 0.5)), false)
  assert.equal(landAt(lookup, new Vec3(30.5, 44, 0.5)), false)
  // the shore's edge: 15 of the 25 cells firm a block back from it, 10 at it
  assert.equal(landAt(lookup, new Vec3(-0.5, 37, 0.5)), true)
  assert.equal(landAt(lookup, new Vec3(0.5, 37, 0.5)), false)
})

/** a fake bot in the sea's world, with findBlocks over it and the trail's memory */
function seaBot (position: Vec3, items: any[]): any {
  const bot = fakeBot({ position, items, world: p => sea('cobblestone', p) })
  bot.game.dimension = 'the_nether'
  bot.survival = { memory: new WorldMemory() }
  bot.findBlocks = (opts: { matching: number | number[], point?: Vec3, maxDistance?: number, count?: number }) => {
    const ids = typeof opts.matching === 'number' ? [opts.matching] : opts.matching
    const at = (opts.point ?? bot.entity.position).floored()
    const r = opts.maxDistance ?? 16
    const out: Vec3[] = []
    for (let x = at.x - r; x <= at.x + r; x++) {
      for (let y = at.y - r; y <= at.y + r; y++) {
        for (let z = at.z - r; z <= at.z + r; z++) {
          const p = new Vec3(x, y, z)
          if (p.distanceTo(at) <= r && ids.includes(bot.registry.blocksByName[sea('cobblestone', p)]?.id)) out.push(p)
          if (out.length >= (opts.count ?? 1)) return out
        }
      }
    }
    return out
  }
  return bot
}

test('scaffoldShort: 4 blocks at the bridge\'s end are short of the 29 to cross (the pathfinder keeps 4 back); the working set is not; on land with nothing to cross, never', () => {
  const end = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 4), item('diamond_pickaxe')])
  assert.deepEqual(scaffoldShort(end, new Vec3(94.5, 44, 0.5)), { short: true, need: 29, held: 4 })
  // 33 held: 29 to place past the reserve of 4
  const enough = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 33)])
  assert.equal(scaffoldShort(enough, new Vec3(94.5, 44, 0.5)).short, false)
  const fewer = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 32)])
  assert.equal(scaffoldShort(fewer, new Vec3(94.5, 44, 0.5)).short, true)
  const full = seaBot(new Vec3(30.5, 44, 0.5), [item('netherrack', 64), item('netherrack', 64)])
  assert.equal(scaffoldShort(full, new Vec3(94.5, 44, 0.5)).short, false)
  assert.equal(NETHER_SCAFFOLD_KEEP, 128)
  const land = seaBot(new Vec3(-10.5, 37, 0.5), [item('cobblestone', 4)])
  assert.equal(scaffoldShort(land, new Vec3(-40.5, 37, 0.5)).short, false)
})

test('turnBackPoint: back along the trail to the newest point on firm ground with netherrack round it, the bridge\'s points passed over; here when the bot stands on such ground', () => {
  const bot = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 4), item('diamond_pickaxe')])
  // walked: the shore from x -40, up the tower at x -1, along the bridge
  for (let x = -40; x <= -4; x += 12) extendTrail(bot.survival.memory, { x, y: 37, z: 0 })
  for (let x = 10; x <= 30; x += 12) extendTrail(bot.survival.memory, { x, y: 44, z: 0 })
  const to = turnBackPoint(bot)
  assert.ok(to != null)
  assert.deepEqual(to.toArray(), [-4, 37, 0])
  // on the shore already: here
  const shore = seaBot(new Vec3(-20.5, 37, 0.5), [item('cobblestone', 4)])
  assert.deepEqual(turnBackPoint(shore)?.toArray(), [-21, 37, 0])
  // no trail: the trip's start when it is firm ground, else none
  const lost = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 4)])
  assert.equal(turnBackPoint(lost), null)
  assert.deepEqual(turnBackPoint(lost, new Vec3(-30.5, 37, 0.5))?.toArray(), [-31, 37, 0])
})

test('mineNetherrack: up to the working set, none under the feet but a floor block with ground under it; turnBackForBlocks walks back first, and does nothing with no pickaxe', async () => {
  const collect = require('../../src/skills/collectBlock')
  const { mineNetherrack, turnBackForBlocks } = await import('../../src/nether/restock')
  const real = collect.collectBlock
  const calls: any[] = []
  collect.collectBlock = async (bot: any, args: any) => { calls.push(args); bot.inventory.slots[20] = Object.assign(item('netherrack', 64), { slot: 20 }); return { mined: 64 } }
  try {
    const bot = seaBot(new Vec3(-20.5, 37, 0.5), [item('cobblestone', 4), item('diamond_pickaxe')])
    assert.equal(await mineNetherrack(bot), 64)
    assert.equal(calls[0].count, NETHER_SCAFFOLD_KEEP - 4)
    assert.deepEqual(calls[0].names, ['netherrack'])
    const exclude = calls[0].exclude as (p: Vec3) => boolean
    assert.equal(exclude(new Vec3(-22, 37, 0)), false, 'a wall')
    assert.equal(exclude(new Vec3(-22, 36, 0)), false, 'the floor with ground under it')
    assert.equal(exclude(new Vec3(-22, 35, 0)), true, 'under the floor')
    // the bridge's end: walked back to the shore first
    const end = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 4), item('diamond_pickaxe')])
    for (let x = -40; x <= -4; x += 12) extendTrail(end.survival.memory, { x, y: 37, z: 0 })
    const walks: Vec3[] = []
    const got = await turnBackForBlocks(end, async (to) => { walks.push(to); end.entity.position = to.offset(0.5, 0, 0.5) })
    assert.deepEqual(walks.map(w => w.toArray()), [[-4, 37, 0]])
    assert.equal(got, 64)
    const bare = seaBot(new Vec3(30.5, 44, 0.5), [item('cobblestone', 4)])
    for (let x = -40; x <= -4; x += 12) extendTrail(bare.survival.memory, { x, y: 37, z: 0 })
    assert.equal(await turnBackForBlocks(bare, async () => { throw new Error('walked') }), 0)
  } finally {
    collect.collectBlock = real
  }
})

test('travel in the nether: the first hop with no path, short of the blocks to cross, turns back for netherrack at once and plans again; with the blocks, the detours as before', async () => {
  // (full-26.3-fresh-t: at its bridge's end with 4 cobblestone every hop on toward the fortress failed, 35000 ticks)
  const gridModule = require('../../src/skills/gridWalk')
  const navModule = require('../../src/skills/navigate')
  const restock = require('../../src/nether/restock')
  const { SkillError } = await import('../../src/skills/errors')
  const { travel } = await import('../../src/skills/travel')
  const realGrid = gridModule.gridWalk
  const realNav = navModule.navigate
  const realTurn = restock.turnBackForBlocks
  const make = (items: any[]): { bot: any, log: string[] } => {
    const bot = seaBot(new Vec3(30.5, 44, 0.5), items)
    bot.pathfinder = { pathfinderSettings: {}, defaultMoveSettings: { scaffoldReserve: 4 }, setOptions: () => {}, setMoveOptions: () => {}, cancel: () => {} }
    bot.world = { getColumnAt: () => ({}) }
    return { bot, log: [] }
  }
  let current: { bot: any, log: string[] } = make([])
  gridModule.gridWalk = async () => { current.log.push('grid'); throw new SkillError('NO_PATH', 'no grid path') }
  navModule.navigate = async () => {
    const { bot, log } = current
    const held = bot.inventory.items().filter((i: any) => i.name === 'netherrack' || i.name === 'cobblestone').reduce((n: number, i: any) => n + i.count, 0)
    if (held < 33) { log.push('no path'); throw new SkillError('NO_PATH', 'no path to the goal') }
    log.push('across')
    bot.entity.position = new Vec3(94.5, 44, 0.5)
  }
  restock.turnBackForBlocks = async (bot: any) => {
    current.log.push('turn back')
    bot.inventory.slots[30] = Object.assign(item('netherrack', 64), { slot: 30 })
    bot.inventory.slots[31] = Object.assign(item('netherrack', 60), { slot: 31 })
    bot.entity.position = new Vec3(-4.5, 37, 0.5)
    return 124
  }
  const ticking = setInterval(() => current.bot.emit('physicsTick'), 1)
  try {
    current = make([item('cobblestone', 4), item('diamond_pickaxe')])
    await travel(current.bot, { target: new Vec3(94.5, 44, 0.5), range: 3, trail: false })
    assert.deepEqual(current.log, ['grid', 'no path', 'turn back', 'grid', 'across'])
    // enough blocks: no turn back, the detours tried
    current = make([item('cobblestone', 40), item('diamond_pickaxe')])
    navModule.navigate = async () => { current.log.push('no path'); throw new SkillError('NO_PATH', 'no path to the goal') }
    await assert.rejects(travel(current.bot, { target: new Vec3(94.5, 44, 0.5), range: 3, trail: false }), /no way on/)
    assert.ok(!current.log.includes('turn back'))
    assert.equal(current.log.filter(l => l === 'no path').length, 8)
    // short, but restock off: none
    current = make([item('cobblestone', 4), item('diamond_pickaxe')])
    await assert.rejects(travel(current.bot, { target: new Vec3(94.5, 44, 0.5), range: 3, trail: false, restock: false }), /no way on/)
    assert.ok(!current.log.includes('turn back'))
    // on firm ground short of the blocks (the shore, the sea ahead): the detours first, a way round, then back for them
    current = make([item('cobblestone', 4), item('diamond_pickaxe')])
    current.bot.entity.position = new Vec3(-4.5, 37, 0.5)
    navModule.navigate = async () => {
      const { bot, log } = current
      const held = bot.inventory.items().filter((i: any) => i.name === 'netherrack' || i.name === 'cobblestone').reduce((n: number, i: any) => n + i.count, 0)
      if (held < 33) { log.push('no path'); throw new SkillError('NO_PATH', 'no path to the goal') }
      log.push('across')
      bot.entity.position = new Vec3(94.5, 44, 0.5)
    }
    await travel(current.bot, { target: new Vec3(94.5, 37, 0.5), range: 3, trail: false })
    assert.deepEqual(current.log.filter(l => l !== 'grid'), [...new Array(8).fill('no path'), 'turn back', 'across'])
    // a turn-back that gets nothing: the detours, and no second
    current = make([item('cobblestone', 4), item('diamond_pickaxe')])
    restock.turnBackForBlocks = async () => { current.log.push('turn back'); return 0 }
    await assert.rejects(travel(current.bot, { target: new Vec3(94.5, 44, 0.5), range: 3, trail: false }), /no way on/)
    assert.equal(current.log.filter(l => l === 'turn back').length, 1)
  } finally {
    clearInterval(ticking)
    gridModule.gridWalk = realGrid
    navModule.navigate = realNav
    restock.turnBackForBlocks = realTurn
  }
})
