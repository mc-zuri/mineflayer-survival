// The server's spawn protection learnt and kept out of (skills/spawnProtection): a bot in the browser on a server with
// spawn-protection 16 was stuck at 'survival: stone (step:kill 2 cow for 4 beef)', its digs and places by the spawn
// refused ('1, 67, 1 is under spawn protection') and put back, again and again.
import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import {
  SPAWN_INFER_RANGE, SPAWN_PROTECTION_COST, SPAWN_PROTECTION_RADIUS, installSpawnProtection, keepOffSpawnProtection,
  placeUnderSpawnProtection, spawnProtectionMessage, spawnProtectionState, underSpawnProtection
} from '../../src/skills/spawnProtection'
import { fakeBot } from '../reflexes/fakeBot'

const STONE = { type: 1, stateId: 1, name: 'stone' }
const AIR = { type: 0, stateId: 0, name: 'air' }
const COBBLE = { type: 12, stateId: 14, name: 'cobblestone' }
const GRAVEL = { type: 40, stateId: 118, name: 'gravel' }
const at = (b: { type: number, stateId: number, name: string }, pos: Vec3): any => ({ ...b, position: pos })

function spawnBot (spawn = new Vec3(0, 64, 0)): any {
  const bot = fakeBot({ position: new Vec3(0.5, 64, 0.5) })
  bot.spawnPoint = spawn
  bot._client = new EventEmitter()
  return bot
}

/** the 26.3 server's action bar message, as prismarine-chat has it */
const message = (text: string): any => ({ translate: 'build.spawn_protection', with: [{ text, toString: () => text }], toString: () => `${text} is under spawn protection` })

/** a dig the client predicted at `pos` and the server put back */
function refusedDig (bot: any, pos: Vec3, block = STONE): void {
  bot.targetDigBlock = at(block, pos)
  bot.emit('blockUpdate', at(block, pos), at(AIR, pos))
  bot.targetDigBlock = null
  bot.emit('blockUpdate', at(AIR, pos), at(block, pos))
}

/** a place the client predicted at `pos` and the server put back */
function refusedPlace (bot: any, pos: Vec3): void {
  bot.emit('blockPlaced', at(AIR, pos), at(COBBLE, pos))
  bot.emit('blockUpdate', at(COBBLE, pos), at(AIR, pos))
}

test('the refusal\'s message: the translatable build.spawn_protection with the block\'s "x, y, z", or its English text; no other', () => {
  assert.deepStrictEqual(spawnProtectionMessage(message('1, 67, 1')), new Vec3(1, 67, 1))
  assert.deepStrictEqual(spawnProtectionMessage({ text: '', extra: [message('-3, 70, -12')] }), new Vec3(-3, 70, -12))
  assert.deepStrictEqual(spawnProtectionMessage('1, 68, -1 is under spawn protection'), new Vec3(1, 68, -1))
  assert.strictEqual(spawnProtectionMessage({ translate: 'build.tooHigh', with: ['319'], toString: () => 'Height limit for building is 319' }), null)
  assert.strictEqual(spawnProtectionMessage('<steve> 1, 2, 3 go'), null)
})

test('the message learns the square: SPAWN_PROTECTION_RADIUS about the world spawn (max |dx|, |dz|), the places a block past it; a refusal further out widens it', () => {
  const bot = spawnBot(new Vec3(0, 64, 0))
  installSpawnProtection(bot, 'auto')
  assert.strictEqual(underSpawnProtection(bot, new Vec3(1, 67, 1)), false)
  bot.emit('message', message('1, 67, 1'), 'game_info')
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
  assert.strictEqual(underSpawnProtection(bot, new Vec3(16, 10, -16)), true)
  assert.strictEqual(underSpawnProtection(bot, new Vec3(17, 64, 0)), false)
  // a block placed at 17 is placed against one at 16 (the server checks the block clicked)
  assert.strictEqual(placeUnderSpawnProtection(bot, new Vec3(17, 64, 0)), true)
  assert.strictEqual(placeUnderSpawnProtection(bot, new Vec3(18, 64, 0)), false)
  bot.emit('message', message('-20, 64, 3'), 'game_info')
  assert.strictEqual(spawnProtectionState(bot)?.radius, 20)
  // in another dimension than the spawn's: none
  bot.game.dimension = 'minecraft:the_nether'
  assert.strictEqual(underSpawnProtection(bot, new Vec3(1, 64, 1)), false)
})

test('the option: a radius known from the start (0 none), the message widening it; \'auto\' none until a refusal', () => {
  const set = spawnBot()
  installSpawnProtection(set, 8)
  assert.strictEqual(underSpawnProtection(set, new Vec3(8, 64, 0)), true)
  assert.strictEqual(underSpawnProtection(set, new Vec3(9, 64, 0)), false)
  set.emit('message', message('5, 64, 5'), 'game_info')
  assert.strictEqual(spawnProtectionState(set)?.radius, 8)
  const none = spawnBot()
  installSpawnProtection(none, 0)
  assert.strictEqual(underSpawnProtection(none, new Vec3(0, 64, 0)), false)
})

