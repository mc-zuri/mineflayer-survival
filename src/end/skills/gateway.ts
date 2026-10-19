// throughGateway: from the main island (or an outer island) through an end gateway with an ender pearl. The bot gets
// to a throw spot by the gateway at the opening's height (a pillar of its blocks there, bridged out to first over the
// void), throws the pearl along the solved arc into the 1 x 1 opening (ThrownEnderpearl's physics, the frame's
// bedrock in the way checked), and is teleported to where the pearl lands at the exit (EndGatewayBlock: the pearl
// comes out at the exit's position with no velocity, ThrownEnderpearl.onHit teleports its owner there).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension } from '../../core/memory'
import { findBlocks } from '../../core/findBlocks'
import { TaskError, throwIfAborted, waitTicks, type SkillOptions } from '../../skills/combatUtil'
import { arrowWorld } from '../../skills/shoot'
import { bridgeOverLava } from '../../nether/safety'
import { countItems, eyeHeight, trace } from '../../skills/util'
import { GATEWAY_JUMP, GATEWAY_POI, aimPearl, gatewayPositions, openGateways, rankThrowSpots, throwSpots } from '../gateway'
import { PEARL_EYE_OFFSET } from '../../skills/arrow'
import { SCAFFOLD_ITEMS, blockGetter, gotoBlock, gotoNear, groundY, isVoidColumn, towerUp, worldMinY } from './world'
import { isInEnd } from './enterEnd'

/** pearls thrown at a gateway before it's given up */
export const GATEWAY_THROWS = 3
/** ticks a thrown pearl is waited on for the teleport (a pearl into the gateway lands at the exit within a few) */
export const GATEWAY_TELEPORT_TICKS = 120
/** how far from a column along the line to the island a bridge to it may start */
export const GATEWAY_BRIDGE_REACH = 24

/** the gateways in the loaded world: the ring's that are open, and any other end_gateway block within `range` (an exit) */
export function visibleGateways (bot: Bot, range = 128): Vec3[] {
  const get = blockGetter(bot)
  const found = openGateways(get)
  const id = bot.registry.blocksByName.end_gateway?.id
  if (id != null) {
    for (const p of findBlocks(bot, { matching: id, maxDistance: range, count: 8 })) {
      if (!found.some(f => f.equals(p))) found.push(p)
    }
  }
  return found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
}

/** the gateways seen get remembered, the ring's as 'main', the others as 'exit' */
export function rememberGateways (bot: Bot, gateways: Vec3[]): void {
  const memory = bot.survival?.memory
  if (memory == null) return
  const ring = gatewayPositions()
  for (const g of gateways) memory.addPoi(GATEWAY_POI, g, 'the_end', ring.some(r => r.equals(g)) ? 'main' : 'exit')
}

/**
 * On the main island with no gateway in sight: round the ring at 50 blocks out (each of the 20 places then within
 * 60 blocks of a stop, inside the view distance), until one is seen. Resolves the nearest seen, or null.
 */
export async function seekGateway (bot: Bot, opts: SkillOptions = {}): Promise<Vec3 | null> {
  const signal = opts.signal
  let seen = visibleGateways(bot)
  if (seen.length > 0) { rememberGateways(bot, seen); return seen[0] }
  const start = Math.atan2(bot.entity.position.z, bot.entity.position.x)
  for (let i = 0; i < 6; i++) {
    throwIfAborted(signal)
    const a = start + i * Math.PI / 3
    const stop = new Vec3(Math.round(Math.cos(a) * 50), 64, Math.round(Math.sin(a) * 50))
    const get = blockGetter(bot)
    const y = groundY(get, stop.x, stop.z, 100)
    try {
      if (y != null) await gotoBlock(bot, { x: stop.x, y, z: stop.z }, { signal, retries: 0 })
      else await gotoNear(bot, stop, 12, { signal, retries: 0 })
    } catch (err) {
      if (signal?.aborted === true) throw err
      trace('seekGateway: to', stop.toString(), 'failed:', (err as Error).message)
    }
    await waitTicks(bot, 10, signal)
    seen = visibleGateways(bot)
    if (seen.length > 0) { rememberGateways(bot, seen); return seen[0] }
  }
  return null
}

