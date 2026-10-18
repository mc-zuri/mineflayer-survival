import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferThrowDirection, signalTo, simulateEye, EYE_UPDATE_INTERVAL, type Vec } from '../../src/end/eye'

// [tick, x, y, z, dx, dy, dz] after each EyeOfEnder tick, printed (%.17g) by a harness that
// ran the 1.21.11 server classes (mojmap): signalTo, then position += delta and
// EyeOfEnder.updateDeltaMovement (called by reflection) once per tick
const VANILLA_FAR = '[1,100.50000000000000,64.900000000000000,-20.500000000000000,0.027176997470692650,0.015000000000000000,0.012704755349000845][2,100.52717699747069,64.915000000000000,-20.487295244650998,0.054218109954031850,0.029775000000000000,0.025345986921256680][3,100.58139510742473,64.944775000000000,-20.461949257729742,0.081056074381277600,0.044328375000000000,0.037892250447278750][20,105.19945535032348,67.509095556473440,-18.303089522166736,0.44674476753006714,0.26086356665289830,0.20884510811161017][40,111.41867819918052,72.562615882479720,-15.395715194269702,-0.055589557768957826,0.097875050786016270,-0.025987113997420003][60,111.37018993894118,72.834510289166930,-15.418382579961289,0.00062459570687934780,0.040233436568328874,0.00029198720921395314][80,111.37079087009067,72.999783712216910,-15.418101655505174,7.0182983176323940e-06,-0.024804529118262288,3.2809277048182316e-06][81,111.37079788838899,72.974979183098650,-15.418098374577468,5.6028018333619770e-06,-0.034545968945190686,2.6192086645756194e-06]'
const VANILLA_NEAR = '[1,0.50000000000000000,30.900000000000000,0.50000000000000000,0.011250000000000000,-0.015000000000000000,-0.0087500000000000000][2,0.51125000000000000,30.884999999999998,0.49125000000000000,0.022443750000000000,-0.029775000000000000,-0.017456250000000000][3,0.53369375000000000,30.855224999999997,0.47379375000000000,0.033553406249999994,-0.044328375000000000,-0.026097093749999998][20,2.4453537039237823,28.290904443526546,-1.0130528808296082,0.18493134277004300,-0.26086356665289830,-0.14383548882114455][40,5.0146512385366515,23.834003878088815,-3.0113954077507270,-0.015091654122482454,-0.086477082477663800,0.011737953206373006][60,4.9998414917031190,22.345379421494666,-2.9998767157690980,0.00016957446662500329,-0.070888697679702420,-0.00013189125181348193][80,4.9999979779125180,20.929658483003040,-2.9999984272652904,1.9054745294408134e-06,-0.070755858719478860,-1.4820357461435806e-06][81,4.9999998833870470,20.858902624283560,-2.9999999093010365,1.5208019011073158e-06,-0.070755616670949350,-1.1828459224399604e-06]'

function parse (s: string): number[][] {
  return s.slice(1, -1).split('][').map(r => r.split(',').map(Number))
}

function close (a: number, b: number, what: string): void {
  assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)), `${what}: ${a} vs vanilla ${b}`)
}

for (const [name, data, spawn, structure] of [
  ['a far stronghold (stand-in target 12 out, 8 up)', VANILLA_FAR, { x: 100.5, y: 64.9, z: -20.5 }, { x: 1000, y: 0, z: 400 }],
  ['a stronghold within 12 blocks', VANILLA_NEAR, { x: 0.5, y: 30.9, z: 0.5 }, { x: 5, y: 0, z: -3 }]
] as Array<[string, string, Vec, Vec]>) {
  test(`the eye flight matches vanilla per tick for ${name}`, () => {
    const sim = simulateEye(spawn, structure)
    assert.equal(sim.length, 81)
    for (const [t, x, y, z, dx, dy, dz] of parse(data)) {
      const s = sim[t - 1]
      close(s.position.x, x, `x at tick ${t}`)
      close(s.position.y, y, `y at tick ${t}`)
      close(s.position.z, z, `z at tick ${t}`)
      close(s.deltaMovement.x, dx, `dx at tick ${t}`)
      close(s.deltaMovement.y, dy, `dy at tick ${t}`)
      close(s.deltaMovement.z, dz, `dz at tick ${t}`)
    }
  })
}

test('signalTo caps the target at 12 blocks out and 8 up', () => {
  const t = signalTo({ x: 0, y: 70, z: 0 }, { x: 300, y: 0, z: 400 })
  assert.deepEqual(t, { x: 300 / 500 * 12, y: 78, z: 400 / 500 * 12 })
  assert.deepEqual(signalTo({ x: 0, y: 70, z: 0 }, { x: 3, y: 0, z: 4 }), { x: 3, y: 0, z: 4 })
})

/** what the client sees: the spawn, then a position every 4 ticks, quantised to 1/4096 */
function observed (spawn: Vec, structure: Vec, ticks = 81): Vec[] {
  const q = (v: number): number => Math.round(v * 4096) / 4096
  return simulateEye(spawn, structure, ticks)
    .filter((_, i) => (i + 1) % EYE_UPDATE_INTERVAL === 0)
    .map(s => ({ x: q(s.position.x), y: q(s.position.y), z: q(s.position.z) }))
}

test('the throw direction is recovered from the positions the client sees', () => {
  const spawn = { x: 12.3, y: 71.9, z: -40.7 }
  const structure = { x: -1600, y: 0, z: 960 }
  const dir = inferThrowDirection({ spawn, positions: observed(spawn, structure) })
  assert.ok(dir != null)
  const want = Math.atan2(structure.z - spawn.z, structure.x - spawn.x)
  const got = Math.atan2(dir.direction.z, dir.direction.x)
  assert.ok(Math.abs(got - want) < 1e-4, `angle off by ${got - want}`)
  assert.equal(dir.near, undefined)
  assert.ok(Math.abs(dir.travelled - 12) < 0.1)
  // the first 20 ticks are enough for a usable direction
  const early = inferThrowDirection({ spawn, positions: observed(spawn, structure, 20) })
  assert.ok(early != null && Math.abs(Math.atan2(early.direction.z, early.direction.x) - want) < 1e-3)
})

test('an eye that settles short of 12 blocks gives the stronghold itself', () => {
  const spawn = { x: 100.5, y: 30.9, z: 200.5 }
  const structure = { x: 96, y: 0, z: 208 }
  const dir = inferThrowDirection({ spawn, positions: observed(spawn, structure) })
  assert.ok(dir?.near != null)
  assert.ok(Math.hypot(dir.near.x - structure.x, dir.near.z - structure.z) < 0.05)
})
