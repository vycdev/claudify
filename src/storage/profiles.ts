import fs from "fs";
import path from "path";
import { PROFILES_DIR, PROFILE_MAX_CHARS, SERVER_MEMORY_MAX_CHARS } from "../config.js";
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

    // Deduplicate by ID
    const uniqueUsers = Array.from(
        new Map(users.map((u) => [u.id, u])).values(),
    );

    // Build existing profiles section
    const profileSections = uniqueUsers.map((u) => {
        const existing = getUserProfile(u.id);
        return `===CURRENT ${u.tag} (ID: ${u.id})===\n${existing || "(no profile yet)"}`;
    }).join("\n\n");

    try {
        const prompt = [
            `Current user profiles:`,
            profileSections,
            "",
            `Recent conversation:`,
            conversationContext,
            "",
            `Task: Based on this conversation, output updated profiles for users who revealed NEW lasting information about themselves (name, preferences, expertise, interests, projects, opinions, etc).`,
            ``,
            `Rules:`,
            `- Only output profiles for users where you learned something new. Skip users with no new info.`,
            `- Do NOT include information about the bot itself.`,
            `- Each profile must be under ${PROFILE_MAX_CHARS} characters.`,
            `- If a user already has a profile, merge new info with existing info.`,
            ``,
            `Output format (strictly follow this, one block per user that needs updating):`,
            `===PROFILE USER_ID_HERE===`,
            `(profile text here)`,
            `===END===`,
            ``,
            `If no profiles need updating, output exactly: NO_UPDATES`,
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, "claude-haiku-4-5");
        const output = stdout.trim();

        if (output === "NO_UPDATES") {
            console.error(`[Profile] No profile updates needed`);
            return;
        }

        // Parse output blocks
        const blockPattern = /===PROFILE\s+(\S+)===\s*([\s\S]*?)===END===/g;
        let match;
        let updateCount = 0;
        while ((match = blockPattern.exec(output)) !== null) {
            const userId = match[1];
            const profileText = match[2].trim();
            if (!profileText) continue;

            // Verify this is a user we asked about
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
            console.error(`[Profile] Could not parse profile updates from output`);
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
            `Task: Based on this conversation, output an updated server memory. Include ONLY server-wide context: channel purposes, recurring topics, ongoing projects, inside jokes, server culture, important events, and shared knowledge. Do NOT include any user-specific information (user descriptions, user preferences, user behavior patterns, who does what) — that belongs in individual user profiles which are managed separately. Keep it under ${SERVER_MEMORY_MAX_CHARS} characters. If you learned nothing new about the server, output the existing memory unchanged. Output ONLY the memory text, no preamble or explanation.`,
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, "claude-haiku-4-5");

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
