// The End skills against a real 1.21.11 server (the tests/harness lockstep server and bot): the 10 crystals destroyed,
// the dragon killed at full health and the exit portal opened, the credits and the respawn; and on a second server a
// portal frame built with /setblock completed with eyes and walked into, and a dragon with lowered health killed.
// Each test logs its wall time and the ticks it ran.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import { performance } from 'node:perf_hooks'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { parseSeed } from '../../src/worldgen/random'
import { exitPortal } from '../../src/end/spikes'
import { blockGetter, destroyCrystals, enterEnd, exitPortalOpen, fightDragon, findPortalY, isInEnd, leaveEnd } from '../../src/end/skills'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USER = 'survivor'
const SEED = 'endfight'
// the superflat's ground: grass at y -61, the bot standing at -60
const GROUND = -60

const KIT = [
  'give survivor netherite_sword[enchantments={sharpness:5}]',
  'give survivor bow[enchantments={power:5,infinity:1}]',
  'give survivor arrow 64',
  'give survivor cobblestone 128',
  'give survivor diamond_pickaxe',
  'give survivor cooked_beef 64',
  'give survivor golden_apple 8',
  'give survivor water_bucket',
  'item replace entity survivor armor.head with netherite_helmet[enchantments={protection:4}]',
  'item replace entity survivor armor.chest with netherite_chestplate[enchantments={protection:4}]',
  'item replace entity survivor armor.legs with netherite_leggings[enchantments={protection:4}]',
  'item replace entity survivor armor.feet with netherite_boots[enchantments={protection:4,feather_falling:4}]'
]

async function commands (server: TestServer, list: string[]): Promise<void> {
  for (const c of list) await server.command(c)
}

/** a clean inventory and full health */
async function reset (server: TestServer, bot: Bot): Promise<void> {
  bot.clearControlStates()
  bot.deactivateItem()
  await commands(server, [`clear ${USER}`, `effect clear ${USER}`, `effect give ${USER} minecraft:instant_health 1 10 true`, `effect give ${USER} minecraft:saturation 1 20 true`])
  await bot.waitForTicks(10)
}

/** onto the main island's ground near the podium */
async function toTheIsland (server: TestServer, bot: Bot): Promise<void> {
  await server.command(`execute in minecraft:the_end run spreadplayers 0 20 0 2 false ${USER}`)
  await waitFor(bot, () => isInEnd(bot) && bot.entity.onGround && bot.entity.position.distanceTo(new Vec3(0, bot.entity.position.y, 20)) < 4, 400)
  await bot.waitForChunksToLoad()
  await bot.waitForTicks(20)
}

