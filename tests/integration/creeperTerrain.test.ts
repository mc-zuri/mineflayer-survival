// A creeper at night against a real server (SURVIVAL_VERSION, default 1.21.11; the tests/harness lockstep server, a
// superflat world, normal difficulty, no natural spawning, the reflexes on), the bot busy with a task (a wait standing
// in for the work) when it comes. The ground is the ground the bot died on in a 1.21.11 lockstep game (ls3b-1.21.11,
// seed -3348798922721507200; tests/skills/fleeTerrain's, built where the superflat is, its grass at y -61):
// - 'trunk': by an oak's trunk at (157, 69..72, 321) under another oak's canopy low over z 322 on, the bot on its
//   pillar's top out of a cave at (159.5, 69, 321.8), in plain iron but the boots, a stone pickaxe in hand, an iron
//   sword and 64 cobblestone carried; a creeper from the north-east (t327032: blown up there, its run 76 ticks
//   jumping at the trunk);
// - 'hollow': in a hollow under an oak's leaves at y 66, at (27.7, 64, 203.3), an iron chestplate only, a diamond
//   pickaxe in hand, an iron sword and 64 cobblestone; two creepers from the west and the south (t439660);
// - 'open': open superflat ground, the 'trunk' kit, a creeper from the east;
// - 'nook': a nook of cobblestone a cell across, shut but for its east side, the bot in it with the 'trunk' kit (no
//   shield), a creeper 3.3 off at its open side: cornered, fought with the sword;
// - 'crowd': open ground, a creeper 3 off east, a husk with no AI a block west of the bot (mine-ai-mcp's
//   creeper-crowd-retreat): the run not into the husk;
// - 'nookBare': the nook with no sword (the stone pickaxe in hand, the cobblestone): cornered, its sight cut with the
//   blocks carried.
// Each run is a pass when the bot is alive 400 ticks on with the creepers gone (blown up, killed) or out of reach.
// CREEPER_RUNS=n repeats each (default 2); CREEPER_CASES picks some (trunk,hollow,open,nook,crowd,nookBare).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { isAlive } from '../../src/skills/combatUtil'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { LS3B_CREEPER_1, LS3B_CREEPER_2, type Grid } from '../skills/fleeTerrain'
import { NightLog, summary } from './nightLog'

const USER = 'creeperbot'
const RUNS = Number(process.env.CREEPER_RUNS ?? 2)
const CASES = (process.env.CREEPER_CASES ?? 'trunk,hollow,open,nook,crowd,nookBare').split(',')
// the superflat's grass
const GRASS = -61

let server: TestServer
let bot: Bot
let runs = 0

const BLOCKS: Record<string, string> = { C: 'cobblestone', '#': 'grass_block', W: 'oak_log', L: 'oak_leaves[persistent=true]', '.': 'air', '~': 'water' }

/** the air over x0..x1, z0..z1 from the grass up to y 120 (a 26.3 superflat's structures over it are a roof, the cave rule's): fills of 32768 blocks at most */
async function clearAbove (x0: number, z0: number, x1: number, z1: number): Promise<void> {
  const layers = Math.max(1, Math.floor(32768 / ((x1 - x0 + 1) * (z1 - z0 + 1))))
  for (let y = GRASS + 1; y <= 120; y += layers) await run(`fill ${x0} ${y} ${z0} ${x1} ${Math.min(120, y + layers - 1)} ${z1} minecraft:air`)
}

interface Case {
  name: string
  grid: Grid | null
  /** the grid's own cells changed (the bot's pillar and its digs) */
  extra?: Record<string, string>
  /** where the bot stands, and the creepers, in the grid's coordinates */
  bot: Vec3
  creepers: Vec3[]
  worn: Record<string, string>
  hand: string
  carried: Array<[string, number]>
  /** other mobs put about (in the grid's coordinates), their summon NBT */
  others?: Array<{ type: string, at: Vec3, nbt: string }>
}

/** a nook a cell across at (1, 1, 1), shut but for its east side ('C' cobblestone) */
const NOOK: Grid = {
  x0: 0,
  y0: 0,
  z0: 0,
  layers: [
    ['###', '###', '###'],
    ['CCC', 'C..', 'CCC'],
    ['CCC', 'C..', 'CCC'],
    ['CCC', 'CCC', 'CCC']
  ]
}

