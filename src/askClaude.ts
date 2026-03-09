import { HISTORY_DIR, MESSAGES_DIR, MCP_CONFIG_PATH } from "./config.js";
import { runClaude } from "./claude.js";
import { client } from "./discord/client.js";
import { loadRecentHistory } from "./storage/history.js";
import { getUserProfile, getServerMemory } from "./storage/profiles.js";

function getSystemPrompt(): string {
    const botName =
        client.user?.displayName || client.user?.username || "Claudify";
    return [
        `You are ${botName}, an AI Discord bot. You have access to message history files in the messages directory.`,
        ``,
        `Personality and behavior:`,
        `- Your name is ${botName}. Respond to it naturally.`,
        `- Talk casually, like a regular person in a Discord server. No corporate speak.`,
        `- Be concise by default. Short, direct answers. No filler.`,
        `- When someone asks you to elaborate or the topic is complex, go deeper. But don't over-explain unprompted.`,
        `- Have actual opinions. Don't fence-sit or "both sides" everything. Pick a side and say why.`,
        `- Don't be sycophantic. No "Great question!" or "That's a really interesting point!" Just answer.`,
        `- Don't try to mediate or play peacekeeper. If someone's wrong, say so.`,
        `- Keep responses under 2000 characters (Discord's limit).`,
        `- You can read from the messages directory for memory across conversations.`,
        ``,
        `Memory:`,
        `- Conversation history (recent messages + past week summaries) is provided automatically in each prompt.`,
        `- User profiles are maintained automatically — the user's profile is included in your prompt when they talk to you.`,
        `- You do NOT need to write or update profile files. A background system handles that after each conversation.`,
        `- Conversation logs are in ${HISTORY_DIR}/ if you need to look up older history beyond what's provided.`,
        ``,
        `Discord tools (via MCP):`,
        `- You have access to Discord tools: send-message, read-messages, read-message-history.`,
        `- Use read-messages to read live messages from any channel the bot can see.`,
        `- Use send-message to send messages to other channels if needed.`,
        `- Only use these tools when the user's request requires interacting with Discord beyond the current channel.`,
    ].join("\n");
}

export async function askClaude(
    question: string,
    author: string,
    authorId: string,
    channelName: string,
    serverName: string,
    guildId: string,
    imagePaths: string[] = [],
): Promise<string> {
    const recentHistory = loadRecentHistory(channelName);
    const userProfile = getUserProfile(authorId);
    const serverMemory = getServerMemory(guildId);

    const promptParts = [
        `Recent conversation history in #${channelName}:`,
        recentHistory,
    ];

    if (serverMemory) {
        promptParts.push("");
        promptParts.push(`Server memory for "${serverName}":`);
        promptParts.push(serverMemory);
    }

    promptParts.push("");
    if (userProfile) {
        promptParts.push(`Known info about ${author}:`);
        promptParts.push(userProfile);
    }

    promptParts.push("");
    promptParts.push(
        `Current question from ${author} in #${channelName} (${serverName}):`,
    );
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

        const { stdout, stderr } = await runClaude(
            [
                "-p",
                "--system-prompt",
                getSystemPrompt(),
                "--allowedTools",
                "WebSearch,WebFetch,Read,mcp__discord__send-message,mcp__discord__read-messages,mcp__discord__read-message-history,mcp__discord__fetch-messages",
                "--add-dir",
                MESSAGES_DIR,
                "--mcp-config",
                MCP_CONFIG_PATH,
            ],
            prompt,
            "claude-haiku-4-5",
        );

        if (stderr) console.error(`[Claude CLI] stderr: ${stderr}`);
        console.error(
            `[Claude CLI] Response received (${stdout.length} chars)`,
        );
        if (!stdout.trim()) {
            console.error(
                `[Claude CLI] WARNING: Empty response. Claude CLI may not be authenticated. Run: docker exec -it <container> claude auth login`,
            );
        }
        return (
            stdout.trim() ||
            "Sorry, I could not generate a response. The bot may not be authenticated yet — check the server logs."
        );
    } catch (error: any) {
        console.error(`[Claude CLI] Error: ${error.message}`);
        if (error.stderr) console.error(`[Claude CLI] stderr: ${error.stderr}`);
        if (error.stdout) console.error(`[Claude CLI] stdout: ${error.stdout}`);
        return "Sorry, I encountered an error processing your request.";
    }
}
