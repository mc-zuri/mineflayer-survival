// The ruined portals' candidate chunks for a seed (ruinedPortalCandidates) against the server's /locate on a
// SURVIVAL_VERSION world of seed 2 and seed 9183: the portal it finds nearest the spawn is one of them.
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { DEFAULT_VERSION, startServer, type TestServer } from '../harness'
import { ruinedPortalCandidates } from '../../src/worldgen/placement'

for (const seed of ['2', '9183']) {
  describe(`the ruined portals of seed ${seed} on a ${DEFAULT_VERSION} server`, { timeout: 10 * 60 * 1000 }, () => {
    let server: TestServer | null = null
    after(async () => { if (server != null) await server.cleanup() })

    it('/locate finds one of the candidates', async () => {
      server = await startServer({ seed })
      const out = (await server.command('locate structure minecraft:ruined_portal')).join(' ')
      const m = /at \[(-?\d+), ~, (-?\d+)\]/.exec(out)
      assert.ok(m != null, out)
      const real = { x: Number(m[1]), z: Number(m[2]) }
      const candidates = ruinedPortalCandidates(seed, { x: 0, z: 0 }, 2)
      console.log(`seed ${seed}: /locate ${real.x} ${real.z}; candidates ${candidates.slice(0, 4).map(c => `${c.x} ${c.z}`).join(', ')}`)
      assert.ok(candidates.some(c => c.x === real.x && c.z === real.z), `${real.x} ${real.z} not a candidate`)
    })
  })
}
