# lockstep: a Fabric server mod for 1.21.11 and 26.3

The server advances one tick only once every opted-in client has acked the previous one. A bot under test then runs as
fast as the CPU allows instead of 50 ms a tick, and the server and the bot count the same ticks.

It is a dedicated-server mod (`"environment": "server"`) without Fabric API: the payload, the commands and the gate are
plain mixins on the official Mojang names.

## Build

```
./gradlew build                 # every version
./gradlew :26.3:build           # one version
```

| version | jar | Fabric loader | Java | Loom plugin |
| --- | --- | --- | --- | --- |
| 1.21.11 | `versions/1.21.11/build/libs/lockstep-0.1.0+1.21.11.jar` | 0.18.4 | 21 | `net.fabricmc.fabric-loom-remap` |
| 26.3 | `versions/26.3/build/libs/lockstep-0.1.0+26.3.jar` | 0.20.0 | 25 | `net.fabricmc.fabric-loom` |

Gradle 9.8.1 (the wrapper) runs Fabric Loom 1.19.1 for every version. Loom 1.19 needs Gradle 9.8+ and a Java 25 JVM
(`JAVA_HOME`), also for the 1.21.11 jar, which is still compiled for Java 21 (`--release 21`).

Layout:

- `common/src/main/`: everything the versions share, i.e. all of the mod's code (the payload, the gate, the command, the
  mixins) and its resources. `fabric.mod.json` takes the Minecraft and Java versions from the subproject.
- `versions/<version>/`: one Gradle subproject per Minecraft version (`settings.gradle` includes every directory there
  with a `build.gradle`): its `gradle.properties` (`loader_version`, `java_version`), its Loom setup, and its own
  `src/main/java` if a version ever needs code of its own (none does yet).

### What 26.3 changed

- **No obfuscation.** 26.x ships with the official names (Fabric's intermediary for it is 0.0.0). The 26.3 project uses
  the plain `net.fabricmc.fabric-loom` plugin, with no mappings and no remapping: the jar keeps the official names, which
  the 26.3 loader runs as they are. 1.21.11 stays on `fabric-loom-remap` with `loom.officialMojangMappings()`, which
  remaps the jar to intermediary.
- **Java 25.** 26.3's classes are Java 25 class files, so the 26.3 project compiles with `--release 25` and needs a
  Java 25 server; `fabric.mod.json` depends on `java >= 25` there.
- **`ReentrantBlockableEventLoop`'s constructor** is `(String)` in 1.21.11 and `(String, boolean propagatesCrashes)` in
  26.3. `MinecraftServerMixin` used to extend it to call the protected `runAllTasks`; it now goes through an invoker
  mixin on `BlockableEventLoop` (`BlockableEventLoopInvoker`), so the same mixin builds on both.
- **Everything else the mod touches is the same in 26.3**: `MinecraftServer.runServer`, `processPacketsAndTick`,
  `waitUntilNextTick`, `haveTime`, `nextTickTimeNanos`, `managedBlock`, `getTickCount`; `DiscardedPayload.codec(Identifier,
  int)` and `CustomPacketPayload.codec`; `ServerGamePacketListenerImpl.handleCustomPayload` (still empty, on the netty
  thread); `PlayerList.remove`; the `Commands` constructor and `Commands.hasPermission(Commands.LEVEL_ADMINS)`.
- **The server around it** (the test harness handles these): the server needs Java 25, `white-list` defaults to true in
  26.x's `server.properties`, and the server logs what it sends itself (the console's command feedback, chat broadcasts)
  as `System chat: <message>`.

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
