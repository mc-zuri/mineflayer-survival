// The end gateway's places, frame, throw spots and the pearl's aim into it, without a server.
import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { aimPearl, gatewayExitGuess, gatewayFrame, gatewayPositions, openGateways, rankThrowSpots, throwFeetY, throwSpots } from '../../src/end/gateway'
import { PEARL_EYE_OFFSET, PEARL_PHYSICS, launchVelocity, simulateArrow } from '../../src/skills/arrow'

test('the 20 gateway places are EnderDragonFight\'s: a circle of 96 at y 75, Mth.floor of each', () => {
  const ps = gatewayPositions()
  assert.strictEqual(ps.length, 20)
  // the list the game makes (spawnNewGateway's x and z for i = 0 .. 19)
  const xz = [[96, 0], [91, 29], [77, 56], [56, 77], [29, 91], [-1, 96], [-30, 91], [-57, 77], [-78, 56], [-92, 29],
    [-96, -1], [-92, -30], [-78, -57], [-57, -78], [-30, -92], [0, -96], [29, -92], [56, -78], [77, -57], [91, -30]]
  assert.deepStrictEqual(ps.map(p => [p.x, p.z]), xz)
  assert.ok(ps.every(p => p.y === 75))
})

test('the frame is EndGatewayFeature\'s bedrock: a cross a block over and under the gateway, a block two over and under', () => {
  const g = new Vec3(96, 75, 0)
  const frame = gatewayFrame(g)
  assert.strictEqual(frame.length, 12)
  assert.ok(frame.some(p => p.equals(new Vec3(97, 76, 0))))
  assert.ok(frame.some(p => p.equals(new Vec3(96, 77, 0))))
  assert.ok(!frame.some(p => p.equals(new Vec3(97, 76, 1))), 'the corners are open')
  assert.ok(!frame.some(p => p.y === 75), 'its own level is open all round')
})

test('the exit is looked for 1024 out along the gateway\'s direction', () => {
  const e = gatewayExitGuess({ x: -57, y: 75, z: 77 })
  assert.ok(Math.abs(Math.hypot(e.x, e.z) - 1024) < 1e-9)
  assert.ok(e.x < 0 && e.z > 0)
})

// an island round 0, 0 of radius 100 (its top at y 60) and the gateway at (96, 75, 0) with its frame, the rest the void
function islandWorld (radius = 100) {
  const g = new Vec3(96, 75, 0)
  const frame = gatewayFrame(g)
  return (p: Vec3): { name: string, boundingBox: string } => {
    if (p.equals(g)) return { name: 'end_gateway', boundingBox: 'empty' }
    if (frame.some(f => f.equals(p))) return { name: 'bedrock', boundingBox: 'block' }
    if (p.y <= 60 && p.y >= 50 && Math.hypot(p.x, p.z) < radius) return { name: 'end_stone', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
}

function groundAt (get: (p: Vec3) => { boundingBox: string } | null) {
  return (x: number, z: number, fromY: number): number | null => {
    for (let y = fromY; y >= 0; y--) if (get(new Vec3(x, y, z))?.boundingBox === 'block') return y + 1
    return null
  }
}

test('the open gateways are the ring\'s places with an end_gateway block', () => {
  assert.deepStrictEqual(openGateways(islandWorld()).map(p => p.toString()), [new Vec3(96, 75, 0).toString()])
})

test('the throw spots: 3 to 5 out at the opening\'s height (feet 74, the pearl leaving at 75.52), over ground first, the void last', () => {
  const g = new Vec3(96, 75, 0)
  assert.strictEqual(throwFeetY(g), 74)
  assert.ok(Math.abs(74 + 1.62 - PEARL_EYE_OFFSET - 75.5) < 0.05)
  const get = islandWorld()
  const spots = throwSpots(g, groundAt(get))
  assert.ok(spots.length >= 30)
  assert.ok(spots.every(s => s.stand.y === 74 && Math.max(Math.abs(s.stand.x - 96), Math.abs(s.stand.z)) >= 2))
  const ranked = rankThrowSpots(spots, new Vec3(0, 61, 0))
  // the nearest over the island (inside the radius of 100), on the island's top
  assert.strictEqual(ranked[0].ground, 61)
  assert.ok(ranked[0].stand.x < 96)
  // over the void (the island smaller than the ring) every spot is, and they come nearest the bot first
  const voidSpots = rankThrowSpots(throwSpots(g, groundAt(islandWorld(80))), new Vec3(0, 61, 0))
  assert.ok(voidSpots.every(s => s.ground == null))
  assert.ok(voidSpots[0].stand.x <= 93)
})

test('the pearl\'s aim from a throw spot goes into the gateway between its bedrock, checked against the blocks', () => {
  const g = new Vec3(96, 75, 0)
  const get = islandWorld()
  // a clip that walks the segment in small steps, stopping at the first solid cell (the frame's bedrock)
  const clip = (from: Vec3, to: Vec3): Vec3 | null => {
    const d = to.minus(from)
    const n = Math.ceil(d.norm() / 0.02)
    for (let i = 1; i <= n; i++) {
      const p = from.plus(d.scaled(i / n))
      if (get(p.floored())?.boundingBox === 'block') return p
    }
    return null
  }
  for (const stand of [new Vec3(92, 74, 0), new Vec3(93, 74, 3), new Vec3(96, 74, -5)]) {
    const start = stand.offset(0.5, 1.62 - PEARL_EYE_OFFSET, 0.5)
    const sol = aimPearl(start, g, { clip })
    assert.ok(sol != null, `no aim from ${stand.toString()}`)
    const flight = simulateArrow(start, launchVelocity(sol.yaw, sol.pitch, 1.5), { physics: PEARL_PHYSICS, world: { clip }, target: { min: g, max: g.offset(1, 1, 1) }, hitMargin: PEARL_PHYSICS.halfWidth, maxTicks: 40 })
    assert.ok(flight.hit != null && flight.blocked == null, `the pearl from ${stand.toString()} doesn't get in`)
  }
  // from under the frame's cross (feet 71) the flat arc meets the bedrock; the high one comes down on the top's bedrock too
  const low = new Vec3(93.5, 71 + 1.62 - PEARL_EYE_OFFSET, 0.5)
  assert.strictEqual(aimPearl(low, g, { clip }), null)
})
