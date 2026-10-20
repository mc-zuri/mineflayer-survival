import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { WART_LEG, brewingBoxCells, wartLegs } from '../../src/nether/brewing'

test('wartLegs: WART_LEG out along each axis from where the bot came in, the ones leading away from the spawner first (seed 2: east and north of its throne at (-277, 77, -159))', () => {
  const from = new Vec3(-270.5, 61, -164.5)
  const legs = wartLegs(from, new Vec3(-277, 77, -159))
  assert.equal(legs.length, 4)
  assert.deepEqual(legs.slice(0, 2), [new Vec3(-271 + WART_LEG, 61, -165), new Vec3(-271, 61, -165 - WART_LEG)])
  assert.deepEqual(legs.slice(2).map(l => l.toString()).sort(), [new Vec3(-271, 61, -165 + WART_LEG), new Vec3(-271 - WART_LEG, 61, -165)].map(l => l.toString()).sort())
})

test('brewingBoxCells: on open ground the walls round the bot\'s cell and the stand\'s two high and the roof over both; the floor and a wall there already left out', () => {
  const feet = new Vec3(0, 64, 0)
  const floor = (p: Vec3): boolean => p.y < 64
  const open = brewingBoxCells(feet, new Vec3(1, 0, 0), floor)
  // 6 sides round the two cells, 2 high, and 2 of roof
  assert.equal(open.length, 14)
  assert.ok(open.some(p => p.equals(new Vec3(2, 64, 0))) && open.some(p => p.equals(new Vec3(-1, 65, 0))) && open.some(p => p.equals(new Vec3(1, 66, 0))))
  assert.ok(!open.some(p => p.equals(new Vec3(1, 64, 0)) || p.equals(new Vec3(0, 65, 0)) || p.y < 64))
  // a wall by the bot already, and a hole in the stand's floor filled
  const cells = brewingBoxCells(feet, new Vec3(1, 0, 0), p => (p.y < 64 && !p.equals(new Vec3(1, 63, 0))) || (p.x === 0 && p.z === -1))
  assert.ok(cells.some(p => p.equals(new Vec3(1, 63, 0))))
  assert.ok(!cells.some(p => p.equals(new Vec3(0, 64, -1)) || p.equals(new Vec3(0, 65, -1))))
  assert.equal(cells.length, 13)
})

test('blazeRodsWithBrew: with the wart and cream held, the rods a rod at a time till the stand\'s and the fuel\'s 2, then a box by where the bot came in and the brew, then the rest of the rods; with no wart, the fight alone', async () => {
  const { blazeRodsWithBrew, resetBrewTries } = await import('../../src/nether/brewing')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const fortress = require('../../src/nether/fortressSkills')
  const brewModule = require('../../src/skills/brew')
  const fight = require('../../src/nether/blazeFight')
  const travelModule = require('../../src/skills/travel')
  const craftModule = require('../../src/skills/craft')
  const real = { rods: fortress.collectBlazeRods, brew: brewModule.brew, fill: fight.fillNook, travel: travelModule.travel, craft: craftModule.craft }
  const water = (): any => { const p = item('potion'); p.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: 0, customEffects: [] } }]]); return p }
  const calls: string[] = []
  const give = (bot: any, it: any): void => { const slot = bot.inventory.slots.findIndex((s: any, i: number) => i >= 9 && i < 45 && s == null); it.slot = slot; bot.inventory.slots[slot] = it }
  const lines: string[] = []
  const run = async (items: any[], bow = true): Promise<string[]> => {
    calls.length = 0
    lines.length = 0
    const bot = fakeBot({ items: [...items, ...(bow ? [item('bow'), item('arrow', 32)] : [])], position: new Vec3(0.5, 64, 30.5) })
    bot.entity.effects = {}
    bot.pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
    resetBrewTries(bot)
    fortress.collectBlazeRods = async (_b: unknown, a: any) => {
      calls.push(`rods ${String(a.count)}`)
      const have = bot.inventory.items().filter((i: any) => i.name === 'blaze_rod').reduce((n: number, i: any) => n + i.count, 0)
      for (let n = have; n < a.count; n++) give(bot, item('blaze_rod'))
      return { rods: a.count, kills: 0, ticks: 0 }
    }
    // (the potions it makes in the bag, the effect on once one's drunk: the mock's drink puts it on)
    brewModule.brew = async () => {
      calls.push('brew')
      const { POTION_IDS } = require('../../src/skills/potion')
      const p = item('potion'); p.componentMap = new Map([['potion_contents', { type: 'potion_contents', data: { potionId: POTION_IDS.fire_resistance[0], customEffects: [] } }]])
      give(bot, p)
      return { potions: 3, potion: 11, stand: new Vec3(0, 0, 0), placedStand: true }
    }
    fight.fillNook = async () => { calls.push('box'); return 0 }
    travelModule.travel = async (_b: unknown, a: any) => { calls.push(`travel ${String(a.target)}`); return {} }
    craftModule.craft = async (_b: unknown, a: any) => { calls.push(`craft ${String(a.item)}`); give(bot, item(a.item)); return {} }
    try {
      await blazeRodsWithBrew(bot, { count: 8, spawner: new Vec3(0, 64, 0), away: new Vec3(0.5, 64, 30.5), log: (l: string) => lines.push(l) })
    } catch (err) {
      calls.push(`threw ${(err as Error).message}${(err as any).noFireResistance === true ? ' (noFireResistance)' : ''}`)
    } finally {
      fortress.collectBlazeRods = real.rods
      brewModule.brew = real.brew
      fight.fillNook = real.fill
      travelModule.travel = real.travel
      craftModule.craft = real.craft
    }
    return calls.slice()
  }
  assert.deepEqual(await run([water(), water(), water(), item('nether_wart'), item('magma_cream')]), ['rods 1', 'rods 2', 'craft blaze_powder', 'craft brewing_stand', 'box', 'brew', 'rods 8'])
  // no wart found (the legs walked): the fight as it was
  const noWart = await run([water(), item('magma_cream')])
  assert.deepEqual(noWart.filter(c => !c.startsWith('travel')), ['rods 8'])
  // a slime ball for the cream: a blaze powder made and the cream of them, then the stand
  assert.deepEqual(await run([water(), water(), water(), item('nether_wart'), item('slime_ball')]), ['rods 1', 'rods 2', 'craft blaze_powder', 'craft magma_cream', 'craft brewing_stand', 'box', 'brew', 'rods 8'])
  // no cream: no wart looked for, the fight as it was
  assert.deepEqual(await run([water(), water(), water()]), ['rods 8'])
  // no bottles: nothing looked for
  assert.deepEqual(await run([item('nether_wart'), item('magma_cream')]), ['rods 8'])
  assert.deepEqual(lines, ['fire resistance: no water bottles to brew it in'])
  // no cream and no bow: no fight with the sword alone (full-1.21.11-fresh-e), the decisions logged
  assert.deepEqual(await run([water(), water(), water()], false), ['threw MISSING_ITEMS: no bow and no fire resistance for the blazes (no magma cream or slime ball to brew it) (noFireResistance)'])
  assert.deepEqual(lines, ['fire resistance: no magma cream or slime ball: the cubes about looked for', 'fire resistance: no magma cream and no slime ball for it: no wart sought, no brew', 'fire resistance: not brewed, short of nether_wart, magma_cream, blaze rods', 'fire resistance: no bow and none of it: no fight'])
  // no bow, the makings held: the brew, then the rest with the potions
  assert.deepEqual(await run([water(), water(), water(), item('nether_wart'), item('magma_cream')], false), ['rods 1', 'rods 2', 'craft blaze_powder', 'craft brewing_stand', 'box', 'brew', 'rods 8'])
})

