import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import minecraftData from 'minecraft-data'
import {
  BOOKSHELF_OFFSETS, ENCHANT_PREFERENCES, MAX_BOOKSHELVES, bookshelfGap, bookshelfLayout, chooseEnchantingSite, chooseOffer,
  countBookshelves, enchantingRequests, isValidBookShelf, itemKind, nearestDoor, offerCostRange, planEnchantingSetup, topOfferFits, type EnchantOffer
} from '../../src/skills/enchant'
import { checkPlan, type PlanStep } from '../../src/planner/steps'
import type { RegistryLike } from '../../src/core/registry'
import type { BlockView } from '../../src/skills/placement'

const registry: RegistryLike = minecraftData('1.21.11')

// a superflat: grass at y = -1 and below, air above; `extra` sets blocks by "x,y,z"
function flat (extra: Record<string, string> = {}): (pos: Vec3) => BlockView {
  const empty = new Set(['air', 'short_grass', 'water', 'lava', 'torch', 'poppy'])
  return pos => {
    const name = extra[`${pos.x},${pos.y},${pos.z}`] ?? (pos.y <= -1 ? 'grass_block' : 'air')
    return { name, boundingBox: empty.has(name) ? 'empty' : 'block' }
  }
}

const key = (v: Vec3): string => `${v.x},${v.y},${v.z}`

test('BOOKSHELF_OFFSETS: BlockPos.betweenClosed(-2, 0, -2, 2, 1, 2) with |x| or |z| 2, in its order (x, then y, then z)', () => {
  assert.strictEqual(BOOKSHELF_OFFSETS.length, 32)
  // vanilla's stream, written out: x fastest, then y, then z, filtered to the ring
  const vanilla: string[] = []
  for (let i = 0; i < 5 * 2 * 5; i++) {
    const x = -2 + i % 5
    const y = Math.floor(i / 5) % 2
    const z = -2 + Math.floor(i / 10)
    if (Math.abs(x) === 2 || Math.abs(z) === 2) vanilla.push(`${x},${y},${z}`)
  }
  assert.deepStrictEqual(BOOKSHELF_OFFSETS.map(key), vanilla)
  assert.deepStrictEqual(BOOKSHELF_OFFSETS.slice(0, 6).map(key), ['-2,0,-2', '-1,0,-2', '0,0,-2', '1,0,-2', '2,0,-2', '-2,1,-2'])
  assert.strictEqual(BOOKSHELF_OFFSETS.filter(o => o.y === 0).length, 16)
  // the gap: the offset halved toward 0 (Java's int division), at the shelf's own level
  assert.deepStrictEqual(key(bookshelfGap(new Vec3(2, 0, 1))), '1,0,0')
  assert.deepStrictEqual(key(bookshelfGap(new Vec3(-2, 1, -1))), '-1,1,0')
  assert.deepStrictEqual(key(bookshelfGap(new Vec3(1, 0, -2))), '0,0,-1')
  assert.deepStrictEqual(key(bookshelfGap(new Vec3(-2, 0, 2))), '-1,0,1')
  assert.deepStrictEqual(key(bookshelfGap(new Vec3(0, 1, 2))), '0,1,1')
})

test('countBookshelves: a shelf counts when the cell halfway to the table lets the power through (replaceable)', () => {
  const table = new Vec3(10, 0, 10)
  const extra: Record<string, string> = { '10,0,10': 'enchanting_table' }
  for (const o of BOOKSHELF_OFFSETS) if (o.y === 0) extra[key(table.plus(o))] = 'bookshelf'
  assert.strictEqual(countBookshelves(flat(extra), table), 16)
  // grass in a gap still lets it through; a torch in (11,0,10) blocks the three shelves whose gap it is: (12,0,9..11)
  assert.strictEqual(countBookshelves(flat({ ...extra, '11,0,11': 'short_grass' }), table), 16)
  assert.strictEqual(countBookshelves(flat({ ...extra, '11,0,10': 'torch' }), table), 13)
  assert.strictEqual(isValidBookShelf(flat({ ...extra, '11,0,10': 'torch' }), table, new Vec3(2, 0, 0)), false)
  // the corner (12,0,12)'s gap is (11,0,11), its own: (12,0,11) goes through (11,0,10), (11,0,12) through (10,0,11)
  assert.strictEqual(countBookshelves(flat({ ...extra, '11,0,11': 'stone' }), table), 15)
})

