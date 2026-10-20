// Food on a barren snowy land against a real server (SURVIVAL_VERSION, default 1.21.11): a superflat patch laid with
// snow, as the snowy mountains of 26.3 seed 31337 were, whose only animals were rabbits and whose only water was frozen.
// Rabbits hunted on open snow and cooked; the food got there with only rabbits and a frozen pond (the hunt, then
// fishing through the ice); and a bot at 3 health crossing a ravine without a fall.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { goals } from '@nxg-org/mineflayer-pathfinder'
import { createPlugin } from '../../src'
import { DEFAULT_VERSION, connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'
import { countItems, waitUntil } from '../../src/skills/util'
import { WorldMemory } from '../../src/core/memory'
import { Executor } from '../../src/executor/executor'
import { FOOD_GOAL } from '../../src/planner/progression'
import { navigate } from '../../src/skills/navigate'
import { foodInfo } from '../../src/core/items'
import { ReflexEngine } from '../../src/reflexes/engine'
import { fallReflex } from '../../src/reflexes/rules'

const USERNAME = 'snowbot'
// the superflat's grass is at y = -61; the bot stands at -60
const GROUND = -61

describe(`food on a snowy land on a ${DEFAULT_VERSION} server`, { timeout: 60 * 60 * 1000 }, () => {
  let server: TestServer
  let bot: Bot
  let origin: Vec3
  let ticks = 0

  const run = async (cmd: string): Promise<string> => (await server.command(cmd)).join(' ')
  const at = (dx: number, dy: number, dz: number): Vec3 => origin.offset(dx, dy, dz)
  const xyz = (pos: Vec3): string => `${pos.x} ${pos.y} ${pos.z}`
  const rabbits = (): any[] => Object.values(bot.entities).filter(e => e.name === 'rabbit')
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
    if (process.env.SNOW_LOG != null) console.log(`[snow] t${ticks} ${line}`)
  }
  const points = (): number => FOOD_GOAL.reduce((n, f) => n + countItems(bot, f) * (foodInfo(bot.registry as any, f)?.nutrition ?? 0), 0)

  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'snowfood',
      difficulty: 'peaceful',
      gamerules: { advance_weather: false, advance_time: false, spawn_mobs: false, spawn_monsters: false, natural_health_regeneration: false },
      // (no animals of the land's own: a biome that spawns none, the classic superflat's layers; no structures, a trial
      // chamber's copper stood over the ground by the bot)
      properties: {
        'spawn-protection': 0,
        'generator-settings': JSON.stringify({ layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 }, { block: 'minecraft:grass_block', height: 1 }], biome: 'minecraft:stony_peaks', features: false, lakes: false, structure_overrides: [] })
      }
    })
    bot = await connectLockstepBot(server, { username: USERNAME })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: false }))
    bot.on('physicsTick', () => { ticks++ })
    origin = new Vec3(Math.floor(bot.entity.position.x), GROUND + 1, Math.floor(bot.entity.position.z))
    await run('time set 1000')
    await run('weather clear')
  })

  after(async () => {
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  /** the snowy patch: snow blocks for ground and a snow layer over them, 40 blocks about the bot, snowy plains */
  async function snowField (): Promise<void> {
    for (const [x0, z0] of [[-40, -40], [0, -40], [-40, 0], [0, 0]]) {
      await run(`fill ${xyz(at(x0, 0, z0))} ${xyz(at(x0 + 40, 12, z0 + 40))} air`)
      await run(`fill ${xyz(at(x0, 13, z0))} ${xyz(at(x0 + 40, 24, z0 + 40))} air`)
      await run(`fill ${xyz(at(x0, -1, z0))} ${xyz(at(x0 + 40, -1, z0 + 40))} snow_block`)
      await run(`fill ${xyz(at(x0, 0, z0))} ${xyz(at(x0 + 40, 0, z0 + 40))} snow`)
    }
    await run(`fillbiome ${xyz(at(-40, -4, -40))} ${xyz(at(40, 16, 40))} minecraft:snowy_plains`)
  }

  /** a snowy hillside's lumps over the field: mounds 1 to 3 high every few blocks, and spruce trunks */
  async function snowHills (): Promise<void> {
    for (let dx = -36; dx <= 36; dx += 6) {
      for (let dz = -36; dz <= 36; dz += 6) {
        const h = ((dx * 7 + dz * 13) % 4 + 4) % 4
        if (Math.abs(dx) < 3 && Math.abs(dz) < 3) continue
        if (h === 0) {
          await run(`fill ${xyz(at(dx, 0, dz))} ${xyz(at(dx, 5, dz))} spruce_log`)
          continue
        }
        await run(`fill ${xyz(at(dx - 1, 0, dz - 1))} ${xyz(at(dx + 1, h - 1, dz + 1))} snow_block`)
        await run(`fill ${xyz(at(dx - 1, h, dz - 1))} ${xyz(at(dx + 1, h, dz + 1))} snow`)
      }
    }
  }

  beforeEach(async () => {
    await snowField()
    await run('kill @e[type=item]')
    await run('kill @e[type=rabbit]')
    await run('kill @e[type=arrow]')
    await run(`clear ${USERNAME}`)
    await run(`effect clear ${USERNAME}`)
    await run(`effect give ${USERNAME} minecraft:saturation 1 20 true`)
    // (no natural regeneration here: the health put back)
    await run(`effect give ${USERNAME} minecraft:instant_health 1 5 true`)
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`)
    const settled = await waitUntil(bot, () => bot.entity.position.distanceTo(origin.offset(0.5, 0, 0.5)) < 0.3 && bot.inventory.items().length === 0 && rabbits().length === 0 && bot.health >= 20, 100)
    assert.ok(settled, `the bot is at ${bot.entity.position.toString()}`)
    lines.length = 0
  })

  async function give (item: string, count: number): Promise<void> {
    const name = item.replace(/\[.*$/, '')
    const had = countItems(bot, name)
    await run(`give ${USERNAME} ${item} ${count}`)
    assert.ok(await waitUntil(bot, () => countItems(bot, name) >= had + count, 40), `no ${count} ${item} given`)
  }

  async function summonRabbits (spots: Array<[number, number]>): Promise<void> {
    for (const [dx, dz] of spots) await run(`summon rabbit ${xyz(at(dx, 0, dz))}`)
    assert.ok(await waitUntil(bot, () => rabbits().length === spots.length, 40), `${rabbits().length} rabbits`)
  }

  it('breaks falls of 5, 7 and 10 blocks at 3 health with a water bucket', async () => {
    await give('water_bucket', 1)
    await run(`damage ${USERNAME} 17 minecraft:starve`)
    assert.ok(await waitUntil(bot, () => Math.abs(bot.health - 3) < 0.01, 40), `health ${bot.health}`)
    const engine = new ReflexEngine(bot, { reflexes: [fallReflex] })
    try {
      for (const height of [5, 7, 10]) {
        await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y + height} ${origin.z + 0.5}`)
        assert.ok(await waitUntil(bot, () => bot.entity.position.y > origin.y + height - 1, 40), `not up at ${height}: ${bot.entity.position.toString()}`)
        assert.ok(await waitUntil(bot, () => bot.entity.onGround || (bot.entity as any).isInWater === true, 100), `no landing from ${height}`)
        await bot.waitForTicks(20)
        assert.ok(bot.health > 2.99, `a fall of ${height} at 3 health: ${bot.health} left`)
        assert.ok(countItems(bot, 'water_bucket') === 1, `the water taken back up after the fall of ${height}`)
        console.log(`[snow] fall of ${height}: health ${bot.health}`)
      }
    } finally {
      engine.stop()
    }
  })

  it('falls off a 30-block cliff at full health with the water bucket in the bag (not the hotbar), and lives (full-26.3-fresh-o)', async () => {
    // a pillar 30 high, 3 x 3, the bot on it
    const H = 30
    // (the bot out of the way first: not built into the pillar)
    await run(`tp ${USERNAME} ${origin.x + 6.5} ${origin.y} ${origin.z + 0.5}`)
    await run(`fill ${xyz(at(-1, 0, -1))} ${xyz(at(1, H - 1, 1))} stone`)
    await run(`item replace entity ${USERNAME} inventory.12 with water_bucket`)
    assert.ok(await waitUntil(bot, () => countItems(bot, 'water_bucket') === 1, 40))
    await run(`tp ${USERNAME} ${origin.x + 0.5} ${origin.y + H} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.y > origin.y + H - 0.1, 60))
    const engine = new ReflexEngine(bot, { reflexes: [fallReflex] })
    let landed = false
    let died = false
    const onDeath = (): void => { died = true }
    bot.on('death', onDeath)
    try {
      // off the edge, as a knock from a mob or a slide off a ledge leaves it: in the air beside the pillar's top
      await run(`tp ${USERNAME} ${origin.x + 2.8} ${origin.y + H + 0.2} ${origin.z + 0.5}`)
      assert.ok(await waitUntil(bot, () => !bot.entity.onGround && bot.entity.position.x > origin.x + 2, 60), `never off the edge: at ${bot.entity.position.toString()}`)
      bot.clearControlStates()
      let n = 0
      landed = await waitUntil(bot, () => {
        if (process.env.SNOW_LOG != null && n++ % 5 === 0) console.log(`[snow] cliff t${n}: ${bot.entity.position.toString()} v ${bot.entity.velocity.toString()} ground ${String(bot.entity.onGround)} held ${bot.heldItem?.name ?? '-'} under ${bot.blockAt(bot.entity.position.offset(0, -0.5, 0))?.name ?? '?'} at ${bot.entity.position.offset(0, -0.5, 0).floored().toString()} origin ${origin.toString()}`)
        return bot.entity.position.y < origin.y + 2 && (bot.entity.onGround || (bot.entity as any).isInWater === true)
      }, 200)
      await bot.waitForTicks(20)
    } finally {
      engine.stop()
      bot.off('death', onDeath)
      bot.clearControlStates()
    }
    console.log(`[snow] cliff: landed ${String(landed)} at ${bot.entity.position.toString()}, health ${bot.health}`)
    assert.ok(!died, 'died of the fall')
    assert.ok(landed && bot.health >= 19, `a 30-block fall: health ${bot.health} at ${bot.entity.position.toString()}`)
    await run(`fill ${xyz(at(-1, 0, -1))} ${xyz(at(1, H - 1, 1))} air`)
  })

  it('crosses a ravine at 3 health without a jump or a fall', async () => {
    // two plateaus 4 high, a ravine 2 wide between them down to the ground (a fall into it hurts, one to kill at 1 or 2
    // health); the way round is a bridge one block wide over it 28 blocks off. At full health the jump across is the way
    const H = 4
    await run(`fill ${xyz(at(-8, 0, -8))} ${xyz(at(-1, H - 1, 30))} snow_block`)
    await run(`fill ${xyz(at(2, 0, -8))} ${xyz(at(9, H - 1, 30))} snow_block`)
    await run(`fill ${xyz(at(0, H - 1, 28))} ${xyz(at(1, H - 1, 28))} snow_block`)
    await run(`tp ${USERNAME} ${origin.x - 4 + 0.5} ${origin.y + H} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.onGround && Math.abs(bot.entity.position.y - (origin.y + H)) < 0.1, 60))
    // at full health first: the moves the way across takes then
    const fullMoves: string[] = []
    const onFull = (path: any): void => {
      for (const m of path.path ?? []) fullMoves.push(String(m.moveType?.constructor?.name ?? ''))
      if (process.env.SNOW_LOG != null) console.log(`[snow] path: ${(path.path ?? []).map((m: any) => `${String(m.moveType?.constructor?.name)} ${String(m.exitPos)}`).join(' | ')}`)
    }
    bot.on('pathGenerated' as any, onFull)
    try {
      await navigate(bot, { goal: new goals.GoalBlock(origin.x + 5, origin.y + H, origin.z) }, new AbortController().signal)
    } finally {
      bot.off('pathGenerated' as any, onFull)
    }
    console.log(`[snow] ravine at full health: moves ${[...new Set(fullMoves)].join(', ')}`)
    assert.ok(fullMoves.some(m => /Parkour/.test(m)), `no jump across at full health: the scenario proves nothing (${fullMoves.join(', ')})`)
    await run(`tp ${USERNAME} ${origin.x - 4 + 0.5} ${origin.y + H} ${origin.z + 0.5}`)
    assert.ok(await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.x < origin.x, 60))
    await run(`damage ${USERNAME} 17 minecraft:starve`)
    assert.ok(await waitUntil(bot, () => Math.abs(bot.health - 3) < 0.01, 40), `health ${bot.health}`)
    let least = bot.health
    const onHealth = (): void => { least = Math.min(least, bot.health) }
    bot.on('health', onHealth)
    const moves: string[] = []
    const onPath = (path: any): void => { for (const m of path.path ?? []) moves.push(String(m.moveType?.constructor?.name ?? m.moveType?.name ?? '')) }
    bot.on('pathGenerated' as any, onPath)
    try {
      for (let i = 0; i < 3; i++) {
        await run(`tp ${USERNAME} ${origin.x - 4 + 0.5} ${origin.y + H} ${origin.z + 0.5}`)
        assert.ok(await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.x < origin.x, 60))
        await navigate(bot, { goal: new goals.GoalBlock(origin.x + 5, origin.y + H, origin.z) }, new AbortController().signal)
        assert.ok(bot.entity.position.x > origin.x + 3, `round ${i}: ended at ${bot.entity.position.toString()}`)
      }
    } finally {
      bot.off('health', onHealth)
      bot.off('pathGenerated' as any, onPath)
    }
    console.log(`[snow] ravine: least health ${least}, moves ${[...new Set(moves)].join(', ')}`)
    assert.ok(least >= 3 - 1e-6, `fell: health down to ${least}`)
    assert.ok(!moves.some(m => /Parkour/.test(m)), `parkour at 3 health: ${moves.join(', ')}`)
  })

  for (const hills of [false, true]) {
  it(`hunts 3 rabbits on ${hills ? 'a snowy hillside' : 'open snow'} and cooks them`, async () => {
    if (hills) await snowHills()
    // (looting III: a rabbit drops 0 to 1 meat, and the hunt is what's tried, not the loot's luck)
    await give(/^1\./.test(DEFAULT_VERSION) ? 'iron_sword[enchantments={looting:3}]' : 'iron_sword[enchantments={"minecraft:looting":3}]', 1)
    await give('furnace', 1)
    await give('coal', 8)
    await give('stone_pickaxe', 1)
    await summonRabbits([[12, 6], [-10, 14], [4, -16]])
    const memory = new WorldMemory()
    memory.setBase(origin)
    const executor = new Executor(bot, { memory, log })
    const start = ticks
    const outcome = await executor.obtain([{ item: 'cooked_rabbit', count: 2 }], new AbortController().signal).catch(err => err)
    const took = ticks - start
    console.log(`[snow] hunt${hills ? ' on the hills' : ''}: ${countItems(bot, 'cooked_rabbit')} cooked rabbit, ${rabbits().length} rabbits left, in ${took} ticks`)
    assert.ok(countItems(bot, 'cooked_rabbit') >= 2, `${countItems(bot, 'cooked_rabbit')} cooked rabbit in ${took} ticks, ${rabbits().length} rabbits left: ${String(outcome?.message ?? '')}\n${lines.join('\n')}`)
    assert.ok(lines.some(l => /kill .*rabbit for .*rabbit/.test(l)) || !lines.some(l => /for beef/.test(l)), lines.join('\n'))
  })
  }

  it('gets 20 food points on a snowy land with only rabbits and a frozen pond', async () => {
    // the pond: 7 x 7 and 3 deep, frozen over, 10 blocks off
    await run(`fill ${xyz(at(8, -4, -3))} ${xyz(at(14, -2, 3))} water`)
    await run(`fill ${xyz(at(8, -1, -3))} ${xyz(at(14, -1, 3))} ice`)
    await run(`fill ${xyz(at(8, 0, -3))} ${xyz(at(14, 0, 3))} air`)
    await give('iron_sword', 1)
    await give('stone_pickaxe', 1)
    await give('furnace', 1)
    await give('crafting_table', 1)
    await give('coal', 16)
    await give('stick', 6)
    await give('string', 2)
    await summonRabbits([[-12, 6], [-6, -14], [16, 12]])
    const memory = new WorldMemory()
    memory.setBase(origin)
    const executor = new Executor(bot, { memory, log })
    const start = ticks
    const outcome = await executor.obtain([{ item: FOOD_GOAL, count: 20, unit: 'nutrition' }], new AbortController().signal).catch(err => err)
    const took = ticks - start
    console.log(`[snow] food: ${points()} points (${FOOD_GOAL.filter(f => countItems(bot, f) > 0).map(f => `${countItems(bot, f)} ${f}`).join(', ')}) in ${took} ticks`)
    assert.ok(points() >= 20, `${points()} food points in ${took} ticks: ${String(outcome?.message ?? '')}\n${lines.join('\n')}`)
  })
})
