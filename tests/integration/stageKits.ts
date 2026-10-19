// The stages' kits: what a run carries when it gets to a late stage of the game, given from the server's console to
// a bot on a fresh world (tests/integration/stages.test.ts, pnpm e2e --stage), and play's save with the milestones
// before the stage reached.
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import type { MilestoneEvent } from '../../src/runner'
import { MILESTONES, type MilestoneId } from '../../src/planner/progression'
import { countItems, waitUntil } from '../../src/skills/util'
import type { TestServer } from '../harness'

export type Kit = Array<[string, number]>

export interface Stage {
  /** the first milestone play works on: the ones before it are in the save as reached */
  from: MilestoneId
  /** play runs until this one is reached */
  until: MilestoneId
  /** what the bot carries at the start (given from the console; worn by the armor reflex) */
  kit: Kit
  /** experience levels at the start */
  levels?: number
}

// the gear of a run that enchanted it at a 15-shelf table and an anvil
const ENCHANTED_GEAR: Kit = [
  ['diamond_sword[enchantments={sharpness:3,unbreaking:3,looting:2}]', 1],
  ['diamond_pickaxe[enchantments={efficiency:4,unbreaking:3}]', 1],
  ['diamond_axe[enchantments={efficiency:2}]', 1],
  ['bow[enchantments={power:4,unbreaking:3}]', 1],
  ['diamond_helmet[enchantments={protection:3,unbreaking:2}]', 1],
  ['diamond_chestplate[enchantments={protection:3,unbreaking:2}]', 1],
  ['diamond_leggings[enchantments={protection:3,unbreaking:2}]', 1],
  ['diamond_boots[enchantments={protection:3,feather_falling:4}]', 1],
  ['shield', 1]
]

/** the stages, the last first */
export const STAGES: Record<string, Stage> = {
  // the eyes made: the stronghold found by their throws (from the spawn), the portal filled, the crystals and the dragon
  dragon: {
    from: 'eyes',
    until: 'end',
    kit: [
      ...ENCHANTED_GEAR,
      ['ender_eye', 16], ['arrow', 128], ['cobblestone', 128], ['cooked_beef', 48], ['bread', 16], ['golden_apple', 2],
      ['water_bucket', 1], ['bucket', 1], ['torch', 32], ['oak_log', 64], ['crafting_table', 1], ['iron_ingot', 16], ['coal', 16],
      ['flint_and_steel', 1], ['iron_pickaxe', 1]
    ]
  },
  // the epoch before: farming and enchanting. The diamond gear plain, the eyes made already (the nether's done), and
  // what a farm and a table are made from: cows from eggs bred with wheat for the books' leather, canes by water for
  // their paper, the table's diamonds and obsidian, lapis, iron for an anvil; then on to the dragon as above
  enchant: {
    from: 'enchanting',
    until: 'end',
    kit: [
      ['diamond_sword', 1], ['diamond_pickaxe', 1], ['diamond_axe', 1], ['bow', 1], ['shield', 1],
      ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['diamond_boots', 1],
      ['ender_eye', 16], ['arrow', 128], ['cobblestone', 128], ['cooked_beef', 48], ['bread', 16],
      ['water_bucket', 2], ['bucket', 1], ['sugar_cane', 128], ['cow_spawn_egg', 8], ['wheat', 64], ['wheat_seeds', 32],
      ['diamond', 3], ['obsidian', 4], ['lapis_lazuli', 32], ['iron_ingot', 40], ['torch', 32], ['oak_log', 64],
      ['crafting_table', 1], ['coal', 16], ['flint_and_steel', 1], ['iron_pickaxe', 1]
    ]
  }
}

/** play's save with the milestones before `from` reached (at made-up ticks) and an empty memory */
export function stageSave (from: MilestoneId): string {
  const before = MILESTONES.slice(0, MILESTONES.findIndex(m => m.id === from))
  const reached: MilestoneEvent[] = before.map((m, i) => ({ id: m.id, title: m.title, tick: i, wallMs: 0 }))
  return JSON.stringify({ version: 1, memory: { version: 1, blocks: [], chests: [], base: null, pois: [], death: null }, reached, ticks: before.length })
}


/** gives the stage's kit (and levels) from the console and waits for it to arrive */
export async function giveKit (server: TestServer, bot: Bot, username: string, stage: Stage): Promise<void> {
  for (const [item, count] of stage.kit) {
    const out = await server.command(`give ${username} ${item} ${count}`)
    assert.ok(out.some(l => /^Gave /.test(l)), `give ${item} ${count}: ${out.join(' | ')}`)
  }
  if (stage.levels != null) await server.command(`xp add ${username} ${stage.levels} levels`)
  const last = stage.kit[stage.kit.length - 1][0].replace(/\[.*$/, '')
  assert.ok(await waitUntil(bot, () => countItems(bot, last) > 0, 200), 'the kit never arrived')
}
