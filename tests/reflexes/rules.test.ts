import { test } from 'node:test'
import assert from 'node:assert'
import { Vec3 } from 'vec3'
import { dropsReflex, armorReflex, creeperReflex, drowningReflex, eatReflex, emergencyEatReflex, hazardReflex, hostilesReflex, nightChoice, nightReflex, totemReflex, type NightChoiceInputs } from '../../src/reflexes/rules'
import { ReflexEngine } from '../../src/reflexes/engine'
import { DEFAULT_REFLEX_CONFIG, type ReflexConfigInput } from '../../src/reflexes/config'
import type { Reflex } from '../../src/reflexes/types'
import { CREEPER_IGNITED_INDEX, CREEPER_SWELL_DIR_INDEX, creeperSwelling } from '../../src/skills/fight'
import { metadataIndex } from '../../src/skills/combatUtil'
import { rememberShelter, setTicksSinceRest, shelter, shelterToLeave } from '../../src/skills/shelter'
import { entity, fakeBot, item, type FakeBotInput } from './fakeBot'

const at = (x: number, y = 64, z = 0.5): Vec3 => new Vec3(0.5 + x, y, z)

function check (reflex: Reflex, input: FakeBotInput, config: ReflexConfigInput = {}, setup?: (engine: ReflexEngine) => void): string | null {
  const bot = fakeBot(input)
  const engine = new ReflexEngine(bot, { config, enabled: false })
  setup?.(engine)
  const task = reflex.check(engine.context())
  engine.stop()
  return task == null ? null : (task.detail ?? task.name)
}

test('the creeper\'s fuse fields on 1.21.11: swell_dir at 16, is_ignited at 18 (Creeper.DATA_SWELL_DIR, DATA_IS_IGNITED)', () => {
  const bot = fakeBot()
  assert.strictEqual(metadataIndex(bot, 'creeper', 'swell_dir', -1), 16)
  assert.strictEqual(metadataIndex(bot, 'creeper', 'is_ignited', -1), 18)
  assert.strictEqual(CREEPER_SWELL_DIR_INDEX, 16)
  assert.strictEqual(CREEPER_IGNITED_INDEX, 18)
  assert.strictEqual(creeperSwelling(bot, entity({ name: 'creeper', position: at(2), meta: { swell_dir: 1 } })), true)
  assert.strictEqual(creeperSwelling(bot, entity({ name: 'creeper', position: at(2), meta: { swell_dir: -1 } })), false)
  assert.strictEqual(creeperSwelling(bot, entity({ name: 'creeper', position: at(2), meta: { swell_dir: -1, is_ignited: true } })), true)
})

test('creeper reflex: a swelling creeper within the blast, or any within 3 blocks', () => {
  const creeper = (x: number, swell: number): any => entity({ name: 'creeper', position: at(x), meta: { swell_dir: swell } })
  assert.strictEqual(check(creeperReflex, { entities: [creeper(5, -1)] }), null)
  assert.strictEqual(check(creeperReflex, { entities: [creeper(5, 1)] }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(2.5, -1)] }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(9, 1)] }), null)
  // configurable
  assert.strictEqual(check(creeperReflex, { entities: [creeper(4, -1)] }, { creeper: { triggerDistance: 5 } }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(9, 1)] }, { creeper: { safeDistance: 10 } }), 'evade creeper')
  assert.strictEqual(check(creeperReflex, { entities: [creeper(2, 1)] }, { creeper: { enabled: false } }), null)
})

test('eat reflex: at food 14 out of combat, or at low health with no hostile in reach', () => {
  const bread = [item('bread', 5)]
  assert.strictEqual(check(eatReflex, { food: 14, items: bread }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 15, items: bread }), null)
  assert.strictEqual(check(eatReflex, { food: 14, items: [] }), null)
  // a zombie in range: combat
  const zombie = entity({ name: 'zombie', position: at(5) })
  assert.strictEqual(check(eatReflex, { food: 10, items: bread, entities: [zombie] }), null)
  // hurt a moment ago: combat
  assert.strictEqual(check(eatReflex, { food: 10, items: bread }, {}, e => { (e as any).lastHurtTick = e.tick - 5 }), null)
  // low health: eat even in combat once nothing's within reach
  assert.strictEqual(check(eatReflex, { food: 18, health: 8, items: bread }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 18, health: 8, items: bread, entities: [zombie] }), null)
  assert.strictEqual(check(eatReflex, { food: 18, health: 8, items: bread, entities: [entity({ name: 'zombie', position: at(12) })] }), 'eat')
  // only rotten flesh: not until starving
  assert.strictEqual(check(eatReflex, { food: 12, items: [item('rotten_flesh', 4)] }), null)
  assert.strictEqual(check(eatReflex, { food: 6, items: [item('rotten_flesh', 4)] }), 'eat')
  // configurable
  assert.strictEqual(check(eatReflex, { food: 12, items: bread }, { eat: { food: 10 } }), null)
  assert.strictEqual(check(eatReflex, { food: 19, health: 12, items: bread }, { eat: { health: 12 } }), 'eat')
})

test('hostiles reflex: fight the nearest, flee when hurt or outnumbered', () => {
  const zombie = (x: number, y = 64): any => entity({ name: 'zombie', position: at(x, y) })
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(10)] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(3, 70)] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)], health: 6 }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(3), zombie(4), zombie(5), zombie(6)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(3), zombie(4), zombie(5), zombie(6)], items: [item('stone_sword')] }, { hostiles: { maxFight: 5 } }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)], health: 10 }, { hostiles: { fleeHealth: 10 } }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)] }, { hostiles: { fleeUnarmed: true } }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(5)], items: [item('iron_sword')] }, { hostiles: { fleeUnarmed: true } }), 'fight zombie')
  // neutral mobs and bosses aren't fought; passive ones aren't hostile
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'enderman', position: at(3) }), entity({ name: 'cow', position: at(2) })] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(7) })], items: [item('stone_sword')] }), 'fight skeleton')
})

test('hostiles reflex: creepers are shot from a distance, fought only with a shield, else fled', () => {
  const creeper = (x: number): any => entity({ name: 'creeper', position: at(x) })
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(6)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(6)], items: [item('bow'), item('arrow', 16)] }), 'shoot creeper')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(4)], items: [item('bow'), item('arrow', 16)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(4), entity({ name: 'zombie', position: at(5) })], items: [item('stone_sword')] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [creeper(4)], offhand: item('shield') }), 'fight creeper')
})

