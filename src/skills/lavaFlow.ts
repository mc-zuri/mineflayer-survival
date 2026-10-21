// Lava about to flow into the bot's cells: escaped before it touches the bot, not once it burns (the hazard reflex's
// inHazard fires only in the lava). Lava spreads on its update (LavaFluid.getTickDelay: every 30 ticks in the
// overworld, 10 in the nether) from a cell over the one it flows into always, and sideways while its level, one more a
// block from the source (LavaFluid.getDropOff: 2 in the overworld, 1 in the nether), is still under 8; a falling
// column (level 8 and up) spreads sideways again where it lands.
//
// advancingLavaAt is after mine-ai-mcp's src/world/lava-flow.ts (advancingLavaAt), MIT License, Copyright (c) 2026
// AI Bengineering: "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, ... The above
// copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software."
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

/** a lava block's level (its state's `level`: 0 the source, 1 to 7 flowing, 8 and up falling) */
export function lavaLevel (block: { getProperties?: () => Record<string, unknown> }): number {
  const level = Number(block.getProperties?.().level ?? 0)
  return Number.isFinite(level) ? level : 0
}

/** the lava a body cell is reached from: over it, or beside it at a level that still spreads (LavaFluid.getDropOff) */
const FROM: Array<[number, number, number]> = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]]

/**
 * Whether the lava beside the body's dry cells at `position` (the bot's own by default; a stand's, to refuse it) can
 * flow into one of them on its next update: the lava over a cell always; beside one when it's falling (level 8 and
 * up) or its level and the drop-off still under 8. `source`: only the lava at that cell is looked at (a block update's).
 */
export function advancingLavaAt (bot: Bot, position: Vec3 = bot.entity.position, source?: Vec3): boolean {
  const half = ((bot.entity as any)?.width ?? 0.6) / 2
  const height = (bot.entity as any)?.height ?? 1.8
  const decay = /nether/.test(String(bot.game?.dimension ?? '')) ? 1 : 2
  for (let x = Math.floor(position.x - half + 0.001); x <= Math.floor(position.x + half - 0.001); x++) {
    for (let z = Math.floor(position.z - half + 0.001); z <= Math.floor(position.z + half - 0.001); z++) {
      for (let y = Math.floor(position.y); y <= Math.floor(position.y + height - 0.001); y++) {
        const cell = new Vec3(x, y, z)
        const body = bot.blockAt(cell)
        if (body == null || body.boundingBox === 'block' || body.name === 'water' || body.name === 'lava') continue
        for (const [dx, dy, dz] of FROM) {
          const from = cell.offset(dx, dy, dz)
          if (source != null && !source.equals(from)) continue
          const neighbour = bot.blockAt(from)
          if (neighbour?.name !== 'lava') continue
          const level = lavaLevel(neighbour as any)
          if (dy === 1 || level >= 8 || level + decay < 8) return true
        }
      }
    }
  }
  return false
}

/** each watched bot's mark: a lava block changed beside its body that could flow into it */
const marks = new WeakMap<Bot, { advancing: boolean }>()

/**
 * Watches the block updates for lava that changed beside the bot's body and could flow into it next (once a bot): the
 * mark lavaAdvancing reads. A still pool beside a stand the bot walked to is none (its flow there already happened or
 * can't), a flow come up to it, or a dig that let the lava in, is.
 */
export function watchAdvancingLava (bot: Bot): void {
  if (marks.has(bot)) return
  const mark = { advancing: false }
  marks.set(bot, mark)
  ;(bot as any).on?.('blockUpdate', (before: any, after: any) => {
    if (after?.name !== 'lava' || before?.stateId === after.stateId || bot.entity == null) return
    if (advancingLavaAt(bot, bot.entity.position, after.position)) mark.advancing = true
  })
}

/** whether lava marked as coming (watchAdvancingLava) can still flow into the bot's cells; the mark let go when not */
export function lavaAdvancing (bot: Bot): boolean {
  const mark = marks.get(bot)
  if (mark == null || !mark.advancing) return false
  mark.advancing = advancingLavaAt(bot)
  return mark.advancing
}

/** how far up beside a stand lava keeps the escape off it (lavaNear): a falling column there comes down beside the body */
export const LAVA_NEAR_UP = 3

/**
 * Whether lava is beside a stand's cells or over them (the 3 by 3 columns round its feet, from the feet to LAVA_NEAR_UP
 * over them): a stand the escape doesn't take. A flow off a block over the bot's head fell down the columns either
 * side of a stand under it, beside its body two updates on, and the bot burned there (tests/integration/lavaFlow 'over')
 */
export function lavaNear (bot: Bot, feet: Vec3): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= LAVA_NEAR_UP; dy++) {
        if (bot.blockAt(feet.offset(dx, dy, dz))?.name === 'lava') return true
      }
    }
  }
  return false
}
