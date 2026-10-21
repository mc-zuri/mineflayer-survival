// No trip to the lava for its obsidian without a water bucket (waterForTheLava): a 26.3 bot's hazard reflex poured its
// water in a deep pool's lava, and with none left it went on mining the pool's obsidian at y -29 and swam into the lava
// (ls4-26.3, t188337 to t188576).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { waterForTheLava } from '../../src/milestones'
import { fakeBot, item } from '../reflexes/fakeBot'

test('waterForTheLava: a water bucket held goes; none, one planned (a bucket and the water); none to be had, no trip', async () => {
  const signal = new AbortController().signal
  const lines: string[] = []
  const log = (l: string): void => { lines.push(l) }
  const held = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('water_bucket')] })
  let asked = 0
  assert.equal(await waterForTheLava(held, { obtain: async () => { asked++; return { plans: 0, steps: 0 } } } as any, signal, log), true)
  assert.equal(asked, 0)
  // none: the planner's water bucket got
  const none = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [] })
  const obtain = async (reqs: any[]): Promise<any> => {
    asked++
    assert.equal(reqs[0].item, 'water_bucket')
    const w = item('water_bucket')
    w.slot = 20
    none.inventory.slots[20] = w
    return { plans: 1, steps: 2 }
  }
  assert.equal(await waterForTheLava(none, { obtain } as any, signal, log), true)
  assert.equal(asked, 1)
  // none to be had: no trip
  const dry = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [] })
  assert.equal(await waterForTheLava(dry, { obtain: async () => { throw new Error('no water found') } } as any, signal, log), false)
  assert.match(lines.join('\n'), /no trip to the lava/)
})

test('lavaPoolOrder: the pool under the sky first, then the one in the rock; the one in a cave last, and none for a bot not fit for the caves (ls4-26.3)', async () => {
  const { lavaPoolOrder } = await import('../../src/milestones')
  // the surface at y 63 (rock under it); a cave of air round (40, 20, 0); pools at the surface, in the rock and in the cave
  const world = (p: Vec3): string => p.x >= 36 && p.x <= 44 && p.y >= 18 && p.y <= 23 && Math.abs(p.z) <= 4 && p.y !== 18 ? 'air' : p.y <= 63 ? 'stone' : 'air'
  const pools = [{ x: 40, y: 18, z: 0 }, { x: 10, y: 30, z: 0 }, { x: 60, y: 63, z: 0 }]
  const plain = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  plain.game.dimension = 'overworld'
  assert.deepEqual(lavaPoolOrder(plain, pools), [{ x: 60, y: 63, z: 0 }, { x: 10, y: 30, z: 0 }])
  const prot = [{ name: 'protection', lvl: 1 }]
  const ready = fakeBot({
    position: new Vec3(0.5, 64, 0.5),
    world,
    armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 10)]
  })
  ready.game.dimension = 'overworld'
  assert.deepEqual(lavaPoolOrder(ready, pools), [{ x: 60, y: 63, z: 0 }, { x: 10, y: 30, z: 0 }, { x: 40, y: 18, z: 0 }])
})

test('withinBound: the obsidian\'s trips within OBSIDIAN_HOME_RANGE of home; no home, no bound; naturalObsidian goes to no ruined portal past it (f2-26.3)', async () => {
  const { OBSIDIAN_HOME_RANGE, naturalObsidian, withinBound } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const home = { x: 0, z: 0 }
  assert.equal(withinBound({ home, range: OBSIDIAN_HOME_RANGE }, { x: 100, z: 100 }), true)
  assert.equal(withinBound({ home, range: OBSIDIAN_HOME_RANGE }, { x: 286, z: 0 }), false)
  assert.equal(withinBound({}, { x: 1000, z: 0 }), true)
  // seed 2's ruined portals, none within 20 of home: no trip
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('diamond_pickaxe', 1)] })
  bot.game.dimension = 'overworld'
  bot.survival = { playOptions: { seed: '2' } }
  bot.findBlocks = () => []
  const calls: string[] = []
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (name: string) => { calls.push(name) } }
  const seedBiomes = require('../../src/worldgen/seedBiomes')
  const realOpen = seedBiomes.openSeedBiomes
  seedBiomes.openSeedBiomes = async () => null
  try {
    await naturalObsidian(bot, executor, 4, new AbortController().signal, () => {}, { home, range: 20 })
  } finally {
    seedBiomes.openSeedBiomes = realOpen
  }
  assert.ok(!calls.includes('to a ruined portal'), calls.join(', '))
})

