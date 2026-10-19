// Off a magma block (the hazard reflex's escapeHazard) on the snapshots of seed 2's nether (26.3) with the
// pathfinder's fake rig: a step onto the ground beside it where there's one, else a block put on the magma. In the
// basalt delta east of the fortress (nether-seed2-east.json.gz) a magma block at (89, 31, -546) lies by the lava sea
// with the lava on two sides and a wall two high on the others: a 26.3 bot stood on it 170 ticks, the reflex steering
// at a stand it couldn't climb to, till the floor and the magma cubes killed it.
import { test } from 'node:test'
import assert from 'node:assert'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { netherSnapshotRig, readNetherSnapshot } from './netherSnapshot'
import { escapeHazard, hotFloorStep, onHotFloor } from '../../src/skills/escape'

const fixture = (name: string): string => path.join(__dirname, '..', 'fixtures', name)

async function rigAt (file: string, start: Vec3): Promise<{ bot: any, world: any, stop: () => void }> {
  const { rig, world } = netherSnapshotRig(start, readNetherSnapshot(fixture(file)))
  const bot = rig.bot
  bot.game.dimension = 'the_nether'
  for (let i = 0; i < 40 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
  return { bot, world, stop: () => rig.stopPassivePhysics() }
}

test('hotFloorStep: none from the delta\'s magma pocket by the lava sea (89 31 -546); the bridge wall\'s magma (42 62 -523) has the ground beside it', async () => {
  const pocket = await rigAt('nether-seed2-east.json.gz', new Vec3(89.5, 32, -545.5))
  try {
    assert.equal(pocket.bot.blockAt(new Vec3(89, 31, -546))?.name, 'magma_block')
    assert.ok(onHotFloor(pocket.bot), `at ${pocket.bot.entity.position.toString()}`)
    assert.equal(hotFloorStep(pocket.bot), null)
  } finally {
    pocket.stop()
  }
  const wall = await rigAt('nether-seed2-blaze.json.gz', new Vec3(42.5, 63, -522.5))
  try {
    assert.ok(onHotFloor(wall.bot))
    const step = hotFloorStep(wall.bot)
    assert.ok(step != null)
    const under = wall.bot.blockAt(step.offset(0, -1, 0))?.name
    assert.ok(under != null && !['magma_block', 'lava'].includes(under), `${step.toString()} over ${String(under)}`)
    assert.ok(step.distanceTo(new Vec3(42, 63, -523)) < 2.5)
  } finally {
    wall.stop()
  }
})

test('escapeHazard in the delta\'s magma pocket puts a block on the magma at once and stands on it, never stepping into the lava', { timeout: 60000 }, async () => {
  const { bot, world, stop } = await rigAt('nether-seed2-east.json.gz', new Vec3(89.5, 32, -545.5))
  let covers = 0
  let lava = 0
  const onTick = (): void => {
    const feet = bot.entity.position.floored()
    if (bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, -1, 0))?.name === 'lava' || bot.entity.isInLava === true) lava++
  }
  bot.on('physicsTick', onTick)
  try {
    // (the pillar's jump and place, which the rig can't do: the block put, the bot on it)
    const cover = async (): Promise<boolean> => {
      covers++
      const feet = bot.entity.position.floored()
      world.setBlock(feet, 'cobblestone')
      bot.entity.position = feet.offset(0.5, 1, 0.5)
      for (let i = 0; i < 20 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
      return !onHotFloor(bot)
    }
    const res = await escapeHazard(bot, { searchRadius: 6, waterRadius: 0, maxTicks: 100, cover })
    assert.equal(covers, 1)
    assert.ok(res.ticks < 10, `${res.ticks} ticks`)
    assert.ok(!onHotFloor(bot))
    assert.equal(bot.blockAt(bot.entity.position.offset(0, -0.2, 0).floored())?.name, 'cobblestone')
    assert.equal(lava, 0)
  } finally {
    bot.off('physicsTick', onTick)
    stop()
  }
})

test('escapeHazard on the bridge wall\'s magma steps off onto the ground beside it, no block put', { timeout: 60000 }, async () => {
  const { bot, stop } = await rigAt('nether-seed2-blaze.json.gz', new Vec3(42.5, 63, -522.5))
  try {
    let covers = 0
    const res = await escapeHazard(bot, { searchRadius: 6, waterRadius: 0, maxTicks: 100, cover: async () => { covers++; return false } })
    assert.equal(covers, 0)
    assert.ok(res.ticks < 30, `${res.ticks} ticks`)
    assert.ok(!onHotFloor(bot))
    assert.notEqual(bot.blockAt(bot.entity.position.offset(0, -0.2, 0).floored())?.name, 'magma_block')
  } finally {
    stop()
  }
})

test('escapeHazard in the delta\'s magma pocket with no block put sneaks where it is (no hot floor hurts it), never across the lava', { timeout: 60000 }, async () => {
  const { bot, stop } = await rigAt('nether-seed2-east.json.gz', new Vec3(89.5, 32, -545.5))
  let lava = 0
  const onTick = (): void => {
    const feet = bot.entity.position.floored()
    if (bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, -1, 0))?.name === 'lava' || bot.entity.isInLava === true) lava++
  }
  bot.on('physicsTick', onTick)
  let sneaking = 0
  const onSneak = (): void => { if (bot.getControlState('sneak') === true) sneaking++ }
  bot.on('physicsTick', onSneak)
  try {
    await assert.rejects(escapeHazard(bot, { searchRadius: 6, waterRadius: 0, maxTicks: 30, cover: async () => false }), /still in lava or fire/)
    assert.equal(lava, 0)
    assert.ok(sneaking >= 20, `${sneaking} ticks sneaking`)
    assert.equal(bot.blockAt(bot.entity.position.offset(0, -0.2, 0).floored())?.name, 'magma_block')
  } finally {
    bot.off('physicsTick', onTick)
    bot.off('physicsTick', onSneak)
    stop()
  }
})
