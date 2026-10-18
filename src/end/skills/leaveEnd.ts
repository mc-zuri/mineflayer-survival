import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { normalizeDimension } from '../../core/memory'
import { TaskError, type SkillOptions, throwIfAborted, waitTicks, waitUntil } from '../../skills/combatUtil'
import { steerToward } from '../../skills/steer'
import { exitPortal } from '../spikes'
import { isInEnd } from './enterEnd'
import { blockGetter, gotoNear, exitPortalOpen, findPortalY } from './world'

// leaveEnd: into the exit portal once the dragon is dead. ServerPlayer.teleport from the End to the overworld sends
// the first time ClientboundGameEventPacket WIN_GAME (1: roll the credits), and waits for the client's
// ServerboundClientCommandPacket PERFORM_RESPAWN to respawn it in the overworld (PlayerList.respawn). Mineflayer
// answers WIN_GAME with the respawn command itself (game.js), as the client does when the credits end.

export interface LeaveEndOptions extends SkillOptions {
  /** ticks to wait for the respawn in the overworld (default 400) */
  respawnTicks?: number
}

export interface LeaveEndResult {
  /** WIN_GAME came: the first exit, the credits */
  credits: boolean
  /** where the bot respawned in the overworld */
  spawn: Vec3
}

export async function leaveEnd (bot: Bot, opts: LeaveEndOptions = {}): Promise<LeaveEndResult> {
  const signal = opts.signal
  if (!isInEnd(bot)) throw new TaskError('NOT_FOUND', 'not in the End')
  const get = blockGetter(bot)
  const portalY = findPortalY(get)
  if (portalY == null) throw new TaskError('NOT_FOUND', 'no exit portal pillar at 0,0')
  const portal = exitPortal(portalY)
  if (!exitPortalOpen(get, portal)) throw new TaskError('NOT_FOUND', 'the exit portal is shut (the dragon lives)')

  let credits = false
  const onGameState = (packet: any): void => {
    if (packet.reason === 4 || packet.reason === 'win_game') credits = true
  }
  bot._client.on('game_state_change', onGameState)
  try {
    // to the rim, then over it into the nearest portal cell
    const cells = portal.portal.map(p => new Vec3(p.x + 0.5, p.y, p.z + 0.5))
    cells.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const cell = cells[0]
    if (bot.entity.position.distanceTo(cell) > 5) await gotoNear(bot, cell.offset(0, 1, 0), 3, { signal })
    for (let t = 0; t < 200 && isInEnd(bot); t++) {
      throwIfAborted(signal)
      steerToward(bot, cell, { sprint: false })
      await waitTicks(bot, 1, signal)
    }
    bot.clearControlStates()
    const home = await waitUntil(bot, () => normalizeDimension(bot.game?.dimension) === 'overworld' && bot.entity.onGround, opts.respawnTicks ?? 400, signal)
    if (!home) throw new TaskError('TIMEOUT', `still in ${String(bot.game?.dimension)} after the exit portal`)
  } finally {
    bot._client.off('game_state_change', onGameState)
    bot.clearControlStates()
  }
  return { credits, spawn: bot.entity.position.clone() }
}
