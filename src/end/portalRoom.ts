import type { Pos } from '../core/memory'

export type Facing = 'north' | 'south' | 'west' | 'east'

/** Direction steps: north is -z, south +z, west -x, east +x */
export const FACING_STEP: Record<Facing, { x: number, z: number }> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 },
  east: { x: 1, z: 0 }
}

/** an end_portal_frame block with its block state (EndPortalFrameBlock.FACING and HAS_EYE) */
export interface FrameBlock {
  pos: Pos
  facing: Facing
  eye: boolean
}

/** what a block getter or mineflayer's Block gives: a name, and the state as properties */
export interface BlockLike {
  name: string
  position?: Pos
  properties?: Record<string, string | number | boolean>
  getProperties?: () => Record<string, string | number | boolean>
}

function truthy (v: string | number | boolean | undefined): boolean {
  return v === true || v === 'true' || v === 1
}

/** reads an end_portal_frame's `facing` and `eye`; null for any other block */
export function readPortalFrame (block: BlockLike, pos?: Pos): FrameBlock | null {
  if (block.name !== 'end_portal_frame') return null
  const at = pos ?? block.position
  if (at == null) throw new Error('readPortalFrame needs the block position')
  const props = block.properties ?? block.getProperties?.() ?? {}
  const facing = String(props.facing ?? '') as Facing
  if (!(facing in FACING_STEP)) return null
  return { pos: { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }, facing, eye: truthy(props.eye) }
}

export interface PortalRoom {
  /** the middle cell of the 3×3 inside */
  center: Pos
  /** the 9 cells the end_portal fills */
  interior: Pos[]
  /** the 12 frame cells and the facing each must have, in StrongholdPieces.PortalRoom's order */
  expected: Array<{ pos: Pos, facing: Facing }>
  /** frames read in the right place and facing */
  frames: FrameBlock[]
  /** frames that still need an eye */
  missing: FrameBlock[]
  /** expected frame cells not seen (out of sight, or not a frame) */
  unseen: Array<{ pos: Pos, facing: Facing }>
  /** eyes to place: missing frames plus unseen ones */
  eyesNeeded: number
  /** all 12 frames seen with an eye: the portal is (or is about to be) open */
  complete: boolean
}

/**
 * The 12 frames around a 3×3 inside. StrongholdPieces.PortalRoom places each side's three
 * frames facing into the room (the pattern EndPortalFrameBlock.getOrCreatePortalShape checks).
 */
export function expectedFrames (center: Pos): Array<{ pos: Pos, facing: Facing }> {
  const out: Array<{ pos: Pos, facing: Facing }> = []
  const sides: Array<[Facing, Facing]> = [['north', 'south'], ['south', 'north'], ['west', 'east'], ['east', 'west']]
  for (const [side, facing] of sides) {
    const s = FACING_STEP[side]
    for (let t = -1; t <= 1; t++) {
      out.push({ pos: { x: center.x + s.x * 2 + (s.x === 0 ? t : 0), y: center.y, z: center.z + s.z * 2 + (s.z === 0 ? t : 0) }, facing })
    }
  }
  return out
}

function key (p: Pos): string {
  return `${p.x},${p.y},${p.z}`
}

/**
 * Finds the portal's inside from the frames seen (any number, even one side) and lists the
 * frames still needing an eye. Every frame's facing points into the 3×3, so a frame votes
 * for the three centers 2 cells along its facing (one per place it can have on its side);
 * the center most frames agree on wins. Null when no frame was read.
 */
export function analyzePortalRoom (blocks: FrameBlock[]): PortalRoom | null {
  if (blocks.length === 0) return null
  const votes = new Map<string, { center: Pos, n: number }>()
  for (const f of blocks) {
    const s = FACING_STEP[f.facing]
    for (let t = -1; t <= 1; t++) {
      const c = { x: f.pos.x + s.x * 2 + (s.x === 0 ? t : 0), y: f.pos.y, z: f.pos.z + s.z * 2 + (s.z === 0 ? t : 0) }
      const k = key(c)
      const v = votes.get(k)
      if (v == null) votes.set(k, { center: c, n: 1 }); else v.n++
    }
  }
  const counts = [...votes.values()]
  // most votes; ties go to the center nearest the frames' mean (a single side can't tell along its own row)
  const mean = { x: 0, z: 0 }
  for (const f of blocks) { mean.x += f.pos.x / blocks.length; mean.z += f.pos.z / blocks.length }
  const spread = (c: Pos): number => Math.hypot(c.x - mean.x, c.z - mean.z)
  counts.sort((a, b) => b.n !== a.n ? b.n - a.n : spread(a.center) - spread(b.center))
  const center = counts[0].center
  const expected = expectedFrames(center)
  const seen = new Map(blocks.map(f => [key(f.pos), f]))
  const frames: FrameBlock[] = []
  const unseen: Array<{ pos: Pos, facing: Facing }> = []
  for (const e of expected) {
    const f = seen.get(key(e.pos))
    if (f != null && f.facing === e.facing) frames.push(f); else unseen.push(e)
  }
  const missing = frames.filter(f => !f.eye)
  const interior: Pos[] = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) interior.push({ x: center.x + dx, y: center.y, z: center.z + dz })
  return { center, interior, expected, frames, missing, unseen, eyesNeeded: missing.length + unseen.length, complete: frames.length === 12 && missing.length === 0 }
}

/** scans a cube around `near` with a block getter for end_portal_frame blocks */
export function findPortalFrames (getBlock: (pos: Pos) => BlockLike | null, near: Pos, radius = 8): FrameBlock[] {
  const out: FrameBlock[] = []
  const c = { x: Math.floor(near.x), y: Math.floor(near.y), z: Math.floor(near.z) }
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
        const b = getBlock(pos)
        if (b == null) continue
        const f = readPortalFrame(b, pos)
        if (f != null) out.push(f)
      }
    }
  }
  return out
}

/** where to put an eye: use the item on the frame's top face (EnderEyeItem.useOn) */
export function eyePlacements (room: PortalRoom): Array<{ block: Pos, face: Pos }> {
  return room.missing.map(f => ({ block: f.pos, face: { x: 0, y: 1, z: 0 } }))
}
