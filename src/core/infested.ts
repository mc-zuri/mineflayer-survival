// Infested blocks (InfestedBlock: infested stone, cobblestone, deepslate and the stone bricks of each kind) hide a
// silverfish each, let out when the block is broken (InfestedBlock.spawnInfestation), and a hurt silverfish calls the
// ones in the infested blocks round it out (Silverfish's WakeUpFriendsGoal). None is broken: a 26.3 bot mining iron at
// y 29 broke into a nest and was slain by 9 silverfish in an iron helmet with an iron sword (f5-26.3).
// (mineflayer names each by the server's block: infested_stone is a block of its own)

/** whether the block is an infested one (a silverfish in it) */
export function isInfested (name: string | null | undefined): boolean {
  return name != null && name.startsWith('infested_')
}
