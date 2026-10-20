// Breeding and the cane farm without a server: the pairs fed, the spots canes stand on, a water hole's site.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { BREED_COOLDOWN_TICKS, breedingPairs, gatherHerd, releaseSpots } from '../../src/skills/husbandry'
import { caneSpot, caneSpots, waterHoleSite } from '../../src/skills/caneFarm'

test('breedingPairs: adults within 8 blocks of each other, not fed in the cooldown, nearest first', () => {
  const a = (id: number, x: number, adult = true) => ({ id, position: new Vec3(x, 64, 0), adult })
  const herd = [a(1, 2), a(2, 4), a(3, 6), a(4, 30), a(5, 3, false), a(6, 7)]
  assert.deepStrictEqual(breedingPairs(herd, new Map(), 10000, new Vec3(0, 64, 0), 4), [[1, 2], [3, 6]])
  // one pair at most
  assert.deepStrictEqual(breedingPairs(herd, new Map(), 10000, new Vec3(0, 64, 0), 1), [[1, 2]])
  // the ones fed lately wait
  const fed = new Map([[1, 9000], [2, 10000 - BREED_COOLDOWN_TICKS]])
  assert.deepStrictEqual(breedingPairs(herd, fed, 10000, new Vec3(0, 64, 0), 4), [[2, 3]])
  // a lone adult far off has no partner
  assert.deepStrictEqual(breedingPairs([a(4, 30), a(1, 2)], new Map(), 10000, new Vec3(0, 64, 0), 4), [])
})

// grass at y 63 with air over it, a pond at x 5..6, z 0, sand at x 7, stone at x 8
const world = (p: Vec3): { name: string } => {
  if (p.y > 63) return { name: 'air' }
  if (p.y < 63) return { name: 'dirt' }
  if (p.z === 0 && (p.x === 5 || p.x === 6)) return { name: 'water' }
  if (p.z === 0 && p.x === 7) return { name: 'sand' }
  if (p.z === 0 && p.x === 8) return { name: 'stone' }
  return { name: 'grass_block' }
}

test('caneSpot: dirt or sand with water on a side and room over it; not stone, not away from water', () => {
  assert.strictEqual(caneSpot(world, new Vec3(4, 63, 0)), true)
  assert.strictEqual(caneSpot(world, new Vec3(7, 63, 0)), true)
  assert.strictEqual(caneSpot(world, new Vec3(5, 63, 1)), true)
  assert.strictEqual(caneSpot(world, new Vec3(8, 63, 1)), false)
  assert.strictEqual(caneSpot(world, new Vec3(0, 63, 3)), false)
  const spots = caneSpots(world, new Vec3(5, 64, 0), 4)
  assert.strictEqual(spots.length, 6)
  assert.ok(spots.every(s => caneSpot(world, s)))
})

test('waterHoleSite: level cane ground with the same on its four sides, not under the bot', () => {
  const flat = (p: Vec3) => ({ name: p.y > 63 ? 'air' : p.y === 63 ? 'grass_block' : 'dirt' })
  const site = waterHoleSite(flat, new Vec3(0.5, 64, 0.5)) as Vec3
  assert.ok(site != null)
  assert.strictEqual(site.y, 63)
  assert.ok(Math.abs(site.x) > 1 || Math.abs(site.z) > 1)
  assert.strictEqual(waterHoleSite((p: Vec3) => ({ name: p.y > 63 ? 'air' : 'stone' }), new Vec3(0, 64, 0)), null)
})

