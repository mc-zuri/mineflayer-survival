// The combat skills and reflexes against a real 1.21.11 server (the tests/harness lockstep server and bot): a zombie
// killed, a creeper survived, hunger eaten away, armor worn, a cow hunted, an end crystal shot, and an arrow's flight
// checked against the server's.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createPlugin } from '../../src'
import { shoot } from '../../src/skills/shoot'
import { hunt } from '../../src/skills/hunt'
import { simulateArrow } from '../../src/skills/arrow'
import { connectLockstepBot, quitBot, startServer, type TestServer } from '../harness'

const USER = 'survivor'
// the superflat's ground: grass at y -61, the bot standing at -60
const GROUND = -60

let server: TestServer
let bot: Bot

async function waitFor (predicate: () => boolean, ticks: number): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true
    await bot.waitForTicks(1)
  }
  return predicate()
}

function nearest (name: string): any {
  return bot.nearestEntity(e => e.name === name)
}

async function give (item: string, count = 1): Promise<void> {
  await server.command(`give ${USER} ${item} ${count}`)
}

/** a clean slate: no mobs, empty inventory, full health and food, at the origin at noon */
async function reset (): Promise<void> {
  if (bot.survival.reflexes != null) bot.survival.reflexes.enabled = false
  bot.clearControlStates()
  bot.deactivateItem()
  for (const cmd of ['kill @e[type=!player]', `clear ${USER}`, `effect clear ${USER}`, 'time set noon', `tp ${USER} 0.5 ${GROUND} 0.5 0 0`,
    `effect give ${USER} minecraft:instant_health 1 10 true`, `effect give ${USER} minecraft:saturation 1 20 true`, 'fill -8 -60 -8 32 -50 8 minecraft:air']) {
    await server.command(cmd)
  }
  await bot.waitForTicks(20)
}

