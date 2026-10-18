// A small End for the End skills' unit tests: named blocks in a map, the main island as a disc of end stone with the
// spikes (obsidian, the bedrock cap, the cages) and the exit podium.
import type { Vec3 } from 'vec3'
import { cageBars, exitPortal, spikeColumns, type EndSpike } from '../../src/end/spikes'
import type { BlockGetter } from '../../src/end/skills/world'

const SOLID = new Set(['end_stone', 'obsidian', 'bedrock', 'cobblestone', 'iron_bars'])

/** a block getter over a map of named blocks, air elsewhere (y 0 - 255: the End's height) */
export function world (blocks: Map<string, string>, fallback: (p: Vec3) => string = () => 'air'): BlockGetter {
  return (pos) => {
    const p = pos.floored()
    if (p.y < 0 || p.y > 255) return null
    const name = blocks.get(`${p.x},${p.y},${p.z}`) ?? fallback(p)
    return { name, boundingBox: SOLID.has(name) ? 'block' : 'empty' }
  }
}

/** the main island as a disc of end stone (top at y 61) of the radius, with the spikes and the exit podium */
export function endIsland (spikes: EndSpike[], radius = 60, portalY = 62): Map<string, string> {
  const m = new Map<string, string>()
  const set = (x: number, y: number, z: number, name: string): void => { m.set(`${x},${y},${z}`, name) }
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) if (x * x + z * z <= radius * radius) for (let y = 55; y <= 61; y++) set(x, y, z, 'end_stone')
  for (const s of spikes) {
    for (const c of spikeColumns(s)) for (let y = 62; y < s.height; y++) set(c.x, y, c.z, 'obsidian')
    set(s.centerX, s.height, s.centerZ, 'bedrock')
    for (const b of cageBars(s)) set(b.x, b.y, b.z, 'iron_bars')
  }
  const podium = exitPortal(portalY)
  for (const p of podium.rim) set(p.x, p.y, p.z, 'bedrock')
  for (const p of podium.portal) set(p.x, p.y - 1, p.z, 'bedrock')
  for (const p of podium.pillar) set(p.x, p.y, p.z, 'bedrock')
  set(0, portalY - 1, 0, 'bedrock')
  return m
}
