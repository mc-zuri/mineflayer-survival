# lockstep: a Fabric server mod for 1.21.11

The server advances one tick only once every opted-in client has acked the previous one. A bot under test then runs as
fast as the CPU allows instead of 50 ms a tick, and the server and the bot count the same ticks.

It is a dedicated-server mod (`"environment": "server"`) without Fabric API: the payload, the commands and the gate are
plain mixins on the official Mojang names.

## Build

```
./gradlew build        # build/libs/lockstep-<version>.jar
```

Gradle 9.4.0 (the wrapper) runs Fabric Loom 1.16.1 (`net.fabricmc.fabric-loom-remap`, since 1.21.11 is still
obfuscated), which needs a Java 21+ JVM to run; the mod is compiled for Java 21. Loom 1.17+ needs Gradle 9.5+, and 1.18+
a Java 25 JVM.

## Protocol: the `lockstep:v1` custom payload

A kind byte, then a VarInt:

| kind | message | direction | meaning |
| --- | --- | --- | --- |
| 0 | `hello{version}` | client to server, then back | the client opts in (version 1); the server answers with its own hello |
| 1 | `tick{n}` | server to client | the server ran tick `n` (`MinecraftServer.tickCount`) and flushed its packets |
| 2 | `ack{n}` | client to server | the client ran its tick for server tick `n` |

- Vanilla knows only the brand payload: `CustomPacketPayload.codec` falls back to `DiscardedPayload.codec` for any other
  channel, which skips the bytes. `DiscardedPayloadMixin` hands back the lockstep codec for `lockstep:v1`, both ways.
- `ServerGamePacketListenerImpl.handleCustomPayload` is empty in vanilla and runs on the netty thread (it does not hand
  the packet to the server thread). Hello and ack are handled there, so an ack never waits for a tick. Every packet the
  client sent before its ack (its movement, `tick_end`) is already queued in the `PacketProcessor` by then, and the
  server handles them at the start of the next tick, as it does in vanilla.
- `tick{n}` goes at the end of `processPacketsAndTick`. The connections stop flushing during `tickChildren`
  (`suspendFlushing`) and flush again after the chunks are sent (`resumeFlushing`), so `tick{n}` follows all of tick
  `n`'s packets on the wire.

## The gate

`MinecraftServer.runServer` runs `processPacketsAndTick`, then `waitUntilNextTick`, which runs the queued tasks and parks
until `nextTickTimeNanos` (`haveTime`). `MinecraftServerMixin` replaces that wait while the gate is on and some connected
player gates the server:

1. `runAllTasks()`, as vanilla's wait does.
2. `managedBlock` until each gating player has acked the tick just sent. `managedBlock` keeps running the server's tasks
   and the chunk work while it waits (`blockingCount > 0` makes `pollTask` run all of them), and an ack unparks the
   server thread at once.
3. `nextTickTimeNanos = now`. The loop then adds one tick's nanos, so the next tick never runs back to back to catch up,
   and none is skipped ("Can't keep up!").

The wait only follows a tick of the run loop: the waits of world preparation (`prepareLevels`) are left alone.

Who gates the server:

- Players who never sent hello (real clients, bots without the client side) never gate the server.
- A player gates the server from the first tick sent to it after its hello, until it leaves (`PlayerList.remove`). The
  wait also ends when a player's connection has closed: its removal only comes in the next tick.
- **Timeout.** If a player has not acked within the timeout (default 5000 ms), the server logs a warning and the player
  no longer gates it: the server goes back to real-time ticking for that player. Its tick messages keep coming, and it
  gates the server again once it acks the latest tick sent.

## Commands

`/lockstep` needs the admin permission (`Commands.LEVEL_ADMINS`, as `/tick`):

- `/lockstep on|off`: turns the gate on or off. With it off, the opted-in players still get `tick{n}` after every tick,
  so they keep running one client tick per server tick, but the server ticks in real time.
- `/lockstep status`: `lockstep on, timeout 5000 ms, tick 1234, gated ticks 1200 (0.410 ms waiting each), peers 1;
  Bot sent 1234 acked 1233`. The command's result is the tick count.
- `/lockstep timeout [<ms>]`: shows or sets the timeout.

System properties set the start values: `-Dlockstep.enabled=false` and `-Dlockstep.timeoutMs=<ms>`.

## Wall-clock timers on the server

These keep working under lockstep:

- **Keep-alive.** `ServerCommonPacketListenerImpl.keepConnectionAlive` runs in every tick and uses wall-clock time: one
  keep-alive every 15 s, and a kick after 15 s with no answer. The client answers keep-alives on its own, without a tick.
  While the server waits on acks the check does not run, and the answer is handled before the next check (at the start
  of the next tick). A wait never lasts longer than the timeout.
- **The watchdog.** `ServerWatchdog` (`max-tick-time`, 60 s by default) kills a server whose tick deadline is more than
  that far in the past, and a wait counts toward it. Keep the lockstep timeout well under `max-tick-time`, or set
  `max-tick-time=-1`. The test harness does the latter.
- **Status and autosave.** The server status cache expires on wall-clock time. Autosave counts ticks
  (`ticksUntilAutosave`, 6000 at 20 ticks a second), so under lockstep it comes as often in ticks and more often in time.
- **pause-when-empty-seconds** counts ticks (`emptyTicks`). An empty server has no one to gate it.

## The vanilla tick manager (`/tick`)

`ServerTickRateManager` and the gate work together:

- **`/tick rate`** sets `nanosecondsPerTick`, which only sets the wait's deadline. The gate resets that deadline, so the
  rate only matters for real-time ticking: with the gate off, with no one gating the server, or for a player who timed
  out.
- **`/tick freeze`** stops the levels (`runsNormally` is false: no game time, no entities but players and their
  vehicles). `MinecraftServer.tickCount` and the run loop go on, and so do `tick{n}` and the gate. A frozen server sends
  the bot ticks, and the bot moves (players are not frozen, as in vanilla). The tick number is `tickCount`, so under a
  freeze the game time stops while the tick numbers go on.
- **`/tick step <n>`** runs `n` frozen ticks with the levels on, still one ack apart.
- **`/tick sprint <n>`** runs ticks with no wait between them (`nextTickTimeNanos = now`, `l = 0`), but the gate still
  waits for the acks. A sprint therefore goes as fast as the slowest gating client. Its report (`sprintTimeSpend`, added
  up in `endTickWork` after the wait) counts the time spent waiting on acks.
- None of them gates on players in vanilla: freeze and step don't wait for clients, and nothing in vanilla waits for one.
