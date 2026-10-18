// The integration harness's version handling, without a server: the per-version setup, the JDK pick and the log lines
// of both versions.
import { describe, test } from 'node:test'
import assert from 'node:assert'
import { isJdkOfMajor, parseLogLine, versionSetup, VERSIONS } from '../harness/server'

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
})
