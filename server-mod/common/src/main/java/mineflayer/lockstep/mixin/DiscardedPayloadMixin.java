package mineflayer.lockstep.mixin;

import mineflayer.lockstep.LockstepPayload;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.DiscardedPayload;
import net.minecraft.resources.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Vanilla knows only the brand payload: CustomPacketPayload.codec falls back to DiscardedPayload.codec for any other
 * channel, which skips the bytes when reading and writes none. For lockstep:v1 the fallback is the lockstep codec, both
 * ways (serverbound and clientbound).
 */
@Mixin(DiscardedPayload.class)
public abstract class DiscardedPayloadMixin {
    @SuppressWarnings({"rawtypes", "unchecked"})
    @Inject(method = "codec", at = @At("HEAD"), cancellable = true)
    private static void lockstep$codec(Identifier id, int maxSize, CallbackInfoReturnable<StreamCodec> cir) {
        if (LockstepPayload.ID.equals(id)) cir.setReturnValue((StreamCodec) LockstepPayload.STREAM_CODEC);
    }
}
