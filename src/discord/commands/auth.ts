import {
    ChatInputCommandInteraction,
    Events,
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

const authCommand = new SlashCommandBuilder()
    .setName("auth")
    .setDescription("Manage Claudify's Claude CLI authentication")
    .setDefaultMemberPermissions(null)
    .setDMPermission(false)
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
