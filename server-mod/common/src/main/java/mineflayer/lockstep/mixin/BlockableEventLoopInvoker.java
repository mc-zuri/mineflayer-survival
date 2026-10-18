package mineflayer.lockstep.mixin;

import net.minecraft.util.thread.BlockableEventLoop;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/**
 * BlockableEventLoop.runAllTasks (protected), for the gate's wait. An invoker rather than a mixin that extends the
 * server's superclass: ReentrantBlockableEventLoop's constructor is (String) in 1.21.11 and (String, boolean) in 26.3.
 */
@Mixin(BlockableEventLoop.class)
public interface BlockableEventLoopInvoker {
    @Invoker("runAllTasks")
    void lockstep$runAllTasks();
}
