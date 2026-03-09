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
    authorTag: string,
    authorId: string,
    question: string,
    response: string,
): Promise<void> {
    const profilePath = path.join(PROFILES_DIR, `${authorId}.txt`);
    const existingProfile = getUserProfile(authorId);

    try {
        const prompt = [
            `Current profile for ${authorTag} (may be empty):`,
            existingProfile || "(no profile yet)",
            "",
            `Latest exchange:`,
            `${authorTag}: ${question}`,
            `Bot: ${response}`,
            "",
            `Task: Based on this exchange, output an updated user profile. Include ONLY lasting facts about the user (name, preferences, expertise, interests, projects, etc). Keep it under ${PROFILE_MAX_CHARS} characters. If you learned nothing new, output the existing profile unchanged. Output ONLY the profile text, no preamble or explanation.`,
        ].join("\n");

        const { stdout } = await runClaude(["-p"], prompt, "claude-haiku-4-5");

        const newProfile = stdout.trim();
        if (newProfile && newProfile !== existingProfile.trim()) {
            const capped = newProfile.slice(0, PROFILE_MAX_CHARS);
            fs.writeFileSync(profilePath, capped, "utf-8");
            console.error(
                `[Profile] Updated profile for ${authorTag} (${capped.length} chars)`,
            );
        }
    } catch (err: any) {
        console.error(
            `[Profile] Failed to update profile for ${authorTag}: ${err.message}`,
        );
    }
}

export async function backgroundServerMemoryUpdate(
    guildId: string,
    guildName: string,
    channelName: string,
    authorTag: string,
    question: string,
    response: string,
): Promise<void> {
    const memoryPath = path.join(PROFILES_DIR, `server_${guildId}.txt`);
    const existingMemory = getServerMemory(guildId);

    try {
        const prompt = [
            `Current server memory for "${guildName}" (may be empty):`,
            existingMemory || "(no server memory yet)",
            "",
            `Latest exchange in #${channelName}:`,
            `${authorTag}: ${question}`,
            `Bot: ${response}`,
            "",
            `Task: Based on this exchange, output an updated server memory. Include ONLY server-wide context: channel purposes, recurring topics, ongoing projects, inside jokes, server culture, important events, and shared knowledge. Do NOT include any user-specific information (user descriptions, user preferences, user behavior patterns, who does what) — that belongs in individual user profiles which are managed separately. Keep it under ${SERVER_MEMORY_MAX_CHARS} characters. If you learned nothing new about the server, output the existing memory unchanged. Output ONLY the memory text, no preamble or explanation.`,
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
