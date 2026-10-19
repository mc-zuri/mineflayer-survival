// The end gateways: a dragon's death opens one on the main island's ring (EnderDragonFight.spawnNewGateway: the next of
// 20 places on a circle of radius 96 at y 75, their order shuffled by the world's seed), and its first use makes its
// exit out on the outer islands (TheEndGatewayBlockEntity.findOrCreateValidTeleportPos: 1024 blocks on along the
// gateway's direction from 0, 0, the first chunk with blocks in it, the exit gateway 10 over its tallest block). The
// gateway is the EndGatewayFeature: the end_gateway block in a 3 x 5 x 3 of bedrock (a cross a block over and under it,
// a block two over and under), open on all eight sides at its own level. A player is 1.8 high and the opening one:
// the way in is an ender pearl thrown into it (the pearl comes out at the exit with no velocity and lands; the player
// is teleported to where it lands), or flying in with an elytra.
import { Vec3 } from 'vec3'
import type { Pos } from '../core/memory'
import { PEARL_EYE_OFFSET, PEARL_PHYSICS, PEARL_SPEED, arrowHits, solveAim, type AimSolution, type ArrowWorld, type Box } from '../skills/arrow'

/** EnderDragonFight.GATEWAY_COUNT, GATEWAY_DISTANCE and the y of spawnNewGateway's BlockPos */
export const GATEWAY_COUNT = 20
export const GATEWAY_DISTANCE = 96
export const GATEWAY_Y = 75
/** TheEndGatewayBlockEntity.findExitPortalXZPosTentative: the exit's distance along the gateway's direction */
export const GATEWAY_EXIT_DISTANCE = 1024
/** the memory's kind for a gateway; its note is 'main' (on the main island's ring) or 'exit' (out on the islands) */
export const GATEWAY_POI = 'end_gateway'

/**
 * The 20 gateway places in EnderDragonFight's numbering (spawnNewGateway: Mth.floor of 96 cos and 96 sin of
 * 2 (-pi + 0.15707963267948966 i), at y 75). The same in 1.21.11 and 26.3.
 */
export function gatewayPositions (): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < GATEWAY_COUNT; i++) {
    const a = 2.0 * (-3.141592653589793 + 0.15707963267948966 * i)
    out.push(new Vec3(Math.floor(96.0 * Math.cos(a)), GATEWAY_Y, Math.floor(96.0 * Math.sin(a))))
  }
  return out
}

/** the block view the gateway code reads (bot.blockAt, or a test's) */
export type GatewayBlocks = (pos: Vec3) => { name: string, boundingBox: string } | null

/** the gateway places on the ring whose end_gateway block is in the loaded world */
export function openGateways (get: GatewayBlocks): Vec3[] {
  return gatewayPositions().filter(p => get(p)?.name === 'end_gateway')
}

/**
 * Where the exit of a gateway is looked for first (findExitPortalXZPosTentative before its skips past empty and full
 * chunks): 1024 blocks from 0, 0 along the gateway's direction
 */
export function gatewayExitGuess (gateway: Pos): Vec3 {
  const len = Math.hypot(gateway.x, gateway.z)
  if (len < 1e-9) return new Vec3(GATEWAY_EXIT_DISTANCE, GATEWAY_Y, 0)
  return new Vec3(gateway.x / len * GATEWAY_EXIT_DISTANCE, GATEWAY_Y, gateway.z / len * GATEWAY_EXIT_DISTANCE)
}

/** EndGatewayFeature's bedrock round a gateway at `g`: the cross a block over and under, a block two over and under */
export function gatewayFrame (g: Pos): Vec3[] {
  const out: Vec3[] = []
  for (const dy of [-2, -1, 1, 2]) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cross = dx === 0 || dz === 0
        if (Math.abs(dy) === 2 ? (dx === 0 && dz === 0) : cross) out.push(new Vec3(g.x + dx, g.y + dy, g.z + dz))
      }
    }
  }
  return out
}

/** the gateway block's cell as a box */
export function gatewayBox (g: Pos): Box {
  return { min: new Vec3(g.x, g.y, g.z), max: new Vec3(g.x + 1, g.y + 1, g.z + 1) }
}

/** the feet height a pearl is thrown from at the gateway's level: the eye less 0.1 (the pearl's start) a little over the opening's middle */
export function throwFeetY (gateway: Pos, eyeHeight = 1.62): number {
  return Math.round(gateway.y + 0.5 - (eyeHeight - PEARL_EYE_OFFSET))
}

export interface ThrowSpot {
  /** the cell the feet stand in */
  stand: Vec3
  /** the feet height of the ground under it (null: the void, a bridge to it first) */
  ground: number | null
}

/**
 * The cells to throw from: 3 to 5 blocks out from the gateway in 16 directions, at throwFeetY, outside the frame,
 * each with the ground under it (`groundAt` gives a column's feet height, null over the void)
 */
export function throwSpots (gateway: Pos, groundAt: (x: number, z: number, fromY: number) => number | null, eyeHeight = 1.62): ThrowSpot[] {
  const y = throwFeetY(gateway, eyeHeight)
  const seen = new Set<string>()
  const out: ThrowSpot[] = []
  for (const d of [3, 4, 5]) {
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8
      const x = Math.floor(gateway.x + 0.5 + Math.cos(a) * d)
      const z = Math.floor(gateway.z + 0.5 + Math.sin(a) * d)
      if (Math.abs(x - gateway.x) <= 1 && Math.abs(z - gateway.z) <= 1) continue
      const k = `${x},${z}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ stand: new Vec3(x, y, z), ground: groundAt(x, z, y - 1) })
    }
  }
  return out
}

/** the throw spots round a gateway, those over ground first (the nearest to the bot, the lowest pillar), then the void's */
export function rankThrowSpots (spots: ThrowSpot[], from: Vec3): ThrowSpot[] {
  const cost = (s: ThrowSpot): number => s.ground == null
    ? 1e6 + s.stand.distanceTo(from)
    : s.ground > s.stand.y ? Infinity : Math.hypot(s.stand.x - from.x, s.stand.z - from.z) + 3 * (s.stand.y - s.ground)
  return spots.filter(s => Number.isFinite(cost(s))).sort((a, b) => cost(a) - cost(b))
}

/**
 * The aim of a pearl from `start` (the eye less 0.1) into the gateway: the flat arc, else the high one, each checked
 * with the pearl's flight (the frame's bedrock and the world's blocks in the way, `world`) to enter the gateway's cell
 * (the pearl's box meeting it: its half width round the cell). Null when neither does.
 */
export function aimPearl (start: Vec3, gateway: Pos, world?: ArrowWorld): AimSolution | null {
  const middle = new Vec3(gateway.x + 0.5, gateway.y + 0.5, gateway.z + 0.5)
  const opts = { physics: PEARL_PHYSICS, speed: PEARL_SPEED, hitMargin: PEARL_PHYSICS.halfWidth, world }
  for (const highArc of [false, true]) {
    const sol = solveAim(start, middle, { ...opts, highArc })
    if (sol == null) continue
    if (arrowHits(start, sol.yaw, sol.pitch, gatewayBox(gateway), opts).hit != null) return sol
  }
  return null
}

/** a teleport through a gateway is a jump of this many blocks at least (the exit is ~1000 out, the way back as far) */
export const GATEWAY_JUMP = 256
