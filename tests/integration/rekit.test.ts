// A bare bot by a base it can't get into (f9-1.21.11, t313911 to t411859: back from a creeper's death with nothing,
// the base's door over a hole the pathfinder had dug its step into, every search for the chest timing out; then every
// re-equip planned 'loot ... at -552 76 40' again and failed, and the bot went 100000 ticks bare till a zombie killed
// it), as lockstep scenarios on a SURVIVAL_VERSION (default 1.21.11) superflat world (the tests/harness server, by
// day, no mobs), each run on fresh ground 64 blocks along from the last:
// - the base: a hut of cobblestone 9 across on a floor a block over the ground (its door on the west wall, a chest with
//   a kit in it in the middle, out of reach through the walls and the bedrock under it: a stone sword, a stone
//   pickaxe, an iron chestplate; a crafting table), the memory's base with its entrance, box, table and chest, its
//   shell kept from the pathfinder's breaks as a built base's is (protectBase);
// - an oak tree 8 blocks off and a patch of stone 6 blocks off;
// - the bot bare, 6 blocks from the door.
// 'the step dug': the dirt step before the door and the ground under it dug out, the bot with 4 dirt: the kit taken
// (the step put back). 'the way in shut': the doorway walled up: the base's kit out of reach, a stone pickaxe and a
// stone sword made from the world (the tree and the stone), the chest not planned again after its failure.
// REKIT_VERBOSE=1 logs the runner's lines.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { Runner } from '../../src/runner'
import { protectBase } from '../../src/base/build'
import { countItems } from '../../src/skills/util'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USER = 'rekitbot'
const VERBOSE = process.env.REKIT_VERBOSE != null
// the superflat's ground: grass at y -61, the bot standing at -60
const GROUND = -60
/** ticks a scenario gets at most */
const SCENARIO_TICKS = 30000

let server: TestServer
let bot: Bot
let runs = 0

async function run (cmd: string): Promise<string[]> {
  return await server.command(cmd)
}

async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

interface Scenario { x0: number, runner: Runner, lines: string[] }

