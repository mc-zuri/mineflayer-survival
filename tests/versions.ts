// The Minecraft versions the package supports. A unit test that reads version data (the registry, vanilla values that
// changed) runs once for each.
export const VERSIONS = ['1.21.11', '26.3'] as const
export type Version = typeof VERSIONS[number]
