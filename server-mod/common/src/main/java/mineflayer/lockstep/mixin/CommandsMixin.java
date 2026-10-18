package mineflayer.lockstep.mixin;

import com.mojang.brigadier.CommandDispatcher;
import mineflayer.lockstep.LockstepCommand;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** /lockstep joins the vanilla commands (the Commands constructor registers them, again on every /reload) */
@Mixin(Commands.class)
public abstract class CommandsMixin {
    @Shadow
    @Final
    private CommandDispatcher<CommandSourceStack> dispatcher;

    @Inject(method = "<init>", at = @At("TAIL"))
    private void lockstep$register(Commands.CommandSelection selection, CommandBuildContext context, CallbackInfo ci) {
        LockstepCommand.register(this.dispatcher);
    }
}
