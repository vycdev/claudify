import {
    ChannelType,
    InteractionContextType,
    Events,
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type Message,
} from "discord.js";
import {
    AUTH_ADMIN_USER_IDS,
    CODEX_HOME,
    CODEX_AUTH_LOGIN_TIMEOUT_MS,
    assertSafeCodexHome,
} from "../../config.js";
import { CodexAuthManager, type CodexAuthStatus } from "../../codexAuth.js";
import { createCodexClient } from "../../codexClient.js";
import { client } from "../client.js";

const authManager = new CodexAuthManager({
    clientFactory: () => {
        assertSafeCodexHome();
        return createCodexClient({ home: CODEX_HOME });
    },
    loginTimeoutMs: CODEX_AUTH_LOGIN_TIMEOUT_MS,
});
export const codexAuthCommand = new SlashCommandBuilder()
    .setName("codex-auth")
    .setDescription("Manage the bot's Codex subscription login privately")
    .setDefaultMemberPermissions(null)
    .setContexts(InteractionContextType.BotDM);
for (const action of [
    "status",
    "login",
    "cancel",
    "logout",
    "usage",
] as const) {
    codexAuthCommand.addSubcommand((command) =>
        command
            .setName(action)
            .setDescription(
                `${action} the bot's Codex subscription authentication`,
            ),
    );
}
const HELP =
    "**Codex subscription login**\n`!codex auth status`\n`!codex usage`\n`!codex auth login`\n`!codex auth cancel`\n`!codex auth logout`\nUse these commands only in a private DM. Log in with the account that will fund the bot's usage. Never send passwords, API keys, or OAuth tokens to Discord.";
const SAFE_ERROR =
    "Codex authentication could not complete. Check that the pinned Codex CLI is installed, device-code authentication is enabled in ChatGPT security settings, and no other admin owns an active login. Retry status or login; no API-key fallback is used.";
function statusText(status: CodexAuthStatus): string {
    if (status === "subscription")
        return "Codex is authenticated with a ChatGPT subscription.";
    if (status === "unsupported")
        return "Codex has an unsupported authentication mode. Claudify requires a ChatGPT subscription, not an API key. Use !codex auth logout, then !codex auth login.";
    return "Codex is not authenticated. Start !codex auth login in this private DM.";
}
type AuthActions = Pick<
    CodexAuthManager,
    "getStatus" | "startLogin" | "cancelLogin" | "logout" | "getUsage"
>;
export function createCodexAuthHandlers(
    manager: AuthActions,
    admins: ReadonlySet<string>,
) {
    const execute = async (
        action: string,
        owner: string,
        reply: (message: string) => Promise<unknown>,
        notify: (message: string) => Promise<unknown>,
    ): Promise<void> => {
        if (action === "help") {
            await reply(HELP);
            return;
        }
        if (action === "usage") {
            await reply(await manager.getUsage());
            return;
        }
        if (action === "status") {
            await reply(statusText(await manager.getStatus()));
            return;
        }
        if (action === "login") {
            const login = await manager.startLogin(owner, async (message) => {
                await notify(message);
            });
            try {
                await reply(
                    `Open <${login.verificationUrl}> and enter **${login.userCode}** in your browser. Approve only if you initiated this login for Claudify.\n\nDo not paste the code or any token back into Discord. I will confirm completion privately. Use !codex auth cancel to stop.`,
                );
            } catch (error) {
                await manager.cancelLogin(owner).catch(() => {});
                throw error;
            }
            return;
        }
        if (action === "cancel") {
            const status = await manager.cancelLogin(owner);
            await reply(
                status === "canceled"
                    ? "Codex login cancelled."
                    : "No pending Codex login was cancelled. It may already have completed; check !codex auth status. Use logout if you intend to sign the bot out.",
            );
            return;
        }
        if (action === "logout") {
            await manager.logout(owner);
            await reply(
                "Codex is signed out. Existing in-flight work may already have used the subscription.",
            );
            return;
        }
        await reply(HELP);
    };
    return {
        async handleText(msg: Message): Promise<boolean> {
            if (!/^!codex(?:\s|$)/i.test(msg.content.trim())) return false;
            if (!admins.has(msg.author.id)) {
                await msg.reply(
                    "You are not allowed to manage Codex authentication.",
                );
                return true;
            }
            if (msg.guildId !== null || msg.channel.type !== ChannelType.DM) {
                await msg.reply(
                    "For security, send Codex commands in a private DM. Start with !codex auth help.",
                );
                return true;
            }
            const match =
                /^!codex(?:\s+auth)?(?:\s+(help|status|login|cancel|logout|usage))?\s*$/i.exec(
                    msg.content.trim(),
                );
            try {
                await execute(
                    match ? (match[1]?.toLowerCase() ?? "help") : "help",
                    msg.author.id,
                    (text) => msg.reply(text),
                    (text) => msg.reply(text),
                );
            } catch {
                await msg.reply(SAFE_ERROR);
            }
            return true;
        },
        async handleInteraction(
            interaction: ChatInputCommandInteraction,
        ): Promise<void> {
            if (
                !admins.has(interaction.user.id) ||
                interaction.guildId !== null ||
                interaction.context !== InteractionContextType.BotDM
            ) {
                await interaction.reply({
                    content:
                        "Codex authentication is restricted to configured admins in private DMs.",
                    ephemeral: true,
                });
                return;
            }
            await interaction.deferReply({ ephemeral: true });
            try {
                await execute(
                    interaction.options.getSubcommand(),
                    interaction.user.id,
                    (text) => interaction.editReply(text),
                    (text) => interaction.user.send(text),
                );
            } catch {
                await interaction.editReply(SAFE_ERROR);
            }
        },
    };
}
const handlers = createCodexAuthHandlers(authManager, AUTH_ADMIN_USER_IDS);
export const handleCodexAuthTextMessage = handlers.handleText;
export function registerCodexAuthInteractionHandler(): void {
    client.on(Events.InteractionCreate, async (interaction) => {
        if (
            !interaction.isChatInputCommand() ||
            interaction.commandName !== "codex-auth"
        )
            return;
        try {
            await handlers.handleInteraction(interaction);
        } catch {
            console.error(
                "[Codex Auth] Could not deliver a private authentication reply.",
            );
        }
    });
}
export async function registerCodexAuthCommand(): Promise<void> {
    if (!client.application)
        throw new Error("Discord application is unavailable.");
    const commands = await client.application.commands.fetch();
    const existing = commands.find((command) => command.name === "codex-auth");
    if (AUTH_ADMIN_USER_IDS.size === 0) {
        if (existing) await client.application.commands.delete(existing.id);
        return;
    }
    const definition = codexAuthCommand.toJSON();
    if (existing)
        await client.application.commands.edit(existing.id, definition);
    else await client.application.commands.create(definition);
}
