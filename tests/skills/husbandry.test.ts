// Breeding and the cane farm without a server: the pairs fed, the spots canes stand on, a water hole's site.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { BREED_COOLDOWN_TICKS, breedingPairs, releaseSpots } from '../../src/skills/husbandry'
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
  assert.strictEqual(herdChore({ leather: 45, want: 46, adults: 2, calves: 0, wheat: 0 }), 'breed')
  assert.strictEqual(herdChore({ leather: 46, want: 46, adults: 2, calves: 0, wheat: 0 }), 'done')
})