test('hazard reflex: in lava, or fire at the feet', () => {
  assert.strictEqual(check(hazardReflex, {}), null)
  assert.strictEqual(check(hazardReflex, { inLava: true }), 'hazard')
  assert.strictEqual(check(hazardReflex, { world: p => p.y === 64 ? 'fire' : p.y < 64 ? 'stone' : 'air' }), 'hazard')
  assert.strictEqual(check(hazardReflex, { world: p => p.y === 63 ? 'lava' : p.y < 63 ? 'stone' : 'air' }), null)
  assert.strictEqual(check(hazardReflex, { inLava: true }, { hazard: { enabled: false } }), null)
})

test('drowning reflex: surface when the air is low with the head under water', () => {
  const underwater = (p: Vec3): string => p.y < 60 ? 'stone' : p.y < 70 ? 'water' : 'air'
  assert.strictEqual(check(drowningReflex, { oxygen: 5, world: underwater }), 'drowning')
  assert.strictEqual(check(drowningReflex, { oxygen: 6, world: underwater }), 'drowning')
  assert.strictEqual(check(drowningReflex, { oxygen: 7, world: underwater }), null)
  assert.strictEqual(check(drowningReflex, { oxygen: 5 }), null)
  assert.strictEqual(check(drowningReflex, { oxygen: 10, world: underwater }, { drowning: { air: 12 } }), 'drowning')
})

test('armor reflex: when better armor comes into the inventory', () => {
  assert.strictEqual(check(armorReflex, { items: [item('iron_chestplate')] }), 'armor')
  assert.strictEqual(check(armorReflex, { items: [item('iron_chestplate')] }, {}, e => { (e as any).armorChanged = false }), null)
  assert.strictEqual(check(armorReflex, { items: [item('leather_chestplate')], armor: { torso: item('iron_chestplate') } }), null)
})

test('totem reflex: a totem goes to the off hand, unless the shield is up there', () => {
  const totem = [item('totem_of_undying')]
  assert.strictEqual(check(totemReflex, { items: totem }), 'totem')
  assert.strictEqual(check(totemReflex, { items: [] }), null)
  assert.strictEqual(check(totemReflex, { offhand: item('totem_of_undying') }), null)
  assert.strictEqual(check(totemReflex, { items: totem, offhand: item('shield'), usingHeldItem: true }), null)
  assert.strictEqual(check(totemReflex, { items: totem }, { totem: { always: false } }), null)
  assert.strictEqual(check(totemReflex, { items: totem, health: 8 }, { totem: { always: false } }), 'totem')
})

test('hostiles and creeper reflexes leave alone what has no line of sight to the bot (a wall, a shelter\'s roof)', () => {
  // a stone wall at x 2 from y 64 to 66, between the bot (x 0.5) and the mobs further along x
  const wall = (pos: Vec3): string => pos.y < 64 ? 'stone' : pos.x === 2 && pos.y <= 66 ? 'stone' : 'air'
  const zombie = entity({ name: 'zombie', position: at(4) })
  assert.strictEqual(check(hostilesReflex, { entities: [zombie] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie], world: wall }), null)
  const creeper = (meta?: Record<string, unknown>): any => entity({ name: 'creeper', position: at(2.2), meta })
  assert.strictEqual(check(creeperReflex, { entities: [creeper()], world: (p) => p.y < 64 ? 'stone' : p.x === 1 && p.y <= 66 ? 'stone' : 'air' }), null)
  assert.strictEqual(check(creeperReflex, { entities: [creeper()] }), 'evade creeper')
  // swelling, it sees the bot (the server says so): evade whatever the client's blocks say
  assert.strictEqual(check(creeperReflex, { entities: [creeper({ swell_dir: 1 })], world: (p) => p.y < 64 ? 'stone' : p.x === 1 && p.y <= 66 ? 'stone' : 'air' }), 'evade creeper')
  // the bot in a hole three deep (feet at 61), sealed at 63; a zombie standing on the seal
  const hole = (p: Vec3): string => (p.x === 0 && p.z === 0 && (p.y === 61 || p.y === 62)) ? 'air' : p.y < 64 ? 'dirt' : 'air'
  const above = entity({ name: 'zombie', position: new Vec3(0.5, 64, 0.5) })
  assert.strictEqual(check(hostilesReflex, { position: new Vec3(0.5, 61, 0.5), entities: [above], world: hole }), null)
})

test('night reflex: at night a bed means sleep, poor gear a shelter, good gear nothing (the hostiles reflex fights); not by day or underground', () => {
  const night = (input: FakeBotInput, time: number, setup?: (bot: any) => void): string | null => {
    const bot = fakeBot(input)
    bot.time = { timeOfDay: time }
    bot.game.dimension = 'overworld'
    setup?.(bot)
    const engine = new ReflexEngine(bot, { enabled: false })
    const task = nightReflex.check(engine.context())
    engine.stop()
    return task == null ? null : (task.detail ?? task.name)
  }
  const early = { items: [item('stone_sword'), item('bread', 4)] }
  assert.strictEqual(night(early, 13000), 'shelter')
  assert.strictEqual(night(early, 6000), null)
  assert.strictEqual(night(early, 23500), null)
  assert.strictEqual(night({ items: [...early.items, item('white_bed')] }, 13000), 'sleep')
  const iron = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') }
  assert.strictEqual(night({ armor: iron, items: [item('iron_sword')] }, 13000), null)
  assert.strictEqual(night(early, 13000, bot => { bot.game.dimension = 'the_nether' }), null)
  // in a mine (rock over the head): not a night out; under a tree's leaves it is
  assert.strictEqual(night({ ...early, world: (p: Vec3) => p.y < 64 || p.y >= 70 ? 'stone' : 'air' }, 13000), null)
  assert.strictEqual(night({ ...early, world: (p: Vec3) => p.y < 64 ? 'stone' : p.y === 69 ? 'oak_leaves' : 'air' }, 13000), 'shelter')
  assert.strictEqual(night(early, 13000, bot => { bot.isSleeping = true }), null)
  assert.strictEqual(night(early, 13000), 'shelter')
  // the runner's night mining on its way down: no shelter
  assert.strictEqual(night(early, 13000, bot => { bot.survival = { ...bot.survival, nightWork: true } }), null)
  // turned off
  const bot = fakeBot(early)
  bot.time = { timeOfDay: 13000 }
  const engine = new ReflexEngine(bot, { enabled: false, config: { night: { shelter: false } } })
  assert.strictEqual(nightReflex.check(engine.context()), null)
  engine.stop()
})

