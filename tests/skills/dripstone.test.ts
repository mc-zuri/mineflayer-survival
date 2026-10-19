// Pointed dripstone, on the pathfinder's fake rig and in the skills' checks: no walk or drop ends standing on a
// stalagmite (keepOffDripstone's step rule; PointedDripstoneBlock.fallOn hurts a fall onto a tip pointing up as one 2.5
// blocks longer, twice over), and no staircase step opens onto one. A 26.3 bot stood on a stalagmite in a dripstone cave
// on its way back from the staircase to the deep lava, crit-jumped at the zombies there and was impaled 17 times, once a
// jump, till it died (run full-g).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { dripstoneStepCost, keepOffDripstone, onDripstone } from '../../src/skills/hazardCells'
import { unsafeStep, staircaseStep } from '../../src/executor/explore'

const pf = require('@nxg-org/mineflayer-pathfinder')
const setup = require('@nxg-org/mineflayer-pathfinder/tests/setup')
const registry = require('minecraft-data')('1.21.11')

/** pointed_dripstone[thickness=tip, vertical_direction=up, waterlogged=false]: a stalagmite's tip, 0.6875 high */
const TIP_UP = { stateId: registry.blocksByName.pointed_dripstone.minStateId + 5 }

/**
 * The fake rig on a flat floor (the bot's feet at 64) with a platform two blocks up (x -2 to 2, z 0 to 2) and
 * stalagmites' tips in the two rows along its -z edge but at x 2; the pathfinder loaded, no digging or placing, the step
 * rule with `rule`. The ticks the bot stood on a tip (on the ground 0.6875 up in a dripstone cell) are kept.
 */
async function platformRig (rule: boolean): Promise<{ bot: any, onTip: () => string[], stop: () => void }> {
  const { rig } = setup.createCacheWorld('1.21.11', 64, new Vec3(0.5, 66, 1.5))
  const bot = rig.bot
  for (let x = -2; x <= 2; x++) for (let z = 0; z <= 2; z++) for (const y of [64, 65]) bot.world.setBlock(new Vec3(x, y, z), 'stone')
  // two rows of them: the walk off the edge of a platform two high comes down a block and more out from it
  for (let x = -2; x <= 1; x++) for (const z of [-1, -2]) bot.world.setBlock(new Vec3(x, 64, z), TIP_UP)
  bot.loadPlugin(pf.createPlugin({ pathfinderSettings: { partialPathProducer: false, searchTimeoutMs: 8000 } }))
  bot.pathfinder.setMoveOptions({ ...bot.pathfinder.defaultMoveSettings, canDig: false, canPlace: false })
  if (rule) keepOffDripstone(bot)
  const on: string[] = []
  const onTick = (): void => {
    const p = bot.entity.position
    if (bot.entity.onGround === true && p.y - Math.floor(p.y) > 0.3 && onDripstone(q => bot.blockAt(q), p.floored())) on.push(p.toString())
  }
  bot.on('physicsTick', onTick)
  for (let i = 0; i < 40 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
  return { bot, onTip: () => on, stop: () => { bot.off('physicsTick', onTick); rig.stopPassivePhysics() } }
}

test('dripstoneStepCost: a cell with a stalagmite\'s tip in it or on top of dripstone is forbidden, the cells beside it not', () => {
  const blocks: Record<string, string> = { '0,64,0': 'pointed_dripstone', '3,63,0': 'pointed_dripstone' }
  const bot: any = { blockAt: (p: Vec3) => ({ name: blocks[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 ? 'stone' : 'air') }) }
  const cost = dripstoneStepCost(bot)
  assert.ok(cost({ position: new Vec3(0, 64, 0) }) >= 1000000)
  assert.ok(cost({ position: new Vec3(0, 65, 0) }) >= 1000000, 'on top of the tip')
  // (a node's plain x, y, z, as the pathfinder hands it)
  assert.ok(cost({ position: { x: 3, y: 64, z: 0 } }) >= 1000000)
  assert.equal(cost({ position: new Vec3(1, 64, 0) }), 0)
  assert.equal(cost({ position: new Vec3(3, 65, 0) }), 0, 'two over the dripstone')
})

test('the step down off a platform whose edge has stalagmites under it lands beside them, not on one (keepOffDripstone)', { timeout: 60000 }, async () => {
  for (const rule of [false, true]) {
    const { bot, onTip, stop } = await platformRig(rule)
    try {
      await bot.pathfinder.goto(new pf.goals.GoalBlock(0, 64, -4))
      assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 64, -3.5)) < 1.2, `at ${bot.entity.position.toString()}`)
      // (without the rule the drop lands on the tips)
      if (rule) assert.deepEqual(onTip(), [], 'stood on a stalagmite')
      else assert.ok(onTip().length > 0, 'the platform\'s way down without the rule is over the tips')
    } finally {
      stop()
    }
  }
})

test('unsafeStep: a staircase\'s step into, onto or over pointed dripstone is unsafe (it turns)', () => {
  const SOLID = new Set(['stone', 'pointed_dripstone'])
  const world = (blocks: Record<string, string>) => (p: Vec3) => { const name = blocks[`${p.x},${p.y},${p.z}`] ?? 'stone'; return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' } }
  const step = staircaseStep(new Vec3(0, 20, 0), new Vec3(1, 0, 0))
  assert.equal(unsafeStep(world({}), step), null)
  // one in the cells it opens; one as its floor; one under the floor in a cave below
  assert.match(unsafeStep(world({ '1,20,0': 'pointed_dripstone' }), step) ?? '', /dripstone/)
  assert.match(unsafeStep(world({ '1,18,0': 'pointed_dripstone' }), step) ?? '', /dripstone/)
  assert.match(unsafeStep(world({ '1,18,0': 'air', '1,17,0': 'pointed_dripstone' }), step) ?? '', /dripstone/)
})
