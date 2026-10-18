package mineflayer.lockstep;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/**
 * A message on the {@code lockstep:v1} custom payload channel: a kind byte, then a VarInt.
 * <ul>
 *   <li>{@code hello{version}}: the client opts in; the server answers with its own hello</li>
 *   <li>{@code tick{n}}: the server ran tick n ({@code MinecraftServer.tickCount}) and flushed its packets</li>
 *   <li>{@code ack{n}}: the client ran its tick for server tick n</li>
 * </ul>
 */
public record LockstepPayload(int kind, int value) implements CustomPacketPayload {
    public static final int HELLO = 0;
    public static final int TICK = 1;
    public static final int ACK = 2;
    public static final int VERSION = 1;

    public static final Identifier ID = Identifier.fromNamespaceAndPath("lockstep", "v1");
    public static final CustomPacketPayload.Type<LockstepPayload> TYPE = new CustomPacketPayload.Type<>(ID);
    public static final StreamCodec<FriendlyByteBuf, LockstepPayload> STREAM_CODEC = CustomPacketPayload.codec(LockstepPayload::write, LockstepPayload::read);

    public static LockstepPayload hello() {
        return new LockstepPayload(HELLO, VERSION);
    }

    public static LockstepPayload tick(int n) {
        return new LockstepPayload(TICK, n);
    }

    private static LockstepPayload read(FriendlyByteBuf buf) {
        int kind = buf.readByte();
        int value = buf.readVarInt();
        // a newer client's fields after these are skipped (the payload codec must read everything)
        buf.skipBytes(buf.readableBytes());
        return new LockstepPayload(kind, value);
    }

    private void write(FriendlyByteBuf buf) {
        buf.writeByte(this.kind);
        buf.writeVarInt(this.value);
    }

    @Override
    public CustomPacketPayload.Type<LockstepPayload> type() {
        return TYPE;
    }
}
