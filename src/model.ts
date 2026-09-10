import {
    BOT_PROVIDER,
    CODEX_HOME,
    MESSAGES_DIR,
    MCP_PORT,
    MORPHEUS_MCP_URL,
    MORPHEUS_MCP_API_KEY,
} from "./config.js";
import { runClaude } from "./claude.js";
import type { ClaudeEffort } from "./claudeTypes.js";
import { createCodexRunner, type CodexMcpServer } from "./codex.js";
import type { ModelRunner } from "./modelTypes.js";

const servers: Record<string, CodexMcpServer> = {
    discord: {
        url: `http://127.0.0.1:${MCP_PORT}/mcp`,
        enabled_tools: [
            "send-message",
            "react-to-message",
            "read-messages",
            "read-message-history",
            "fetch-messages",
        ],
    },
};
if (MORPHEUS_MCP_URL && MORPHEUS_MCP_API_KEY)
    servers.morpheus = {
        url: MORPHEUS_MCP_URL,
        http_headers: { Authorization: `Bearer ${MORPHEUS_MCP_API_KEY}` },
    };
const codexRunner = createCodexRunner({
    home: CODEX_HOME,
    forbiddenRoots: [MESSAGES_DIR],
    mcpServers: servers,
});
export const runModel: ModelRunner = (args, input, options, imagePaths) => {
    if (BOT_PROVIDER === "codex")
        return codexRunner(args, input, options, imagePaths);
    if (options.effort === "none" || options.effort === "minimal")
        throw new Error("Unsupported Claude effort.");
    return runClaude(args, input, {
        ...options,
        effort: options.effort as ClaudeEffort | undefined,
    });
};
