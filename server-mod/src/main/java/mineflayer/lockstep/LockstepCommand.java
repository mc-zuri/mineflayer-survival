package mineflayer.lockstep;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

/** {@code /lockstep on|off|status|timeout <ms>}, an admin command like TickCommand */
public final class LockstepCommand {
    private LockstepCommand() {
    }

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("lockstep")
            .requires(Commands.hasPermission(Commands.LEVEL_ADMINS))
            .then(Commands.literal("on").executes(ctx -> setEnabled(ctx.getSource(), true)))
            .then(Commands.literal("off").executes(ctx -> setEnabled(ctx.getSource(), false)))
            .then(Commands.literal("status").executes(ctx -> {
                ctx.getSource().sendSuccess(() -> Component.literal(Lockstep.status(ctx.getSource().getServer())), false);
                return ctx.getSource().getServer().getTickCount();
            }))
            .then(Commands.literal("timeout")
                .executes(ctx -> {
                    ctx.getSource().sendSuccess(() -> Component.literal("lockstep timeout " + Lockstep.timeoutMs() + " ms"), false);
                    return (int) Lockstep.timeoutMs();
                })
                .then(Commands.argument("ms", IntegerArgumentType.integer(1)).executes(ctx -> {
                    int ms = IntegerArgumentType.getInteger(ctx, "ms");
                    Lockstep.setTimeoutMs(ms);
                    ctx.getSource().sendSuccess(() -> Component.literal("lockstep timeout set to " + ms + " ms"), true);
                    return ms;
                }))));
    }

    private static int setEnabled(CommandSourceStack source, boolean enabled) {
        Lockstep.setEnabled(enabled);
        source.sendSuccess(() -> Component.literal("lockstep " + (enabled ? "on" : "off")), true);
        return 1;
    }
}