test('getBrewMakings: wart seen far in the chunks the bot has (WART_SIGHT 160: seed 2\'s room 126 off) is walked to and dug, no legs; then back where the bot came in, shut in to heal there when hurt (backToHeal)', async () => {
  const { getBrewMakings, resetBrewTries, WART_SIGHT } = await import('../../src/nether/brewing')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  assert.ok(WART_SIGHT >= 128)
  const fortress = require('../../src/nether/fortressSkills')
  const travelModule = require('../../src/skills/travel')
  const collectModule = require('../../src/skills/collectBlock')
  const real = { travel: travelModule.travel, collect: collectModule.collectBlock, heal: fortress.healSealed }
  const calls: string[] = []
  const from = new Vec3(0.5, 64, 30.5)
  const wart = new Vec3(100, 60, -50)
  const bot = fakeBot({ items: [item('magma_cream')], position: from.clone() })
  bot.pathfinder = { defaultMoveSettings: {}, setMoveOptions: () => {} }
  ;(bot as any).health = 12
  let asked = 0
  bot.findBlocks = (o: any) => { asked = Math.max(asked, o.maxDistance); return o.maxDistance >= wart.distanceTo(bot.entity.position) ? [wart] : [] }
  travelModule.travel = async (_b: unknown, a: any) => { calls.push(`travel ${String(a.target)}`); bot.entity.position = a.target.clone(); return {} }
  collectModule.collectBlock = async (_b: unknown, a: any) => { calls.push(`dig ${String(a.positions[0])}`); bot.inventory.slots[20] = item('nether_wart', 3); return { mined: 1 } }
  fortress.healSealed = async () => { calls.push(`heal at ${String(bot.entity.position)}`); return true }
  resetBrewTries(bot)
  try {
    assert.equal(await getBrewMakings(bot, from, new Vec3(0, 64, 0)), true)
  } finally {
    travelModule.travel = real.travel
    collectModule.collectBlock = real.collect
    fortress.healSealed = real.heal
  }
  assert.ok(asked >= 128, `${asked}`)
  assert.deepEqual(calls, [`travel ${wart.toString()}`, `dig ${wart.toString()}`, `travel ${from.toString()}`, `heal at ${from.toString()}`])
})

test('blazeRodsWithBrew: its opening line is said once a trip, not again at each restart after a reflex', async () => {
  const { blazeRodsWithBrew, resetBrewTries } = await import('../../src/nether/brewing')
  const { fakeBot, item } = await import('../reflexes/fakeBot')
  const fortress = require('../../src/nether/fortressSkills')
  const real = fortress.collectBlazeRods
  fortress.collectBlazeRods = async () => ({ rods: 0, kills: 0, ticks: 0 })
  const bot = fakeBot({ items: [item('bow'), item('arrow', 32)] })
  const lines: string[] = []
  resetBrewTries(bot)
  try {
    for (let i = 0; i < 3; i++) await blazeRodsWithBrew(bot, { count: 8, spawner: new Vec3(0, 64, 0), log: (l: string) => lines.push(l) })
    resetBrewTries(bot)
    await blazeRodsWithBrew(bot, { count: 8, spawner: new Vec3(0, 64, 0), log: (l: string) => lines.push(l) })
  } finally {
    fortress.collectBlazeRods = real
  }
  assert.deepEqual(lines, ['fire resistance: no water bottles to brew it in', 'fire resistance: no water bottles to brew it in'])
})