test('keepFarms: eggs held let out, a pair of cows near bred with the wheat held, a cane farm planted from 8 canes; nothing without them', async () => {
  const { keepFarms } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const tasks: string[] = []
  const executor: any = { memory: new WorldMemory(), task: async (name: string) => { tasks.push(name); return 'done' } }
  const cow = (id: number, x: number): any => ({ id, name: 'cow', position: new Vec3(x, 64, 0), metadata: [] })
  const bot = fakeBot({ items: [item('cow_spawn_egg', 4), item('wheat', 16), item('sugar_cane', 64)], entities: [cow(5, 3), cow(6, 4)] })
  await keepFarms(bot, executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(tasks, ['let out the cows', 'breed the cows', 'plant a cane farm'])
  // where the herd was let out, for its chores after (the levels' mining takes the bot far off)
  assert.strictEqual(executor.memory.getPois('herd').length, 1)
  // a farm known, no eggs, no food: nothing
  tasks.length = 0
  executor.memory.addPoi('cane_farm', { x: 1, y: 64, z: 1 })
  await keepFarms(fakeBot({ items: [item('sugar_cane', 64)] }), executor, new AbortController().signal, () => {})
  assert.deepStrictEqual(tasks, [])
})

test('shelvesForLeather: the shelves the leather at hand makes books for, two cows kept to breed and a book for the anvil', async () => {
  const { shelvesForLeather } = await import('../../src/milestones')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  // 8 cows let out: 6 to kill, 6 books, one kept: a shelf (the table's book made already)
  assert.strictEqual(shelvesForLeather(inv({ enchanting_table: 1 }), 8), 1)
  assert.strictEqual(shelvesForLeather(inv({ enchanting_table: 1 }), 8, 0, 0), 2)
  // the table still to make takes a book first
  assert.strictEqual(shelvesForLeather(inv({}), 9), 1)
  assert.strictEqual(shelvesForLeather(inv({ enchanting_table: 1, leather: 10, book: 3, bookshelf: 1 }), 2), 5)
  assert.strictEqual(shelvesForLeather(inv({ enchanting_table: 1, leather: 64 }), 0, 4), 15)
  assert.strictEqual(shelvesForLeather(inv({ enchanting_table: 1 }), 1), 0)
})

test('releaseSpots and waterHoleSite on a hillside: ground with room over it about the bot, a hole with cane ground on two sides', () => {
  // a slope rising one block a column along +x from x 0, grass on top, the bot at x 0 on y 64
  const top = (x: number): number => 63 + Math.max(0, Math.min(4, x))
  const hill = (p: Vec3): { name: string, boundingBox: string } => {
    const t = top(p.x)
    if (p.y > t) return { name: 'air', boundingBox: 'empty' }
    return { name: p.y === t ? 'grass_block' : 'dirt', boundingBox: 'block' }
  }
  const spots = releaseSpots(hill, new Vec3(0, 64, 0))
  assert.ok(spots.length >= 8, `${spots.length}`)
  for (const s of spots) {
    assert.strictEqual(hill(s).boundingBox, 'block')
    assert.strictEqual(hill(s.offset(0, 1, 0)).boundingBox, 'empty')
  }
  const site = waterHoleSite(hill, new Vec3(0.5, 64, 0.5)) as Vec3
  assert.ok(site != null)
  assert.strictEqual(hill(site).name, 'grass_block')
})

test('herdChore: breed and wait while the adults beyond the two breeders fall short of the leather wanted; then kill', async () => {
  const { herdChore } = await import('../../src/milestones')
  assert.strictEqual(herdChore({ leather: 0, want: 46, adults: 8, calves: 4, wheat: 60 }), 'breed')
  assert.strictEqual(herdChore({ leather: 10, want: 46, adults: 38, calves: 6, wheat: 20 }), 'kill')
  assert.strictEqual(herdChore({ leather: 45, want: 46, adults: 3, calves: 0, wheat: 0 }), 'kill')
  assert.strictEqual(herdChore({ leather: 45, want: 46, adults: 2, calves: 0, wheat: 10 }), 'breed')
  assert.strictEqual(herdChore({ leather: 46, want: 46, adults: 2, calves: 0, wheat: 0 }), 'done')
  // the wheat gone or the time up: the surplus killed, then done
  assert.strictEqual(herdChore({ leather: 1, want: 46, adults: 33, calves: 3, wheat: 1 }), 'grow')
  assert.strictEqual(herdChore({ leather: 1, want: 46, adults: 33, calves: 0, wheat: 1 }), 'kill')
  assert.strictEqual(herdChore({ leather: 1, want: 46, adults: 33, calves: 3, wheat: 20, timeUp: true }), 'kill')
  // the calves waited for, then done with the breeders kept
  assert.strictEqual(herdChore({ leather: 30, want: 46, adults: 2, calves: 3, wheat: 0 }), 'grow')
  assert.strictEqual(herdChore({ leather: 30, want: 46, adults: 2, calves: 0, wheat: 0 }), 'done')
})

test('gatherHerd: nothing to do without the food or with the herd all by home', async () => {
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const home = new Vec3(0, 64, 0)
  const cow = (id: number, x: number): any => ({ id, name: 'cow', position: new Vec3(x, 64, 0), metadata: [] })
  assert.strictEqual(await gatherHerd(fakeBot({ entities: [cow(5, 30)] }), home), 0)
  assert.strictEqual(await gatherHerd(fakeBot({ items: [item('wheat', 10)], entities: [cow(5, 3), cow(6, -4)] }), home), 0)
})

test('startFarm with no water near and a water bucket held digs a water hole for the farm first', async () => {
  const { startFarm } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const tasks: string[] = []
  const executor: any = { memory: new WorldMemory(), task: async (name: string) => { tasks.push(name) } }
  const bot = fakeBot({ items: [item('water_bucket', 1), item('wheat_seeds', 8)] })
  bot.game.dimension = 'overworld'
  assert.strictEqual(await startFarm(bot, executor, new AbortController().signal, () => {}), false)
  assert.deepStrictEqual(tasks, ['a water hole for the farm'])
})

test('startFarm with no water near and an empty bucket fills it first (refillWater), then digs the water hole once it holds water; with no water to fill it from, no farm', async () => {
  const { startFarm } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const tasks: string[] = []
  const lines: string[] = []
  const executor: any = { memory: new WorldMemory(), task: async (name: string) => { tasks.push(name) } }
  const bot = fakeBot({ items: [item('bucket', 1), item('wheat_seeds', 8)] })
  bot.game.dimension = 'overworld'
  // no water in the world about: the fill fails, no hole
  bot.findBlocks = () => []
  bot.findBlock = () => null
  assert.strictEqual(await startFarm(bot, executor, new AbortController().signal, l => lines.push(l)), false)
  assert.ok(lines.some(l => /the bucket filled for a water hole/.test(l)), lines.join(' | '))
  assert.ok(lines.some(l => /no farm yet/.test(l)), lines.join(' | '))
  assert.deepStrictEqual(tasks, [])
  // the bucket full already: the hole dug at once
  lines.length = 0
  const full = fakeBot({ items: [item('water_bucket', 1), item('bucket', 1), item('wheat_seeds', 8)] })
  full.game.dimension = 'overworld'
  await startFarm(full, executor, new AbortController().signal, l => lines.push(l))
  assert.ok(!lines.some(l => /the bucket filled/.test(l)), lines.join(' | '))
  assert.deepStrictEqual(tasks, ['a water hole for the farm'])
})

test('leatherFromHerd pens the herd first, and leads the cows outside the pen back in, not a 96-block gather', async () => {
  const { leatherFromHerd } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({
    position: new Vec3(0.5, 64, 0.5),
    items: [item('wheat', 20)],
    entities: [
      { id: 1, name: 'cow', position: new Vec3(10, 64, 10), metadata: [] },
      { id: 2, name: 'cow', position: new Vec3(11, 64, 10), metadata: [] },
      { id: 3, name: 'cow', position: new Vec3(20, 64, 0), metadata: [] }
    ]
  })
  bot.game.dimension = 'overworld'
  const pen = { center: new Vec3(10, 64, 10), size: 5, side: 'west', gate: new Vec3(8, 64, 10), inside: new Vec3(9, 64, 10), outside: new Vec3(7, 64, 10), fences: [] }
  let tick = 0
  const tasks: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    obtain: async () => {},
    plan: () => ({ ok: false }),
    task: async (name: string) => {
      tasks.push(name)
      if (name === 'the herd pen') return { pen, inside: 2, built: true }
      if (name === 'wait for the calves') tick += 1e6
      return { fed: 0 }
    }
  }
  await leatherFromHerd(bot, executor, 46, new AbortController().signal, () => {})
  assert.equal(tasks[0], 'the herd pen')
  assert.ok(tasks.includes('the herd into its pen'), tasks.join(', '))
  assert.ok(!tasks.includes('gather the herd'))
})

