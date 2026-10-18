/**
 * Where the eye-of-ender rays cross. Each throw gives a ray from the throw point along the
 * eye's flight; the stronghold's locate pos (its start chunk's corner) lies on every ray of
 * throws aimed at the same stronghold. The estimate is the point with the least weighted
 * squared perpendicular distance to all the rays.
 */

export interface XZ { x: number, z: number }

export interface EyeRay {
  origin: XZ
  /** the flight direction; normalised here */
  direction: XZ
  /** 1-sigma error of the direction in radians (default 0.005: about 5 blocks per kilometre) */
  angleError?: number
}

export interface Triangulation extends XZ {
  /** covariance of the estimate, blocks² ([xx, xz, zz]) */
  covariance: [number, number, number]
  /** 1-sigma semi-axes of the error ellipse, blocks (major first) */
  errorAxes: [number, number]
  /** a radius that holds the stronghold's locate pos with about 95% confidence */
  error: number
  /** each ray's perpendicular miss distance from the estimate, blocks */
  misses: number[]
  /** the sum of (miss / sigma)²; a large value means the throws disagree (two strongholds, or a bad read) */
  chiSquare: number
  /** the smallest angle between two of the rays, degrees: under ~5 the crossing is poorly conditioned */
  crossingAngle: number
}

const DEFAULT_ANGLE_ERROR = 0.005
/** sqrt of the chi-square quantile for 95% with 2 degrees of freedom */
const RADIUS_95 = Math.sqrt(5.991)

function unit (v: XZ): XZ {
  const l = Math.hypot(v.x, v.z)
  return { x: v.x / l, z: v.z / l }
}

function solve (rays: Array<{ o: XZ, d: XZ, w: number }>): { p: XZ, a: [number, number, number] } | null {
  // A = Σ w n nᵀ, b = Σ w n nᵀ o, with n ⊥ d: then A p = b
  let axx = 0
  let axz = 0
  let azz = 0
  let bx = 0
  let bz = 0
  for (const { o, d, w } of rays) {
    const nx = -d.z
    const nz = d.x
    const no = nx * o.x + nz * o.z
    axx += w * nx * nx
    axz += w * nx * nz
    azz += w * nz * nz
    bx += w * nx * no
    bz += w * nz * no
  }
  const det = axx * azz - axz * axz
  if (!(Math.abs(det) > 1e-12 * (axx + azz) * (axx + azz))) return null
  return { p: { x: (azz * bx - axz * bz) / det, z: (axx * bz - axz * bx) / det }, a: [axx, axz, azz] }
}

/** least-squares crossing of two or more rays; null when they are parallel or cross behind a throw */
export function triangulate (rays: EyeRay[]): Triangulation | null {
  if (rays.length < 2) return null
  const base = rays.map(r => ({ o: r.origin, d: unit(r.direction), sigma: r.angleError ?? DEFAULT_ANGLE_ERROR }))
  // first pass with equal weights, then weight each ray by 1 / (distance × angle error)²
  let sol = solve(base.map(r => ({ o: r.o, d: r.d, w: 1 })))
  if (sol == null) return null
  for (let pass = 0; pass < 3; pass++) {
    const p = sol.p
    const weighted = base.map(r => {
      const dist = Math.max(16, Math.hypot(p.x - r.o.x, p.z - r.o.z))
      const s = dist * r.sigma
      return { o: r.o, d: r.d, w: 1 / (s * s) }
    })
    const next = solve(weighted)
    if (next == null) break
    sol = next
  }
  const p = sol.p
  // the stronghold is ahead of every throw
  for (const r of base) if ((p.x - r.o.x) * r.d.x + (p.z - r.o.z) * r.d.z <= 0) return null
  const [axx, axz, azz] = sol.a
  const det = axx * azz - axz * axz
  const cov: [number, number, number] = [azz / det, -axz / det, axx / det]
  const tr = cov[0] + cov[2]
  const disc = Math.sqrt(Math.max(0, (cov[0] - cov[2]) * (cov[0] - cov[2]) / 4 + cov[1] * cov[1]))
  const major = Math.sqrt(Math.max(0, tr / 2 + disc))
  const minor = Math.sqrt(Math.max(0, tr / 2 - disc))
  const misses: number[] = []
  let chi = 0
  for (const r of base) {
    const miss = (p.x - r.o.x) * -r.d.z + (p.z - r.o.z) * r.d.x
    misses.push(Math.abs(miss))
    const s = Math.max(16, Math.hypot(p.x - r.o.x, p.z - r.o.z)) * r.sigma
    chi += (miss / s) * (miss / s)
  }
  let crossing = 90
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      const c = Math.abs(base[i].d.x * base[j].d.x + base[i].d.z * base[j].d.z)
      crossing = Math.min(crossing, Math.acos(Math.min(1, c)) * 180 / Math.PI)
    }
  }
  return { x: p.x, z: p.z, covariance: cov, errorAxes: [major, minor], error: major * RADIUS_95, misses, chiSquare: chi, crossingAngle: crossing }
}

/**
 * Where to throw the second eye from: sideways to the first ray, so the rays cross at a
 * good angle. `offset` blocks to the side of the first throw (vanilla targets are exact
 * to the chunk corner, so 30-40 blocks is plenty at stronghold distances).
 */
export function secondThrowPoint (first: EyeRay, offset = 40): XZ {
  const d = unit(first.direction)
  return { x: first.origin.x - d.z * offset, z: first.origin.z + d.x * offset }
}
