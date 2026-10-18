import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Vec3 } from 'vec3'
import { TaskRunner } from '../../src/core/taskRunner'
import { WorldMemory } from '../../src/core/memory'
import { Diagnostics, describeRecovery, diagnoseDeath, isDeathMessage, type SurvivalReport, type DeathFacts } from '../../src/diagnostics'

/* eslint-disable @typescript-eslint/no-var-requires */
const registry = require('minecraft-data')('1.21.11')

/** a bot with a client that sends damage_event and death_combat_event, an inventory the test fills and empties */
function fakeBot (items: Record<string, number>): any {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.username = 'diagbot'
  bot.version = '1.21.11'
  bot.health = 20
  bot.food = 20
  const counts = new Map(Object.entries(items))
  const slots = (): any[] => {
    const out: any[] = new Array(46).fill(null)
    let i = 9
    for (const [name, count] of counts) if (count > 0) out[i++] = { name, count, type: registry.itemsByName[name].id, slot: i - 1 }
    return out
  }
  bot.inventory = { get slots () { return slots() }, items: () => slots().slice(9, 45).filter(s => s != null), emptySlotCount: () => 30 }
  bot.empty = () => counts.clear()
  bot.entity = { id: 7, position: new Vec3(10.5, -60, 3.5) }
  bot.entities = { 7: bot.entity, 12: { id: 12, name: 'zombie', type: 'hostile', position: new Vec3(11.5, -60, 3.5) } }
  bot.game = { dimension: 'overworld' }
  bot.time = { timeOfDay: 14000, day: 1 }
  bot.survival = { memory: new WorldMemory(), tasks: new TaskRunner(bot) }
  return bot
}

const ticks = (bot: any, n: number): void => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
const hurt = (bot: any, health: number): void => {
  bot._client.emit('damage_event', { entityId: 7, sourceTypeId: 30, sourceCauseId: 13, sourceDirectId: 13 })
  bot.health = health
  bot.emit('health')
}

test('a death report: the server\'s message, the hits and who made them, the reflexes, what dropped; then the recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'death-'))
  try {
    const bot = fakeBot({ iron_pickaxe: 1, cobblestone: 20 })
    const lines: string[] = []
    const diagnostics = new Diagnostics(bot, { dir, log: l => lines.push(l) })
    bot.survival.diagnostics = diagnostics
    ticks(bot, 40)
    hurt(bot, 14)
    ticks(bot, 10)
    bot.emit('reflex', 'hostiles')
    hurt(bot, 6)
    ticks(bot, 5)
    // the server: killed (the inventory still there), the items dropped, the message, then the health
    bot._client.emit('death_combat_event', { playerId: 7, message: {} })
    bot.empty()
    bot.emit('messagestr', 'diagbot was slain by Zombie')
    hurt(bot, 0)
    bot.emit('death')
    const [report] = diagnostics.lastReports() as SurvivalReport[]
    assert.equal(report.kind, 'death')
    const d = report.death!
    assert.equal(d.message, 'diagbot was slain by Zombie')
    assert.deepEqual(d.pos, [10.5, -60, 3.5])
    assert.deepEqual(d.attackers, { zombie: 3 })
    assert.equal(d.damage[0].type, 30)
    assert.deepEqual(d.health.map(h => h.health), [14, 6, 0])
    assert.deepEqual(d.reflexes.map(r => r.name), ['hostiles'])
    assert.deepEqual(d.dropped, [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 20 }])
    assert.equal(d.near[0].name, 'zombie')
    assert.equal(report.diagnosis, 'died: diagbot was slain by Zombie at (10, -60, 3) in overworld; hits: zombie x3; reflexes: hostiles; recovery: no recovery yet')
    assert.match(lines[0], /^\[survival\] death report: died: diagbot was slain by Zombie .+ \(.+-death-\d+\.json\)$/)
    // the recovery, as the runner tells it: the same file written again
    diagnostics.recovery({})
    diagnostics.recovery({ deathSpot: 'went', picked: { cobblestone: 20, iron_pickaxe: 1 } })
    diagnostics.recovery({ done: 900 })
    const file = diagnostics.fileOf(report)!
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.death.recovery.deathSpot, 'went')
    assert.equal(saved.death.recovery.done, 900)
    assert.equal(saved.diagnosis, 'died: diagbot was slain by Zombie at (10, -60, 3) in overworld; hits: zombie x3; reflexes: hostiles; recovery: back to the death spot (picked up 20 cobblestone, 1 iron_pickaxe)')
    assert.equal(diagnostics.history[0].diagnosis, saved.diagnosis)
    // one line for the report, none for its updates
    assert.equal(lines.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a death message after the death goes on its report; a death on the way back ends the last one\'s recovery', () => {
  const bot = fakeBot({ dirt: 3 })
  const diagnostics = new Diagnostics(bot, { dir: null, log: null })
  bot.survival.diagnostics = diagnostics
  ticks(bot, 20)
  bot.health = 0
  bot.emit('health')
  bot.emit('death')
  ticks(bot, 3)
  bot.emit('messagestr', 'diagbot joined the game')
  bot.emit('messagestr', 'diagbot fell out of the world')
  const first = diagnostics.lastReports()[0] as SurvivalReport
  assert.equal(first.death?.message, 'diagbot fell out of the world')
  assert.deepEqual(first.death?.dropped, [{ name: 'dirt', count: 3 }])
  assert.match(first.diagnosis, /^died: diagbot fell out of the world at/)
  diagnostics.recovery({})
  bot.health = 20
  bot.emit('health')
  ticks(bot, 40)
  bot.health = 0
  bot.emit('health')
  bot.emit('death')
  assert.equal(first.death?.recovery?.deathSpot, 'failed: died again on the way')
  assert.match(first.diagnosis, /recovery: death spot failed: died again on the way$/)
  const second = diagnostics.lastReports()[1] as SurvivalReport
  assert.equal(second.kind, 'death')
  assert.equal(second.death?.message, null)
})

