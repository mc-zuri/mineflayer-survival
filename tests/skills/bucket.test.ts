import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { castCandidates, isSource, surfacePoints } from '../../src/skills/bucket'

test('castCandidates: beside the lava, above it, then above the blocks beside it', () => {
  const cells = castCandidates(new Vec3(5, -61, 5)).map(pos => pos.toArray().join(','))
  assert.deepStrictEqual(cells.slice(0, 5), ['5,-61,4', '5,-61,6', '4,-61,5', '6,-61,5', '5,-60,5'])
  assert.strictEqual(cells.length, 9)
})

test('isSource: a fluid of level 0', () => {
  const fluid = (name: string, level: number): any => ({ name, getProperties: () => ({ level: String(level) }) })
  assert.strictEqual(isSource(fluid('lava', 0), 'lava'), true)
  assert.strictEqual(isSource(fluid('lava', 2), 'lava'), false)
  assert.strictEqual(isSource(fluid('water', 0), 'lava'), false)
  assert.strictEqual(isSource({ name: 'water', metadata: 0 }, 'water'), true)
  assert.strictEqual(isSource(null, 'water'), false)
})

test('surfacePoints: the surface, the sides and the bottom of a source\'s shape, inside its block', () => {
  const pts = surfacePoints(new Vec3(3, 70, -2))
  assert.strictEqual(pts.length, 12)
  for (const p of pts) assert.ok(p.x > 3 && p.x < 4 && p.y > 70 && p.y < 70 + 8 / 9 && p.z > -2 && p.z < -1, p.toString())
  assert.ok(pts.some(p => p.y < 70.05), 'no point on the bottom')
})

test('renewableWater: a source with two sources beside it fills again once taken; a lone one (a farm\'s water hole) or a pool\'s edge with one does not', async () => {
  const { renewableWater } = await import('../../src/skills/bucket')
  const pool = new Set(['0,62,0', '1,62,0', '-1,62,0', '0,62,1', '5,62,5', '6,62,5'])
  const lookup = (p: Vec3): any => pool.has(`${p.x},${p.y},${p.z}`) ? { name: 'water', getProperties: () => ({ level: 0 }) } : { name: 'stone' }
  assert.strictEqual(renewableWater(lookup, new Vec3(0, 62, 0)), true)
  assert.strictEqual(renewableWater(lookup, new Vec3(1, 62, 0)), false)
  assert.strictEqual(renewableWater(lookup, new Vec3(5, 62, 5)), false)
  assert.strictEqual(renewableWater(lookup, new Vec3(9, 62, 9)), false)
})

test('keepWaterBucket: only with an empty bucket and no water bucket, at a renewable source only (full-26.3-fresh-r: a 35-block fall with an empty bucket)', async () => {
  const { keepWaterBucket, waterBucketEmpty } = await import('../../src/skills/bucket')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const full = fakeBot({ items: [item('water_bucket', 1), item('bucket', 1)] })
  assert.strictEqual(waterBucketEmpty(full), false)
  assert.strictEqual(await keepWaterBucket(full), false)
  const empty = fakeBot({ items: [item('bucket', 1)] })
  assert.strictEqual(waterBucketEmpty(empty), true)
  // the only water a lone source: none taken
  const lone = new Vec3(3, 63, 3)
  empty.findBlocks = () => [lone]
  empty.blockAt = (p: Vec3) => p.equals(lone) ? { name: 'water', position: p, getProperties: () => ({ level: 0 }) } : { name: 'stone', position: p }
  assert.strictEqual(await keepWaterBucket(empty), false)
})