test('hostiles reflex: a skeleton shooting from 12 blocks is taken on (the ones that shoot count to rangedRange, 16), a zombie there isn\'t', () => {
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(12) })], items: [item('stone_sword')] }), 'fight skeleton')
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'pillager', position: at(14) })], items: [item('stone_sword')] }), 'fight pillager')
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'zombie', position: at(12) })] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(15) })] }, { hostiles: { rangedRange: 8 } }), null)
  const wall = (pos: Vec3): string => pos.y < 64 ? 'stone' : pos.x === 4 && pos.y <= 66 ? 'stone' : 'air'
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(12) })], world: wall }), null)
})

test('eat reflex: hurt and out of combat, eat up to food 18, where the health comes back (FoodData.tick)', () => {
  const bread = [item('bread', 5)]
  assert.strictEqual(check(eatReflex, { food: 16, health: 14, items: bread }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 15, health: 19, items: bread }), 'eat')
  // full health, or food 18 already: no need
  assert.strictEqual(check(eatReflex, { food: 16, health: 20, items: bread }), null)
  assert.strictEqual(check(eatReflex, { food: 18, health: 14, items: bread }), null)
  // not in a fight
  assert.strictEqual(check(eatReflex, { food: 16, health: 14, items: bread, entities: [entity({ name: 'zombie', position: at(5) })] }), null)
  assert.strictEqual(check(eatReflex, { food: 16, health: 14, items: bread }, { eat: { regenFood: 0 } }), null)
})

test('hostiles reflex: at low health an armored bot with a weapon fights on against one hostile, flees from two', () => {
  const zombie = (x: number): any => entity({ name: 'zombie', position: at(x) })
  const iron = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('iron_boots') }
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: iron, items: [item('iron_sword')] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4), zombie(6)], health: 5, armor: iron, items: [item('iron_sword')] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: iron }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: { torso: item('leather_chestplate') }, items: [item('iron_sword')] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [zombie(4)], health: 5, armor: iron, items: [item('iron_sword')] }, { hostiles: { fightOnArmor: 21 } }), 'flee')
})

test('hostiles reflex: an armed and armored bot is not outnumbered by the cubes of a split magma cube or slime: it fights them; unarmored, or among other mobs, it flees', () => {
  const cube = (x: number, name = 'magma_cube'): any => entity({ name, position: at(x), meta: { health: 4 } })
  const zombie = (x: number): any => entity({ name: 'zombie', position: at(x) })
  const diamond = { head: item('diamond_helmet'), torso: item('diamond_chestplate'), legs: item('diamond_leggings'), feet: item('diamond_boots') }
  const sword = [item('diamond_sword')]
  const cubes = [cube(2), cube(3), cube(4), cube(5), cube(6)]
  assert.strictEqual(check(hostilesReflex, { entities: cubes, armor: diamond, items: sword }), 'fight magma_cube')
  assert.strictEqual(check(hostilesReflex, { entities: [cube(2, 'slime'), cube(3, 'slime'), cube(4, 'slime'), cube(5, 'slime')], armor: diamond, items: sword }), 'fight slime')
  assert.strictEqual(check(hostilesReflex, { entities: cubes, items: sword }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: cubes, armor: diamond }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [cube(2), zombie(3), zombie(4), zombie(5), zombie(6)], armor: diamond, items: sword }), 'flee')
})

test('hostiles reflex: the fight with slimes and magma cubes keeps to its level (SWARM_MAX_DROP), others step down as far as does no harm', async () => {
  const { meleeOptions, SWARM_MAX_DROP } = await import('../../src/reflexes/rules')
  const config = { ...DEFAULT_REFLEX_CONFIG }
  assert.strictEqual(SWARM_MAX_DROP, 1)
  assert.strictEqual(meleeOptions({ name: 'magma_cube' }, config).maxDrop, 1)
  assert.strictEqual(meleeOptions({ name: 'slime' }, config).maxDrop, 1)
  assert.strictEqual(meleeOptions({ name: 'zombie' }, config).maxDrop, undefined)
  assert.strictEqual(meleeOptions({ name: 'enderman' }, config).aimHeight, 0.3)
  // an enderman's fight on the bot's level too (knocked off a ledge to its death, 26.3)
  assert.strictEqual(meleeOptions({ name: 'enderman' }, config).maxDrop, SWARM_MAX_DROP)
})

test('hostiles reflex: a blaze in sight within 16 is held off where the bot stands when it has a shield (holdOffBlazes), fought without one', () => {
  const blaze = (x: number): any => entity({ name: 'blaze', position: at(x, 66), meta: { health: 20 } })
  const sword = [item('diamond_sword')]
  assert.strictEqual(check(hostilesReflex, { entities: [blaze(12)], items: sword, offhand: item('shield') }), 'hold off blaze')
  assert.strictEqual(check(hostilesReflex, { entities: [blaze(5)], items: sword }), 'fight blaze')
  assert.strictEqual(check(hostilesReflex, { entities: [blaze(20)], items: sword, offhand: item('shield') }), null)
})

test('night reflex: by day, a bot still down its shelter\'s column (cut off climbing out) is got out; out of it, nothing', () => {
  const bot = fakeBot({ position: new Vec3(0.5, 62, 0.5), items: [item('stone_sword'), item('dirt', 3)] })
  bot.time = { timeOfDay: 1000 }
  bot.game.dimension = 'overworld'
  const engine = new ReflexEngine(bot, { enabled: false })
  assert.strictEqual(nightReflex.check(engine.context()), null)
  rememberShelter(bot, new Vec3(0, 64, 0))
  assert.strictEqual(nightReflex.check(engine.context())?.detail, 'leave shelter')
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  assert.strictEqual(nightReflex.check(engine.context()), null)
  // and forgotten once out
  bot.entity.position = new Vec3(0.5, 62, 0.5)
  assert.strictEqual(shelterToLeave(bot), null)
  engine.stop()
})

test('creeper reflex: leaves a creeper the hostiles reflex is fighting with a shield to the fight (it blocks the blast itself)', () => {
  const creeper = entity({ name: 'creeper', position: at(2.2) })
  const fighting = (e: ReflexEngine): void => { (e as any).running = { task: { name: 'hostiles', priority: 60, detail: 'fight creeper' }, cancel: () => {} } }
  assert.strictEqual(check(creeperReflex, { entities: [creeper], offhand: item('shield') }, {}, fighting), null)
  // no shield: run
  assert.strictEqual(check(creeperReflex, { entities: [creeper] }, {}, fighting), 'evade creeper')
  // not fighting it: run
  assert.strictEqual(check(creeperReflex, { entities: [creeper], offhand: item('shield') }), 'evade creeper')
})

