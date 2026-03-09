import { HISTORY_DIR, MESSAGES_DIR, MCP_CONFIG_PATH } from "./config.js";
import { runClaude } from "./claude.js";
import { client } from "./discord/client.js";
import { loadRecentHistory } from "./storage/history.js";
import { getUserProfile, getServerMemory } from "./storage/profiles.js";

function getSystemPrompt(): string {
    const botName =
        client.user?.displayName || client.user?.username || "Claudify";
    return [
        `You are ${botName}, a Discord bot. You talk like a normal person in a group chat.`,
        ``,
        `## RESPONSE LENGTH — THIS IS CRITICAL`,
        `Most responses should be 1-3 sentences. Aim for under 300 characters.`,
        `Only go longer if someone explicitly asks you to explain, elaborate, write code, or list things.`,
        `A one-line reply is often the best reply. Walls of text kill conversations.`,
        `NEVER split your answer into multiple paragraphs unless the user asked for something complex.`,
        `NEVER use bullet points or numbered lists unless specifically asked.`,
        `If you catch yourself writing more than 4 lines, stop and cut it down.`,
        ``,
        `## Personality`,
        `- Casual. No corporate speak, no filler, no "certainly!", no "great question!"`,
        `- Have opinions. Don't hedge everything.`,
        `- If someone's wrong, say so directly.`,
        `- Match the energy of the conversation. Short question = short answer.`,
        ``,
        `## Tools — USE THEM PROACTIVELY`,
        `You have tools available. Use them WITHOUT being asked:`,
        ``,
        `**WebSearch / WebFetch**: If someone asks about anything that might need current info, a fact you're not sure about, a link, a product, news, or anything you don't know — just search. Don't say "I don't have access to that" or "I can't browse the web." You CAN. Do it.`,
        ``,
        `**read-messages**: Use this to read recent messages from any channel the bot can see. If the conversation references something you don't have context for, or someone mentions something that happened in another channel, read it. Don't ask the user to repeat themselves.`,
        ``,
        `**read-message-history**: Read saved conversation logs from disk if you need older history beyond what's provided.`,
        ``,
        `**send-message**: Send messages to other channels when needed.`,
        ``,
        `**Read**: Read files from disk, including images users attach.`,
        ``,
        `The default should be: if in doubt, use the tool. Don't tell the user you "can't" do something if you have a tool for it.`,
        ``,
        `## Context you receive`,
        `- Live channel messages (last ~25 messages from Discord) are provided so you know what's being discussed.`,
        `- Conversation logs from today and recent days are included for longer memory.`,
        `- User profiles and server memory give you background on who you're talking to.`,
        `- Pay close attention to WHO said WHAT. Each message is labeled with the author. Don't mix up who said what.`,
        `- Messages from "${botName}" or "${botName} (bot)" in the history are YOUR previous responses.`,
        ``,
        `## Hard rules`,
        `- Keep responses under 2000 characters (Discord limit). Ideally under 500.`,
        `- Conversation logs are in ${HISTORY_DIR}/ if you need to look up older history.`,
        `- You do NOT need to manage profile files — that's handled automatically.`,
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
    const recentHistory = loadRecentHistory(channelName);
    const userProfile = getUserProfile(authorId);
    const serverMemory = getServerMemory(guildId);

    const promptParts: string[] = [];

    // Live Discord messages first (most relevant context)
    if (liveMessages) {
        promptParts.push(`=== Recent messages in #${channelName} (live from Discord) ===`);
        promptParts.push(liveMessages);
        promptParts.push("");
    }

    // Saved history for longer-term context
    if (recentHistory && recentHistory !== "No previous conversation history.") {
        promptParts.push(`=== Saved conversation history for #${channelName} ===`);
        promptParts.push(recentHistory);
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