/** the blocks to bridge and pillar with the bag holds most of */
function scaffoldItem (bot: Bot): string | null {
  const best = SCAFFOLD_ITEMS.map(n => ({ n, c: countItems(bot, n) })).sort((a, b) => b.c - a.c)[0]
  return best != null && best.c > 0 ? best.n : null
}

/**
 * To a throw spot at the gateway's opening: onto the ground under a spot over ground and up a pillar to it; or, every
 * spot over the void, along the line from the nearest spot toward the bot to the first ground, bridged out from there
 * and up a pillar at the spot
 */
export async function reachThrowSpot (bot: Bot, gateway: Vec3, opts: SkillOptions = {}): Promise<Vec3> {
  const signal = opts.signal
  const get = blockGetter(bot)
  const minY = worldMinY(bot)
  const groundAt = (x: number, z: number, fromY: number): number | null => isVoidColumn(get, x, z, fromY, minY) ? null : groundY(get, x, z, fromY, minY)
  const spots = rankThrowSpots(throwSpots(gateway, groundAt, eyeHeight(bot)), bot.entity.position)
  const spot = spots[0]
  if (spot == null) throw new TaskError('NO_PATH', `no spot to throw into the gateway at ${gateway.toString()} from`)
  const feet = bot.entity.position.floored()
  if (feet.equals(spot.stand)) return spot.stand
  const item = scaffoldItem(bot)
  if (spot.ground != null) {
    const need = spot.stand.y - spot.ground
    if (need > 0 && (item == null || countItems(bot, SCAFFOLD_ITEMS) < need)) throw new TaskError('MISSING_ITEMS', `${need} blocks to pillar up to the gateway, ${countItems(bot, SCAFFOLD_ITEMS)} held`)
    if (feet.x !== spot.stand.x || feet.z !== spot.stand.z) await gotoBlock(bot, { x: spot.stand.x, y: spot.ground, z: spot.stand.z }, { signal })
    if (need > 0) await towerUp(bot, spot.stand.y, { signal })
    return spot.stand
  }
  // over the void: the line from the spot toward the bot, its first column with ground the bridge's start
  const dir = new Vec3(bot.entity.position.x - spot.stand.x, 0, bot.entity.position.z - spot.stand.z)
  const step = Math.abs(dir.x) >= Math.abs(dir.z) ? new Vec3(Math.sign(dir.x), 0, 0) : new Vec3(0, 0, Math.sign(dir.z))
  let start: Vec3 | null = null
  let length = 0
  for (let i = 1; i <= GATEWAY_BRIDGE_REACH; i++) {
    const c = spot.stand.plus(step.scaled(i))
    const y = groundAt(c.x, c.z, spot.stand.y + 4)
    if (y != null && y <= spot.stand.y) { start = new Vec3(c.x, y, c.z); length = i; break }
  }
  if (start == null) throw new TaskError('NO_PATH', `no ground within ${GATEWAY_BRIDGE_REACH} of the gateway at ${gateway.toString()} to bridge from`)
  const need = length + (spot.stand.y - start.y)
  if (item == null || countItems(bot, SCAFFOLD_ITEMS) < need) throw new TaskError('MISSING_ITEMS', `${need} blocks to bridge and pillar to the gateway, ${countItems(bot, SCAFFOLD_ITEMS)} held`)
  await gotoBlock(bot, start, { signal })
  trace('reachThrowSpot: bridging', length, 'from', start.toString(), 'to', spot.stand.toString())
  await bridgeOverLava(bot, { direction: step.scaled(-1), length, rails: false, item }, signal)
  await towerUp(bot, spot.stand.y, { signal })
  return bot.entity.position.floored()
}