test('hostiles reflex: an enderman is let be until it hurts the bot, then fought back for a while; a warden never', () => {
  const enderman = entity({ name: 'enderman', position: at(3) })
  const warden = entity({ name: 'warden', position: at(3) })
  assert.strictEqual(check(hostilesReflex, { entities: [enderman], items: [item('stone_sword')] }), null)
  const hurtBy = (attacker: any) => (e: ReflexEngine): void => { (e as any).onHurt((e as any).bot.entity, attacker) }
  assert.strictEqual(check(hostilesReflex, { entities: [enderman], items: [item('stone_sword')] }, {}, hurtBy(enderman)), 'fight enderman')
  assert.strictEqual(check(hostilesReflex, { entities: [warden], items: [item('stone_sword')] }, {}, hurtBy(warden)), null)
  // long ago: let be again
  assert.strictEqual(check(hostilesReflex, { entities: [enderman], items: [item('stone_sword')] }, {}, (e) => { hurtBy(enderman)(e); (e as any).tick += 401 }), null)
})

test('night reflex: no ground to dig in about (the sea all round): tried again only after 200 ticks, twice as far out', async () => {
  const bot = fakeBot({ items: [item('stone_sword')], world: (p: Vec3) => p.y < 64 ? 'water' : 'air' })
  bot.time = { timeOfDay: 13000 }
  bot.game.dimension = 'overworld'
  const engine = new ReflexEngine(bot, { enabled: false })
  const ctx = engine.context()
  const task = nightReflex.check(ctx)
  assert.strictEqual(task?.detail, 'shelter')
  await assert.rejects(task!.run(new AbortController().signal), /NOT_FOUND/)
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 100 }), null)
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 200 })?.detail, 'shelter')
  engine.stop()
})

test('nightChoice: below the surface at work the night is work, the bed only with the rest due; a failed bed not again that night', () => {
  const base: NightChoiceInputs = { plan: 'sleep', sleep: true, shelter: true, underground: false, restDue: false, sleepFailed: false, out: true }
  assert.strictEqual(nightChoice(base), 'sleep')
  assert.strictEqual(nightChoice({ ...base, underground: true, out: false }), 'work')
  assert.strictEqual(nightChoice({ ...base, underground: true, out: false, restDue: true }), 'sleep')
  assert.strictEqual(nightChoice({ ...base, underground: true, out: false, restDue: true, sleep: false }), 'work')
  assert.strictEqual(nightChoice({ ...base, underground: true, out: false, plan: 'shelter' }), 'work')
  assert.strictEqual(nightChoice({ ...base, underground: true, out: false, plan: 'shelter', restDue: true }), 'work')
  // the bed failed this night: out in it, a shelter; below the surface, work
  assert.strictEqual(nightChoice({ ...base, sleepFailed: true }), 'shelter')
  assert.strictEqual(nightChoice({ ...base, sleepFailed: true, shelter: false }), 'work')
  assert.strictEqual(nightChoice({ ...base, sleepFailed: true, out: false }), 'work')
  assert.strictEqual(nightChoice({ ...base, underground: true, out: false, restDue: true, sleepFailed: true }), 'work')
  assert.strictEqual(nightChoice({ ...base, plan: 'fight' }), 'work')
  assert.strictEqual(nightChoice({ ...base, plan: 'shelter' }), 'shelter')
  assert.strictEqual(nightChoice({ ...base, plan: 'shelter', out: false }), 'work')
})

/** a 1-wide staircase down along +x through stone to y 80: the step at x has its feet at 75 - x, open to feet + 2 */
const staircase = (p: Vec3): string => p.z === 0 && p.x >= 0 && p.x <= 20 && p.y >= 75 - p.x && p.y <= 77 - p.x ? 'air' : p.y < 80 ? 'stone' : 'air'

test('night reflex: down a 1-wide staircase with a bed in the bag the night is work; the bed when the rest is due (the phantoms\' 72000 ticks)', () => {
  const night = (input: FakeBotInput, setup?: (bot: any) => void): string | null => {
    const bot = fakeBot(input)
    bot.time = { timeOfDay: 13000 }
    bot.game.dimension = 'overworld'
    bot.findBlock = () => null
    setup?.(bot)
    const engine = new ReflexEngine(bot, { enabled: false })
    const task = nightReflex.check(engine.context())
    engine.stop()
    return task == null ? null : (task.detail ?? task.name)
  }
  const kit = [item('stone_sword'), item('stone_pickaxe'), item('white_bed')]
  const down = new Vec3(10.5, 65, 0.5)
  assert.strictEqual(night({ items: kit, world: staircase, position: down }), null)
  assert.strictEqual(night({ items: kit, world: staircase, position: down }, bot => setTicksSinceRest(bot, 47999)), null)
  assert.strictEqual(night({ items: kit, world: staircase, position: down }, bot => setTicksSinceRest(bot, 48000)), 'sleep')
  // no bed: the staircase is no night out either
  assert.strictEqual(night({ items: [item('stone_sword')], world: staircase, position: down }), null)
  // its first step, under two blocks of rock: not underground yet, the bed as on the surface
  assert.strictEqual(night({ items: kit, world: staircase, position: new Vec3(0.5, 75, 0.5) }), 'sleep')
  // a wide dark cave a few blocks down (the surface's monsters come down it): the bed
  const cave = (p: Vec3): string => Math.abs(p.x) <= 10 && Math.abs(p.z) <= 10 && p.y >= 60 && p.y <= 70 ? 'air' : p.y < 75 ? 'stone' : 'air'
  assert.strictEqual(night({ items: kit, world: cave, position: new Vec3(0.5, 60, 0.5) }), 'sleep')
  // deep down (16 blocks of rock over the head): work
  const deep = (p: Vec3): string => Math.abs(p.x) <= 10 && Math.abs(p.z) <= 10 && p.y >= 60 && p.y <= 70 ? 'air' : p.y < 90 ? 'stone' : 'air'
  assert.strictEqual(night({ items: kit, world: deep, position: new Vec3(0.5, 60, 0.5) }), null)
})