test('bookshelfLayout: 15 on the bottom ring, the door left open; the rest where the table counts them', () => {
  const table = new Vec3(0, 0, 0)
  const door = nearestDoor(table, new Vec3(0.5, 0, 10))
  assert.strictEqual(key(door), '0,0,2')
  const layout = bookshelfLayout(flat(), table, door)
  assert.strictEqual(layout.length, MAX_BOOKSHELVES)
  assert.ok(layout.every(o => o.y === 0 && !o.equals(door)))
  // placed, they make 15
  const extra: Record<string, string> = {}
  for (const o of layout) extra[key(o)] = 'bookshelf'
  assert.strictEqual(countBookshelves(flat(extra), table), 15)
  assert.deepStrictEqual(bookshelfLayout(flat(extra), table, door), [])

  // five there already: ten more
  const some: Record<string, string> = {}
  for (const o of layout.slice(0, 5)) some[key(o)] = 'bookshelf'
  const rest = bookshelfLayout(flat(some), table, door)
  assert.strictEqual(rest.length, 10)
  assert.ok(rest.every(o => some[key(o)] == null))

  // a stone wall on the -z side of the bottom ring: the shelves go up over the others
  const wall: Record<string, string> = {}
  for (let x = -2; x <= 2; x++) wall[`${x},0,-2`] = 'stone'
  const up = bookshelfLayout(flat(wall), table, door)
  assert.strictEqual(up.length, 15)
  assert.strictEqual(up.filter(o => o.y === 1).length, 5)
  const built: Record<string, string> = { ...wall }
  for (const o of up) built[key(o)] = 'bookshelf'
  assert.strictEqual(countBookshelves(flat(built), table), 15)
})

test('offerCostRange: EnchantmentHelper.getEnchantmentCost; a level-30 top offer means 15 shelves (or more)', () => {
  // every roll of nextInt(8) and nextInt(shelves + 1)
  for (let shelves = 0; shelves <= 20; shelves++) {
    const b = Math.min(shelves, 15)
    const tops = new Set<number>()
    for (let r1 = 0; r1 < 8; r1++) for (let r2 = 0; r2 <= b; r2++) tops.add(Math.max(r1 + 1 + (b >> 1) + r2, b * 2))
    const range = offerCostRange(2, shelves)
    assert.strictEqual(range.min, Math.min(...tops), `${shelves} shelves`)
    assert.strictEqual(range.max, Math.max(...tops), `${shelves} shelves`)
    assert.strictEqual(tops.has(30), shelves >= 15, `${shelves} shelves`)
  }
  assert.deepStrictEqual(offerCostRange(2, 15), { min: 30, max: 30 })
  assert.deepStrictEqual(offerCostRange(0, 0), { min: 1, max: 2 })
  assert.deepStrictEqual(offerCostRange(1, 15), { min: 6, max: 21 })
})

test('chooseOffer: the best paid-for offer by cost and hint, waiting for the top one when asked', () => {
  const offers = (a: [number, string | null, number], b: [number, string | null, number], c: [number, string | null, number]): EnchantOffer[] =>
    [a, b, c].map(([cost, hint, hintLevel], slot) => ({ slot: slot as 0 | 1 | 2, cost, hint, hintLevel }))
  const sword = ENCHANT_PREFERENCES.sword

  // level 30, lapis 3: the top offer
  let choice = chooseOffer(offers([8, 'smite', 1], [17, 'sharpness', 2], [30, 'unbreaking', 3]), { level: 30, lapis: 3, preference: sword })
  assert.strictEqual(choice.action, 'enchant')
  assert.strictEqual(choice.action === 'enchant' && choice.slot, 2)
  // a wanted hint a few levels lower beats an unwanted one at the top
  choice = chooseOffer(offers([8, 'smite', 1], [27, 'sharpness', 3], [30, 'knockback', 2]), { level: 30, lapis: 3, preference: sword })
  assert.strictEqual(choice.action === 'enchant' && choice.slot, 1)
  // only what the levels pay for
  choice = chooseOffer(offers([8, 'smite', 1], [17, 'sharpness', 2], [30, 'unbreaking', 3]), { level: 20, lapis: 3, preference: sword })
  assert.strictEqual(choice.action === 'enchant' && choice.slot, 1)
  // and the lapis: one lapis is the first offer only
  choice = chooseOffer(offers([8, 'smite', 1], [17, 'sharpness', 2], [30, 'unbreaking', 3]), { level: 30, lapis: 1, preference: sword })
  assert.strictEqual(choice.action === 'enchant' && choice.slot, 0)
  // waiting for 30
  choice = chooseOffer(offers([8, 'smite', 1], [17, 'sharpness', 2], [30, 'unbreaking', 3]), { level: 20, lapis: 3, preference: sword, waitForTop: true })
  assert.deepStrictEqual(choice.action === 'wait' && choice.needLevels, 30)
  // nothing paid for, nothing offered
  assert.strictEqual(chooseOffer(offers([8, null, 0], [17, null, 0], [30, null, 0]), { level: 5, lapis: 3, preference: sword }).action, 'none')
  assert.strictEqual(chooseOffer(offers([0, null, 0], [0, null, 0], [0, null, 0]), { level: 30, lapis: 3, preference: sword }).action, 'none')
  // an offer of 0 (EnchantmentMenu: a cost below slot + 1) is never taken
  choice = chooseOffer(offers([1, 'efficiency', 1], [0, null, 0], [0, null, 0]), { level: 30, lapis: 3, preference: ENCHANT_PREFERENCES.pickaxe })
  assert.strictEqual(choice.action === 'enchant' && choice.slot, 0)
})

