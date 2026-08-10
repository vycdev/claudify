import {
    ChatInputCommandInteraction,
    Events,
    Message,
    SlashCommandBuilder,
} from "discord.js";
import {
    AUTH_ADMIN_USER_IDS,
    CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
} from "../../config.js";
import {
    ClaudeAuthManager,
    ClaudeAuthStatus,
} from "../../claudeAuth.js";
import { client } from "../client.js";

const authManager = new ClaudeAuthManager({
    loginTimeoutMs: CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
});

export const authCommand = new SlashCommandBuilder()
    .setName("auth")
    .setDescription("Manage Claudify's Claude CLI authentication")
    .setDefaultMemberPermissions(null)
    .setDMPermission(true)
    .addSubcommand((subcommand) =>
        subcommand
            .setName("status")
            .setDescription("Check whether the Claude CLI is authenticated"),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("login")
            .setDescription("Start an owner-only Claude login session")
            .addStringOption((option) =>
                option
                    .setName("method")
                    .setDescription("Account type to authenticate")
                    .addChoices(
                        {
                            name: "Claude subscription",
                            value: "subscription",
                        },
                        {
                            name: "Claude Console",
                            value: "console",
                        },
                    ),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("code")
            .setDescription("Submit the one-time code from Claude's login page")
            .addStringOption((option) =>
                option
                    .setName("code")
                    .setDescription("Short-lived login code")
                    .setRequired(true)
                    .setMaxLength(4096),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("cancel")
            .setDescription("Cancel the active Claude login session"),
    );

function formatStatus(status: ClaudeAuthStatus): string {
    if (!status.loggedIn) {
        return "Claude CLI is **not authenticated**.";
    }

    const details = [
        status.authMethod ? `Method: \`${status.authMethod}\`` : undefined,
        status.apiProvider ? `Provider: \`${status.apiProvider}\`` : undefined,
    ].filter(Boolean);
    return [
        "Claude CLI is **authenticated**.",
        ...(details.length > 0 ? details : []),
    ].join("\n");
}

function safeErrorMessage(error: unknown): string {
    return error instanceof Error
        ? error.message
        : "Claude authentication failed.";
}

export function isPrivateAuthContext(guildId: string | null): boolean {
    return guildId === null;
}

export type AuthTextCommand =
    | { subcommand: "help" | "status" | "cancel" }
    | { subcommand: "login"; method: "subscription" | "console" }
    | { subcommand: "code"; code: string }
    | { subcommand: "invalid"; error: string };

export function parseAuthTextCommand(
    content: string,
): AuthTextCommand | null {
    const trimmed = content.trim();
    if (!/^!auth(?:\s|$)/i.test(trimmed)) {
        return null;
    }

    const rest = trimmed.slice("!auth".length).trim();
    if (!rest || rest.toLowerCase() === "help") {
        return { subcommand: "help" };
    }

    const separator = rest.search(/\s/);
    const action = (
        separator === -1 ? rest : rest.slice(0, separator)
    ).toLowerCase();
    const argument =
        separator === -1 ? "" : rest.slice(separator).trim();

    if (action === "status" || action === "cancel") {
        if (argument) {
            return {
                subcommand: "invalid",
                error: `\`!auth ${action}\` does not accept an argument.`,
            };
        }
        return { subcommand: action };
    }

    if (action === "login") {
        const method = argument.toLowerCase();
        if (!method || method === "subscription") {
            return { subcommand: "login", method: "subscription" };
        }
        if (method === "console") {
            return { subcommand: "login", method: "console" };
        }
        return {
            subcommand: "invalid",
            error: "Use `!auth login subscription` or `!auth login console`.",
        };
    }

    if (action === "code") {
        if (!argument) {
            return {
                subcommand: "invalid",
                error: "Use `!auth code <one-time-code>`.",
            };
        }
        return { subcommand: "code", code: argument };
    }

    return {
        subcommand: "invalid",
        error: "Unknown auth command. Use `!auth help`.",
    };
}

function authTextHelp(): string {
    return [
        "**Claudify authentication commands**",
        "`!auth status` — Check Claude CLI authentication",
        "`!auth login [subscription|console]` — Start a login",
        "`!auth code <one-time-code>` — Complete the login",
        "`!auth cancel` — Cancel the active login",
        "",
        "These commands only work in this private DM.",
    ].join("\n");
}

export async function handleAuthTextMessage(msg: Message): Promise<boolean> {
    const command = parseAuthTextCommand(msg.content);
    if (!command) {
        return false;
    }

    if (!AUTH_ADMIN_USER_IDS.has(msg.author.id)) {
        await msg.reply("You are not allowed to manage Claude authentication.");
        return true;
    }

    if (msg.guildId !== null) {
        await msg.reply(
            "For security, send this command to me in a private DM. Start with `!auth help`.",
        );
        return true;
    }

    try {
        if (command.subcommand === "invalid") {
            await msg.reply(command.error);
            return true;
        }

        if (command.subcommand === "help") {
            await msg.reply(authTextHelp());
            return true;
        }

        if (command.subcommand === "status") {
            await msg.reply(formatStatus(await authManager.getStatus()));
            return true;
        }

        if (command.subcommand === "login") {
            const loginUrl = await authManager.startLogin(
                msg.author.id,
                command.method,
            );
            const timeoutMinutes = Math.ceil(
                CLAUDE_AUTH_LOGIN_TIMEOUT_MS / 60_000,
            );
            const instructions = [
                "After authorizing, reply here with `!auth code <one-time-code>`.",
                `This private session expires in about ${timeoutMinutes} minute(s).`,
                "",
                "**Do not submit an API key or long-lived OAuth token.**",
            ].join("\n");
            const content = [
                "Open this Claude login URL:",
                `<${loginUrl}>`,
                "",
                instructions,
            ].join("\n");

            if (content.length <= 2000) {
                await msg.reply(content);
            } else {
                await msg.reply({
                    content: [
                        "Claude's login URL is attached because it is too long for a Discord message.",
                        instructions,
                    ].join("\n"),
                    files: [
                        {
                            attachment: Buffer.from(`${loginUrl}\n`, "utf8"),
                            name: "claude-login-url.txt",
                        },
                    ],
                });
            }
            return true;
        }

        if (command.subcommand === "code") {
            const status = await authManager.submitCode(
                msg.author.id,
                command.code,
            );
            await msg.reply(
                `${formatStatus(status)}\nThe one-time code was not logged or stored by Claudify.`,
            );
            return true;
        }

        authManager.cancelLogin(msg.author.id);
        await msg.reply(
            "The active Claude authentication session was cancelled.",
        );
    } catch (error) {
        const message = safeErrorMessage(error);
        console.error(`[Claude Auth] Text command failed: ${message}`);
        await msg.reply(`Authentication error: ${message}`);
    }

    return true;
}

async function handleAuthInteraction(
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    if (!AUTH_ADMIN_USER_IDS.has(interaction.user.id)) {
        await interaction.reply({
            content: "You are not allowed to manage Claude authentication.",
            ephemeral: true,
        });
        return;
    }

    if (!isPrivateAuthContext(interaction.guildId)) {
        await interaction.reply({
            content: "For security, use this command in a private DM.",
            ephemeral: true,
        });
        return;
    }

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (subcommand === "status") {
        const status = await authManager.getStatus();
        await interaction.editReply(formatStatus(status));
        return;
    }

    if (subcommand === "login") {
        const method =
            interaction.options.getString("method") === "console"
                ? "console"
                : "subscription";
        const loginUrl = await authManager.startLogin(
            interaction.user.id,
            method,
        );
        const timeoutMinutes = Math.ceil(
            CLAUDE_AUTH_LOGIN_TIMEOUT_MS / 60_000,
        );
        const instructions = [
            "After authorizing, use `/auth code` with the short-lived code shown by Claude.",
            `This private session expires in about ${timeoutMinutes} minute(s).`,
            "",
            "**Do not submit an API key or long-lived OAuth token.**",
        ].join("\n");
        const content = [
                "Open this Claude login URL:",
                `<${loginUrl}>`,
                "",
                instructions,
            ].join("\n");
        if (content.length <= 2000) {
            await interaction.editReply(content);
        } else {
            await interaction.editReply({
                content: [
                    "Claude's login URL is attached because it is too long for a Discord message.",
                    instructions,
                ].join("\n"),
                files: [
                    {
                        attachment: Buffer.from(`${loginUrl}\n`, "utf8"),
                        name: "claude-login-url.txt",
                    },
                ],
            });
        }
        return;
    }

    if (subcommand === "code") {
        const code = interaction.options.getString("code", true);
        const status = await authManager.submitCode(
            interaction.user.id,
            code,
        );
        await interaction.editReply(
            `${formatStatus(status)}\nThe one-time code was not logged or stored by Claudify.`,
        );
        return;
    }

    if (subcommand === "cancel") {
        authManager.cancelLogin(interaction.user.id);
        await interaction.editReply(
            "The active Claude authentication session was cancelled.",
        );
    }
}

export function registerAuthInteractionHandler(): void {
    client.on(Events.InteractionCreate, async (interaction) => {
        if (
            !interaction.isChatInputCommand() ||
            interaction.commandName !== "auth"
        ) {
            return;
        }

        try {
            await handleAuthInteraction(interaction);
        } catch (error) {
            const message = safeErrorMessage(error);
            console.error(`[Claude Auth] Command failed: ${message}`);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(`Authentication error: ${message}`);
            } else {
                await interaction.reply({
                    content: `Authentication error: ${message}`,
                    ephemeral: true,
                });
            }
        }
    });
}

export async function registerAuthCommand(): Promise<void> {
    if (!client.application) {
        throw new Error("Discord application is unavailable after login.");
    }

    const commands = await client.application.commands.fetch();
    const existing = commands.find((command) => command.name === "auth");
    if (AUTH_ADMIN_USER_IDS.size === 0) {
        if (existing) {
            await client.application.commands.delete(existing.id);
        }
        console.error(
            "[Claude Auth] Discord auth commands disabled: AUTH_ADMIN_USER_IDS is empty.",
        );
        return;
    }

    const definition = authCommand.toJSON();
    if (existing) {
        await client.application.commands.edit(existing.id, definition);
    } else {
        await client.application.commands.create(definition);
    }
    console.error(
        `[Claude Auth] Registered /auth for ${AUTH_ADMIN_USER_IDS.size} allowed user(s).`,
    );
}