test('obsidianAtHome: a bucket of lava scooped from a source near (none in the deep dark, past the bound, or against a cave under the rule), cast in a pit at home, a block a trip, till the 4 are in (f2-26.3)', async () => {
  const { homeLavaSources, obsidianAtHome } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  // lava at (6, 40, 0) in the rock (a pocket), at (300, 40, 0) past the bound, at (0, 40, 30) by a cave's air
  const lava = [new Vec3(6, 40, 0), new Vec3(300, 40, 0), new Vec3(0, 40, 30)]
  const world = (p: Vec3): string => lava.some(l => l.equals(p)) ? 'lava' : p.x >= -3 && p.x <= 3 && p.y >= 38 && p.y <= 42 && p.z >= 31 && p.z <= 37 ? 'air' : p.y < 64 ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('diamond_pickaxe', 1), item('water_bucket', 1), item('bucket', 1)], world })
  bot.game.dimension = 'overworld'
  bot.findBlocks = (opts: any) => opts.matching === bot.registry.blocksByName.lava.id ? lava.slice() : []
  const bound = { home: { x: 0, z: 0 }, range: 160 }
  assert.deepEqual(homeLavaSources(bot, bound).map(p => p.toArray()), [[6, 40, 0]])
  // the trips: the scoop and the cast stubbed (a lava bucket in, an obsidian for it out)
  const bucket = require('../../src/skills/bucket')
  const obsidian = require('../../src/nether/obsidian')
  const realFill = bucket.fillBucket
  const realPit = obsidian.obsidianInPit
  let obsidianCount = 0
  const setSlot = (slot: number, name: string | null, count = 1): void => { const it = name == null ? null : Object.assign(item(name, count), { slot }); bot.inventory.slots[slot] = it }
  const scooped: string[] = []
  bucket.fillBucket = async (_b: any, args: any) => { scooped.push(args.pos.toString()); setSlot(11, 'lava_bucket') }
  obsidian.obsidianInPit = async () => { setSlot(11, 'bucket'); obsidianCount++; setSlot(20, 'obsidian', obsidianCount); return true }
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (_name: string, fn: any) => await fn(new AbortController().signal), obtain: async () => {} }
  try {
    assert.equal(await obsidianAtHome(bot, executor, 4, new AbortController().signal, () => {}, bound), true)
  } finally {
    bucket.fillBucket = realFill
    obsidian.obsidianInPit = realPit
  }
  assert.equal(obsidianCount, 4)
  assert.deepEqual([...new Set(scooped)], ['(6, 40, 0)'])
})

test('obsidianAtHome: a source no spot sees (in the rock) scooped by a tunnel to it (scoopByTunnel), the cast at home made (f3-1.21.11, t195365)', async () => {
  const { obsidianAtHome } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const lava = [new Vec3(6, 40, 0)]
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('diamond_pickaxe', 1), item('water_bucket', 1), item('bucket', 1)], world: p => lava.some(l => l.equals(p)) ? 'lava' : p.y < 64 ? 'stone' : 'air' })
  bot.game.dimension = 'overworld'
  bot.findBlocks = (opts: any) => opts.matching === bot.registry.blocksByName.lava.id ? lava.slice() : []
  const bucket = require('../../src/skills/bucket')
  const scoop = require('../../src/skills/lavaScoop')
  const obsidian = require('../../src/nether/obsidian')
  const real = { fill: bucket.fillBucket, scoop: scoop.scoopByTunnel, pit: obsidian.obsidianInPit }
  const setSlot = (slot: number, name: string, count = 1): void => { bot.inventory.slots[slot] = Object.assign(item(name, count), { slot }) }
  const calls: string[] = []
  const { SkillError } = await import('../../src/skills/errors')
  bucket.fillBucket = async (_b: any, args: any) => { calls.push('fill'); throw new SkillError('NO_PATH', `no spot found to see ${args.pos.toString()} from`) }
  scoop.scoopByTunnel = async () => { calls.push('scoop'); setSlot(11, 'lava_bucket') }
  obsidian.obsidianInPit = async () => { calls.push('cast'); setSlot(11, 'bucket'); setSlot(20, 'obsidian', 1); return true }
  const executor: any = { memory: new WorldMemory(), tasks: { tick: 0 }, task: async (_name: string, fn: any) => await fn(new AbortController().signal), obtain: async () => {} }
  try {
    assert.equal(await obsidianAtHome(bot, executor, 1, new AbortController().signal, () => {}, { home: { x: 0, z: 0 }, range: 160 }), true)
  } finally {
    bucket.fillBucket = real.fill
    scoop.scoopByTunnel = real.scoop
    obsidian.obsidianInPit = real.pit
  }
  assert.deepEqual(calls, ['fill', 'scoop', 'cast'])
})
