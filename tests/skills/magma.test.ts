// Magma blocks in the pathfinder's steps (keepOffMagma): MagmaBlock.stepOn burns a player standing on one who isn't
// sneaking (Entity.isSteppingCarefully). A 26.3 bot's walk to a ruined portal's obsidian underground went back onto
// its magma after each of 12 hazard reflexes, and it burned to death (ls4-26.3, t54809 to t57447).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { MAGMA_STEP_COST, keepOffMagma, magmaStepCost } from '../../src/skills/hazardCells'

const pf = require('@nxg-org/mineflayer-pathfinder')
const setup = require('@nxg-org/mineflayer-pathfinder/tests/setup')

test('magmaStepCost: a move ending over a magma block costs MAGMA_STEP_COST, none sneaking or off it', () => {
  let sneak = false
  const bot: any = { blockAt: (p: Vec3) => ({ name: p.x === 0 && p.y === 63 && p.z === 0 ? 'magma_block' : p.y < 64 ? 'stone' : 'air' }), getControlState: () => sneak }
  const cost = magmaStepCost(bot)
  assert.equal(cost({ position: { x: 0, y: 64, z: 0 } }), MAGMA_STEP_COST)
  assert.equal(cost({ position: { x: 1, y: 64, z: 0 } }), 0)
  assert.equal(cost({ position: { x: 0, y: 65, z: 0 } }), 0)
  sneak = true
  assert.equal(cost({ position: { x: 0, y: 64, z: 0 } }), 0)
})

test('keepOffMagma: the way across a strip of magma goes round it, without the rule straight over (the fake rig)', { timeout: 60000 }, async () => {
  for (const rule of [false, true]) {
    const { rig } = setup.createCacheWorld('1.21.11', 64, new Vec3(0.5, 64, 0.5))
    const bot = rig.bot
    // a strip of magma across the way, x 3 to 5, z -3 to 3, the ground's top
    for (let x = 3; x <= 5; x++) for (let z = -3; z <= 3; z++) bot.world.setBlock(new Vec3(x, 63, z), 'magma_block')
    bot.loadPlugin(pf.createPlugin({ pathfinderSettings: { partialPathProducer: false, searchTimeoutMs: 8000 } }))
    bot.pathfinder.setMoveOptions({ ...bot.pathfinder.defaultMoveSettings, canDig: false, canPlace: false, allowParkour: false })
    if (rule) keepOffMagma(bot)
    try {
      let final: any
      for await (const res of bot.pathfinder.getPathTo(new pf.goals.GoalBlock(9, 64, 0))) final = res
      assert.equal(final?.result?.status, 'success')
      const over = final.result.path.filter((m: any) => m.x >= 3 && m.x <= 5 && Math.abs(m.z) <= 3)
      if (rule) assert.deepEqual(over.map((m: any) => `${m.x},${m.z}`), [])
      else assert.ok(over.length > 0)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})

test('hotFloorDigStep: on magma walled in by netherrack (a ruined portal\'s underground), the side with the fewest blocks to dig over a floor that isn\'t magma; none through lava or obsidian', async () => {
  const { hotFloorDigStep, sneakOnMagma } = await import('../../src/skills/escape')
  const { fakeBot } = await import('../reflexes/fakeBot')
  // the bot at (0, 46, 0) on magma at y 45; netherrack about, the cell west open at the head only; magma under the east side
  const world = (over: Record<string, string>) => (p: Vec3): string => over[`${p.x},${p.y},${p.z}`] ?? (p.x === 0 && p.z === 0 && (p.y === 46 || p.y === 47) ? 'air' : p.y === 45 && p.x === 0 && p.z === 0 ? 'magma_block' : 'netherrack')
  const bot = fakeBot({ position: new Vec3(0.5, 46, 0.5), world: world({ '-1,47,0': 'air', '1,45,0': 'magma_block' }) })
  // (the fake bot's solid blocks: netherrack and magma among them)
  const way = hotFloorDigStep(bot)
  assert.ok(way != null)
  assert.deepEqual(way.stand.toArray(), [-1, 46, 0])
  assert.deepEqual(way.dig.map(p => p.toArray()), [[-1, 46, 0]])
  // a patch of magma 3 across under it: the way dug two columns out, over the magma between (walked sneaking)
  const patch: Record<string, string> = {}
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) patch[`${x},45,${z}`] = 'magma_block'
  const wide = hotFloorDigStep(fakeBot({ position: new Vec3(0.5, 46, 0.5), world: world(patch) }))
  assert.ok(wide != null)
  assert.equal(Math.abs(wide.stand.x) + Math.abs(wide.stand.z), 2)
  assert.equal(wide.dig.length, 4)
  // lava behind every wall, or obsidian: no way dug
  const lava = fakeBot({ position: new Vec3(0.5, 46, 0.5), world: world({ '2,46,0': 'lava', '-2,46,0': 'lava', '0,46,2': 'lava', '0,46,-2': 'lava' }) })
  assert.equal(hotFloorDigStep(lava), null)
  const obsidian = fakeBot({ position: new Vec3(0.5, 46, 0.5), world: world({ '1,46,0': 'obsidian', '-1,46,0': 'obsidian', '0,46,1': 'obsidian', '0,46,-1': 'obsidian' }) })
  assert.equal(hotFloorDigStep(obsidian), null)
  // sneaking on the magma, but for a step down off it
  assert.equal(sneakOnMagma(new Vec3(0, 46, 0), new Vec3(1, 46, 0)), true)
  assert.equal(sneakOnMagma(new Vec3(0, 46, 0), new Vec3(1, 47, 0)), true)
  assert.equal(sneakOnMagma(new Vec3(0, 46, 0), new Vec3(1, 45, 0)), false)
  assert.equal(sneakOnMagma(new Vec3(0, 46, 0), null), true)
})
