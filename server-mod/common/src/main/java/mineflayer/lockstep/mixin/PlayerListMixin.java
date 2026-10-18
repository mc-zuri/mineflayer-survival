package mineflayer.lockstep.mixin;

import mineflayer.lockstep.Lockstep;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** a player who leaves stops gating the server */
@Mixin(PlayerList.class)
public abstract class PlayerListMixin {
    @Inject(method = "remove", at = @At("HEAD"))
    private void lockstep$forget(ServerPlayer player, CallbackInfo ci) {
        Lockstep.forget(player);
    }
}
