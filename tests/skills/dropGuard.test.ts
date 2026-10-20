import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { capDropsByHealth, dropForHealth } from '../../src/skills/dropGuard'

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
