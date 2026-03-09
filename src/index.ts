import "./config.js";
import { MESSAGES_DIR } from "./config.js";
import { client } from "./discord/client.js";
import { registerHandler } from "./discord/handler.js";
import { writeMcpConfig, startMcpHttpServer } from "./mcp/http.js";

client.once("ready", () => {
    console.error("Discord bot is ready!");
    console.error(`Messages will be saved to: ${MESSAGES_DIR}`);
});

registerHandler();

async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error("DISCORD_TOKEN environment variable is not set");
    }

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
