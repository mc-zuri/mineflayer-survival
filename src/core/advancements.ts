// The advancements the server says the player has made (ClientboundUpdateAdvancementsPacket: each advancement's
// criteria with the time each was obtained, none for one not yet): a milestone's check against the game itself, the
// End's minecraft:end/kill_dragon however the dragon died (a fight cut off, the bot carried out through the portal).

export interface AdvancementProgressPacket {
  progressMapping?: Array<{ key: string, value: Array<{ criterionIdentifier: string, criterionProgress?: unknown }> }>
}

/** the advancements a packet's progress has every criterion of obtained, by id without the minecraft namespace */
export function advancementsDone (packet: AdvancementProgressPacket): string[] {
  const out: string[] = []
  for (const { key, value } of packet.progressMapping ?? []) {
    if (value.length === 0 || !value.every(c => c.criterionProgress != null)) continue
    out.push(key.replace(/^minecraft:/, ''))
  }
  return out
}
