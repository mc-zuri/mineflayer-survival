// The caves reflex and the cave rule's choices in the reflexes: a bot not fit for the caves (caveReady) seals the holes
// its tunnel broke into a cave, walls itself in against the mobs that come at it there, and leaves a cave's spawner be.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { cavesReflex } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import type { Reflex } from '../../src/reflexes/types'
import { caveCells } from '../../src/skills/caves'
import { entity, fakeBot, item, type FakeBotInput } from './fakeBot'

/** the bot's tunnel at z 0 from x -6 to 0 (y 20, 21: its cells dug), a cave of air from x 1 to 7 (y 19 to 23, z -3 to 3) */
const caveWorld = (p: Vec3): string => {
  const tunnel = p.z === 0 && p.x >= -6 && p.x <= 0 && (p.y === 20 || p.y === 21)
  const cave = p.x >= 1 && p.x <= 7 && p.y >= 19 && p.y <= 23 && Math.abs(p.z) <= 3
  return tunnel || cave || p.y > 70 ? 'air' : 'stone'
}

const READY_KIT = (): Partial<FakeBotInput> => {
  const prot = [{ name: 'protection', lvl: 1 }]
  return {
    armor: { head: item('iron_helmet', 1, prot), torso: item('iron_chestplate', 1, prot), legs: item('iron_leggings'), feet: item('iron_boots') },
    items: [item('iron_sword', 1, [{ name: 'sharpness', lvl: 1 }]), item('cooked_beef', 10), item('cobblestone', 32)]
  }
}

function check (reflex: Reflex, input: FakeBotInput): { detail: string | null, bot: any } {
  const bot = fakeBot({ world: caveWorld, ...input })
  bot.game.dimension = 'overworld'
  caveCells(bot)
  for (let x = -6; x <= 0; x++) for (const y of [20, 21]) bot.emit('diggingCompleted', { position: new Vec3(x, y, 0) })
  const engine = new ReflexEngine(bot, { enabled: false })
  const task = reflex.check(engine.context())
  engine.stop()
  return { detail: task == null ? null : (task.detail ?? task.name), bot }
}

test('caves reflex: the holes by the tunnel\'s end into a cave sealed; not with no block to seal with, in the cave itself, off the ground, or cave-ready', () => {
  const end = new Vec3(0.5, 20, 0.5)
  assert.strictEqual(check(cavesReflex, { position: end, items: [item('cobblestone', 16)] }).detail, 'seal 2 into a cave')
  assert.strictEqual(check(cavesReflex, { position: end, items: [] }).detail, null)
  assert.strictEqual(check(cavesReflex, { position: new Vec3(4.5, 20, 0.5), items: [item('cobblestone', 16)] }).detail, null)
  assert.strictEqual(check(cavesReflex, { position: end, items: [item('cobblestone', 16)], onGround: false }).detail, null)
  // further back down the tunnel: rock between
  assert.strictEqual(check(cavesReflex, { position: new Vec3(-3.5, 20, 0.5), items: [item('cobblestone', 16)] }).detail, null)
  assert.strictEqual(check(cavesReflex, { position: end, ...READY_KIT() }).detail, null)
})

test('caves reflex: its run puts a block in each hole; a hole it sealed that the work dug open again is let be a while', async () => {
  const filled = new Set<string>()
  const world = (p: Vec3): string => filled.has(`${p.x},${p.y},${p.z}`) ? 'cobblestone' : caveWorld(p)
  const bot = fakeBot({ world, position: new Vec3(0.5, 20, 0.5), items: [item('cobblestone', 16)] })
  bot.game.dimension = 'overworld'
  caveCells(bot)
  for (let x = -6; x <= 0; x++) for (const y of [20, 21]) bot.emit('diggingCompleted', { position: new Vec3(x, y, 0) })
  const mod = require('../../src/skills/placeBlock')
  const real = mod.placeBlock
  mod.placeBlock = async (_b: any, args: any) => {
    filled.add(`${args.pos.x},${args.pos.y},${args.pos.z}`)
    bot.emit('blockUpdate', { name: 'air', boundingBox: 'empty', position: args.pos }, { name: 'cobblestone', boundingBox: 'block', position: args.pos })
  }
  const engine = new ReflexEngine(bot, { enabled: false })
  try {
    const task = cavesReflex.check(engine.context())
    assert.ok(task != null)
    assert.strictEqual(await task.run(new AbortController().signal), 2)
    assert.deepEqual([...filled].sort(), ['1,20,0', '1,21,0'])
    // dug open again (the work's way into the cave): not sealed again within CAVE_RESEAL_TICKS
    for (const k of [...filled]) {
      filled.delete(k)
      const [x, y, z] = k.split(',').map(Number)
      bot.emit('diggingCompleted', { position: new Vec3(x, y, z) })
    }
    // the bot stepped into them: the cave's cells by it are holes, let be (before: sealed again each step through)
    bot.entity.position = new Vec3(1.5, 20, 0.5)
    ;(engine as any).tick += 20
    assert.strictEqual(cavesReflex.check(engine.context()), null)
    // CAVE_RESEAL_TICKS later they're sealed again
    ;(engine as any).tick += 2400
    assert.match(cavesReflex.check(engine.context())?.detail ?? '', /^seal \d into a cave$/)
  } finally {
    mod.placeBlock = real
    engine.stop()
  }
})

test('hostiles reflex: a bot not fit for the caves walls itself in in its tunnel against a zombie, at full health; fit for them, or in the cave, it fights', async () => {
  const { hostilesReflex } = await import('../../src/reflexes/rules')
  const zombie = (x: number): any => entity({ name: 'zombie', position: new Vec3(x, 20, 0.5) })
  const blocks = [item('stone_sword'), item('cobblestone', 16)]
  // in the tunnel at x -3, the zombie come along it from the cave's side
  assert.strictEqual(check(hostilesReflex, { position: new Vec3(-2.5, 20, 0.5), items: blocks, entities: [zombie(-0.5)] }).detail, 'wall in')
  // walled in there a moment ago and dug out: fought
  const { bot } = check(hostilesReflex, { position: new Vec3(-4.5, 20, 0.5), items: blocks, entities: [zombie(-2.5)] })
  const engine = new ReflexEngine(bot, { enabled: false })
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight zombie')
  engine.stop()
  // with too few blocks for the box (a tunnel's two ends: 4)
  assert.strictEqual(check(hostilesReflex, { position: new Vec3(-2.5, 20, 0.5), items: [item('stone_sword'), item('cobblestone', 3)], entities: [zombie(-0.5)] }).detail, 'fight zombie')
  // cave-ready: fought as ever
  const kit = READY_KIT()
  assert.strictEqual(check(hostilesReflex, { position: new Vec3(-2.5, 20, 0.5), ...kit, entities: [zombie(-0.5)] }).detail, 'fight zombie')
  // in the cave itself: no tunnel to wall in
  assert.strictEqual(check(hostilesReflex, { position: new Vec3(4.5, 20, 0.5), items: blocks, entities: [zombie(6.5)] }).detail, 'fight zombie')
})
