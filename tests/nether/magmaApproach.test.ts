// The approach to seed 2's fortress spawner (26.3) on the snapshot of its throne (tests/fixtures/nether-seed2-blaze.json.gz)
// with the pathfinder's fake rig: a magma block lies on the bridge's east wall at (42, 62, -523), where the basalt
// delta steps down onto it. The hazard reflex took a 26.3 bot off it and the walk to the blaze nook took it straight
// back on, 430 times, till it died: the path's drop off the wall into the bridge, merged with the walk along it
// (DropDownOpt), cut across the magma.
import { test } from 'node:test'
import assert from 'node:assert'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { netherSnapshotRig, readNetherSnapshot } from './netherSnapshot'
import { netherMoveSettings } from '../../src/nether/safety'
import { navigate } from '../../src/skills/navigate'
import { botGridView } from '../../src/skills/gridWalk'
import { escapeHazard, onHotFloor } from '../../src/skills/escape'
import { HAZARD_LEFT_TICKS, hazardLeft, hazardLeftStepCost, keepOutOfHazardsLeft } from '../../src/skills/hazardCells'

const pf = require('@nxg-org/mineflayer-pathfinder')

const MAGMA = new Vec3(42, 62, -523)
/** the blaze nook's stand (planBlazeNook's, blazeFight.test.ts) */
const NOOK = new Vec3(58, 61, -544)

/** the snapshot's rig with the pathfinder, the nether's settings and the hazard cells' rule, the bot at `start` */
async function approachRig (start: Vec3): Promise<{ rig: any, bot: any, clock: { tick: number }, hotTicks: () => string[], stop: () => void }> {
  const snapshot = readNetherSnapshot(path.join(__dirname, '..', 'fixtures', 'nether-seed2-blaze.json.gz'))
  const { rig } = netherSnapshotRig(start, snapshot)
  const bot = rig.bot
  bot.game.dimension = 'the_nether'
  // the task runner's tick count, as the hazard cells read it
  const clock = { tick: 0 }
  bot.survival = { tasks: clock }
  bot.loadPlugin(pf.createPlugin({ pathfinderSettings: { partialPathProducer: true, partialPathLength: 50, searchTimeoutMs: 8000 } }))
  bot.pathfinder.setMoveOptions({ ...bot.pathfinder.defaultMoveSettings, ...netherMoveSettings(bot, { avoidDeaths: false }) })
  keepOutOfHazardsLeft(bot)
  const hot: string[] = []
  const onTick = (): void => {
    clock.tick++
    const p = bot.entity.position
    if (bot.entity.onGround && bot.blockAt(p.offset(0, -0.2, 0).floored())?.name === 'magma_block') hot.push(p.toString())
  }
  bot.on('physicsTick', onTick)
  // settled on the ground
  for (let i = 0; i < 40 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
  return { rig, bot, clock, hotTicks: () => hot, stop: () => { bot.off('physicsTick', onTick); rig.stopPassivePhysics() } }
}

test('the walk to the blaze nook from beside the bridge wall\'s magma block (42 62 -523) never stands on it (seed 2, 26.3)', { timeout: 120000 }, async () => {
  const { bot, hotTicks, stop } = await approachRig(new Vec3(42.5, 63, -521.5))
  try {
    assert.equal(bot.blockAt(MAGMA)?.name, 'magma_block')
    await navigate(bot, { goal: new pf.goals.GoalNear(NOOK.x, NOOK.y, NOOK.z, 0), planTicks: 300, unstick: 1 })
    assert.ok(bot.entity.position.distanceTo(NOOK.offset(0.5, 0, 0.5)) < 1.2, `at ${bot.entity.position.toString()}`)
    assert.deepStrictEqual(hotTicks(), [], 'stood on the magma')
  } finally {
    stop()
  }
})

test('the hazard reflex\'s step off the magma keeps the cell out of the walks for HAZARD_LEFT_TICKS, and the walk on to the nook stays off it', { timeout: 120000 }, async () => {
  const { bot, clock, hotTicks, stop } = await approachRig(new Vec3(42.5, 63, -522.5))
  try {
    const cell = MAGMA.offset(0, 1, 0)
    assert.ok(onHotFloor(bot), `not on the magma at ${bot.entity.position.toString()}`)
    assert.ok(!hazardLeft(bot, cell))
    await escapeHazard(bot, { searchRadius: 6, waterRadius: 0, maxTicks: 100 })
    assert.ok(!onHotFloor(bot), `still on the magma at ${bot.entity.position.toString()}`)
    // the pathfinder's step rule and the grid walk's floor keep out of it now
    assert.ok(hazardLeft(bot, cell))
    assert.ok(hazardLeftStepCost(bot)({ position: cell }) >= 1000000)
    assert.ok(!botGridView(bot).floor(MAGMA))
    assert.equal(hazardLeftStepCost(bot)({ position: cell.offset(1, 0, 0) }), 0, 'another cell')
    const off = hotTicks().length
    await navigate(bot, { goal: new pf.goals.GoalNear(NOOK.x, NOOK.y, NOOK.z, 0), planTicks: 300, unstick: 1 })
    assert.ok(bot.entity.position.distanceTo(NOOK.offset(0.5, 0, 0.5)) < 1.2, `at ${bot.entity.position.toString()}`)
    assert.deepStrictEqual(hotTicks().slice(off), [], 'back on the magma')
    // and once HAZARD_LEFT_TICKS have gone by, the cell is the nether rule's alone again
    clock.tick += HAZARD_LEFT_TICKS + 1
    assert.ok(!hazardLeft(bot, cell))
    assert.equal(hazardLeftStepCost(bot)({ position: cell }), 0)
  } finally {
    stop()
  }
})
