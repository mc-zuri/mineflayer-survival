package mineflayer.lockstep;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.LockSupport;
import net.minecraft.network.protocol.common.ClientboundCustomPayloadPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The lockstep gate. After each server tick every opted-in player is sent {@code tick{n}}; before the next tick the
 * server waits (running its queued tasks) until each of them has answered {@code ack{n}}, instead of sleeping until the
 * 50 ms deadline. A player that does not answer within the timeout stops gating the server (it falls back to real-time
 * ticking) until it acks the latest tick again.
 *
 * <p>Threads: hello and ack arrive on the netty threads ({@code ServerGamePacketListenerImpl.handleCustomPayload} does
 * not hand the packet to the server thread); the tick and the wait run on the server thread.
 */
public final class Lockstep {
    public static final Logger LOGGER = LoggerFactory.getLogger("lockstep");

    private static volatile boolean enabled = !"false".equals(System.getProperty("lockstep.enabled"));
    private static volatile long timeoutMs = Long.getLong("lockstep.timeoutMs", 5000L);

    private static final Map<UUID, Peer> PEERS = new ConcurrentHashMap<>();
    private static volatile Thread serverThread;
    /** the run loop just ran a tick and sent its tick messages (server thread only) */
    private static boolean tickSent;
    private static long gatedTicks;
    /** the time the gated ticks waited on acks */
    private static long waitNanos;

    private Lockstep() {
    }

    static final class Peer {
        final String name;
        /** the last tick sent to it, Integer.MIN_VALUE before the first */
        volatile int sent = Integer.MIN_VALUE;
        volatile int acked = Integer.MIN_VALUE;
        /** it timed out: it does not gate the server until it acks the latest tick */
        volatile boolean stalled;
        /** the player's connection, to stop waiting on one that closed (its removal waits for the next tick) */
        volatile ServerGamePacketListenerImpl connection;

        Peer(String name) {
            this.name = name;
        }

        boolean caughtUp() {
            return this.acked >= this.sent;
        }
    }

    public static boolean enabled() {
        return enabled;
    }

    public static void setEnabled(boolean value) {
        enabled = value;
        wake();
    }

    public static long timeoutMs() {
        return timeoutMs;
    }

    public static void setTimeoutMs(long value) {
        timeoutMs = value;
    }

    public static long gatedTicks() {
        return gatedTicks;
    }

    /** netty thread: a lockstep message from the player */
    public static void receive(ServerPlayer player, LockstepPayload payload) {
        switch (payload.kind()) {
            case LockstepPayload.HELLO -> {
                if (payload.value() != LockstepPayload.VERSION) {
                    LOGGER.warn("{} sent lockstep hello version {}, expected {}: it does not gate the server", player.getScoreboardName(), payload.value(), LockstepPayload.VERSION);
                    return;
                }
                if (PEERS.putIfAbsent(player.getUUID(), new Peer(player.getScoreboardName())) == null) {
                    LOGGER.info("{} opted in to lockstep", player.getScoreboardName());
                }
                player.connection.send(new ClientboundCustomPayloadPacket(LockstepPayload.hello()));
            }
            case LockstepPayload.ACK -> {
                Peer peer = PEERS.get(player.getUUID());
                if (peer == null) return;
                if (payload.value() > peer.acked) peer.acked = payload.value();
                if (peer.stalled && peer.caughtUp()) {
                    peer.stalled = false;
                    LOGGER.info("{} caught up with lockstep at tick {}: it gates the server again", peer.name, peer.acked);
                }
                wake();
            }
            default -> LOGGER.debug("{} sent an unknown lockstep message {}", player.getScoreboardName(), payload.kind());
        }
    }

    /** server thread: the player left (PlayerList.remove) */
    public static void forget(ServerPlayer player) {
        if (PEERS.remove(player.getUUID()) != null) wake();
    }

    /**
     * Server thread, the end of MinecraftServer.processPacketsAndTick: the tick's packets were flushed when the
     * connections resumed flushing at the end of tickChildren, so tick{n} goes after all of them.
     */
    public static void afterTick(MinecraftServer server) {
        serverThread = server.getRunningThread();
        int n = server.getTickCount();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Peer peer = PEERS.get(player.getUUID());
            if (peer == null) continue;
            peer.sent = n;
            peer.connection = player.connection;
            player.connection.send(new ClientboundCustomPayloadPacket(LockstepPayload.tick(n)));
        }
        tickSent = true;
    }

    /**
     * Server thread, MinecraftServer.waitUntilNextTick: whether this wait is lockstep's, i.e. it follows a tick of the
     * run loop (not world preparation), the gate is on and some connected player gates the server.
     */
    public static boolean shouldGate(MinecraftServer server) {
        boolean afterTick = tickSent;
        tickSent = false;
        return afterTick && enabled && !gating(server).isEmpty();
    }

    /** server thread: blocks (running the server's tasks) until every gating player acked the tick just sent */
    public static void awaitAcks(MinecraftServer server) {
        List<Peer> gating = gating(server);
        long start = System.nanoTime();
        long timeoutNanos = timeoutMs * 1_000_000L;
        server.managedBlock(() -> {
            if (!enabled) return true;
            boolean all = true;
            long waited = System.nanoTime() - start;
            for (Peer peer : gating) {
                if (peer.stalled || peer.caughtUp() || !PEERS.containsValue(peer) || !peer.connection.isAcceptingMessages()) continue;
                if (waited >= timeoutNanos) {
                    peer.stalled = true;
                    LOGGER.warn("{} has not acked lockstep tick {} in {} ms: it no longer gates the server (real-time ticking) until it catches up", peer.name, peer.sent, waited / 1_000_000L);
                    continue;
                }
                all = false;
            }
            return all;
        });
        gatedTicks++;
        waitNanos += System.nanoTime() - start;
    }

    private static List<Peer> gating(MinecraftServer server) {
        List<Peer> list = new ArrayList<>();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Peer peer = PEERS.get(player.getUUID());
            if (peer != null && !peer.stalled && peer.sent != Integer.MIN_VALUE) list.add(peer);
        }
        return list;
    }

    /** an ack (or a change) the waiting server thread should see now rather than after its next 0.1 ms park */
    private static void wake() {
        Thread thread = serverThread;
        if (thread != null) LockSupport.unpark(thread);
    }

    public static String status(MinecraftServer server) {
        StringBuilder sb = new StringBuilder();
        sb.append("lockstep ").append(enabled ? "on" : "off")
            .append(", timeout ").append(timeoutMs).append(" ms")
            .append(", tick ").append(server.getTickCount())
            .append(", gated ticks ").append(gatedTicks)
            .append(String.format(java.util.Locale.ROOT, " (%.3f ms waiting each)", gatedTicks == 0 ? 0.0 : waitNanos / 1e6 / gatedTicks))
            .append(", peers ").append(PEERS.size());
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Peer peer = PEERS.get(player.getUUID());
            if (peer == null) continue;
            sb.append("; ").append(peer.name).append(" sent ").append(peer.sent == Integer.MIN_VALUE ? "-" : peer.sent)
                .append(" acked ").append(peer.acked == Integer.MIN_VALUE ? "-" : peer.acked);
            if (peer.stalled) sb.append(" (stalled)");
        }
        return sb.toString();
    }
}