test('night reflex: a bed that failed is not tried again that night (the shelter instead, its search backing off twice as long each time); the next night it is', async () => {
  const bot = fakeBot({ items: [item('stone_sword'), item('white_bed')], world: (p: Vec3) => p.y < 64 ? 'water' : 'air' })
  bot.time = { timeOfDay: 13000 }
  bot.game.dimension = 'overworld'
  bot.findBlock = () => null
  const engine = new ReflexEngine(bot, { enabled: false })
  const ctx = engine.context()
  const sleep = nightReflex.check(ctx)
  assert.strictEqual(sleep?.detail, 'sleep')
  // no room for the bed on the sea, nor ground for a shelter
  await assert.rejects(sleep!.run(new AbortController().signal), /NOT_FOUND|CANNOT_PLACE/)
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 100 }), null)
  const shelter = nightReflex.check({ ...ctx, tick: ctx.tick + 200 })
  assert.strictEqual(shelter?.detail, 'shelter')
  await assert.rejects(shelter!.run(new AbortController().signal), /NOT_FOUND/)
  // the second time, 400 ticks on
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 599 }), null)
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 600 })?.detail, 'shelter')
  // the day forgets the failed bed
  bot.time = { timeOfDay: 1000 }
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 700 }), null)
  bot.time = { timeOfDay: 13000 }
  assert.strictEqual(nightReflex.check({ ...ctx, tick: ctx.tick + 900 })?.detail, 'sleep')
  engine.stop()
})

test('armor reflex: better armor in the bag goes on before the fight with the zombie at hand (it outranks the hostiles reflex)', () => {
  const bot = fakeBot({ entities: [entity({ name: 'zombie', position: at(3) })], items: [item('iron_sword'), item('iron_chestplate')] })
  const engine = new ReflexEngine(bot, { enabled: false })
  assert.strictEqual(engine.evaluate()?.name, 'armor')
  assert.ok(DEFAULT_REFLEX_CONFIG.armor.priority > DEFAULT_REFLEX_CONFIG.hostiles.priority)
  engine.stop()
})

test('hostiles reflex: a neutral animal that hurt the bot (a polar bear by its cub) is fought back; let be before', () => {
  const bear = entity({ name: 'polar_bear', position: at(2) })
  const hurtBy = (attacker: any) => (e: ReflexEngine): void => { (e as any).onHurt((e as any).bot.entity, attacker) }
  assert.strictEqual(check(hostilesReflex, { entities: [bear], items: [item('stone_sword')] }), null)
  assert.strictEqual(check(hostilesReflex, { entities: [bear], items: [item('stone_sword')] }, {}, hurtBy(bear)), 'fight polar_bear')
  // a cow is never fought, hurt or not (nothing hurts like that)
  const cow = entity({ name: 'cow', position: at(2) })
  assert.strictEqual(check(hostilesReflex, { entities: [cow], items: [item('stone_sword')] }, {}, hurtBy(cow)), null)
})

test('emergency eat: at 8 health or less a golden apple is eaten, two angry endermen hitting or not', () => {
  const enderman = (x: number): any => entity({ name: 'enderman', position: at(x) })
  assert.strictEqual(check(emergencyEatReflex, { health: 7, food: 20, items: [item('golden_apple', 2)], entities: [enderman(1), enderman(-1)] }), 'golden_apple')
  assert.strictEqual(check(emergencyEatReflex, { health: 7, items: [item('golden_apple', 1), item('enchanted_golden_apple', 1)] }), 'enchanted_golden_apple')
  assert.strictEqual(check(emergencyEatReflex, { health: 9, items: [item('golden_apple', 2)] }), null)
  assert.strictEqual(check(emergencyEatReflex, { health: 4, items: [item('bread', 5)] }), null)
})

test('eat reflex: starving (food 6 or less) the bot eats with a zombie in range too', () => {
  const zombie = entity({ name: 'zombie', position: at(5) })
  assert.strictEqual(check(eatReflex, { food: 6, items: [item('bread', 16)], entities: [zombie] }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 0, health: 1, items: [item('bread', 16)], entities: [zombie] }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 7, items: [item('bread', 16)], entities: [zombie] }), null)
})

test('a slime, a magma cube, a phantom and a hoglin are hostiles too (minecraft-data types them mob and animal)', async () => {
  const { isHostile } = await import('../../src/reflexes/rules')
  const bot = fakeBot()
  for (const name of ['slime', 'magma_cube', 'phantom', 'hoglin', 'zombie']) assert.strictEqual(isHostile(bot, entity({ name, position: at(3) })), true, name)
  for (const name of ['cow', 'villager']) assert.strictEqual(isHostile(bot, entity({ name, position: at(3) })), false, name)
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'slime', position: at(3) })], items: [item('diamond_sword', 1)] }), 'fight slime')
})

test('night reflex: no shelter by night nor leave-shelter by day while a shelter() task runs (it gets in and out by itself)', async () => {
  // a bot in a sealed hole, the feet at 61 (its column's surface cell at 64)
  const hole = (p: Vec3): string => p.x === 0 && p.z === 0 && (p.y === 61 || p.y === 62) ? 'air' : p.y < 64 ? 'dirt' : 'air'
  const bot = fakeBot({ position: new Vec3(0.5, 61, 0.5), items: [item('dirt', 3)], world: hole })
  bot.game.dimension = 'overworld'
  bot.time = { timeOfDay: 13000 }
  const engine = new ReflexEngine(bot, { enabled: false })
  const seen: Array<string | null> = []
  // the runner's 'wait out the night' task in its hole: the night and then the morning
  const ticker = setInterval(() => bot.emit('physicsTick'), 1)
  await shelter(bot, {
    torch: false,
    leave: false,
    until: () => {
      seen.push(nightReflex.check(engine.context())?.detail ?? null)
      bot.time.timeOfDay = 1000
      return seen.length >= 2
    }
  }).finally(() => clearInterval(ticker))
  assert.deepStrictEqual(seen, [null, null])
  // the task done (cut off, say) with the bot still down its column: the reflex gets it out
  assert.strictEqual(nightReflex.check(engine.context())?.detail, 'leave shelter')
  engine.stop()
})

