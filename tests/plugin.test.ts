import { test } from 'node:test'
import assert from 'node:assert'
import { createPlugin } from '../src'

test('createPlugin sets bot.survival with the default options', () => {
  const bot: any = { pathfinder: {}, loadPlugin () { throw new Error('pathfinder already loaded') } }
  createPlugin()(bot)
  assert.deepStrictEqual(bot.survival.options, { loadPathfinder: true })
})
