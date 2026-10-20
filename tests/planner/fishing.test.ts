// Fishing as a food source of the planner: a rod and water, the catches the fish needs; the water as the sightings see
// it (open, or ice over it to break); and a frozen pond's hole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { obtainAll } from '../../src/planner/obtain'
import { checkPlan } from '../../src/planner/steps'
import { FISHING } from '../../src/planner/sources'
import { FOOD_GOAL, FOOD_POINTS } from '../../src/planner/progression'
import { Sightings } from '../../src/executor/sight'
import { fishableWaterNear, iceHole, iceOverWater } from '../../src/skills/fish'
import { VERSIONS } from '../versions'

/* eslint-disable @typescript-eslint/no-var-requires */
const registryOf = (v: string): any => require('minecraft-data')(v)

const food = [{ item: FOOD_GOAL, count: FOOD_POINTS, unit: 'nutrition' as const }]
const kit = { crafting_table: 1, stone_pickaxe: 1, iron_sword: 1, furnace: 1, coal: 16 }

for (const version of VERSIONS) {
  test(`${version}: fish for cod: a rod crafted of sticks and string, the catches the cod needs, the salmon along`, () => {
    const registry = registryOf(version)
    const plan = obtainAll(registry, [{ item: 'cod', count: 5 }], { inventory: { ...kit, stick: 3, string: 2 }, exclude: ['kill'] })
    assert.ok(plan.ok)
    const fish = plan.steps.find(s => s.kind === 'fish') as any
    assert.ok(fish != null, plan.steps.map(s => s.kind).join(', '))
    assert.equal(fish.catches, Math.ceil(5 / 0.51))
    assert.ok(fish.extra.some((e: any) => e.name === 'salmon'))
    assert.ok(plan.steps.findIndex(s => s.kind === 'craft' && s.item === 'fishing_rod') < plan.steps.indexOf(fish))
    assert.ok(checkPlan(registry, plan.steps, { ...kit, stick: 3, string: 2 }).ok)
    assert.ok(!checkPlan(registry, [fish], kit).ok, 'no fish step without a rod')
  })

  test(`${version}: the food plan fishes in the water in sight once the land's animals and plants weren't found`, () => {
    const registry = registryOf(version)
    // a frozen pond by the bot: ice over water
    const blocks = new Map<string, string>()
    for (let x = 6; x <= 10; x++) for (let z = -2; z <= 2; z++) { blocks.set(`${x},63,${z}`, 'ice'); blocks.set(`${x},62,${z}`, 'water') }
    const bot: any = { registry, game: { dimension: 'overworld' }, entity: { id: 0, position: new Vec3(0, 64, 0) } }
    bot.entities = { 0: bot.entity }
    bot.blockAt = (p: Vec3) => { const name = blocks.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 63 ? 'stone' : 'air'); return { name, position: p, getProperties: () => ({ level: 0 }) } }
    bot.findBlocks = ({ matching }: { matching: number[] }) => [...blocks.entries()]
      .filter(([, n]) => matching.includes(registry.blocksByName[n].id))
      .map(([k]) => new Vec3(...(k.split(',').map(Number) as [number, number, number])))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const s = new Sightings(bot, () => 0)
    assert.ok(fishableWaterNear(bot, bot.entity.position) != null)
    for (let i = 0; i < 2; i++) s.missing(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'sweet_berry_bush', 'melon', 'kelp', 'kelp_plant', 'carrots', 'potatoes', 'wheat', 'beetroots', 'hay_block'])
    const inventory = { ...kit, stick: 3, string: 2 }
    const plan = obtainAll(registry, food, { inventory, findCost: t => s.cost(t), exclude: ['farm'] })
    const steps = plan.steps.map(st => `${st.kind} ${st.item}`)
    assert.ok(steps.some(st => st.startsWith('fish ')), steps.join(', '))
    assert.ok(steps.some(st => st === 'smelt cooked_cod' || st === 'smelt cooked_salmon'), steps.join(', '))
  })
}

test('FISHING: the fishing loot table\'s fish (85 of 100, cod 60 of them, salmon 25), a catch in 450 ticks', () => {
  const cod = FISHING.drops.find(d => d.item === 'cod')?.count ?? 0
  assert.ok(Math.abs(cod - 0.85 * 0.6) < 1e-9)
  assert.ok(Math.abs((FISHING.drops.find(d => d.item === 'salmon')?.count ?? 0) - 0.85 * 0.25) < 1e-9)
  assert.equal(FISHING.catchTicks, 450)
})

test('iceHole: the 3 x 3 of ice over water about the nearest ice cell with enough of it; none on ice over ground', () => {
  const pond = (p: Vec3): any => {
    if (p.y === 63 && p.x >= 0 && p.x <= 4 && p.z >= 0 && p.z <= 4) return { name: 'ice' }
    if (p.y === 62 && p.x >= 0 && p.x <= 4 && p.z >= 0 && p.z <= 4) return { name: 'water' }
    return { name: p.y < 63 ? 'stone' : 'air' }
  }
  assert.equal(iceOverWater(pond, new Vec3(2, 63, 2)), true)
  assert.equal(iceOverWater(pond, new Vec3(2, 62, 2)), false)
  // the corner has 4 of its 3 x 3 over water: the next one in
  const hole = iceHole(pond, [new Vec3(0, 63, 0), new Vec3(1, 63, 1)])
  assert.ok(hole != null)
  assert.ok(hole[0].equals(new Vec3(1, 63, 1)), hole[0].toString())
  assert.equal(hole.length, 9)
  const rink = (p: Vec3): any => ({ name: p.y === 63 ? 'ice' : p.y < 63 ? 'stone' : 'air' })
  assert.equal(iceHole(rink, [new Vec3(1, 63, 1)]), null)
})

test('checkPlan: a farm step harvesting a farm sown already needs no hoe; one sowing new plots does', () => {
  const registry: any = require('minecraft-data')('26.3')
  const harvest: any = { kind: 'farm', item: 'wheat', count: 8, crop: 'wheat', seed: 'wheat_seeds', plots: 0, cycles: 1, cost: 100 }
  assert.ok(checkPlan(registry, [harvest], {}).ok, JSON.stringify(checkPlan(registry, [harvest], {}).error))
  const sow: any = { ...harvest, plots: 4 }
  assert.equal(checkPlan(registry, [sow], { wheat_seeds: 4 }).error?.reason, 'no hoe')
  assert.ok(checkPlan(registry, [sow], { wheat_seeds: 4, wooden_hoe: 1 }).ok)
})
