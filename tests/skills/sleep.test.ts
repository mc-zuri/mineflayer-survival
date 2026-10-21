import { test } from 'node:test'
import assert from 'node:assert'
import { bedOccupied, canSleepNow, stateProperty } from '../../src/skills/sleep'
import { isBed } from '../../src/core/items'
import { defaultKeep } from '../../src/executor/keep'

test('isBed: every colour of bed, not the straw bed of 26.3 (no spawn, gone once slept in)', () => {
  assert.ok(isBed('white_bed'))
  assert.ok(isBed('light_blue_bed'))
  assert.ok(!isBed('straw_bed'))
  assert.ok(!isBed('bedrock'))
  assert.strictEqual(defaultKeep('red_bed'), 1)
  assert.notStrictEqual(defaultKeep('straw_bed'), 1)
})

test('canSleepNow: at night (12541 to 23458) or in a thunderstorm', () => {
  assert.strictEqual(canSleepNow(1000, false), false)
  assert.strictEqual(canSleepNow(12540, false), false)
  assert.strictEqual(canSleepNow(12541, false), true)
  assert.strictEqual(canSleepNow(18000, false), true)
  assert.strictEqual(canSleepNow(23459, false), false)
  assert.strictEqual(canSleepNow(6000, true), true)
})

test('bedOccupied: BedBlock.OCCUPIED from the state id (1.21.11 white_bed: facing, occupied, part)', () => {
  const registry = require('minecraft-data')('1.21.11')
  const bot = { registry } as any
  const bed = registry.blocksByName.white_bed
  // facing north, occupied true, part head: the first state
  assert.strictEqual(bedOccupied(bot, { stateId: bed.minStateId }), true)
  assert.strictEqual(stateProperty(bot, bed.minStateId, 'part'), 'head')
  assert.strictEqual(bedOccupied(bot, { stateId: bed.minStateId + 2 }), false)
  assert.strictEqual(stateProperty(bot, bed.minStateId + 2 + 1, 'part'), 'foot')
  assert.strictEqual(stateProperty(bot, bed.minStateId + 3 * 4, 'facing'), 'east')
  // the default state (BedBlock: occupied false, part foot)
  assert.strictEqual(bedOccupied(bot, { stateId: bed.defaultState }), false)
})

test('sleep at the spawn of a server with spawn protection: a bed standing in the square passed over (its use refused), the bag\'s put down out of it, the bot walked SPAWN_LEAVE_MARGIN past the square first (the night\'s sleep there failed for a hole)', async () => {
  const { EventEmitter } = await import('node:events')
  const { Vec3 } = await import('vec3')
  const { sleep } = await import('../../src/skills/sleep')
  const { SPAWN_LEAVE_MARGIN, installSpawnProtection, spawnDistance } = await import('../../src/skills/spawnProtection')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const nav = require('../../src/skills/navigate')
  const place = require('../../src/skills/placeBlock')
  const realNavigate = nav.navigate
  const realPlace = place.placeBlock
  const beds = new Map<string, any>()
  const bed = (p: any): void => { beds.set(p.toString(), p) }
  const bot = fakeBot({ position: new Vec3(2.5, 64, 0.5), items: [item('white_bed')], world: (p: any) => beds.has(p.toString()) ? 'white_bed' : p.y < 64 ? 'stone' : 'air' })
  bot.time = { timeOfDay: 18000 }
  bot.spawnPoint = new Vec3(0, 64, 0)
  bot._client = new EventEmitter()
  installSpawnProtection(bot, 16)
  // a bed standing by the spawn, in the square
  bed(new Vec3(3, 64, 0))
  bot.findBlock = (o: any) => [...beds.values()].map(p => bot.blockAt(p)).find((b: any) => o.matching(b)) ?? null
  bot.lookAt = async () => {}
  bot.isABed = (b: any) => b?.name === 'white_bed'
  bot.parseBedMetadata = () => ({ headOffset: new Vec3(1, 0, 0) })
  let slept: any = null
  bot.sleep = async (b: any) => { slept = b.position }
  bot.isSleeping = false
  const walks: any[] = []
  nav.navigate = async (b: any, args: any) => { walks.push(args.goal); if (args.goal.y == null) b.entity.position = new Vec3(args.goal.x + 0.5, 64, args.goal.z + 0.5); return {} }
  place.placeBlock = async (_b: any, args: any) => { bed(args.pos); bed(args.pos.offset(1, 0, 0)) }
  try {
    const result = await sleep(bot, { bedDistance: 16 })
    assert.ok(result.placedBed)
    assert.ok(spawnDistance(bot, result.bed) > 16 + 1, `the bed at ${result.bed.toString()}`)
    assert.ok(slept != null && spawnDistance(bot, slept) > 16)
    assert.deepStrictEqual([walks[0].x, walks[0].z], [16 + 1 + SPAWN_LEAVE_MARGIN + 1, 0])
  } finally {
    nav.navigate = realNavigate
    place.placeBlock = realPlace
  }
})
