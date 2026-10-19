// Reads a stretch of seed 2's nether from a 26.3 server's chunks into a snapshot for the unit tests' fake world// (tests/fixtures/nether-seed2-delta.json.gz, tests/nether/netherSnapshot.ts)://   node -r ts-node/register/transpile-only tests/e2e/netherSnapshot.ts <out.json.gz> x0 z0 x1 z1 y0 y1// (the fixture: 240 -64 495 127 24 119)
import * as fs from 'node:fs'
import * as zlib from 'node:zlib'
import { Vec3 } from 'vec3'
import { startServer, connectLockstepBot, quitBot } from '../harness'

async function main (): Promise<void> {
  const [out, ...nums] = process.argv.slice(2)
  const [x0, z0, x1, z1, y0, y1] = nums.map(Number)
  const server = await startServer({ version: '26.3', seed: '2', difficulty: 'peaceful' })
  try {
    const bot = await connectLockstepBot(server, { username: 'snap', timeoutMs: 120000 })
    await bot.waitForChunksToLoad()
    await server.command('gamemode spectator snap')
    const sx = x1 - x0 + 1; const sy = y1 - y0 + 1; const sz = z1 - z0 + 1
    const ids = new Uint16Array(sx * sy * sz)
    const done = new Uint8Array(sx * sz)
    const step = 32
    for (let cx = x0; cx <= x1; cx += step) {
      for (let cz = z0; cz <= z1; cz += step) {
        await server.command(`execute in minecraft:the_nether run tp snap ${cx + step / 2} 100 ${cz + step / 2}`)
        const loaded = (): boolean => {
          for (let x = cx; x < Math.min(cx + step, x1 + 1); x += 16) for (let z = cz; z < Math.min(cz + step, z1 + 1); z += 16) if ((bot.world as any).getColumnAt(new Vec3(x, 64, z)) == null) return false
          return (bot.world as any).getColumnAt(new Vec3(Math.min(cx + step, x1 + 1) - 1, 64, Math.min(cz + step, z1 + 1) - 1)) != null && bot.game.dimension.includes('nether')
        }
        for (let i = 0; i < 400 && !loaded(); i++) await bot.waitForTicks(1)
        if (!loaded()) throw new Error(`chunks at ${cx} ${cz} not loaded`)
        for (let x = cx; x < Math.min(cx + step, x1 + 1); x++) {
          for (let z = cz; z < Math.min(cz + step, z1 + 1); z++) {
            for (let y = y0; y <= y1; y++) ids[((x - x0) * sz + (z - z0)) * sy + (y - y0)] = (bot.world as any).getBlockStateId(new Vec3(x, y, z)) ?? 0
            done[(x - x0) * sz + (z - z0)] = 1
          }
        }
        console.log('read', cx, cz)
      }
    }
    if (done.some(d => d === 0)) throw new Error('columns missed')
    fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify({ version: '26.3', dimension: 'the_nether', origin: [x0, y0, z0], size: [sx, sy, sz], order: 'x,z,y', ids: Buffer.from(ids.buffer).toString('base64') })), { level: 9 }))
    console.log('wrote', out, fs.statSync(out).size)
    await quitBot(bot)
  } finally {
    await server.cleanup()
  }
}
main().then(() => process.exit(0), err => { console.error(err); process.exit(1) })