test('itemKind and the preferences: protection on armor, sharpness on swords, efficiency on pickaxes, power on bows, feather falling on boots', () => {
  assert.strictEqual(itemKind('diamond_pickaxe'), 'pickaxe')
  assert.strictEqual(itemKind('iron_axe'), 'axe')
  assert.strictEqual(itemKind('netherite_sword'), 'sword')
  assert.strictEqual(itemKind('turtle_helmet'), 'helmet')
  assert.strictEqual(itemKind('diamond_boots'), 'boots')
  assert.strictEqual(itemKind('bow'), 'bow')
  assert.strictEqual(itemKind('stick'), 'other')
  assert.strictEqual(ENCHANT_PREFERENCES.sword[0], 'sharpness')
  assert.strictEqual(ENCHANT_PREFERENCES.pickaxe[0], 'efficiency')
  assert.ok(ENCHANT_PREFERENCES.pickaxe.slice(0, 2).includes('unbreaking'))
  assert.strictEqual(ENCHANT_PREFERENCES.bow[0], 'power')
  assert.strictEqual(ENCHANT_PREFERENCES.boots[0], 'feather_falling')
  for (const kind of ['helmet', 'chestplate', 'leggings'] as const) assert.strictEqual(ENCHANT_PREFERENCES[kind][0], 'protection')
  // every name is an enchantment of 1.21.11
  const names = new Set(Object.values((registry as any).enchantmentsByName).map((e: any) => e.name))
  for (const list of Object.values(ENCHANT_PREFERENCES)) for (const name of list) assert.ok(names.has(name), name)
})

test('chooseEnchantingSite: the nearest flat 5 x 5 with no work; around a pond, a flower dug out, a hole filled', () => {
  const site = chooseEnchantingSite(flat(), new Vec3(0, 0, 0))
  assert.ok(site != null)
  assert.strictEqual(key(site.table), '0,0,0')
  assert.deepStrictEqual([site.dig.length, site.fill.length], [0, 0])

  // water two blocks out: the table moves off it
  const pond: Record<string, string> = {}
  for (let x = -1; x <= 1; x++) for (let z = 2; z <= 3; z++) pond[`${x},-1,${z}`] = 'water'
  const moved = chooseEnchantingSite(flat(pond), new Vec3(0, 0, 0))
  assert.ok(moved != null)
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) assert.notStrictEqual(pond[`${moved.table.x + x},-1,${moved.table.z + z}`], 'water')

  // walled in by stone at the bot's level, with one flower and one hole in the only 5 x 5 left
  const walls: Record<string, string> = {}
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) {
      if (Math.max(Math.abs(x), Math.abs(z)) > 2) for (let y = 0; y <= 1; y++) walls[`${x},${y},${z}`] = 'cobblestone'
    }
  }
  walls['1,0,1'] = 'poppy'
  walls['-1,-1,0'] = 'air'
  const worked = chooseEnchantingSite(flat({ ...walls, '1,0,1': 'dandelion' }), new Vec3(0, 0, 0), { radius: 2, dy: 0 })
  assert.ok(worked != null)
  assert.strictEqual(key(worked.table), '0,0,0')
  assert.deepStrictEqual(worked.dig.map(key), ['1,0,1'])
  assert.deepStrictEqual(worked.fill.map(key), ['-1,-1,0'])
  // the base's walls are kept
  assert.strictEqual(chooseEnchantingSite(flat({ ...walls, '1,0,1': 'dandelion' }), new Vec3(0, 0, 0), { radius: 2, dy: 0, keep: p => p.x === 1 && p.z === 1 }), null)
})

