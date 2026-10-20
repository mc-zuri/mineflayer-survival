import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { WAY_KEPT, WAY_STEP, extendWay, followWay, keepWayDown, wayDown, wayLength } from '../../src/skills/wayDown'
import { dropsDear } from '../../src/executor/keep'
import { fakeBot } from '../reflexes/fakeBot'

test('extendWay: under the open sky the way starts again; down, a point every WAY_STEP blocks; lost past WAY_KEPT', () => {
  const state = { points: [] as any[], lost: true }
  extendWay(state, { x: 0.5, y: 64, z: 0.5 }, true)
  assert.deepEqual(state, { points: [{ x: 0, y: 64, z: 0 }], lost: false })
  extendWay(state, { x: 1, y: 63, z: 0 }, false)
  assert.equal(state.points.length, 1)
  extendWay(state, { x: WAY_STEP, y: 62, z: 0 }, false)
  assert.equal(state.points.length, 2)
  // back out under the sky: again from there
  extendWay(state, { x: 40, y: 70, z: 0 }, true)
  assert.deepEqual(state.points, [{ x: 40, y: 70, z: 0 }])
  for (let k = 1; k <= WAY_KEPT + 1; k++) extendWay(state, { x: 40 + k * WAY_STEP, y: 60, z: 0 }, false)
  assert.equal(state.lost, true)
  assert.equal(wayLength([{ x: 3, y: 0, z: 4 }, { x: 3, y: 0, z: 10 }], { x: 0, y: 0, z: 0 }), 11)
})

test('keepWayDown: the way from the cave\'s mouth to the bot down a staircase, none before the bot has stood under the sky', () => {
  // a hill of stone over x >= 2 (its roof from y 66 up), the open sky west of it; the ground stepping down east of x 2
  const world = (p: Vec3): string => p.x >= 2 && p.y >= 66 && p.y < 80 ? 'stone' : p.y < 64 - Math.max(0, p.x - 2) ? 'stone' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world })
  bot.game.dimension = 'overworld'
  keepWayDown(bot)
  assert.equal(wayDown(bot), null)
  const tick = (n = 5): void => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  tick()
  for (let x = 1; x <= 12; x++) {
    bot.entity.position = new Vec3(x + 0.5, 64 - Math.max(0, x - 2), 0.5)
    tick()
  }
  const way = wayDown(bot) as any[]
  assert.ok(way != null)
  assert.deepEqual(way[0], { x: 1, y: 64, z: 0 })
  assert.deepEqual(way[way.length - 1], { x: 12, y: 54, z: 0 })
  assert.ok(way.length >= 4, JSON.stringify(way))
})

test('followWay: hop by hop, each to the farthest point within WAY_HOP of the bot', async () => {
  const nav = require('../../src/skills/navigate')
  const real = nav.navigate
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  const way = Array.from({ length: 10 }, (_, k) => ({ x: 3 * (k + 1), y: 64, z: 0 }))
  const hops: number[] = []
  try {
    nav.navigate = async (_b: any, opts: any) => {
      const g = opts.goal
      hops.push(g.x)
      bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5)
    }
    await followWay(bot, way)
  } finally {
    nav.navigate = real
  }
  assert.deepEqual(hops, [9, 18, 27, 30])
})

test('dropsDear: diamond and netherite gear, iron armor, the End\'s way\'s rare drops; not iron tools, cobblestone or food', () => {
  assert.equal(dropsDear(['cobblestone', 'diamond_sword']), true)
  assert.equal(dropsDear(['iron_chestplate']), true)
  assert.equal(dropsDear(['diamond']), true)
  assert.equal(dropsDear(['ender_pearl']), true)
  assert.equal(dropsDear(['iron_pickaxe', 'iron_sword', 'cobblestone', 'cooked_beef', 'torch', 'iron_ingot']), false)
})
