import type { Bot } from 'mineflayer'
import type { Entity } from './combatUtil'
import { Vec3 } from 'vec3'

/**
 * Entity velocities from their positions tick by tick (the server moves most mobs, the dragon among them, with
 * move packets and seldom sends their velocity). The velocity is the mean displacement a tick over the last samples.
 */
export class MotionTracker {
  private readonly samples = new Map<number, Vec3[]>()
  private readonly onTick = (): void => this.sample()

  constructor (private readonly bot: Bot, public window = 5) {
    bot.on('physicsTick', this.onTick)
  }

  track (entity: Entity): void {
    if (!this.samples.has(entity.id)) this.samples.set(entity.id, [entity.position.clone()])
  }

  untrack (entity: Entity): void {
    this.samples.delete(entity.id)
  }

  sample (): void {
    for (const [id, list] of this.samples) {
      const entity = this.bot.entities[id]
      if (entity == null) { this.samples.delete(id); continue }
      list.push(entity.position.clone())
      if (list.length > this.window + 1) list.shift()
    }
  }

  /** blocks a tick, or zero until it has two samples */
  velocity (entity: Entity): Vec3 {
    const list = this.samples.get(entity.id)
    if (list == null || list.length < 2) return new Vec3(0, 0, 0)
    return list[list.length - 1].minus(list[0]).scaled(1 / (list.length - 1))
  }

  detach (): void {
    this.bot.off('physicsTick', this.onTick)
    this.samples.clear()
  }
}

const trackers = new WeakMap<Bot, MotionTracker>()
export function motionTrackerOf (bot: Bot): MotionTracker {
  let t = trackers.get(bot)
  if (t == null) trackers.set(bot, t = new MotionTracker(bot))
  return t
}