test('hostiles reflex: with fists only, the ones that shoot and more than one are fled, a lone zombie fought (26.3 full-26.3-m: a pillager patrol, a skeleton and a spider, fought bare)', () => {
  const mob = (name: string, x: number): any => entity({ name, position: at(x) })
  for (const name of ['pillager', 'skeleton', 'stray', 'witch']) {
    assert.strictEqual(check(hostilesReflex, { entities: [mob(name, 6)] }), 'flee', name)
    assert.strictEqual(check(hostilesReflex, { entities: [mob(name, 6)], items: [item('iron_sword')] }), `fight ${name}`, name)
  }
  assert.strictEqual(check(hostilesReflex, { entities: [mob('spider', 3), mob('skeleton', 6)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [mob('zombie', 3), mob('zombie', 5)] }), 'flee')
  assert.strictEqual(check(hostilesReflex, { entities: [mob('zombie', 3), mob('zombie', 5)], items: [item('wooden_sword')] }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [mob('zombie', 3)] }), 'fight zombie')
  // an axe is a weapon; a pickaxe's hits a second are no better than the fist's (3 at 1.2 a second, 1 at 4)
  assert.strictEqual(check(hostilesReflex, { entities: [mob('skeleton', 6)], items: [item('stone_axe')] }), 'fight skeleton')
  assert.strictEqual(check(hostilesReflex, { entities: [mob('skeleton', 6)], items: [item('stone_pickaxe')] }), 'flee')
})

test('hostiles reflex: a bare bot\'s fight with a lone spider is given up once a skeleton comes into sight (until), to flee', async () => {
  const spider = entity({ name: 'spider', position: at(3) })
  const bot = fakeBot({ entities: [spider] })
  const engine = new ReflexEngine(bot, { enabled: false })
  const task = hostilesReflex.check(engine.context())
  assert.strictEqual(task?.detail, 'fight spider')
  const skeleton = entity({ name: 'skeleton', position: at(8) })
  bot.entities[skeleton.id] = skeleton
  const result: any = await task!.run(new AbortController().signal)
  assert.strictEqual(result.killed, false)
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'flee')
  engine.stop()
})

test('hostiles reflex in the nether: a fight on a leash, an archer past it held off from where the bot stands with the bow, not chased on (nether-26.3-q3: a skeleton chased into the lava sea)', async () => {
  const { pastLeash, letBeInNether, NETHER_LEASH, NETHER_FIGHT_DROP, meleeOptions } = await import('../../src/reflexes/rules')
  const { ARCHER_BUDGET } = await import('../../src/nether/safety')
  const nether = (e: ReflexEngine): void => { (e as any).bot.game.dimension = 'the_nether' }
  const kit = [item('diamond_sword'), item('bow'), item('arrow', 32)]
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(10) })], items: kit }, {}, nether), 'fight skeleton')
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'skeleton', position: at(10) })], items: kit }), 'fight skeleton')
  assert.strictEqual(check(hostilesReflex, { entities: [entity({ name: 'zombified_piglin', position: at(3) })], items: kit }, {}, (e) => { nether(e); (e as any).onHurt((e as any).bot.entity, (e as any).bot.entities[Object.keys((e as any).bot.entities).find(k => k !== '1') as string]) }), 'fight zombified_piglin')
  assert.strictEqual(meleeOptions({ name: 'wither_skeleton' }, DEFAULT_REFLEX_CONFIG, true).maxDrop, 1)
  assert.strictEqual(meleeOptions({ name: 'wither_skeleton' }, DEFAULT_REFLEX_CONFIG).maxDrop, undefined)
  // the leash: NETHER_LEASH across, NETHER_FIGHT_DROP down
  const a = new Vec3(0.5, 64, 0.5)
  assert.equal(pastLeash(a, new Vec3(0.5 + NETHER_LEASH - 0.5, 64, 0.5)), false)
  assert.equal(pastLeash(a, new Vec3(0.5 + NETHER_LEASH + 0.5, 64, 0.5)), true)
  assert.equal(pastLeash(a, new Vec3(0.5, 64 - NETHER_FIGHT_DROP - 1, 0.5)), true)
  // an archer fought from (0.5, 64, 0.5); the bot past its leash, it is held off; held off ARCHER_BUDGET ticks in all, let be
  const bot = fakeBot({ items: kit })
  bot.game.dimension = 'the_nether'
  const skeleton = entity({ name: 'skeleton', position: at(10) })
  bot.entities[skeleton.id] = skeleton
  const engine = new ReflexEngine(bot, { enabled: false })
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight skeleton')
  bot.entity.position = new Vec3(10.5, 63, 0.5)
  skeleton.position = new Vec3(14.5, 64, 0.5)
  const task = hostilesReflex.check(engine.context())
  assert.strictEqual(task?.detail, 'hold off skeleton')
  assert.equal(letBeInNether(bot, skeleton, 0), false)
  const safety = require('../../src/nether/safety')
  const real = safety.holdOffArcher
  safety.holdOffArcher = async (_b: unknown, _e: unknown, o: any) => { o.onHold(ARCHER_BUDGET) }
  try { await task.run(new AbortController().signal) } finally { safety.holdOffArcher = real }
  assert.equal(letBeInNether(bot, skeleton, 0), true)
  assert.strictEqual(hostilesReflex.check(engine.context()), null)
  engine.stop()
})

test('holdOffArcher: off a ledge over lava first, then the shield up while the skeleton draws, never a step toward it', async () => {
  const { holdOffArcher } = await import('../../src/nether/safety')
  const navigate = require('../../src/skills/navigate')
  // a ledge: stone under x <= 0, lava from x 1 at y 62 (two under the feet)
  const world = (p: Vec3): string => p.y === 63 && p.x <= 0 ? 'stone' : p.y <= 62 && p.x >= 1 ? 'lava' : p.y < 63 ? 'stone' : 'air'
  const skeleton = entity({ name: 'skeleton', position: new Vec3(-9.5, 64, 0.5), meta: { living_entity_flags: 1 } })
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5), world, entities: [skeleton], offhand: item('shield') })
  bot.game.dimension = 'the_nether'
  ;(bot as any).world = { raycast: () => null }
  bot.waitForTicks = async (n: number) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  let raised = 0
  bot.activateItem = () => { raised++; bot.usingHeldItem = true }
  bot.deactivateItem = () => { bot.usingHeldItem = false }
  const walks: Vec3[] = []
  const realWalk = navigate.walkTo
  navigate.walkTo = async (_b: any, to: Vec3) => { walks.push(to); bot.entity.position = to.clone(); bot.emit('physicsTick') }
  const forward: boolean[] = []
  const set = bot.setControlState
  bot.setControlState = (k: string, v: boolean) => { if (k === 'forward') forward.push(v); set(k, v) }
  const ticking = setInterval(() => bot.emit('physicsTick'), 1)
  try {
    await holdOffArcher(bot, skeleton as any, { maxTicks: 30 })
  } finally {
    clearInterval(ticking)
    navigate.walkTo = realWalk
  }
  assert.ok(walks.length >= 1 && walks[0].x < 0, walks.map(w => w.toString()).join(' '))
  assert.ok(raised >= 1, 'no shield')
  assert.ok(!forward.includes(true), 'it walked at the skeleton')
})

