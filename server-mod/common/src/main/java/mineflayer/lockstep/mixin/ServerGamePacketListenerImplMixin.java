package mineflayer.lockstep.mixin;

import mineflayer.lockstep.Lockstep;
import mineflayer.lockstep.LockstepPayload;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Vanilla ignores custom payloads (and does not hand them to the server thread first), so hello and ack are handled
 * here on the netty thread, after every packet the client sent before them was queued for the next tick.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class ServerGamePacketListenerImplMixin {
    @Shadow
    public ServerPlayer player;

    @Inject(method = "handleCustomPayload", at = @At("HEAD"))
    private void lockstep$receive(ServerboundCustomPayloadPacket packet, CallbackInfo ci) {
        if (packet.payload() instanceof LockstepPayload payload) Lockstep.receive(this.player, payload);
    }
}
