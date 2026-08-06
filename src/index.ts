import "./config.js";
import { MESSAGES_DIR, logClaudeWorkloadConfig } from "./config.js";
import { client } from "./discord/client.js";
import { registerHandler } from "./discord/handler.js";
import {
    registerAuthCommand,
    registerAuthInteractionHandler,
} from "./discord/commands/auth.js";
import { writeMcpConfig, startMcpHttpServer } from "./mcp/http.js";

client.once("ready", async () => {
    console.error("Discord bot is ready!");
    console.error(`Messages will be saved to: ${MESSAGES_DIR}`);
    try {
        await registerAuthCommand();
    } catch (error) {
        console.error(
            "[Claude Auth] Failed to register Discord command:",
            error,
        );
    }
});

registerHandler();
registerAuthInteractionHandler();

async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error("DISCORD_TOKEN environment variable is not set");
    }

    logClaudeWorkloadConfig();

    try {
        await client.login(token);

        writeMcpConfig();
        startMcpHttpServer();
    } catch (error) {
        console.error("Fatal error in main():", error);
        process.exit(1);
    }
}

main();