async function waitFor (bot: Bot, predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

/** runs a skill and reports its wall time and the ticks it took */
async function timed<T> (t: { diagnostic: (m: string) => void }, bot: Bot, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const ticks0 = bot.lockstep.ticks
  try {
    return await fn()
  } finally {
    const ms = performance.now() - start
    const ticks = bot.lockstep.ticks - ticks0
    const line = `${name}: ${ticks} ticks in ${(ms / 1000).toFixed(1)} s (${(ticks / (ms / 1000)).toFixed(0)} ticks/s, ${(ticks / 20 / (ms / 1000)).toFixed(1)}x real time)`
    t.diagnostic(line)
    console.log(line)
  }
}

async function passes (server: TestServer, cmd: string): Promise<boolean> {
  const out = await server.command(cmd)
  return out.some(l => /^Test passed/.test(l))
}

async function dragonDeadAndAdvancement (server: TestServer, bot: Bot): Promise<void> {
  assert.ok(!await passes(server, 'execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon]'), 'the server still has a dragon')
  assert.ok(await passes(server, `execute if entity @a[name=${USER},advancements={minecraft:end/kill_dragon=true}]`), 'no free_the_end advancement')
  const portalY = findPortalY(blockGetter(bot))
  assert.ok(portalY != null)
  assert.ok(exitPortalOpen(blockGetter(bot), exitPortal(portalY)), 'the bot sees no exit portal')
  assert.ok(await passes(server, `execute in minecraft:the_end if block 1 ${portalY} 0 minecraft:end_portal`), 'the server has no end_portal in the exit portal')
}

describe('the End on 1.21.11: crystals, the dragon at full health, the exit', { timeout: 40 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  before(async () => {
    server = await startServer({ flat: true, seed: SEED, gamerules: { advance_time: false, advance_weather: false, spawn_mobs: false, spawn_monsters: false } })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    // the End skills look out for the dragon themselves; the reflexes stay off as in the combat scenarios
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('in the End with a bow, arrows, blocks, armor and a sword, the bot destroys all 10 crystals', async (t) => {
    await reset(server, bot)
    await commands(server, ['give survivor bow', 'give survivor arrow 64', 'give survivor cobblestone 128', 'give survivor diamond_sword', 'give survivor diamond_pickaxe', 'give survivor cooked_beef 32',
      'item replace entity survivor armor.head with diamond_helmet', 'item replace entity survivor armor.chest with diamond_chestplate',
      'item replace entity survivor armor.legs with diamond_leggings', 'item replace entity survivor armor.feet with diamond_boots'])
    await toTheIsland(server, bot)
    assert.strictEqual(Object.values(bot.entities).filter(e => e.name === 'end_crystal').length, 10)
    const result = await timed(t, bot, 'destroyCrystals', async () => await destroyCrystals(bot, { seed: parseSeed(SEED) }))
    assert.deepStrictEqual(result.remaining, [])
    assert.strictEqual(new Set(result.destroyed).size, 10)
    assert.ok(!await passes(server, 'execute in minecraft:the_end if entity @e[type=minecraft:end_crystal]'), 'the server still has crystals')
  })

  test('with a strong kit, the bot kills the dragon at full health: dead on the server, free_the_end given, the exit portal open', async (t) => {
    await reset(server, bot)
    await commands(server, KIT)
    await toTheIsland(server, bot)
    // full health, whatever the crystals' blasts and stray arrows did
    await server.command('execute in minecraft:the_end run data merge entity @e[type=minecraft:ender_dragon,limit=1] {Health:200f}')
    const health = await server.command('execute in minecraft:the_end run data get entity @e[type=minecraft:ender_dragon,limit=1] Health')
    assert.ok(health.some(l => /200\.0f/.test(l)), health.join(' | '))
    const result = await timed(t, bot, 'fightDragon (200 health)', async () => await fightDragon(bot, { seed: parseSeed(SEED) }))
    t.diagnostic(`${result.meleeHits} melee hits, ${result.arrows} arrows, ${result.perches} perches`)
    assert.ok(result.killed)
    await dragonDeadAndAdvancement(server, bot)
  })

  test('the bot leaves through the exit portal: the credits (win_game) and a respawn in the overworld', async (t) => {
    const result = await timed(t, bot, 'leaveEnd', async () => await leaveEnd(bot))
    assert.ok(result.credits, 'no win_game')
    assert.ok(!isInEnd(bot))
    assert.ok(await passes(server, `execute in minecraft:overworld if entity @a[name=${USER},distance=0..]`), 'the server has the bot elsewhere')
  })
})

describe('the End on 1.21.11: into the End through a frame of /setblock, a dragon with lowered health', { timeout: 30 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot

  before(async () => {
    server = await startServer({ flat: true, seed: SEED, gamerules: { advance_time: false, advance_weather: false, spawn_mobs: false, spawn_monsters: false } })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('a stronghold-like frame with 5 eyes missing: the bot puts them in and arrives in the End', async (t) => {
    await reset(server, bot)
    await server.command(`tp ${USER} 0.5 ${GROUND} 0.5`)
    // StrongholdPieces.PortalRoom's ring round the 3x3 at 6, 8: each side's frames facing into it
    const cx = 6
    const cz = 8
    const frames: Array<{ x: number, z: number, facing: string }> = []
    for (let t = -1; t <= 1; t++) {
      frames.push({ x: cx + t, z: cz - 2, facing: 'south' }, { x: cx + t, z: cz + 2, facing: 'north' }, { x: cx - 2, z: cz + t, facing: 'east' }, { x: cx + 2, z: cz + t, facing: 'west' })
    }
    const missing = new Set([0, 3, 5, 8, 10])
    for (const [i, f] of frames.entries()) {
      await server.command(`setblock ${f.x} ${GROUND} ${f.z} minecraft:end_portal_frame[facing=${f.facing},eye=${String(!missing.has(i))}]`)
    }
    await server.command(`give ${USER} ender_eye 8`)
    await bot.waitForTicks(10)
    const result = await timed(t, bot, 'enterEnd', async () => await enterEnd(bot))
    assert.strictEqual(result.eyesPlaced, 5)
    assert.ok(isInEnd(bot))
    assert.strictEqual(bot.inventory.items().filter(i => i.name === 'ender_eye').reduce((n, i) => n + i.count, 0), 3)
    assert.ok(await passes(server, `execute in minecraft:the_end if entity @a[name=${USER},distance=0..]`), 'the server has the bot elsewhere')
  })

  test('a dragon brought down to 40 health and no crystals: the bot kills it and leaves', async (t) => {
    await reset(server, bot)
    await commands(server, KIT)
    await toTheIsland(server, bot)
    await commands(server, ['execute in minecraft:the_end run kill @e[type=minecraft:end_crystal]',
      'execute in minecraft:the_end run data merge entity @e[type=minecraft:ender_dragon,limit=1] {Health:40f}'])
    await bot.waitForTicks(5)
    const result = await timed(t, bot, 'fightDragon (40 health)', async () => await fightDragon(bot, { seed: parseSeed(SEED) }))
    t.diagnostic(`${result.meleeHits} melee hits, ${result.arrows} arrows, ${result.perches} perches`)
    assert.ok(result.killed)
    await dragonDeadAndAdvancement(server, bot)
    const left = await timed(t, bot, 'leaveEnd', async () => await leaveEnd(bot))
    assert.ok(left.credits)
    assert.ok(!isInEnd(bot))
  })
})