test('keepWaterSource: a renewable source at the top of the water, not one under the water (full-26.3-fresh-z); viewSpots: no stand with the head in the water', async () => {
  const { keepWaterSource, viewSpots } = await import('../../src/skills/bucket')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // a pool x -2 to 2, z -2 to 2, y 60 to 62 of water sources, stone round and under it, air over y 62
  const name = (p: Vec3): string => (Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2 && p.y >= 60 && p.y <= 62) ? 'water' : p.y <= 62 ? 'stone' : 'air'
  const lookup = (p: Vec3): any => ({ name: name(p), boundingBox: name(p) === 'stone' ? 'block' : 'empty', getProperties: () => ({ level: 0 }) })
  assert.deepStrictEqual(keepWaterSource(lookup, [new Vec3(0, 60, 0), new Vec3(0, 61, 0), new Vec3(0, 62, 0)]), new Vec3(0, 62, 0))
  assert.strictEqual(keepWaterSource(lookup, [new Vec3(0, 60, 0), new Vec3(1, 61, 0)]), null)
  const bot = fakeBot({ position: new Vec3(4.5, 63, 0.5), world: name })
  const spots = viewSpots(bot, new Vec3(0, 62, 0), 1.62, () => true)
  assert.ok(spots.length > 0)
  for (const spot of spots) assert.notStrictEqual(name(spot.offset(0, 1, 0)), 'water', spot.toString())
  assert.ok(!spots.some(s => s.y === 60), 'the floor of the pool')
})

test('fillBucket: a fill that comes back empty marks its cell no source NO_SOURCE_TICKS long, and the next fill goes to the next source (f6-26.3: the same cell at (-20, 101, 5) eight times)', async () => {
  const { fillBucket, fillableSource, knownNoSource, NO_SOURCE_TICKS } = await import('../../src/skills/bucket')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const ghost = new Vec3(3, 63, 0)
  const real = new Vec3(-2, 63, 0)
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('bucket', 1)] })
  bot.survival = { tasks: { tick: 100 } }
  const water = (p: Vec3): boolean => p.equals(ghost) || p.equals(real)
  bot.blockAt = (p: Vec3) => ({ name: water(p.floored()) ? 'water' : p.y < 64 ? 'stone' : 'air', position: p.floored(), boundingBox: water(p.floored()) || p.y >= 64 ? 'empty' : 'block', getProperties: () => ({ level: 0 }) })
  bot.world = { raycast: () => null }
  bot._client = new (require('node:events').EventEmitter)()
  // findBlock: the nearest of the two that matches
  bot.findBlock = (opts: any) => [ghost, real].map(p => bot.blockAt(p)).find((b: any) => opts.matching(b)) ?? null
  const used: string[] = []
  bot.activateItem = () => {
    const look = used.length === 0 ? ghost : real
    used.push(look.toString())
    // the ghost gives nothing; the real source fills the bucket
    if (look.equals(real)) bot.inventory.slots[9] = Object.assign(item('water_bucket', 1), { slot: 9 })
  }
  bot.lookAt = async () => {}
  bot.equip = async () => {}
  const ticks = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await assert.rejects(fillBucket(bot, { fluid: 'water' }), (err: any) => err.reason === 'VERIFY_FAILED')
    assert.equal(knownNoSource(bot, ghost), true)
    assert.equal(fillableSource(bot, bot.blockAt(ghost), 'water'), false)
    // a block with no position (findBlock's palette look) matches on the block alone
    assert.equal(fillableSource(bot, { name: 'water', getProperties: () => ({ level: 0 }) }, 'water'), true)
    const got = await fillBucket(bot, { fluid: 'water' })
    assert.deepEqual(got.pos.toArray(), real.toArray())
    // asked for the ghost by its cell: NOT_FOUND, no use of the bucket
    bot.inventory.slots[10] = Object.assign(item('bucket', 1), { slot: 10 })
    const usedBefore = used.length
    await assert.rejects(fillBucket(bot, { fluid: 'water', pos: ghost }), (err: any) => err.reason === 'NOT_FOUND' && /came back empty/.test(err.message))
    assert.equal(used.length, usedBefore)
    // after NO_SOURCE_TICKS it counts again
    bot.survival.tasks.tick += NO_SOURCE_TICKS
    assert.equal(knownNoSource(bot, ghost), false)
  } finally {
    clearInterval(ticks)
  }
})