const TRUNK_KIT = { worn: { 'armor.head': 'iron_helmet', 'armor.chest': 'iron_chestplate', 'armor.legs': 'iron_leggings' }, hand: 'stone_pickaxe', carried: [['iron_sword', 1], ['cobblestone', 64], ['cooked_beef', 4]] as Array<[string, number]> }

const CASES_ALL: Case[] = [
  { name: 'trunk', grid: LS3B_CREEPER_1, extra: { '159,68,322': 'air', '159,67,322': 'cobblestone', '159,70,322': 'air' }, bot: new Vec3(159.5, 69, 321.8), creepers: [new Vec3(165.5, 69, 316.5)], ...TRUNK_KIT },
  { name: 'hollow', grid: LS3B_CREEPER_2, bot: new Vec3(27.7, 64, 203.3), creepers: [new Vec3(19.5, 64, 206.5), new Vec3(26.5, 64, 210.5)], worn: { 'armor.chest': 'iron_chestplate' }, hand: 'diamond_pickaxe', carried: [['iron_sword', 1], ['cobblestone', 64], ['cooked_beef', 4]] },
  { name: 'open', grid: null, bot: new Vec3(0.5, 0, 0.5), creepers: [new Vec3(8.5, 0, 0.5)], ...TRUNK_KIT },
  { name: 'nook', grid: NOOK, bot: new Vec3(1.5, 1, 1.5), creepers: [new Vec3(4.8, 1, 1.5)], ...TRUNK_KIT },
  // (after mine-ai-mcp's scenarios/flat/combat/creeper-crowd-retreat: a husk with no AI a block behind the bot, the
  // creeper 3 off in front: the run from it is not into the husk)
  { name: 'crowd', grid: null, bot: new Vec3(0.5, 0, 0.5), creepers: [new Vec3(3.5, 0, 0.5)], ...TRUNK_KIT, others: [{ type: 'husk', at: new Vec3(-0.5, 0, 0.5), nbt: '{NoAI:1b,PersistenceRequired:1b}' }] },
  { name: 'nookBare', grid: NOOK, bot: new Vec3(1.5, 1, 1.5), creepers: [new Vec3(4.8, 1, 1.5)], ...TRUNK_KIT, carried: [['cobblestone', 64], ['cooked_beef', 4]] }
]

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

/** the grid built at (ox, oz) with its ground on the superflat's grass: each row's runs of a block one fill */
async function build (grid: Grid, extra: Record<string, string>, ox: number, oz: number): Promise<(p: Vec3) => Vec3> {
  const dx = ox - grid.x0
  const dy = GRASS - grid.y0
  const dz = oz - grid.z0
  const to = (p: Vec3): Vec3 => new Vec3(p.x + dx, p.y + dy, p.z + dz)
  const width = grid.layers[0][0].length
  const depth = grid.layers[0].length
  // the air over it first, a margin round it
  await run(`fill ${ox - 4} ${GRASS + 1} ${oz - 4} ${ox + width + 3} ${GRASS + grid.layers.length + 2} ${oz + depth + 3} minecraft:air`)
  for (let ly = 0; ly < grid.layers.length; ly++) {
    for (let lz = 0; lz < depth; lz++) {
      const row = grid.layers[ly][lz]
      let start = 0
      for (let lx = 1; lx <= row.length; lx++) {
        if (lx < row.length && row[lx] === row[start]) continue
        const block = BLOCKS[row[start]] ?? 'stone'
        await run(`fill ${ox + start} ${GRASS + ly} ${oz + lz} ${ox + lx - 1} ${GRASS + ly} ${oz + lz} minecraft:${block}`)
        start = lx
      }
    }
  }
  for (const [k, name] of Object.entries(extra)) {
    const [x, y, z] = k.split(',').map(Number)
    const p = to(new Vec3(x, y, z))
    await run(`setblock ${p.x} ${p.y} ${p.z} minecraft:${name}`)
  }
  return to
}

