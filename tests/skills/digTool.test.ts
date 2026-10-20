// The stone dug with a stone pickaxe, the iron one saved for the ores that need it (diamond, redstone, gold, emerald):
// in rt-1 and grim-2 (1.21.11) the iron pickaxe dug the staircase down to the diamonds' level and broke on the way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIGGING_PICKAXE, diggingTool, saveBetterPickaxes, wantsDiggingPickaxe } from '../../src/skills/digTool'
import { spareToolsKeep } from '../../src/executor/keep'
import { fakeBot, item } from '../reflexes/fakeBot'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')
// (mineflayer's prismarine-block: the blocks' digTime the pathfinder's choice goes by)
const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))('1.21.11')
const { PathingUtil } = require('@nxg-org/mineflayer-pathfinder/dist/PathingUtil')

const block = (name: string): any => Block.fromStateId(registry.blocksByName[name].defaultState, 0)
const STONE_ID = registry.itemsByName.stone_pickaxe.id

function worn (name: string, used: number): any {
  const it = item(name)
  it.durabilityUsed = used
  return it
}

test('diggingTool: the iron pickaxe gives way to a stone one where the stone one harvests the block, the most worn first; not for the ores that need iron, nor a diamond pickaxe', () => {
  const iron = item('iron_pickaxe')
  const fresh = item('stone_pickaxe')
  const old = worn('stone_pickaxe', 100)
  const items = [iron, fresh, old]
  for (const name of ['stone', 'deepslate', 'cobblestone', 'iron_ore', 'deepslate_coal_ore', 'lapis_ore', 'tuff']) {
    assert.equal(diggingTool(block(name), iron, items, STONE_ID), old, name)
  }
  for (const name of ['deepslate_diamond_ore', 'diamond_ore', 'redstone_ore', 'gold_ore', 'emerald_ore', 'obsidian']) {
    assert.equal(diggingTool(block(name), iron, items, STONE_ID), iron, name)
  }
  // a diamond pickaxe (it lasts) or another tool chosen: as chosen
  const diamond = item('diamond_pickaxe')
  assert.equal(diggingTool(block('stone'), diamond, [diamond, fresh], STONE_ID), diamond)
  const shovel = item('iron_shovel')
  assert.equal(diggingTool(block('dirt'), shovel, [shovel, fresh], STONE_ID), shovel)
  // no stone one, or a broken one: the iron
  assert.equal(diggingTool(block('stone'), iron, [iron], STONE_ID), iron)
  assert.equal(diggingTool(block('stone'), iron, [iron, worn('stone_pickaxe', 131)], STONE_ID), iron)
})

test('saveBetterPickaxes: the pathfinder\'s tool choice (PathingUtil) digs stone with the stone pickaxe and the diamond ore with the iron one; a reflex digs with the fastest', () => {
  const iron = item('iron_pickaxe')
  const stone = item('stone_pickaxe')
  const bot = fakeBot({ items: [iron, stone, item('cobblestone', 64)] })
  bot.entity.effects = {}
  bot.pathingUtil = new PathingUtil(bot)
  // the pathfinder's own: the fastest, iron
  assert.equal(bot.pathingUtil.bestHarvestingTool(block('deepslate'))?.name, 'iron_pickaxe')
  let priority = 0
  bot.survival = { tasks: { get current () { return { priority } } } }
  saveBetterPickaxes(bot)
  saveBetterPickaxes(bot)
  bot.pathingUtil.refresh()
  assert.equal(bot.pathingUtil.bestHarvestingTool(block('deepslate'))?.name, 'stone_pickaxe')
  assert.equal(bot.pathingUtil.currentHarvestingTool(block('stone'))?.name, 'stone_pickaxe')
  assert.equal(bot.pathingUtil.bestHarvestingTool(block('deepslate_diamond_ore'))?.name, 'iron_pickaxe')
  assert.equal(bot.pathingUtil.currentHarvestingTool(block('redstone_ore'))?.name, 'iron_pickaxe')
  // (the slot's item, as the dig equips it)
  assert.equal(bot.pathingUtil.bestHarvestingTool(block('stone')), stone)
  // a reflex's dig (out of lava, up out of the water): the fastest
  priority = 5
  assert.equal(bot.pathingUtil.currentHarvestingTool(block('stone'))?.name, 'iron_pickaxe')
})

test('wantsDiggingPickaxe: an iron pickaxe the best carried and no stone one with uses left', () => {
  assert.equal(wantsDiggingPickaxe([item('iron_pickaxe')]), true)
  assert.equal(wantsDiggingPickaxe([item('iron_pickaxe'), item('stone_pickaxe')]), false)
  assert.equal(wantsDiggingPickaxe([item('iron_pickaxe'), worn('stone_pickaxe', 131)]), true)
  // a diamond one digs everything (it lasts): no stone one wanted
  assert.equal(wantsDiggingPickaxe([item('iron_pickaxe'), item('diamond_pickaxe')]), false)
  assert.equal(wantsDiggingPickaxe([item('stone_pickaxe')]), false)
  assert.equal(wantsDiggingPickaxe([]), false)
})

test('pickaxeKeeper: with the iron pickaxe the best carried and no stone one, a stone one made before the step (only stone), tried again 64 steps on after a failure', async () => {
  const { pickaxeKeeper, DIGGING_PICKAXE_RETRY_STEPS } = await import('../../src/executor/explore')
  const bag: string[] = ['iron_pickaxe', 'cobblestone', 'crafting_table']
  const bot: any = { inventory: { items: () => bag.map(name => ({ name })) } }
  const tried: string[] = []
  let canMake = false
  const craft = async (_b: unknown, args: { item: string }): Promise<void> => {
    tried.push(args.item)
    if (!canMake) throw new Error('no sticks')
    bag.push(args.item)
  }
  const keep = pickaxeKeeper(bot, craft)
  await keep()
  assert.deepEqual(tried, [DIGGING_PICKAXE])
  for (let i = 1; i < DIGGING_PICKAXE_RETRY_STEPS; i++) await keep()
  assert.equal(tried.length, 1)
  canMake = true
  await keep()
  assert.deepEqual(tried, [DIGGING_PICKAXE, DIGGING_PICKAXE])
  for (let i = 0; i < 100; i++) await keep()
  assert.equal(tried.length, 2)
  // a diamond one carried: none
  const diamondBag = ['diamond_pickaxe', 'iron_pickaxe']
  const other = pickaxeKeeper({ inventory: { items: () => diamondBag.map(name => ({ name })) } } as any, craft)
  await other()
  assert.equal(tried.length, 2)
})

test('spareToolsKeep: a trip\'s two iron pickaxes and a stone one to dig with; a third iron or a wooden one stored', () => {
  const keep = spareToolsKeep([{ name: 'iron_pickaxe', count: 3 }, { name: 'stone_pickaxe', count: 2 }, { name: 'wooden_pickaxe', count: 1 }])
  assert.equal(keep('iron_pickaxe'), 2)
  assert.equal(keep('stone_pickaxe'), 1)
  assert.equal(keep('wooden_pickaxe'), 0)
  // a diamond one and an iron one: the stone one stored as before
  const diamond = spareToolsKeep([{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 1 }])
  assert.equal(diamond('stone_pickaxe'), 0)
})