test('hostiles reflex: cornered (the flee found no way), an armed bot fights where it stands, a creeper too, for CORNERED_TICKS; the creeper reflex leaves that fight be (full-26.3-fresh-d, nether-26.3-q3)', async () => {
  const { CORNERED_TICKS, wasCornered } = await import('../../src/reflexes/rules')
  // a tunnel 1 wide along x: stone all round but the cells at y 64 and 65, z 0
  const tunnel = (p: Vec3): string => (p.z === 0 && (p.y === 64 || p.y === 65) && p.x > -3 && p.x < 3) ? 'air' : 'stone'
  const skeleton = entity({ name: 'skeleton', position: at(1) })
  const bot = fakeBot({ health: 4, items: [item('stone_sword')], entities: [skeleton], world: tunnel })
  ;(bot as any).world = { raycast: () => null }
  bot.waitForTicks = async () => {}
  const engine = new ReflexEngine(bot, { enabled: false })
  const first = hostilesReflex.check(engine.context())
  assert.strictEqual(first?.detail, 'flee')
  await assert.rejects(first.run(new AbortController().signal), /cornered/)
  assert.equal(wasCornered(bot, engine.tick), true)
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight skeleton')
  // a creeper, no shield: fought too
  delete bot.entities[skeleton.id]
  const creeper = entity({ name: 'creeper', position: at(2) })
  bot.entities[creeper.id] = creeper
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'fight creeper')
  const ctx = { ...engine.context(), running: { name: 'hostiles', priority: 60, detail: 'fight creeper' } }
  assert.strictEqual(creeperReflex.check(ctx as any), null)
  // long after: the flee again
  ;(engine as any).tick += CORNERED_TICKS + 1
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'flee')
  engine.stop()
})

test('eat reflex: the food kept for a trip (setFoodReserve) is eaten into only starving or hurt; food over it is eaten as before; none kept in the nether', async () => {
  const { setFoodReserve, foodReserve } = await import('../../src/skills/eat')
  const run = (input: FakeBotInput, kept: number, dimension?: string): string | null => {
    const bot = fakeBot(input)
    if (dimension != null) bot.game.dimension = dimension
    setFoodReserve(bot, kept, 1000)
    const engine = new ReflexEngine(bot, { config: {}, enabled: false })
    const task = eatReflex.check(engine.context())
    engine.stop()
    return task == null ? null : (task.detail ?? task.name)
  }
  // 16 cooked beef, 128 points, 120 kept: one eaten leaves 120
  const beef = (n: number): any[] => [item('cooked_beef', n)]
  assert.strictEqual(run({ food: 12, items: beef(16) }, 120), 'eat')
  // 15, 120 points: kept whole at food 12
  assert.strictEqual(run({ food: 12, items: beef(15) }, 120), null)
  // starving, or hurt: eaten
  assert.strictEqual(run({ food: 6, items: beef(15) }, 120), 'eat')
  assert.strictEqual(run({ food: 12, health: 9, items: beef(15) }, 120), 'eat')
  // none kept: eaten
  assert.strictEqual(run({ food: 12, items: beef(15) }, 0), 'eat')
  // in the nether the food is the fight's
  assert.strictEqual(run({ food: 12, items: beef(15) }, 120, 'the_nether'), 'eat')
  const bot = fakeBot()
  setFoodReserve(bot, 120, 1000)
  assert.strictEqual(foodReserve(bot), 120)
  bot.survival = { tasks: { tick: 1000 } }
  assert.strictEqual(foodReserve(bot), 0)
})

test('hostiles reflex: an armed bot\'s fight with one of two zombies is given up once its health falls to fleeHealth (until: fightTurned), to flee; more coming do not end it (full-26.3-fresh-l)', async () => {
  const { fleeDue, fightTurned } = await import('../../src/reflexes/rules')
  const zombies = [entity({ name: 'zombie', position: at(2) }), entity({ name: 'zombie', position: at(3) })]
  const kit = { items: [item('diamond_sword')], armor: { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('golden_boots') } }
  const bot = fakeBot({ entities: zombies, ...kit, health: 12 })
  bot.attack = () => {}
  bot.equip = async () => {}
  const engine = new ReflexEngine(bot, { enabled: false })
  const task = hostilesReflex.check(engine.context())
  assert.strictEqual(task?.detail, 'fight zombie')
  let ticks = 0
  bot.waitForTicks = async () => { if (++ticks === 5) bot.health = 5 }
  const result: any = await task!.run(new AbortController().signal)
  assert.strictEqual(result.killed, false)
  assert.ok(ticks <= 6, `the fight went on ${ticks} ticks`)
  assert.strictEqual(hostilesReflex.check(engine.context())?.detail, 'flee')
  engine.stop()
  // one zombie: an armed bot fights on at low health; a second, it flees
  const lone = fakeBot({ entities: [zombies[0]], ...kit, health: 5 })
  assert.strictEqual(fleeDue(lone, [zombies[0]], DEFAULT_REFLEX_CONFIG, 0), false)
  assert.strictEqual(fleeDue(lone, zombies, DEFAULT_REFLEX_CONFIG, 0), true)
  // four at full health: fled before a fight, not a fight given up for
  const four = [0, 1, 2, 3].map(k => entity({ name: 'zombie', position: at(2 + k) }))
  const full = fakeBot({ entities: four, ...kit })
  assert.strictEqual(fleeDue(full, four, DEFAULT_REFLEX_CONFIG, 0), true)
  assert.strictEqual(fightTurned(full, four, DEFAULT_REFLEX_CONFIG, 0), false)
})