test('leatherFromHerd tries smaller pens when the ground near home takes no pen of 9', async () => {
  const { leatherFromHerd, PEN_SIZES } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 20)] })
  bot.game.dimension = 'overworld'
  let tick = 0
  const pens: number[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    obtain: async () => {},
    task: async (name: string, fn: any) => {
      if (name === 'the herd pen') { pens.push(pens.length); throw new Error(`NOT_FOUND: no ground for a pen of ${PEN_SIZES[pens.length - 1]}`) }
      if (name === 'wait for the calves') tick += 1e6
      return { fed: 0 }
    }
  }
  await leatherFromHerd(bot, executor, 46, new AbortController().signal, () => {})
  assert.equal(pens.length, PEN_SIZES.length)
})

test('leatherFromHerd gets the pen\'s fences outside the pen\'s task (an obtain inside it waited on its own make-room task)', async () => {
  const penModule = require('../../src/skills/pen')
  const { leatherFromHerd } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 20)] })
  bot.game.dimension = 'overworld'
  const pen = { center: new Vec3(10, 64, 10), size: 7, side: 'west', gate: new Vec3(7, 64, 10), inside: new Vec3(8, 64, 10), outside: new Vec3(6, 64, 10), fences: [] }
  let calls = 0
  const real = penModule.herdPen
  penModule.herdPen = async (_bot: unknown, args: any) => {
    calls++
    if (calls === 1) await args.obtain([{ item: '#wooden_fences', count: 23 }, { item: '#fence_gates', count: 1 }])
    return { pen, inside: 0, built: true }
  }
  let tick = 0
  const log: string[] = []
  let inTask = false
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    obtain: async (reqs: any[]) => { log.push(`${inTask ? 'in' : 'out'} obtain ${reqs.map(r => r.item).join(',')}`) },
    task: async (name: string, fn: any) => {
      if (name === 'the herd pen') { inTask = true; try { return await fn(new AbortController().signal) } finally { inTask = false } }
      if (name === 'wait for the calves') tick += 1e6
      return { fed: 0 }
    }
  }
  try {
    await leatherFromHerd(bot, executor, 46, new AbortController().signal, () => {})
  } finally {
    penModule.herdPen = real
  }
  assert.equal(calls, 2)
  assert.deepEqual(log.filter(l => /fences/.test(l)), ['out obtain #wooden_fences,#fence_gates'])
})