test(`a dig the server put back at the same cell twice within SPAWN_INFER_RANGE of the spawn is its protection (1.21.11 says nothing); once, a gravel's fall, or one far off is not`, () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  refusedDig(bot, new Vec3(1, 67, 1))
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  // gravel falling into the cell it was dug from is no refusal
  refusedDig(bot, new Vec3(2, 66, 2), GRAVEL)
  refusedDig(bot, new Vec3(2, 66, 2), GRAVEL)
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  // far off: whatever puts it back (an anticheat), it's not the spawn's
  refusedDig(bot, new Vec3(SPAWN_INFER_RANGE + 5, 60, 0))
  refusedDig(bot, new Vec3(SPAWN_INFER_RANGE + 5, 60, 0))
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  // a dig that stays broken: none
  bot.targetDigBlock = at(STONE, new Vec3(3, 63, 3))
  bot.emit('blockUpdate', at(STONE, new Vec3(3, 63, 3)), at(AIR, new Vec3(3, 63, 3)))
  bot.targetDigBlock = null
  refusedDig(bot, new Vec3(1, 67, 1))
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
})

test('a place the server put back twice at a cell near the spawn is its protection; a block the bot placed and dug again is not', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  // placed, then dug by the bot itself
  for (let i = 0; i < 2; i++) {
    const p = new Vec3(4, 65, 4)
    bot.emit('blockPlaced', at(AIR, p), at(COBBLE, p))
    bot.targetDigBlock = at(COBBLE, p)
    bot.emit('blockUpdate', at(COBBLE, p), at(AIR, p))
    bot.targetDigBlock = null
  }
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  refusedPlace(bot, new Vec3(-1, 70, 0))
  refusedPlace(bot, new Vec3(-1, 70, 0))
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
})

test('an op (the server\'s entity event 24 + level) is never under it: no refusal counted; the message says otherwise', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  bot._client.emit('entity_status', { entityId: bot.entity.id, entityStatus: 28 })
  refusedDig(bot, new Vec3(1, 67, 1))
  refusedDig(bot, new Vec3(1, 67, 1))
  assert.strictEqual(spawnProtectionState(bot)?.radius, null)
  bot.emit('message', message('1, 67, 1'), 'game_info')
  assert.strictEqual(underSpawnProtection(bot, new Vec3(1, 67, 1)), true)
})

test('learnt: a dig under way in the square stopped, a path under way planned again, and a place the client predicted against the refused block put back at once (no ghost block to stand on)', () => {
  const bot = spawnBot()
  const blocks = new Map<string, any>()
  bot.blockAt = (p: Vec3) => blocks.get(p.floored().toString()) ?? at(AIR, p.floored())
  const updates: Array<[string, number]> = []
  bot._updateBlockState = (p: Vec3, stateId: number) => { updates.push([p.toString(), stateId]); blocks.delete(p.toString()) }
  let stopped = 0
  bot.stopDigging = () => { stopped++ }
  let resets = 0
  let settings: any = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
  bot.pathfinder = { isPathing: true, reset: async () => { resets++ }, get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  installSpawnProtection(bot, 'auto')
  // the pillar's place against (1, 66, 1): the block predicted at (1, 67, 1)
  const ghost = new Vec3(1, 67, 1)
  blocks.set(ghost.toString(), at(COBBLE, ghost))
  bot.emit('blockPlaced', at(AIR, ghost), at(COBBLE, ghost))
  bot.targetDigBlock = at(STONE, new Vec3(2, 66, 0))
  bot.emit('message', message('1, 66, 1'), 'game_info')
  assert.deepStrictEqual(updates, [[ghost.toString(), 0]])
  assert.strictEqual(stopped, 1)
  assert.strictEqual(resets, 1)
})

test('the pathfinder\'s rules: nothing broken in the square nor placed a block out of it once it\'s known, nothing before; added once', () => {
  const bot = spawnBot()
  let settings: any = { exclusionAreasBreak: [], exclusionAreasPlace: [] }
  bot.pathfinder = { get defaultMoveSettings () { return settings }, setMoveOptions: (s: any) => { settings = s } }
  installSpawnProtection(bot, 'auto')
  keepOffSpawnProtection(bot)
  assert.strictEqual(settings.exclusionAreasBreak.length, 1)
  assert.strictEqual(settings.exclusionAreasPlace.length, 1)
  const brk = settings.exclusionAreasBreak[0]
  const place = settings.exclusionAreasPlace[0]
  assert.strictEqual(brk({ position: new Vec3(1, 67, 1) }), 0)
  bot.emit('message', message('1, 67, 1'), 'game_info')
  assert.strictEqual(brk({ position: new Vec3(1, 67, 1) }), SPAWN_PROTECTION_COST)
  assert.strictEqual(brk({ position: new Vec3(17, 67, 1) }), 0)
  assert.strictEqual(place({ position: new Vec3(17, 67, 1) }), SPAWN_PROTECTION_COST)
  assert.strictEqual(place({ position: new Vec3(18, 67, 1) }), 0)
})

test('a dig that sets no targetDigBlock (mineflayer-mouse\'s) told by its diggingCompleted with the block broken, put back twice: the protection', () => {
  const bot = spawnBot()
  installSpawnProtection(bot, 'auto')
  for (let i = 0; i < 2; i++) {
    const p = new Vec3(0, 68, 1)
    bot.emit('diggingCompleted', at(STONE, p))
    bot.emit('blockUpdate', at(AIR, p), at(STONE, p))
  }
  assert.strictEqual(spawnProtectionState(bot)?.radius, SPAWN_PROTECTION_RADIUS)
})