test('hostiles reflex: hurt to sealHealth among two zombies down a tunnel, with the blocks, the bot shuts itself in (seal in); not on open ground (a box of 10), with a creeper about, against a lone zombie over fleeHealth, nor with too few blocks (full-26.3-fresh-l)', async () => {
  const { sealDue } = await import('../../src/reflexes/rules')
  const zombies = [entity({ name: 'zombie', position: at(2) }), entity({ name: 'zombie', position: at(3) })]
  const armor = { head: item('iron_helmet'), torso: item('iron_chestplate'), legs: item('iron_leggings'), feet: item('golden_boots') }
  // down a 1-wide tunnel along x: its two ends to shut, 4 blocks
  const tunnel = (p: Vec3): string => p.z === 0 && p.y >= 64 && p.y <= 65 ? 'air' : 'stone'
  const kit = (stone = 64): any => ({ items: [item('diamond_sword'), item('cobblestone', stone)], armor, world: tunnel })
  assert.strictEqual(check(hostilesReflex, { entities: zombies, ...kit(), health: 9 }), 'seal in')
  assert.strictEqual(check(hostilesReflex, { entities: zombies, ...kit(), health: 11 }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombies[0]], ...kit(), health: 9 }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [zombies[0]], ...kit(), health: 5 }), 'seal in')
  assert.strictEqual(check(hostilesReflex, { entities: zombies, ...kit(3), health: 9 }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: [...zombies, entity({ name: 'creeper', position: at(5) })], ...kit(), health: 9 }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: zombies, ...kit(), health: 9 }, { hostiles: { sealHealth: 0 } }), 'fight zombie')
  assert.strictEqual(check(hostilesReflex, { entities: zombies, ...kit(), world: undefined, health: 9 }), 'fight zombie')
  // the fight's until: the health falling to it ends the fight, the box next
  const bot = fakeBot({ entities: zombies, ...kit(), health: 12 })
  assert.strictEqual(sealDue(bot, zombies, DEFAULT_REFLEX_CONFIG, 0), false)
  bot.health = 10
  assert.strictEqual(sealDue(bot, zombies, DEFAULT_REFLEX_CONFIG, 0), true)
})

test('spawner reflex: a dark spawner the bot sees within 16, out of a fight, with a torch carried, is lit; not lit, not seen, no torch, in a fight, the nether or an xp farm\'s, let be (full-26.3-fresh-l)', async () => {
  const { spawnerReflex } = await import('../../src/reflexes/rules')
  const spawner = new Vec3(5, 64, 0)
  const run = (opts: { torch?: boolean, lit?: boolean, wall?: boolean, zombie?: boolean, nether?: boolean, farm?: boolean } = {}): string | null => {
    const world = (p: Vec3): string => p.equals(spawner) ? 'spawner' : opts.lit === true && p.equals(spawner.offset(0, 1, 0)) ? 'torch'
      : opts.wall === true && p.x === 3 && p.y >= 64 && p.y <= 66 ? 'stone' : p.y < 64 ? 'stone' : 'air'
    return check(spawnerReflex, {
      world,
      items: opts.torch === false ? [] : [item('torch', 8)],
      entities: opts.zombie === true ? [entity({ name: 'zombie', position: at(4) })] : []
    }, {}, (engine) => {
      const bot = (engine as any).bot
      bot.findBlocks = () => [spawner]
      if (opts.nether === true) bot.game.dimension = 'the_nether'
      if (opts.farm === true) bot.survival = { memory: { getPois: () => [{ x: 5, y: 64, z: 0 }] } }
    })
  }
  assert.strictEqual(run(), 'light spawner')
  assert.strictEqual(run({ lit: true }), null)
  assert.strictEqual(run({ wall: true }), null)
  assert.strictEqual(run({ torch: false }), null)
  assert.strictEqual(run({ zombie: true }), null)
  assert.strictEqual(run({ nether: true }), null)
  assert.strictEqual(run({ farm: true }), null)
})

test('eat reflex: a meal that does not fit the bar whole (FoodData.eat caps it at 20) waits till it does, unless the health needs it', () => {
  const pork = [item('cooked_porkchop', 5)]
  // 8 nutrition: in whole at 12, not at 14 (hungry) nor at 17 (hurt a little)
  assert.strictEqual(check(eatReflex, { food: 12, items: pork }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 14, items: pork }), null)
  assert.strictEqual(check(eatReflex, { food: 17, health: 19, items: pork }), null)
  // hurt at fitHealth (16) with the bar under 18 (no healing there): eaten
  assert.strictEqual(check(eatReflex, { food: 17, health: 16, items: pork }), 'eat')
  assert.strictEqual(check(eatReflex, { food: 17, health: 16, items: pork }, { eat: { fitHealth: 14 } }), null)
  // at 18 and 19 the bar heals: only at the reflex's health (10)
  assert.strictEqual(check(eatReflex, { food: 19, health: 12, items: pork }), null)
  assert.strictEqual(check(eatReflex, { food: 19, health: 10, items: pork }), 'eat')
  // a smaller meal that fits is eaten where the porkchop isn't
  assert.strictEqual(check(eatReflex, { food: 14, items: [...pork, item('bread', 2)] }), 'eat')
  // starving: whatever
  assert.strictEqual(check(eatReflex, { food: 6, items: [item('rabbit_stew', 1)] }), 'eat')
})

test('drops reflex: a slime ball or magma cream a fight left lying is picked up while the bag is short of them; not in a fight, by a blaze, too far, or with enough', () => {
  const drop = (name: string, x: number, y = 64, id = 900): any => ({ id, name: 'item', type: 'object', position: at(x, y), getDroppedItem: () => item(name) })
  assert.strictEqual(check(dropsReflex, { entities: [drop('slime_ball', 4)] }), 'pick up the wanted drops')
  assert.strictEqual(check(dropsReflex, { entities: [drop('magma_cream', 4)] }), 'pick up the wanted drops')
  // not what's wanted, too far, over 3 up
  assert.strictEqual(check(dropsReflex, { entities: [drop('rotten_flesh', 4)] }), null)
  assert.strictEqual(check(dropsReflex, { entities: [drop('slime_ball', 14)] }), null)
  assert.strictEqual(check(dropsReflex, { entities: [drop('slime_ball', 2, 69)] }), null)
  // enough held already
  assert.strictEqual(check(dropsReflex, { entities: [drop('slime_ball', 4)], items: [item('slime_ball', 4)] }), null)
  // a fight on, or a blaze about (the nook's own fetch)
  assert.strictEqual(check(dropsReflex, { entities: [drop('slime_ball', 4), entity({ name: 'zombie', position: at(5) })] }), null)
  assert.strictEqual(check(dropsReflex, { entities: [drop('magma_cream', 4), entity({ name: 'blaze', position: at(20, 70) })] }), null)
})