async function fresh (c: Case): Promise<{ at: Vec3, creepers: Vec3[] }> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.survival.tasks.cancelAll('ABORTED', 'reset')
  if (bot.health <= 0) await waitFor(() => bot.health > 0, 200)
  const ox = 64 * runs++
  const oz = 0
  for (const cmd of ['time set 18000', 'kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, `forceload add ${ox - 16} -16 ${ox + 48} 48`,
    `fill ${ox - 8} ${GRASS + 1} ${oz - 8} ${ox + 40} ${GRASS + 10} ${oz + 40} minecraft:air`]) await run(cmd)
  await clearAbove(ox - 6, oz - 6, ox + 28, oz + 28)
  const to = c.grid != null ? await build(c.grid, c.extra ?? {}, ox, oz) : (p: Vec3) => new Vec3(p.x + ox + 8, GRASS + 1 + p.y, p.z + oz + 8)
  const at = to(c.bot)
  await run(`tp ${USER} ${at.x} ${at.y} ${at.z} 0 0`)
  await waitFor(() => bot.entity.position.distanceTo(at) < 0.5 && bot.inventory.items().length === 0, 200)
  await bot.waitForChunksToLoad()
  for (const [slot, item] of Object.entries(c.worn)) await run(`item replace entity ${USER} ${slot} with ${item}`)
  await run(`item replace entity ${USER} weapon.mainhand with ${c.hand}`)
  for (const [item, count] of c.carried) await run(`give ${USER} ${item} ${count}`)
  await run(`effect give ${USER} minecraft:instant_health 1 10 true`)
  await run(`effect give ${USER} minecraft:saturation 1 20 true`)
  await waitFor(() => bot.inventory.items().some(i => i.name === 'cooked_beef'), 200)
  await bot.waitForTicks(10)
  for (const o of c.others ?? []) {
    const p = to(o.at)
    await run(`summon minecraft:${o.type} ${p.x} ${p.y} ${p.z} ${o.nbt}`)
  }
  return { at, creepers: c.creepers.map(to) }
}

const creepersLeft = (): number => Object.values(bot.entities).filter(e => e.name === 'creeper' && isAlive(bot, e) && e.position.distanceTo(bot.entity.position) < 16).length

describe(`a creeper at night by the ground of two 1.21.11 deaths on ${DEFAULT_VERSION}`, { timeout: 60 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'creepers',
      difficulty: 'normal',
      gamerules: { advance_time: false, advance_weather: false, spawn_monsters: false, spawn_mobs: false, respawn_radius: 0 },
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

  for (const c of CASES_ALL.filter(c => CASES.includes(c.name))) {
    test(`${c.name}: the creeper${c.creepers.length > 1 ? 's' : ''} survived (${RUNS} runs)`, async () => {
      const results: string[] = []
      let failed = 0
      for (let i = 0; i < RUNS; i++) {
        const { creepers } = await fresh(c)
        const log = new NightLog(bot)
        // the work going on (a wait standing in for it), preempted by the reflexes
        const work = bot.survival.tasks.run({ name: 'step: the work', priority: 0 }, async (ctx) => { for (;;) await ctx.waitTicks(20) }).catch(() => {})
        for (const p of creepers) await run(`summon minecraft:creeper ${p.x} ${p.y} ${p.z} {PersistenceRequired:1b}`)
        bot.survival.reflexes!.enabled = true
        let dead = false
        const onDeath = (): void => { dead = true }
        bot.once('death', onDeath)
        await waitFor(() => dead || bot.health <= 0, 400)
        bot.off('death', onDeath)
        bot.survival.reflexes!.enabled = false
        bot.survival.tasks.cancelAll('ABORTED', 'the run is over')
        await work
        const r = log.finish()
        const alive = !dead && r.deaths.length === 0 && bot.health > 0
        const left = creepersLeft()
        const ok = alive
        if (!ok) failed++
        results.push(`run ${i + 1}: ${alive ? 'alive' : 'dead'}, health ${bot.health.toFixed(1)}, ${left} creepers within 16, ${summary(r)}`)
      }
      for (const l of results) console.log(`[creeper] ${c.name}: ${l}`)
      assert.strictEqual(failed, 0, results.join('\n'))
    })
  }
})