test('the full setup planned from nothing: 45 + 1 books from 138 sugar cane and 46 leather, 90 planks of shelves, diamonds and obsidian for the table', () => {
  assert.deepStrictEqual(enchantingRequests(), [{ item: 'enchanting_table', count: 1 }, { item: 'bookshelf', count: 15 }, { item: 'lapis_lazuli', count: 9 }])
  const plan = planEnchantingSetup(registry)
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(checkPlan(registry, plan.steps, {}).ok, true)
  const total = (pred: (s: PlanStep) => boolean): number => plan.steps.filter(pred).reduce((n, s) => n + s.count, 0)
  assert.strictEqual(total(s => s.kind === 'craft' && s.item === 'bookshelf'), 15)
  assert.strictEqual(total(s => s.kind === 'craft' && s.item === 'enchanting_table'), 1)
  assert.strictEqual(total(s => s.kind === 'craft' && s.item === 'book'), 46)
  assert.strictEqual(total(s => s.kind === 'craft' && s.item === 'paper'), 138)
  assert.strictEqual(total(s => s.kind === 'mine' && s.item === 'sugar_cane'), 138)
  const leather = plan.steps.filter(s => s.kind === 'kill' && s.item === 'leather')
  assert.strictEqual(leather.reduce((n, s) => n + s.count, 0), 46)
  assert.ok(leather.every(s => s.kind === 'kill' && s.mob === 'cow'))
  assert.strictEqual(total(s => s.kind === 'mine' && s.item === 'obsidian'), 4)
  // two for the table, three for the diamond pickaxe obsidian needs
  assert.strictEqual(total(s => s.kind === 'mine' && s.item === 'diamond'), 5)
  assert.ok(plan.steps.some(s => s.kind === 'craft' && s.item === 'diamond_pickaxe'))
  assert.ok(total(s => s.kind === 'craft' && /_planks$/.test(s.item)) >= 90)
  assert.ok(total(s => s.kind === 'mine' && s.item === 'lapis_lazuli') >= 9)
  // the shelves are crafted after the books, the table after the obsidian
  const at = (pred: (s: PlanStep) => boolean): number => plan.steps.findIndex(pred)
  assert.ok(at(s => s.kind === 'craft' && s.item === 'book') < at(s => s.kind === 'craft' && s.item === 'bookshelf'))
  assert.ok(at(s => s.kind === 'mine' && s.item === 'obsidian') < at(s => s.kind === 'craft' && s.item === 'enchanting_table'))

  // with the books and planks held and a diamond pickaxe: the shelves and the table from the diamonds and obsidian
  const held = { book: 46, oak_planks: 90, diamond_pickaxe: 1, crafting_table: 1, diamond: 2, obsidian: 4, lapis_lazuli: 9 }
  const short = planEnchantingSetup(registry, { inventory: held })
  assert.deepStrictEqual(short.steps.map(s => `${s.kind} ${s.item} ${s.count}`), ['craft enchanting_table 1', 'craft bookshelf 15'])
  assert.strictEqual(checkPlan(registry, short.steps, held).ok, true)
})

test('topOfferFits: the top offer a table makes with fewer shelves (no shelves: 1 to 8; 6: 12 to 17; 15: 30)', () => {
  for (let c = 1; c <= 8; c++) assert.ok(topOfferFits(c, 0))
  assert.ok(!topOfferFits(9, 0))
  assert.ok(!topOfferFits(11, 6))
  assert.ok(topOfferFits(12, 6) && topOfferFits(17, 6))
  assert.ok(!topOfferFits(18, 6))
  assert.ok(topOfferFits(30, 15) && !topOfferFits(29, 15))
})

test('the enchanting milestone\'s shelves: the most within the budget, in steps of 3; none when even 3 cost too much or have no plan', async () => {
  const { shelvesWithin } = await import('../../src/milestones')
  assert.equal(shelvesWithin(n => n * 1000, 24000), 15)
  assert.equal(shelvesWithin(n => n * 2000, 24000), 12)
  assert.equal(shelvesWithin(n => n > 6 ? null : n * 3000, 24000), 6)
  assert.equal(shelvesWithin(() => 30000, 24000), 0)
})

