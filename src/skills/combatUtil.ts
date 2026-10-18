import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskError } from '../core/errors'

/** mineflayer's entity (prismarine-entity's, without depending on it) */
export type Entity = Bot['entities'][string]

// A skill either returns what it observed or throws a TaskError (src/core/errors) with a code the planner branches on.
export { TaskError, type TaskErrorCode } from '../core/errors'

export interface SkillOptions {
  signal?: AbortSignal
}

/** throws the signal's reason (the runner's PREEMPTED or ABORTED TaskError), or ABORTED */
export function throwIfAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason ?? new TaskError('ABORTED')
}

/** Waits n physics ticks (lockstep friendly: no wall clock), throwing if the signal aborts. */
export async function waitTicks (bot: Bot, n: number, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < n; i++) {
    throwIfAborted(signal)
    await bot.waitForTicks(1)
  }
  throwIfAborted(signal)
}

/** Waits until the predicate holds, checking once a physics tick; false if it doesn't within maxTicks. */
export async function waitUntil (bot: Bot, predicate: () => boolean, maxTicks: number, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return true
    await waitTicks(bot, 1, signal)
  }
  return predicate()
}

/** The index of an entity's synched data field on this version (minecraft-data's metadataKeys), or the fallback. */
export function metadataIndex (bot: Bot, entityName: string, key: string, fallback: number): number {
  const keys: string[] | undefined = (bot.registry.entitiesByName as any)[entityName]?.metadataKeys
  const i = keys?.indexOf(key) ?? -1
  return i >= 0 ? i : fallback
}

/** An entity's synched data field by its name (e.g. a creeper's swell_dir), or undefined. */
export function metadataValue (bot: Bot, entity: Entity, key: string): unknown {
  const keys: string[] | undefined = (bot.registry.entitiesByName as any)[entity.name ?? '']?.metadataKeys
  const i = keys?.indexOf(key) ?? -1
  return i >= 0 ? (entity.metadata as any)?.[i] : undefined
}

/** The entity is still in the world: tracked, and its health (LivingEntity.DATA_HEALTH_ID) not 0. */
export function isAlive (bot: Bot, entity: Entity): boolean {
  if (bot.entities[entity.id] !== entity) return false
  const health = metadataValue(bot, entity, 'health')
  return typeof health !== 'number' || health > 0
}

export function entityName (entity: Entity): string {
  return entity.name ?? ''
}

/** The entity's bounding box (Entity.getBoundingBox: width around its feet, height up). */
export function entityBox (entity: { position: Vec3, width?: number, height?: number }): { min: Vec3, max: Vec3 } {
  const w = (entity.width ?? 0.6) / 2
  const h = entity.height ?? 1.8
  const p = entity.position
  return { min: new Vec3(p.x - w, p.y, p.z - w), max: new Vec3(p.x + w, p.y + h, p.z + w) }
}

/** Distance from a point to the nearest point of a box. */
export function distanceToBox (point: Vec3, box: { min: Vec3, max: Vec3 }): number {
  const dx = Math.max(box.min.x - point.x, 0, point.x - box.max.x)
  const dy = Math.max(box.min.y - point.y, 0, point.y - box.max.y)
  const dz = Math.max(box.min.z - point.z, 0, point.z - box.max.z)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function eyePosition (bot: Bot): Vec3 {
  return bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0)
}

/** mineflayer's yaw and pitch (radians, yaw 0 facing -z, pitch up positive) from a direction. */
export function yawPitchOf (dir: Vec3): { yaw: number, pitch: number } {
  const yaw = Math.atan2(-dir.x, -dir.z)
  const pitch = Math.atan2(dir.y, Math.sqrt(dir.x * dir.x + dir.z * dir.z))
  return { yaw, pitch }
}

/** The direction mineflayer's yaw and pitch look along (as bot.entity's view direction). */
export function directionOf (yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c)
}

export function clearControls (bot: Bot): void {
  bot.clearControlStates()
}