/** the hut at x0 (x0..x0+4 by -2..2, its floor at GROUND, 3 high inside), the tree, the stone, the bot bare by it */
async function scenario (opts: { stepDug: boolean, doorShut: boolean, dirt: number }): Promise<Scenario> {
  const x0 = 64 * runs++
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  for (const cmd of ['gamerule advance_time false', 'time set 1000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`]) await run(cmd)
  await run(`tp ${USER} ${x0 - 6 + 0.5} ${GROUND} 0.5`)
  await waitFor(() => Math.abs(bot.entity.position.x - (x0 - 6 + 0.5)) < 1, 100)
  await bot.waitForChunksToLoad()
  await run(`fill ${x0 - 16} ${GROUND} -16 ${x0 + 24} ${GROUND + 8} 16 minecraft:air`)
  await run(`fill ${x0 - 16} ${GROUND - 3} -16 ${x0 + 20} ${GROUND - 2} 16 minecraft:dirt`)
  await run(`fill ${x0 - 16} ${GROUND - 1} -16 ${x0 + 20} ${GROUND - 1} 16 minecraft:grass_block`)
  // the hut, its floor a block over the ground, its door in the west wall over a dirt step, 9 across: its chest in the
  // middle out of reach through its walls (a chest's use is the server's by distance alone)
  await run(`fill ${x0} ${GROUND} -4 ${x0 + 8} ${GROUND + 4} 4 minecraft:cobblestone hollow`)
  // (and bedrock under it: no reach to the chest from a hole dug under its floor)
  await run(`fill ${x0} ${GROUND - 4} -4 ${x0 + 8} ${GROUND - 1} 4 minecraft:bedrock`)
  if (opts.doorShut) {
    await run(`fill ${x0} ${GROUND + 1} 0 ${x0} ${GROUND + 2} 0 minecraft:cobblestone`)
  } else {
    await run(`setblock ${x0} ${GROUND + 1} 0 minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]`)
    await run(`setblock ${x0} ${GROUND + 2} 0 minecraft:oak_door[facing=east,half=upper,hinge=left,open=false]`)
  }
  await run(`setblock ${x0 - 1} ${GROUND} 0 minecraft:dirt`)
  // the step and the ground under it dug out: a hole 2 deep before the door
  if (opts.stepDug) await run(`fill ${x0 - 1} ${GROUND - 1} 0 ${x0 - 1} ${GROUND} 0 minecraft:air`)
  await run(`setblock ${x0 + 4} ${GROUND + 1} 0 minecraft:chest[facing=west]{Items:[{Slot:0b,id:"minecraft:stone_sword",count:1},{Slot:1b,id:"minecraft:stone_pickaxe",count:1},{Slot:2b,id:"minecraft:iron_chestplate",count:1},{Slot:3b,id:"minecraft:cobblestone",count:32}]}`)
  await run(`setblock ${x0 + 4} ${GROUND + 1} 2 minecraft:crafting_table`)
  await run(`setblock ${x0 + 1} ${GROUND + 3} -3 minecraft:wall_torch[facing=south]`)
  // an oak tree 8 north of the hut, and a patch of stone 6 south of the bot
  await run(`fill ${x0 - 4} ${GROUND} -8 ${x0 - 4} ${GROUND + 4} -8 minecraft:oak_log`)
  await run(`fill ${x0 - 6} ${GROUND + 3} -10 ${x0 - 2} ${GROUND + 4} -6 minecraft:oak_leaves[persistent=true] keep`)
  await run(`fill ${x0 - 8} ${GROUND - 3} 5 ${x0 - 5} ${GROUND - 1} 7 minecraft:stone`)
  if (opts.dirt > 0) await run(`give ${USER} dirt ${opts.dirt}`)
  await waitFor(() => countItems(bot, 'dirt') >= opts.dirt, 100)
  // the runner, its memory's base (the hut's entrance, box, table and chest), past the wood and the stone
  const lines: string[] = []
  const runner = new Runner(bot, { log: l => { lines.push(l); if (VERBOSE) console.log(`[rekit] ${l}`) } })
  for (const id of ['wood', 'stone', 'food', 'base'] as const) runner.reached.push({ id, title: '', tick: 0, wallMs: 0 })
  const memory = runner.memory
  memory.base = null
  ;(memory as any).pois = (memory as any).pois.filter((p: any) => !String(p.kind).startsWith('base_'))
  for (const c of memory.knownChests()) memory.forgetChest(c)
  memory.death = null
  memory.setBase({ x: x0 + 4, y: GROUND + 1, z: 0 })
  memory.addPoi('base_entrance', { x: x0 - 1, y: GROUND + 1, z: 0 })
  memory.addPoi('base_bounds', { x: x0, y: GROUND, z: -4 }, 'overworld', `${x0 + 9},${GROUND + 5},5`)
  memory.addPoi('base_crafting_table', { x: x0 + 4, y: GROUND + 1, z: 2 })
  memory.rememberChest({ x: x0 + 4, y: GROUND + 1, z: 0 }, { stone_sword: 1, stone_pickaxe: 1, iron_chestplate: 1, cobblestone: 32 })
  // the shell kept from the pathfinder's breaks, as a built base's is
  const dig: Array<{ x: number, y: number, z: number }> = []
  for (let x = x0 + 1; x <= x0 + 7; x++) for (let y = GROUND + 1; y <= GROUND + 3; y++) for (let z = -3; z <= 3; z++) dig.push({ x, y, z })
  // (the doorway the room's, its door, the chest and the table the blueprint's own blocks; a walled-up doorway the shell)
  if (!opts.doorShut) dig.push({ x: x0, y: GROUND + 1, z: 0 }, { x: x0, y: GROUND + 2, z: 0 })
  const placements = [
    { pos: { x: x0, y: GROUND + 1, z: 0 }, block: 'oak_door' }, { pos: { x: x0, y: GROUND + 2, z: 0 }, block: 'oak_door' },
    { pos: { x: x0 + 4, y: GROUND + 1, z: 0 }, block: 'chest' }, { pos: { x: x0 + 4, y: GROUND + 1, z: 2 }, block: 'crafting_table' }
  ]
  protectBase(bot, { bounds: { min: { x: x0, y: GROUND, z: -4 }, max: { x: x0 + 9, y: GROUND + 5, z: 5 } }, dig, placements } as any)
  return { x0, runner, lines }
}

/** fn within `ticks`, called off once `until` holds */
async function withTicks<T> (ticks: number, fn: (signal: AbortSignal) => Promise<T>, until?: () => boolean): Promise<{ result: T | null, ticks: number, error: Error | null }> {
  const ctrl = new AbortController()
  let n = 0
  const onTick = (): void => {
    if (++n >= ticks) ctrl.abort(new Error('out of ticks'))
    else if (until?.() === true) ctrl.abort(new Error('done'))
  }
  bot.on('physicsTick', onTick)
  try {
    return { result: await fn(ctrl.signal), ticks: n, error: null }
  } catch (err) {
    return { result: null, ticks: n, error: err as Error }
  } finally {
    bot.off('physicsTick', onTick)
  }
}

const has = (name: string): boolean => [5, 6, 7, 8].some(s => bot.inventory.slots[s]?.name === name) || countItems(bot, name) > 0

describe(`a bare bot by a base it can't get into on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'rekit',
      difficulty: 'peaceful',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false },
      startTimeoutMs: 10 * 60 * 1000
    })
    bot = await connectLockstepBot(server, { username: USER, timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({}))
    bot.survival.reflexes!.enabled = false
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('the step before the door dug out, the bot with 4 dirt: the kit taken from the chest', async () => {
    const { runner, lines } = await scenario({ stepDug: true, doorShut: false, dirt: 4 })
    const out = await withTicks(SCENARIO_TICKS, async (s) => await runner.rekit(s))
    console.log(`[rekit] the step dug: ${JSON.stringify(out.result)} in ${out.ticks} ticks${out.error != null ? `, ${out.error.message}` : ''}`)
    assert.ok(has('stone_sword') && has('stone_pickaxe'), lines.join('\n'))
  })

  test('the way in shut: the kit out of reach, a stone pickaxe and a stone sword made from the world', async () => {
    const { runner, lines } = await scenario({ stepDug: false, doorShut: true, dirt: 0 })
    // (the re-equip called off once the two are made: its iron after them is none of the scenario's)
    const out = await withTicks(SCENARIO_TICKS, async (s) => { await runner.rekit(s); await runner.reequip(s) }, () => has('stone_pickaxe') && has('stone_sword'))
    console.log(`[rekit] the way in shut: ${out.ticks} ticks${out.error != null ? `, ${out.error.message}` : ''}`)
    for (const l of lines.filter(l => /plan \d|kit|re-equipping|step failed/.test(l))) console.log(`[rekit]   ${l}`)
    assert.ok(has('stone_pickaxe'), lines.join('\n'))
    assert.ok(has('stone_sword'), lines.join('\n'))
    // the chest planned once at most for each: not again after its failure
    const loots = lines.filter(l => /^plan \d+: .*loot \d+ \w+ at /.test(l))
    assert.ok(loots.length <= 2, loots.join('\n'))
  })
})
