package mineflayer.lockstep.mixin;

import mineflayer.lockstep.Lockstep;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.Util;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The run loop (MinecraftServer.runServer) ticks with processPacketsAndTick, then waitUntilNextTick runs tasks and
 * parks until nextTickTimeNanos. Lockstep sends tick{n} after the tick, and replaces the wait by one on the acks.
 */
@Mixin(MinecraftServer.class)
public abstract class MinecraftServerMixin {
    @Shadow
    private long nextTickTimeNanos;

    @Inject(method = "processPacketsAndTick", at = @At("TAIL"))
    private void lockstep$afterTick(boolean sprinting, CallbackInfo ci) {
        Lockstep.afterTick((MinecraftServer) (Object) this);
    }

    @Inject(method = "waitUntilNextTick", at = @At("HEAD"), cancellable = true)
    private void lockstep$gate(CallbackInfo ci) {
        MinecraftServer server = (MinecraftServer) (Object) this;
        if (!Lockstep.shouldGate(server)) return;
        // as vanilla's wait: the queued tasks first, then the block (managedBlock keeps running tasks and chunk work)
        ((BlockableEventLoopInvoker) server).lockstep$runAllTasks();
        Lockstep.awaitAcks(server);
        // the next tick is due now: the loop adds one tick's nanos to this, so it never catches up (runs ticks back to
        // back) or skips ticks ("Can't keep up!") after a wait that took longer than a tick
        this.nextTickTimeNanos = Util.getNanos();
        ci.cancel();
    }
}