test('levelsToward: the near ores, then down for the deep ones, then tunnel legs, within the budget', async () => {
  const { levelsToward, LEVELS_DEPTH } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  ;(bot as any).experience = { level: 20, points: 0, progress: 0 }
  let tick = 0
  const tasks: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { get tick () { return tick } },
    task: async (name: string) => {
      tasks.push(name)
      tick += 10000
      if (name === 'levels') throw new Error('NOT_FOUND: no ore, smelt, kill left')
      if (name === 'down for the ores') bot.entity.position = new Vec3(0.5, LEVELS_DEPTH, 0.5)
    }
  }
  await levelsToward(bot, executor, 30, new AbortController().signal, () => {})
  assert.deepEqual(tasks.slice(0, 5), ['levels', 'down for the ores', 'levels', 'a tunnel for ores', 'levels'])
  assert.ok(tick <= 72000 + 20000)
})

test('the enchanting milestone makes room in the bag, what the shelves take kept, before it crafts them', async () => {
  const { enchantingHandler } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('leather', 40), item('sugar_cane', 120), item('enchanting_table', 1)] })
  bot.game.dimension = 'overworld'
  bot.findBlock = () => null
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    plan: () => ({ ok: true, cost: 0 }),
    makeRoom: async (needed: Record<string, number>, _s: unknown, force: boolean) => { calls.push(`room ${force ? 'force' : ''} ${needed.sugar_cane ?? 0}`) },
    obtain: async (reqs: any[]) => { calls.push(`obtain ${reqs[0]?.item}`) },
    task: async (name: string) => { calls.push(name); if (name === 'enchant the gear') throw new Error('stop here') }
  }
  await assert.rejects(enchantingHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: { goals: () => [] } as any, state: null as any }), /stop here/)
  const room = calls.findIndex(c => /^room force/.test(c))
  assert.ok(room >= 0, calls.join(', '))
  assert.ok(room < calls.indexOf('obtain bookshelf'), calls.join(', '))
  // and before the gear's, for the armor taken off
  assert.equal(calls[calls.indexOf('enchant the gear') - 1], 'room force 256', calls.join(', '))
})

test('ENCHANTING_KEEP keeps the table, its makings and the anvil from a forced room', async () => {
  const { ENCHANTING_KEEP } = await import('../../src/milestones')
  for (const name of ['enchanting_table', 'anvil', 'diamond', 'obsidian', 'lapis_lazuli', 'leather', 'sugar_cane']) assert.ok((ENCHANTING_KEEP[name] ?? 0) > 0, name)
})

test('the enchanting goes on when no room can be made in the bag (INVENTORY_FULL)', async () => {
  const { enchantingHandler } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { TaskError } = await import('../../src/core/errors')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('leather', 40), item('sugar_cane', 120), item('enchanting_table', 1)] })
  bot.game.dimension = 'overworld'
  bot.findBlock = () => null
  const calls: string[] = []
  const executor: any = {
    memory: new WorldMemory(),
    tasks: { tick: 0 },
    plan: () => ({ ok: true, cost: 0 }),
    makeRoom: async () => { throw new TaskError('INVENTORY_FULL', 'nothing to throw') },
    obtain: async () => {},
    task: async (name: string) => { calls.push(name); if (name === 'enchant the gear') throw new Error('stop here') }
  }
  await assert.rejects(enchantingHandler({ bot, executor, signal: new AbortController().signal, log: () => {}, milestone: { goals: () => [] } as any, state: null as any }), /stop here/)
})

test('levelsToward builds the xp farm first at a zombie spawner it knows, when many levels are to go', async () => {
  const { levelsToward } = await import('../../src/milestones')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.game.dimension = 'overworld'
  ;(bot as any).experience = { level: 2, points: 0, progress: 0 }
  const memory = new WorldMemory()
  memory.addPoi('spawner', { x: 40, y: 20, z: 10 }, 'overworld', 'zombie')
  let tick = 0
  const tasks: string[] = []
  const executor: any = {
    memory,
    tasks: { get tick () { return tick } },
    obtain: async () => {},
    task: async (name: string) => { tasks.push(name); tick += 100000 }
  }
  await levelsToward(bot, executor, 30, new AbortController().signal, () => {})
  assert.equal(tasks[0], 'to the spawner')
  // none known: the ores as before
  tasks.length = 0
  tick = 0
  const plain: any = { ...executor, memory: new WorldMemory() }
  await levelsToward(bot, plain, 30, new AbortController().signal, () => {})
  assert.equal(tasks[0], 'levels')
})
