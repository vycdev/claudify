import {
    CLAUDE_WORKLOAD_CONFIG,
    HISTORY_DIR,
    MESSAGES_DIR,
    MCP_CONFIG_PATH,
    getResponseModelDisplay,
} from "./config.js";
import { runClaude } from "./claude.js";
import { client } from "./discord/client.js";
import { loadRecentHistory } from "./storage/history.js";
import { getUserProfile, getServerMemory } from "./storage/profiles.js";
import { renderPrompt } from "./prompts.js";

type ClaudeRunner = typeof runClaude;

function getSystemPrompt(): string {
    const botName =
        client.user?.displayName || client.user?.username || "Claudify";

    return renderPrompt("botSystem", {
        botModel: getResponseModelDisplay(),
        botName,
        historyDir: HISTORY_DIR,
        messagesDir: MESSAGES_DIR,
    });
}

export async function askClaude(
    question: string,
    author: string,
    authorId: string,
    channelName: string,
    channelId: string,
    serverName: string,
    guildId: string,
    imagePaths: string[] = [],
    liveMessages: string = "",
    claudeRunner: ClaudeRunner = runClaude,
): Promise<string> {
    const recentHistory = loadRecentHistory(channelId, question, channelName);
    const userProfile = getUserProfile(authorId);
    const serverMemory = getServerMemory(guildId);

    const promptParts: string[] = [];

    const now = new Date();
    promptParts.push(
        `=== Current time: ${now.toLocaleString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
        })} ===`,
    );
    promptParts.push("");

    if (recentHistory && recentHistory !== "No previous conversation history.") {
        promptParts.push(
            `=== Saved channel memory for #${channelName} (primary for recaps and older context) ===`,
        );
        promptParts.push(recentHistory);
        promptParts.push("");
    }

    if (liveMessages) {
        promptParts.push(
            `=== Recent live messages in #${channelName} (newest Discord API slice) ===`,
        );
        promptParts.push(liveMessages);
        promptParts.push("");
    }

    if (serverMemory) {
        promptParts.push(`=== Server context for "${serverName}" ===`);
        promptParts.push(serverMemory);
        promptParts.push("");
    }

    if (userProfile) {
        promptParts.push(`=== Known info about ${author} ===`);
        promptParts.push(userProfile);
        promptParts.push("");
    }

    try {
        const guild = client.guilds.cache.find((g) => g.id === guildId);
        if (guild && guild.emojis.cache.size > 0) {
            const emojiList = guild.emojis.cache
                .map((e) => e.name)
                .filter(Boolean)
                .join(", ");
            promptParts.push("=== Custom emojis available in this server ===");
            promptParts.push(emojiList);
            promptParts.push("");
        }
    } catch {
        /* ignore */
    }

    promptParts.push(`=== Current message from ${author} in #${channelName} (${serverName}) ===`);
    promptParts.push(question);

    if (imagePaths.length > 0) {
        promptParts.push("");
        promptParts.push(
            `The user attached ${imagePaths.length} image(s). Use the Read tool to view them:`,
        );
        for (const imgPath of imagePaths) {
            promptParts.push(`- ${imgPath}`);
        }
    }

    const prompt = promptParts.join("\n");

    try {
        console.error(
            `[Claude CLI] Spawning claude with prompt via stdin (${prompt.length} chars)`,
        );

        const { stdout, stderr } = await claudeRunner(
            [
                "-p",
                "--system-prompt",
                getSystemPrompt(),
                "--allowedTools",
                "WebSearch,WebFetch,Read,Grep,Glob,mcp__discord__send-message,mcp__discord__read-messages,mcp__discord__read-message-history,mcp__discord__fetch-messages,mcp__discord__react-to-message,mcp__morpheus__*",
                "--add-dir",
                MESSAGES_DIR,
                "--mcp-config",
                MCP_CONFIG_PATH,
            ],
            prompt,
            CLAUDE_WORKLOAD_CONFIG.response,
        );

        if (stderr) console.error(`[Claude CLI] stderr: ${stderr}`);
        console.error(
            `[Claude CLI] Response received (${stdout.length} chars)`,
        );
        if (!stdout.trim()) {
            console.error(
                "[Claude CLI] WARNING: Empty response. Claude CLI may not be authenticated. Run: docker exec -it <container> claude auth login",
            );
        }
        return (
            stdout.trim() ||
            "Sorry, I could not generate a response. The bot may not be authenticated yet - check the server logs."
        );
    } catch (error: any) {
        console.error(`[Claude CLI] Error: ${error.message}`);
        if (error.stderr) console.error(`[Claude CLI] stderr: ${error.stderr}`);
        if (error.stdout) console.error(`[Claude CLI] stdout: ${error.stdout}`);
        return "Sorry, I encountered an error processing your request.";
    }
}