describe('combat skills and reflexes on 1.21.11', { timeout: 15 * 60 * 1000 }, () => {
  before(async () => {
    server = await startServer({
      flat: true,
      seed: 'combat',
      difficulty: 'easy',
      gamerules: { advance_time: false, advance_weather: false, spawn_mobs: false, spawn_monsters: false, respawn_radius: 0 }
    })
    bot = await connectLockstepBot(server, { username: USER })
    await bot.waitForChunksToLoad()
    bot.loadPlugin(createPlugin({ reflexes: { enabled: false } }))
  })

  after(async () => {
    bot?.survival?.reflexes?.stop()
    if (bot != null) await quitBot(bot)
    if (server != null) await server.cleanup()
  })

  test('a zombie comes at the bot, and the bot kills it', async () => {
    await reset()
    await give('iron_sword')
    await server.command('time set midnight') // no burning in the sun
    await server.command(`summon minecraft:zombie 6.5 ${GROUND} 0.5`)
    assert.ok(await waitFor(() => nearest('zombie') != null, 40), 'no zombie')
    const zombie = nearest('zombie')
    let died = false
    bot.on('entityDead', e => { if (e.id === zombie.id) died = true })
    bot.survival.reflexes!.enabled = true
    assert.ok(await waitFor(() => died, 600), 'the zombie is still alive')
    assert.ok(bot.health > 0)
  })

  test('a creeper next to the bot: the bot survives, the creeper dead or the bot away', async () => {
    await reset()
    let botDied = false
    bot.once('death', () => { botDied = true })
    await server.command(`summon minecraft:creeper 2.5 ${GROUND} 0.5`)
    assert.ok(await waitFor(() => nearest('creeper') != null, 40), 'no creeper')
    const creeper = nearest('creeper')
    bot.survival.reflexes!.enabled = true
    await bot.waitForTicks(200)
    const gone = bot.entities[creeper.id] == null
    const away = !gone && bot.entity.position.distanceTo(creeper.position) >= 7
    assert.ok(!botDied && bot.health > 0, `the bot died (health ${bot.health})`)
    assert.ok(gone || away, `the creeper is ${bot.entity.position.distanceTo(creeper.position).toFixed(1)} blocks away`)
  })

  test('hungry from /effect hunger, the bot eats', async () => {
    await reset()
    await give('cooked_beef', 8)
    await bot.waitForTicks(5)
    let ate = false
    bot.on('reflex' as any, (name: string) => { if (name === 'eat') ate = true })
    bot.survival.reflexes!.enabled = true
    await server.command(`effect give ${USER} minecraft:hunger 10 255`)
    assert.ok(await waitFor(() => bot.food <= 14, 300), `still at food ${bot.food}`)
    await server.command(`effect clear ${USER} minecraft:hunger`)
    const beef = (): number => bot.inventory.count(bot.registry.itemsByName.cooked_beef.id, null)
    assert.ok(await waitFor(() => beef() < 8, 200), 'no beef eaten')
    assert.ok(ate)
    assert.ok(await waitFor(() => bot.food > 14, 200), `food ${bot.food} after eating`)
  })

  test('given armor, the bot wears the best of it', async () => {
    await reset()
    bot.survival.reflexes!.enabled = true
    await give('leather_chestplate')
    await give('iron_chestplate')
    await give('diamond_helmet')
    await give('golden_boots')
    const slot = (n: number): string | undefined => bot.inventory.slots[n]?.name
    assert.ok(await waitFor(() => slot(5) === 'diamond_helmet' && slot(6) === 'iron_chestplate' && slot(8) === 'golden_boots', 200),
      `wearing ${String(slot(5))} ${String(slot(6))} ${String(slot(7))} ${String(slot(8))}`)
    // a better piece picked up later replaces the worn one
    await give('iron_boots')
    assert.ok(await waitFor(() => slot(8) === 'iron_boots', 200), `boots ${String(slot(8))}`)
  })

  test('hunt a cow: killed, and its beef picked up', async () => {
    await reset()
    await give('iron_sword')
    await server.command(`summon minecraft:cow 8.5 ${GROUND} 3.5 {NoAI:1b}`)
    assert.ok(await waitFor(() => nearest('cow') != null, 40), 'no cow')
    const result = await hunt(bot, 'cow')
    assert.ok(result.killed)
    assert.ok((result.drops.beef ?? 0) >= 1, `drops ${JSON.stringify(result.drops)}`)
  })

  test('an end crystal on bedrock 20 blocks away is shot', async () => {
    await reset()
    await give('bow')
    await give('arrow', 16)
    await server.command(`setblock 20 ${GROUND} 0 minecraft:bedrock`)
    await server.command(`summon minecraft:end_crystal 20.5 ${GROUND + 1} 0.5 {ShowBottom:0b}`)
    assert.ok(await waitFor(() => nearest('end_crystal') != null, 40), 'no crystal')
    const crystal = nearest('end_crystal')
    const result = await shoot(bot, crystal, { maxShots: 3 })
    assert.ok(result.hit, `missed: ${JSON.stringify(result)}`)
    assert.strictEqual(bot.entities[crystal.id], undefined)
  })

  test('the arrow flies as simulateArrow says (positions from the server along the simulated path)', async () => {
    await reset()
    await give('bow')
    await give('arrow', 4)
    await bot.waitForTicks(5)
    await bot.equip(bot.registry.itemsByName.bow.id, 'hand')
    await bot.look(-Math.PI / 2, 1.3, true)
    await bot.waitForTicks(2)
    let arrow: any = null
    let spawn: { position: Vec3, velocity: Vec3 } | null = null
    const seen: Vec3[] = []
    // the spawn packet's velocity (1.21.9+: an LpVec3 in blocks a tick); mineflayer leaves entity.velocity at zero
    let spawnVelocity: Vec3 | null = null
    bot._client.prependListener('spawn_entity', (p: any) => { if (spawnVelocity == null && bot.registry.entities[p.type]?.name === 'arrow') spawnVelocity = new Vec3(p.velocity.x, p.velocity.y, p.velocity.z) })
    bot.on('entitySpawn', e => { if (e.name === 'arrow' && arrow == null) { arrow = e; spawn = { position: e.position.clone(), velocity: spawnVelocity ?? e.velocity.clone() } } })
    bot.on('entityMoved', e => { if (e === arrow) seen.push(e.position.clone()) })
    bot.activateItem()
    await bot.waitForTicks(22)
    bot.deactivateItem()
    assert.ok(await waitFor(() => arrow != null, 20), 'no arrow')
    await bot.waitForTicks(110)
    assert.ok(spawn != null)
    const s = spawn as { position: Vec3, velocity: Vec3 }
    // a full draw: speed 3 (BowItem.getPowerForTime(20) x 3), give or take the inaccuracy's noise
    assert.ok(Math.abs(s.velocity.norm() - 3) < 0.1, `launch speed ${s.velocity.norm()}`)
    // it starts at the eye less 0.1
    assert.ok(Math.abs(s.position.y - (GROUND + 1.52)) < 0.01, `spawned at y ${s.position.y}`)
    const path = simulateArrow(s.position, s.velocity, { maxTicks: 150, stopBelowY: GROUND - 1 }).path.map(p => p.position)
    // the server sends an arrow's position every 20 ticks (EntityType.ARROW's updateInterval)
    const inFlight = seen.filter(p => p.y > GROUND + 0.2 && p.distanceTo(s.position) > 1)
    assert.ok(inFlight.length >= 2, `${inFlight.length} positions from the server in flight`)
    for (const p of inFlight) {
      let best = Infinity
      for (let i = 1; i < path.length; i++) best = Math.min(best, distanceToSegment(p, path[i - 1], path[i]))
      assert.ok(best < 0.01, `the server's ${p.toString()} is ${best.toFixed(3)} off the simulated path`)
    }
  })
})

function distanceToSegment (p: Vec3, a: Vec3, b: Vec3): number {
  const ab = b.minus(a)
  const t = Math.max(0, Math.min(1, p.minus(a).dot(ab) / Math.max(1e-12, ab.dot(ab))))
  return p.distanceTo(a.plus(ab.scaled(t)))
}
