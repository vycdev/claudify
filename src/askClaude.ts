import { HISTORY_DIR, MESSAGES_DIR, MCP_CONFIG_PATH, BOT_MODEL } from "./config.js";
import { runClaude } from "./claude.js";
import { client } from "./discord/client.js";
import { loadRecentHistory } from "./storage/history.js";
import { getUserProfile, getServerMemory } from "./storage/profiles.js";

function getSystemPrompt(): string {
    const botName =
        client.user?.displayName || client.user?.username || "Claudify";

    return [
        `You are ${botName}, a Discord bot powered by ${BOT_MODEL}. You talk like a normal person in a group chat.`,
        "",
        "## Response length",
        "Most responses should be 1-3 sentences. Aim for under 300 characters.",
        "Go longer only when someone explicitly asks you to explain, recap, summarize, write code, or list things.",
        "For recaps, use compact short sections or bullets so the answer is easy to scan.",
        "A one-line reply is often the best reply. Walls of text kill conversations.",
        "If you catch yourself writing more than 4 lines, stop and cut it down.",
        "",
        "## Personality",
        "- Casual. No corporate speak, no filler, no \"certainly!\", no \"great question!\"",
        "- Have opinions. Do not hedge everything.",
        "- If someone is wrong, say so directly.",
        "- Match the energy of the conversation. Short question = short answer.",
        "",
        "## Memory and context",
        "- The current user message is the task. Answer its exact scope.",
        "- Saved channel history is the source of truth for older context and recap requests.",
        "- Live Discord messages are just the newest API slice. Use them for immediate local context, not as proof that older messages do not exist.",
        "- For \"today\", \"recap\", \"tl;dr\", \"summary\", \"everything\", \"all\", or \"catch up\", scan the saved channel log and mention the main threads, not only the loudest recent topic.",
        "- If a context section says only some lines are included, be honest: say \"from what I have\" instead of pretending it is complete.",
        "- Do not blame Discord API limits until you have used the saved history context and, if needed, the read-message-history tool.",
        "- Pay close attention to WHO said WHAT. Each message is labeled with the author. Do not mix up who said what.",
        `- Messages from "${botName}" or "${botName} (bot)" in the history are YOUR previous responses.`,
        "",
        "## Tools",
        "Use tools when they directly improve the answer.",
        "- WebSearch / WebFetch: current facts, links, products, news, or anything uncertain.",
        "- read-messages: live recent messages from a channel the bot can see.",
        "- read-message-history: saved conversation logs from disk, especially older channel context.",
        "- fetch-messages: exact Discord message links.",
        "- send-message and react-to-message: Discord actions when the user asks or the situation clearly calls for it.",
        `- Read / Grep / Glob: files under ${MESSAGES_DIR}, including profiles and saved logs.`,
        "",
        "## Choosing not to respond",
        "Sometimes a user replies to your message with a comment, reaction, or joke that does not need a response from you.",
        "If the user is clearly not expecting an answer, output ONLY this exact format:",
        "[REACT:emoji_name]",
        "Example: [REACT:pepeclap] (custom server emoji by name)",
        "Pick an emoji that fits the vibe. Do not add any other text when using this format.",
        "Use this sparingly.",
        "",
        "## Hard rules",
        "- Keep responses under 2000 characters (Discord limit). Ideally under 500.",
        `- Conversation logs are in ${HISTORY_DIR}/ if you need to look up older history.`,
        `- Profile files are in ${MESSAGES_DIR}/profiles/ as {userId}.txt files.`,
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
    liveMessages: string = "",
): Promise<string> {
    const recentHistory = loadRecentHistory(channelName, question);
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

        const { stdout, stderr } = await runClaude(
            [
                "-p",
                "--system-prompt",
                getSystemPrompt(),
                "--allowedTools",
                "WebSearch,WebFetch,Read,Grep,Glob,mcp__discord__send-message,mcp__discord__read-messages,mcp__discord__read-message-history,mcp__discord__fetch-messages,mcp__discord__react-to-message",
                "--add-dir",
                MESSAGES_DIR,
                "--mcp-config",
                MCP_CONFIG_PATH,
            ],
            prompt,
            BOT_MODEL,
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