export interface ThroughGatewayResult {
  /** where the bot stood to throw */
  from: Vec3
  /** where the teleport put it */
  arrival: Vec3
  /** the gateway thrown into */
  gateway: Vec3
  /** the end_gateway at the other end, when seen from the arrival */
  exit: Vec3 | null
  throws: number
  ticks: number
}

/**
 * Through the gateway at `gateway` by ender pearl: to a throw spot, a pearl along the solved arc, and the teleport
 * waited for (a jump of GATEWAY_JUMP blocks or more). A pearl that missed lands somewhere about and the bot with it:
 * back to a spot and again, GATEWAY_THROWS times. Throws MISSING_ITEMS with no pearls, NO_PATH with no spot or no arc.
 */
export async function throughGateway (bot: Bot, gateway: Vec3, opts: SkillOptions = {}): Promise<ThroughGatewayResult> {
  const signal = opts.signal
  if (!isInEnd(bot)) throw new TaskError('NOT_FOUND', 'not in the End')
  const t0 = (bot as any).lockstep?.ticks ?? 0
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  let throws = 0
  try {
    for (; throws < GATEWAY_THROWS;) {
      throwIfAborted(signal)
      const pearl = bot.inventory.items().find(i => i.name === 'ender_pearl')
      if (pearl == null) throw new TaskError('MISSING_ITEMS', `no ender pearl to throw into the gateway (${throws} thrown)`)
      const from = await reachThrowSpot(bot, gateway, { signal })
      // standing still on the pillar: the throw takes no movement of the bot's (Projectile.shootFromRotation adds it)
      for (let t = 0; t < 10 && !bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
      const start = bot.entity.position.offset(0, eyeHeight(bot) - PEARL_EYE_OFFSET, 0)
      const aim = aimPearl(start, gateway, arrowWorld(bot))
      if (aim == null) throw new TaskError('NO_PATH', `no arc from ${start.toString()} into the gateway at ${gateway.toString()}`)
      await bot.equip(pearl, 'hand')
      await bot.look(aim.yaw, aim.pitch, true)
      // the look goes out with this tick's move packet, the use after it with the same rotation
      await waitTicks(bot, 1, signal)
      const before = bot.entity.position.clone()
      bot.activateItem()
      throws++
      trace('throughGateway: pearl', throws, 'from', start.toString(), 'into', gateway.toString(), 'pitch', aim.pitch.toFixed(3), 'flight', aim.ticks.toFixed(1))
      let moved = 0
      for (let t = 0; t < GATEWAY_TELEPORT_TICKS; t++) {
        await waitTicks(bot, 1, signal)
        moved = bot.entity.position.distanceTo(before)
        if (moved > 4) break
      }
      if (moved >= GATEWAY_JUMP && isInEnd(bot)) {
        // the arrival's chunks, and the ground under the feet
        for (let t = 0; t < 100 && !bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
        await bot.waitForChunksToLoad?.()
        const exit = visibleGateways(bot, 24)[0] ?? null
        rememberGateways(bot, [gateway, ...(exit != null ? [exit] : [])])
        const arrival = bot.entity.position.clone()
        trace('throughGateway: through to', arrival.toString(), 'in', ticks, 'ticks, the exit gateway', exit?.toString())
        return { from, arrival, gateway, exit, throws, ticks }
      }
      trace('throughGateway: pearl', throws, moved > 4 ? `missed, the bot moved ${moved.toFixed(1)}` : 'missed')
      if (normalizeDimension(bot.game?.dimension) !== 'the_end') throw new TaskError('FAILED', 'out of the End')
    }
    throw new TaskError('FAILED', `${throws} pearls thrown at the gateway at ${gateway.toString()}, no teleport (${(bot as any).lockstep?.ticks - t0} ticks)`)
  } finally {
    bot.off('physicsTick', onTick)
    bot.clearControlStates()
  }
}
