// The integration harness's version handling, without a server: the per-version setup, the JDK pick and the log lines
// of both versions.
import { describe, test } from 'node:test'
import assert from 'node:assert'
import { grimMods, isJdkOfMajor, parseGrimAlert, parseLogLine, versionSetup, GRIM_CONFIG, VERSIONS } from '../harness/server'
import * as fs from 'node:fs'

describe('integration harness', () => {
  test('each version has its loader and Java: 1.21.11 on Java 21 (remapped), 26.3 on Java 25 (unobfuscated)', () => {
    assert.deepStrictEqual(versionSetup('1.21.11'), { loader: '0.18.4', installer: '1.1.2', java: 21, obfuscated: true })
    assert.deepStrictEqual(versionSetup('26.3'), { loader: '0.20.0', installer: '1.1.2', java: 25, obfuscated: false })
    assert.throws(() => versionSetup('1.8.9'), /no server setup for Minecraft 1\.8\.9/)
    assert.ok(Object.keys(VERSIONS).includes('26.3'))
  })

  test('a JDK directory is of the major version its first number says', () => {
    assert.ok(isJdkOfMajor('jdk-21.0.11', 21))
    assert.ok(isJdkOfMajor('jdk-25.0.3', 25))
    assert.ok(isJdkOfMajor('temurin-25-jdk', 25))
    assert.ok(!isJdkOfMajor('jdk-25.0.21', 21))
    assert.ok(!isJdkOfMajor('jdk-21.0.11', 25))
  })

  test('a log line\'s message, without the "System chat: " 26.x puts before what the server sends itself', () => {
    assert.deepStrictEqual(parseLogLine('[10:26:16] [Server thread/INFO]: Gamerule spawn_mobs is now set to: false'),
      { thread: 'Server thread', level: 'INFO', message: 'Gamerule spawn_mobs is now set to: false' })
    assert.deepStrictEqual(parseLogLine('[21:41:02] [Server thread/INFO]: System chat: Game rule spawn_mobs is now set to false'),
      { thread: 'Server thread', level: 'INFO', message: 'Game rule spawn_mobs is now set to false' })
    assert.strictEqual(parseLogLine('not a log line'), null)
  })

  test('a Grim alert\'s player, check, violations and verbose; other lines none', () => {
    assert.deepStrictEqual(parseGrimAlert('Grim » probe failed Simulation (x3) .113131 /gl 3'), { player: 'probe', check: 'Simulation', vl: 3, verbose: '.113131 /gl 3' })
    assert.deepStrictEqual(parseGrimAlert('Grim » probe failed BadPacketsN* (x1)'), { player: 'probe', check: 'BadPacketsN', vl: 1, verbose: '' })
    assert.strictEqual(parseGrimAlert('Grim » Alerts enabled'), null)
    assert.strictEqual(parseGrimAlert('probe joined the game'), null)
  })

  test('GrimAC is pinned for 1.21.11 (with the Fabric API), its config alerting each violation', () => {
    const mods = grimMods('1.21.11')
    assert.deepStrictEqual(mods.map(m => m.file), ['grimac-fabric-2.3.74-f5bbe9c.jar', 'fabric-api-0.141.6+1.21.11.jar'])
    for (const m of mods) assert.match(m.sha1, /^[0-9a-f]{40}$/)
    assert.throws(() => grimMods('26.3'), /no GrimAC build for Minecraft 26\.3/)
    const punishments = fs.readFileSync(Object.values(GRIM_CONFIG)[0], 'utf8')
    const alerts = punishments.split(/\r?\n/).filter(l => /^\s+- ".*\[alert\]"/.test(l))
    assert.ok(alerts.length >= 8)
    for (const l of alerts) assert.match(l, /"1:1 \[alert\]"/)
  })
})