test('shelvesForPaper: the shelves the paper and canes at hand make books for', async () => {
  const { shelvesForPaper } = await import('../../src/milestones')
  const inv = (items: Record<string, number>) => ({ count: (n: string) => items[n] ?? 0 })
  // 64 paper and 21 canes: 28 books, one kept, the table made: 9 shelves
  assert.strictEqual(shelvesForPaper(inv({ enchanting_table: 1, paper: 64, sugar_cane: 21 })), 9)
  assert.strictEqual(shelvesForPaper(inv({ enchanting_table: 1, paper: 200 })), 15)
  assert.strictEqual(shelvesForPaper(inv({})), 0)
})

test('leatherFromHerd makes room in a full bag before it kills for leather', async () => {
  const { leatherFromHerd } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 0)] })
  bot.game.dimension = 'overworld'
  ;(bot.inventory as any).emptySlotCount = () => 0
  for (let i = 1; i <= 10; i++) bot.entities[i] = { id: i, name: 'cow', type: 'animal', position: new Vec3(i, 64, 0), metadata: [] } as any
  let tick = 0
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    makeRoom: async (_n: unknown, _s: unknown, force: boolean) => { calls.push(`room ${String(force)}`) },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${reqs[0].item}`); tick += 1e6 },
    task: async (name: string) => { if (name === 'the herd pen') throw new Error('NOT_FOUND: no ground for a pen'); return { fed: 0 } }
  }
  await leatherFromHerd(bot, executor, 46, new AbortController().signal, () => {})
  assert.deepStrictEqual(calls.slice(0, 2), ['room true', 'obtain leather'])
})

test('leatherFromHerd counts the cows about a pen built off home with those in it (the herd still to be led in)', async () => {
  const { leatherFromHerd } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('wheat', 20)] })
  bot.game.dimension = 'overworld'
  for (let i = 1; i <= 8; i++) bot.entities[i] = { id: i, name: 'cow', type: 'animal', position: new Vec3(i, 64, 0), metadata: [] } as any
  const pen = { center: new Vec3(20, 64, 20), size: 5, side: 'west', gate: new Vec3(18, 64, 20), inside: new Vec3(19, 64, 20), outside: new Vec3(17, 64, 20), fences: [] }
  let tick = 0
  const lines: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    obtain: async () => {},
    task: async (name: string) => { if (name === 'the herd pen') return { pen, inside: 0, built: true }; if (name === 'wait for the calves') tick += 1e6; return { fed: 0 } }
  }
  await leatherFromHerd(bot, executor, 46, new AbortController().signal, l => lines.push(l))
  assert.ok(lines.some(l => /herd: breed \(8 cows/.test(l)), lines.join(' | '))
})
