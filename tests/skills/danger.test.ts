import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { DangerMap, NEVER, SCULK_COST, WARDEN_SAFE_DISTANCE, clearOfWarden, dangerAt, dangerMap, inDanger, listenerRadius, pillagersNear, scanDangers, sculkMoveAreas } from '../../src/skills/danger'
import { wardenReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { entity, fakeBot } from '../reflexes/fakeBot'

/** deepslate under y -10, a sensor at (5, -10, 0) and a shrieker at (8, -10, 0) on the floor */
const deepDark = (p: Vec3): string => p.x === 5 && p.y === -10 && p.z === 0 ? 'sculk_sensor' : p.x === 8 && p.y === -10 && p.z === 0 ? 'sculk_shrieker' : p.y < -10 ? 'stone' : 'air'

function deepBot (input: Parameters<typeof fakeBot>[0] = {}): any {
  const bot = fakeBot({ position: new Vec3(0.5, -9, 0.5), world: deepDark, ...input })
  bot.game.dimension = 'overworld'
  bot.findBlocks = () => [new Vec3(5, -10, 0), new Vec3(8, -10, 0)]
  return bot
}

test('DangerMap: a point\'s reach, kept till its time, the same cell noted once', () => {
  const map = new DangerMap()
  map.note('sculk', { x: 0, y: 0, z: 0 }, 10)
  map.note('sculk', { x: 0.4, y: 0.2, z: 0.9 }, 6)
  assert.strictEqual(map.points.length, 1)
  assert.strictEqual(map.at({ x: 9, y: 0, z: 0 }).length, 1)
  assert.strictEqual(map.at({ x: 11, y: 0, z: 0 }).length, 0)
  map.note('sculk', { x: 50, y: 0, z: 0 }, 10, 100)
  map.tick = 100
  assert.strictEqual(map.at({ x: 50, y: 0, z: 0 }).length, 0)
  map.prune()
  assert.strictEqual(map.points.length, 1)
})

test('listenerRadius: a sensor hears 8 blocks, a calibrated one 16 (SculkSensorBlockEntity, CalibratedSculkSensorBlockEntity)', () => {
  assert.strictEqual(listenerRadius('sculk_sensor'), 8)
  assert.strictEqual(listenerRadius('calibrated_sculk_sensor'), 16)
})

test('scanDangers: the sensors and shriekers about under y 20 are noted, a sensor\'s hearing and 2 more; none from the surface', () => {
  const bot = deepBot()
  scanDangers(bot)
  assert.strictEqual(dangerMap(bot).points.filter(p => p.kind === 'sculk').length, 2)
  assert.strictEqual(inDanger(bot, { x: 5, y: -10, z: 9 }, 'sculk'), true)
  assert.strictEqual(inDanger(bot, { x: 5, y: -10, z: 11 }, 'sculk'), false)
  const up = deepBot({ position: new Vec3(0.5, 64, 0.5) })
  scanDangers(up)
  assert.strictEqual(dangerMap(up).points.length, 0)
})

test('sculkMoveAreas: never a step on a sensor or a shrieker, nor one broken; a step or a dig in their hearing dear; far off, nothing', () => {
  const bot = deepBot()
  scanDangers(bot)
  const { step, brk } = sculkMoveAreas(bot)
  const at = (x: number, y: number, z: number): any => ({ position: new Vec3(x, y, z), name: deepDark(new Vec3(x, y, z)) })
  assert.strictEqual(step(at(8, -9, 0)), NEVER)
  assert.strictEqual(step(at(5, -9, 0)), NEVER)
  assert.strictEqual(step(at(3, -9, 0)), SCULK_COST)
  assert.strictEqual(step(at(40, -9, 0)), 0)
  assert.strictEqual(brk(at(8, -10, 0)), NEVER)
  assert.strictEqual(brk(at(5, -10, 0)), NEVER)
  assert.strictEqual(brk(at(3, -11, 0)), SCULK_COST)
  assert.strictEqual(brk(at(40, -11, 0)), 0)
  // a sensor met far from any noted is never broken either
  assert.strictEqual(brk({ position: new Vec3(100, -10, 0), name: 'sculk_shrieker' }), NEVER)
})

test('dangerAt: a mining target in the sculk\'s hearing or by a pillager in view (an outpost\'s hay bales)', () => {
  const bot = deepBot({ entities: [entity({ name: 'pillager', position: new Vec3(40.5, -9, 0.5) })] })
  scanDangers(bot)
  assert.strictEqual(dangerAt(bot, { x: 6, y: -11, z: 0 }), true)
  assert.strictEqual(pillagersNear(bot, { x: 60, y: -9, z: 0 }), true)
  assert.strictEqual(dangerAt(bot, { x: 60, y: -9, z: 0 }), true)
  assert.strictEqual(dangerAt(bot, { x: 80, y: -9, z: 0 }), false)
})

test('the warden reflex: a warden in its boom\'s reach (15 across, 20 up or down) or its follow (24) is run from, till 28 off or 20 up', () => {
  const check = (pos: Vec3): string | null => {
    const bot = deepBot({ entities: [entity({ name: 'warden', position: pos })] })
    const engine = new ReflexEngine(bot, { enabled: false })
    const task = wardenReflex.check(engine.context())
    engine.stop()
    return task?.detail ?? null
  }
  assert.strictEqual(check(new Vec3(10.5, -9, 0.5)), 'escape warden')
  assert.strictEqual(check(new Vec3(25.5, -9, 0.5)), 'escape warden')
  assert.strictEqual(check(new Vec3(0.5 + WARDEN_SAFE_DISTANCE + 1, -9, 0.5)), null)
  assert.strictEqual(check(new Vec3(5.5, 13, 0.5)), null)
  const bot = deepBot()
  assert.strictEqual(clearOfWarden(bot, entity({ name: 'warden', position: new Vec3(0.5, -30, 0.5) })), true)
  assert.strictEqual(clearOfWarden(bot, entity({ name: 'warden', position: new Vec3(0.5, -20, 0.5) })), false)
})

test('the deep dark: its ground noted DEEP_DARK_RADIUS round its sculk, no step into it for a bot not fit for the caves (out of it from in it), its lava and obsidian passed over (f2-26.3)', async () => {
  const { DEEP_DARK_RADIUS, deepDarkNear } = await import('../../src/skills/danger')
  const { obsidianHazard } = await import('../../src/skills/hazardCells')
  const bot = deepBot()
  scanDangers(bot)
  assert.ok(dangerMap(bot).points.some(p => p.kind === 'deepdark' && p.radius === DEEP_DARK_RADIUS))
  const { step } = sculkMoveAreas(bot)
  // a cell 14 off the sensor (out of its hearing, in the deep dark's ground): none for the bot out of it
  bot.entity.position = new Vec3(40.5, -9, 0.5)
  assert.strictEqual(step({ position: new Vec3(19, -9, 0) }), NEVER)
  // the bot in it: its way out
  bot.entity.position = new Vec3(18.5, -9, 0.5)
  assert.notStrictEqual(step({ position: new Vec3(19, -9, 0) }), NEVER)
  // a lava pool's or an obsidian's spot by its sculk
  assert.strictEqual(deepDarkNear(bot, new Vec3(10, -9, 0)), true)
  assert.strictEqual(obsidianHazard(bot, new Vec3(10, -9, 0)), true)
  const far = deepBot()
  far.findBlocks = () => []
  assert.strictEqual(deepDarkNear(far, new Vec3(100, -9, 0)), false)
})
