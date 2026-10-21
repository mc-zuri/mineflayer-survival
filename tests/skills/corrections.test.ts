// The server's corrections of the bot's position over and over at one spot (skills/corrections): a bot in the web
// client was teleported back 25 to 82 times every 100 ticks, its ForwardDropDown to (10.5, 44, -15.5) stuck at
// (11.3, 45, -15.45), a block the server had there that the client had as air.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { CORRECTION_LIMIT, CORRECTION_WINDOW, SUSPECT_COST, SUSPECT_TICKS, cellsToward, guardCorrections, suspectCell } from '../../src/skills/corrections'
import { fakeBot } from '../reflexes/fakeBot'

function stuckBot (): { bot: any, resets: () => number, cleared: () => number, settings: () => any } {
  const bot = fakeBot({ position: new Vec3(11.3, 45, -15.45) })
  let resets = 0
  let cleared = 0
  let settings: any = { exclusionAreasStep: [] }
  bot.pathfinder = {
    isPathing: true,
    currentMove: { x: 10.5, y: 44, z: -15.5 },
    world: { clearCache: () => { cleared++ } },
    reset: async () => { resets++ },
    get defaultMoveSettings () { return settings },
    setMoveOptions: (s: any) => { settings = s }
  }
  guardCorrections(bot)
  return { bot, resets: () => resets, cleared: () => cleared, settings: () => settings }
}

test('the cells toward the move\'s end: feet and head from the lower to the higher, not the bot\'s own column', () => {
  const cells = cellsToward(new Vec3(11.3, 45, -15.45), new Vec3(10.5, 44, -15.5)).map(c => c.toString()).sort()
  assert.deepStrictEqual(cells, ['(10, 44, -16)', '(10, 45, -16)', '(10, 46, -16)'])
})

test(`more than CORRECTION_LIMIT corrections at one spot in CORRECTION_WINDOW ticks: the move stopped and planned again, the pathfinder's cache dropped, the cells toward its end kept off for SUSPECT_TICKS`, () => {
  const t = stuckBot()
  for (let i = 0; i < CORRECTION_LIMIT; i++) { t.bot.emit('forcedMove'); t.bot.emit('physicsTick') }
  assert.strictEqual(t.resets(), 0)
  t.bot.emit('forcedMove')
  assert.strictEqual(t.resets(), 1)
  assert.strictEqual(t.cleared(), 1)
  assert.strictEqual(suspectCell(t.bot, new Vec3(10, 44, -16)), true)
  const step = t.settings().exclusionAreasStep.find((f: any) => f.survivalCorrections === true)
  assert.strictEqual(step({ position: new Vec3(10, 45, -16) }), SUSPECT_COST)
  assert.strictEqual(step({ position: new Vec3(12, 45, -16) }), 0)
  // once a window at most
  t.bot.emit('forcedMove')
  assert.strictEqual(t.resets(), 1)
  for (let i = 0; i <= SUSPECT_TICKS; i++) t.bot.emit('physicsTick')
  assert.strictEqual(suspectCell(t.bot, new Vec3(10, 44, -16)), false)
})

test('corrections spread over time, or each at another spot (a walk teleported along), are no stuck move', () => {
  const slow = stuckBot()
  for (let i = 0; i < 3 * CORRECTION_LIMIT; i++) {
    slow.bot.emit('forcedMove')
    for (let j = 0; j < CORRECTION_WINDOW / CORRECTION_LIMIT + 1; j++) slow.bot.emit('physicsTick')
  }
  assert.strictEqual(slow.resets(), 0)
  const moving = stuckBot()
  for (let i = 0; i < 3 * CORRECTION_LIMIT; i++) {
    moving.bot.entity.position = new Vec3(11.3 + 3 * i, 45, -15.45)
    moving.bot.emit('forcedMove')
  }
  assert.strictEqual(moving.resets(), 0)
})
