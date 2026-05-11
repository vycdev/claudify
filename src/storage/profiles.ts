import fs from "fs";
import path from "path";
import { PROFILES_DIR, PROFILE_MAX_CHARS, SERVER_MEMORY_MAX_CHARS, BOT_MODEL } from "../config.js";
import { runClaude } from "../claude.js";

export function getUserProfile(userId: string): string {
    const filePath = path.join(PROFILES_DIR, `${userId}.txt`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
    return "";
}

export function getServerMemory(guildId: string): string {
    const filePath = path.join(PROFILES_DIR, `server_${guildId}.txt`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
    return "";
}

export async function backgroundProfileUpdate(
    users: { tag: string; id: string }[],
    conversationContext: string,
): Promise<void> {
    if (users.length === 0) return;

    const uniqueUsers = Array.from(
        new Map(users.map((u) => [u.id, u])).values(),
    );

    const profileSections = uniqueUsers.map((u) => {
        const existing = getUserProfile(u.id);
        return `===CURRENT ${u.tag} (ID: ${u.id})===\n${existing || "(no profile yet)"}`;
    }).join("\n\n");

    try {
        const prompt = [
            "Current user profiles:",
            profileSections,
            "",
            "Recent conversation:",
            conversationContext,
            "",
            "Task: Based on this conversation, output updated profiles for users who revealed NEW lasting information about themselves (name, preferences, expertise, interests, projects, durable opinions, ongoing work, communication style, etc).",
            "",
            "Rules:",
            "- Only output profiles for users where you learned something new. Skip users with no new info.",
            "- Store durable facts, not one-off moods, jokes, insults, or temporary reactions.",
            "- Keep attribution straight. Never copy facts from one user into another user's profile.",
            "- If new info contradicts old info, prefer the newest explicit statement and keep the profile internally consistent.",
            "- Do NOT include information about the bot itself.",
            `- Each profile must be under ${PROFILE_MAX_CHARS} characters.`,
            "- If a user already has a profile, output the full merged profile, not just the new sentence.",
            "",
            "Output format (strictly follow this, one block per user that needs updating):",
            "===PROFILE USER_ID_HERE===",
            "(profile text here)",
            "===END===",
            "",
            "If no profiles need updating, output exactly: NO_UPDATES",
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, BOT_MODEL);
        const output = stdout.trim();

        if (output === "NO_UPDATES") {
            console.error("[Profile] No profile updates needed");
            return;
        }

        const blockPattern = /===PROFILE\s+(\S+)===\s*([\s\S]*?)===END===/g;
        let match;
        let updateCount = 0;
        while ((match = blockPattern.exec(output)) !== null) {
            const userId = match[1];
            const profileText = match[2].trim();
            if (!profileText) continue;

            const user = uniqueUsers.find((u) => u.id === userId);
            if (!user) continue;

            const existing = getUserProfile(userId);
            if (profileText !== existing.trim()) {
                const capped = profileText.slice(0, PROFILE_MAX_CHARS);
                const profilePath = path.join(PROFILES_DIR, `${userId}.txt`);
                fs.writeFileSync(profilePath, capped, "utf-8");
                console.error(
                    `[Profile] Updated profile for ${user.tag} (${capped.length} chars)`,
                );
                updateCount++;
            }
        }

        if (updateCount === 0 && output !== "NO_UPDATES") {
            console.error("[Profile] Could not parse profile updates from output");
        }
    } catch (err: any) {
        console.error(
            `[Profile] Failed to update profiles: ${err.message}`,
        );
    }
}

export async function backgroundServerMemoryUpdate(
    guildId: string,
    guildName: string,
    channelName: string,
    conversationContext: string,
): Promise<void> {
    const memoryPath = path.join(PROFILES_DIR, `server_${guildId}.txt`);
    const existingMemory = getServerMemory(guildId);

    try {
        const prompt = [
            `Current server memory for "${guildName}" (may be empty):`,
            existingMemory || "(no server memory yet)",
            "",
            `Recent conversation in #${channelName}:`,
            conversationContext,
            "",
            "Task: Based on this conversation, output an updated server memory.",
            "Include ONLY server-wide context: channel purposes, recurring topics, ongoing projects, inside jokes, server culture, important events, shared knowledge, and standing preferences for how the bot should respond in this server.",
            "Do NOT include user-specific descriptions, user preferences, behavior patterns, or who does what. Those belong in individual user profiles.",
            "Store durable context, not one-off chatter. If you learned nothing durable about the server, output the existing memory unchanged.",
            `Keep it under ${SERVER_MEMORY_MAX_CHARS} characters. Output ONLY the memory text, no preamble or explanation.`,
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, BOT_MODEL);

        const newMemory = stdout.trim();
        if (newMemory && newMemory !== existingMemory.trim()) {
            const capped = newMemory.slice(0, SERVER_MEMORY_MAX_CHARS);
            fs.writeFileSync(memoryPath, capped, "utf-8");
            console.error(
                `[ServerMemory] Updated memory for ${guildName} (${capped.length} chars)`,
            );
        }
    } catch (err: any) {
        console.error(
            `[ServerMemory] Failed to update memory for ${guildName}: ${err.message}`,
        );
    }
}
