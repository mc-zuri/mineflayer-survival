// A trident drowned's zone kept off by the work's paths: the cells within TRIDENT_ZONE_RANGE of one known in the water
// that it sees cost TRIDENT_ZONE_COST more a step (the pathfinder's exclusionAreasStep), so the work's walks go round
// it, not back into its reach. The hostiles reflex's keep-off took a 26.3 bot out of a drowned's range, and the work
// ('exploring for a skeleton') walked it back each time, till a trident killed it (f6-26.3, t232374).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

/** how far a trident drowned's zone reaches (the hostiles reflex's TRIDENT_KEEP_OFF) */
export const TRIDENT_ZONE_RANGE = 24
/** the extra cost of a step in a zone (a step's own is some 4 to 5): far round it, never through it but for need */
export const TRIDENT_ZONE_COST = 200
/** ticks a trident drowned is kept as known after it was last seen (it sinks out of sight, it's still there) */
export const TRIDENT_ZONE_TICKS = 1200
/** ticks between the looks at the drowned about, and the zone's sight cache's life */
const LOOK_TICKS = 10

interface Known { id: number, eyes: Vec3, seen: number }
interface Zone { known: Map<number, Known>, tick: number, sight: Map<string, boolean> }
const zones = new WeakMap<Bot, Zone>()

function zoneOf (bot: Bot): Zone {
  let z = zones.get(bot)
  if (z == null) zones.set(bot, z = { known: new Map(), tick: 0, sight: new Map() })
  return z
}

/** whether a mob is a trident drowned in the water (its feet's cell, or half a block up, water) */
export function tridentDrownedInWater (bot: Bot, e: any): boolean {
  if (e?.name !== 'drowned' || e.position == null) return false
  const held = e.heldItem ?? e.equipment?.[0]
  if (held?.name !== 'trident') return false
  for (const dy of [0, 0.5]) {
    const b: any = bot.blockAt(e.position.offset(0, dy, 0))
    if (b != null && (b.name === 'water' || b.name === 'bubble_column' || /kelp|seagrass/.test(b.name) || b.getProperties?.()?.waterlogged === true)) return true
  }
  return false
}

/** the trident drowned about noted (their eyes, when), the ones unseen past TRIDENT_ZONE_TICKS forgotten */
export function noteTridentDrowned (bot: Bot, tick: number): void {
  const z = zoneOf(bot)
  z.tick = tick
  for (const e of Object.values(bot.entities ?? {})) {
    if (!tridentDrownedInWater(bot, e)) continue
    const health = (e as any).metadata?.[9]
    if (typeof health === 'number' && health <= 0) { z.known.delete(e.id); continue }
    z.known.set(e.id, { id: e.id, eyes: e.position.offset(0, (e.height ?? 1.95) * 0.85, 0), seen: tick })
  }
  for (const [id, k] of z.known) if (tick - k.seen > TRIDENT_ZONE_TICKS || (bot.entities?.[id] != null && (bot.entities[id] as any).isValid === false)) z.known.delete(id)
  z.sight.clear()
}

/** whether full blocks cut the line from `from` to `to` (the world's raycast, else a step a quarter block) */
function cut (bot: Bot, from: Vec3, to: Vec3): boolean {
  const delta = to.minus(from)
  const dist = delta.norm()
  if (dist < 1e-6) return false
  const raycast = (bot.world as any)?.raycast
  if (typeof raycast === 'function') {
    const hit: any = raycast.call(bot.world, from, delta.scaled(1 / dist), dist)
    return hit != null && (hit.intersect == null || hit.intersect.distanceTo(from) < dist - 1e-4)
  }
  for (let t = 0.25; t < dist; t += 0.25) if (bot.blockAt(from.plus(delta.scaled(t / dist)))?.boundingBox === 'block') return true
  return false
}

/** whether a cell (the feet's: its head's middle looked at) is in a known trident drowned's zone: within range and in its sight */
export function inTridentZone (bot: Bot, cell: { x: number, y: number, z: number }): boolean {
  const z = zoneOf(bot)
  if (z.known.size === 0) return false
  const key = `${cell.x},${cell.y},${cell.z}`
  const cached = z.sight.get(key)
  if (cached != null) return cached
  const head = new Vec3(cell.x + 0.5, cell.y + 1.6, cell.z + 0.5)
  let inside = false
  for (const k of z.known.values()) {
    if (k.eyes.distanceTo(head) > TRIDENT_ZONE_RANGE) continue
    if (!cut(bot, k.eyes, head)) { inside = true; break }
  }
  z.sight.set(key, inside)
  return inside
}

/** the pathfinder's step rule of the zones: TRIDENT_ZONE_COST for a step into a cell in one (inTridentZone) */
export function tridentZoneStepCost (bot: Bot): (block: { position: { x: number, y: number, z: number } }) => number {
  return (block) => inTridentZone(bot, block.position) ? TRIDENT_ZONE_COST : 0
}

/** tridentZoneStepCost added to the pathfinder's step rules for good, and the drowned about looked at every LOOK_TICKS (once) */
export function keepOffTridentZones (bot: Bot): void {
  const pf = bot.pathfinder as any
  const settings = pf?.defaultMoveSettings
  if (pf?.setMoveOptions == null || settings == null) return
  if ((settings.exclusionAreasStep ?? []).some((f: any) => f.survivalTridents === true)) return
  const cost = tridentZoneStepCost(bot)
  ;(cost as any).survivalTridents = true
  pf.setMoveOptions({ ...settings, exclusionAreasStep: [...(settings.exclusionAreasStep ?? []), cost] })
  let tick = 0
  bot.on?.('physicsTick' as any, () => { if (++tick % LOOK_TICKS === 0) noteTridentDrowned(bot, tick) })
  bot.on?.('death' as any, () => zoneOf(bot).known.clear())
  bot.on?.('entityDead' as any, (e: any) => { if (e?.id != null) zoneOf(bot).known.delete(e.id) })
}