test('pourPoint: a face the use ray hits first (pourRayLands): a point whose ray hits the block\'s other face, or crosses lava on its way, is passed over (after mine-ai-mcp\'s pourAim)', async () => {
  const { pourPoint, pourRayLands } = await import('../../src/skills/bucket')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // the pour's cell (2, 64, 0) over the floor (2, 63, 0); lava at (1, 64, 0) in one case
  const pos = new Vec3(2, 64, 0)
  const floor = new Vec3(2, 63, 0)
  let lava = false
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.blockAt = (p: Vec3) => {
    const c = p.floored()
    const name = lava && c.equals(new Vec3(1, 64, 0)) ? 'lava' : c.y < 64 ? 'stone' : 'air'
    return { name, position: c, boundingBox: name === 'stone' ? 'block' : 'empty', getProperties: () => ({}) }
  }
  // the world's ray: the floor's west face for a point at its top face's middle (as a ray grazing its edge would),
  // its top face for the others
  bot.world = {
    raycast: (eye: Vec3, dir: Vec3, range: number) => {
      const t = (64 - eye.y) / dir.y
      const at = eye.plus(dir.scaled(t))
      const centre = Math.abs(at.x - 2.5) < 0.01 && Math.abs(at.z - 0.5) < 0.01
      return { position: floor, face: centre ? 4 : 1, intersect: at }
    }
  }
  const eye = new Vec3(0.5, 65.62, 0.5)
  assert.equal(pourRayLands(bot, eye, new Vec3(2.5, 64, 0.5), floor, pos), false)
  assert.equal(pourRayLands(bot, eye, new Vec3(2.8, 64, 0.8), floor, pos), true)
  const point = pourPoint(bot, pos, eye)
  assert.ok(point != null && !(Math.abs(point.x - 2.5) < 0.01 && Math.abs(point.z - 0.5) < 0.01), String(point))
  // lava on the ray's way to the cell: none
  lava = true
  assert.equal(pourRayLands(bot, eye, new Vec3(2.8, 64, 0.8), floor, pos), false)
})

test('a fill from the nearest water never takes a farm\'s own (keptWater: the wheat farm\'s hole, the water by the cane farm\'s spots): with no other, NOT_FOUND (f5-1.21.11: the obsidian\'s bucket filled at the farm\'s hole, the farm dried)', async () => {
  const { fillBucket, keptWater } = await import('../../src/skills/bucket')
  const { WorldMemory } = await import('../../src/core/memory')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const { Vec3 } = await import('vec3')
  const memory = new WorldMemory()
  memory.addPoi('farm', new Vec3(5, 63, 5), 'overworld', JSON.stringify({ crop: 'wheat', cells: [[6, 63, 5]], sown: 0 }))
  memory.addPoi('cane_farm', new Vec3(20, 64, 0), 'overworld', JSON.stringify({ spots: [[20, 63, 0]] }))
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), items: [item('bucket', 1)] })
  bot.survival = { memory }
  const kept = keptWater(bot)
  assert.equal(kept(new Vec3(5, 63, 5)), true)
  assert.equal(kept(new Vec3(21, 63, 0)), true)
  assert.equal(kept(new Vec3(22, 63, 0)), false)
  assert.equal(kept(new Vec3(40, 63, 40)), false)
  // mineflayer's findBlock: the nearest that matches, its extra info checked too
  const waters = [new Vec3(5, 63, 5), new Vec3(21, 63, 0)]
  bot.findBlock = (opts: any) => {
    for (const p of waters) {
      const block = { name: 'water', position: p, getProperties: () => ({ level: 0 }) }
      if (opts.matching(block) && (typeof opts.useExtraInfo !== 'function' || opts.useExtraInfo(block))) return block
    }
    return null
  }
  await assert.rejects(fillBucket(bot, { fluid: 'water' }), /no water source nearby/)
})
