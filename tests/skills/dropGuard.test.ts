import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { capDropsByHealth, dropForHealth, LOW_HEALTH_EDGE_COST, movesForHealth, PARKOUR_MOVES } from '../../src/skills/dropGuard'

test('dropForHealth: 3 blocks down from 3 health up, 2 at 2, 1 at 1 (a fall past 3 hurts, a jump\'s rise counted)', () => {
  assert.equal(dropForHealth(20), 3)
  assert.equal(dropForHealth(3), 3)
  assert.equal(dropForHealth(2), 2)
  assert.equal(dropForHealth(1), 1)
  assert.equal(dropForHealth(0.5), 1)
})

test('capDropsByHealth: the pathfinder\'s maxDropDown held to the health, a setting put back keeps the drop asked for, and it comes back with the health (full-26.3-fresh-d: a 4-block drop at 1 health)', () => {
  const bot: any = new EventEmitter()
  bot.health = 20
  const pf: any = { defaultMoveSettings: { maxDropDown: 3 }, setMoveOptions (s: any) { this.defaultMoveSettings = s } }
  bot.pathfinder = pf
  capDropsByHealth(bot)
  assert.equal(pf.defaultMoveSettings.maxDropDown, 3)
  bot.health = 1
  bot.emit('health')
  assert.equal(pf.defaultMoveSettings.maxDropDown, 1)
  // a skill's settings saved and put back (onTheSurface's way)
  const before = { ...pf.defaultMoveSettings }
  pf.setMoveOptions({ ...before, infiniteLiquidDropdownDistance: false })
  assert.equal(pf.defaultMoveSettings.maxDropDown, 1)
  bot.health = 20
  bot.emit('health')
  assert.equal(pf.defaultMoveSettings.maxDropDown, 3)
  pf.setMoveOptions(before)
  assert.equal(pf.defaultMoveSettings.maxDropDown, 3)
})

test('movesForHealth: at 4 health and under, the edges and jumps by a deadly drop dear and no sprint jumps', () => {
  assert.deepEqual(movesForHealth(20, { maxDropDown: 3, edgeHazardCost: 4, hazardJumpCost: 20, allowJumpSprint: true }), { maxDropDown: 3, edgeHazardCost: 4, hazardJumpCost: 20, allowJumpSprint: true })
  const low = movesForHealth(3, { maxDropDown: 3, edgeHazardCost: 4, hazardJumpCost: 20, allowJumpSprint: true })
  assert.equal(low.edgeHazardCost, LOW_HEALTH_EDGE_COST)
  assert.ok(low.hazardJumpCost > 20)
  assert.equal(low.allowJumpSprint, false)
  // the nether's dearer edges stay dearer still
  assert.equal(movesForHealth(2, { edgeHazardCost: 100 }).edgeHazardCost, 100)
})

test("capDropsByHealth: the parkour moves out at low health and back with the health (full-26.3-s31337-f: a slide off a ledge after a parkour given up, at 2 health), a skill's own edge cost kept", () => {
  const bot: any = new EventEmitter()
  bot.health = 20
  const execs = new Map<unknown, any>(PARKOUR_MOVES.map(p => [p, { settings: null }]))
  const other = { settings: null }
  execs.set('Forward', other)
  const pf: any = {
    defaultMoveSettings: { maxDropDown: 3, edgeHazardCost: 4, hazardJumpCost: 20, allowJumpSprint: true },
    movements: execs,
    setMoveOptions (s: any) { this.defaultMoveSettings = s; for (const [, e] of this.movements) e.settings = s },
    dropMovment (p: unknown) { this.movements.delete(p) },
    setExecutor (p: unknown, e: any) { this.movements.set(p, e) }
  }
  bot.pathfinder = pf
  capDropsByHealth(bot)
  assert.equal(pf.movements.size, 3)
  bot.health = 3
  bot.emit('health')
  assert.equal(pf.movements.size, 1)
  assert.equal(pf.defaultMoveSettings.edgeHazardCost, LOW_HEALTH_EDGE_COST)
  assert.equal(pf.defaultMoveSettings.allowJumpSprint, false)
  // the nether's settings laid over the held ones: its edge cost is what it asks
  const before = { ...pf.defaultMoveSettings }
  pf.setMoveOptions({ ...before, edgeHazardCost: 6 })
  assert.equal(pf.defaultMoveSettings.edgeHazardCost, LOW_HEALTH_EDGE_COST)
  bot.health = 20
  bot.emit('health')
  assert.equal(pf.movements.size, 3)
  assert.equal(pf.defaultMoveSettings.edgeHazardCost, 6)
  assert.equal(pf.defaultMoveSettings.allowJumpSprint, true)
  for (const p of PARKOUR_MOVES) assert.equal(pf.movements.get(p).settings, pf.defaultMoveSettings)
  pf.setMoveOptions(before)
  assert.equal(pf.defaultMoveSettings.edgeHazardCost, 4)
})