test('the death rules: no attacker, the recovery in words', () => {
  const d: DeathFacts = { message: null, pos: [0, 70, 0], dimension: 'the_nether', health: [], damage: [{ tick: 1, type: 5, cause: null, direct: null, health: null }], attackers: {}, reflexes: [], near: [], had: null, dropped: [], recovery: null }
  assert.equal(diagnoseDeath(d), 'died: no death message at (0, 70, 0) in the_nether; hits: 1 with no attacker; recovery: no recovery yet')
  assert.equal(describeRecovery({ started: 1, deathSpot: 'skipped: no death spot', picked: null, kit: 'no base', done: 5 }), 'death spot skipped: no death spot, no base for a kit')
  assert.equal(describeRecovery({ started: 1, deathSpot: null, picked: null, kit: { iron_pickaxe: 1, bread: 5 }, done: null }), 'kit: 1 iron_pickaxe, 5 bread, under way')
  assert.equal(isDeathMessage('diagbot was killed'), true)
  assert.equal(isDeathMessage('diagbot has made the advancement [Stone Age]'), false)
})

test('the runner tells the recovery: no death spot and no base', async () => {
  const { Runner } = await import('../../src/runner')
  const bot = fakeBot({ dirt: 1 })
  bot.waitForTicks = async () => {}
  bot.blockAt = () => ({ name: 'air' })
  bot.isAlive = true
  bot.survival.handlers = {}
  const diagnostics = new Diagnostics(bot, { dir: null, log: null })
  bot.survival.diagnostics = diagnostics
  bot.emit('death')
  const runner = new Runner(bot, { log: () => {} })
  await runner.recoverFromDeath()
  const report = diagnostics.lastReports()[0] as SurvivalReport
  assert.equal(report.death?.recovery?.deathSpot, 'skipped: no death spot')
  assert.equal(report.death?.recovery?.kit, 'no base')
  assert.notEqual(report.death?.recovery?.done, null)
  assert.match(report.diagnosis, /recovery: death spot skipped: no death spot, no base for a kit$/)
})
