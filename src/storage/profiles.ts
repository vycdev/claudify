import fs from "fs";
import path from "path";
import {
    CLAUDE_WORKLOAD_CONFIG,
    PROFILES_DIR,
    PROFILE_MAX_CHARS,
    SERVER_MEMORY_MAX_CHARS,
} from "../config.js";
import { runClaude } from "../claude.js";
import { renderPrompt } from "../prompts.js";

type ClaudeRunner = typeof runClaude;

const updateTails = new Map<string, Promise<void>>();

function truncateWithoutSplittingSurrogatePair(
    text: string,
    maxLength: number,
): string {
    let truncated = text.slice(0, maxLength);
    if (truncated.length === text.length || truncated.length === 0) {
        return truncated;
    }

    const precedingCodeUnit = truncated.charCodeAt(truncated.length - 1);
    const followingCodeUnit = text.charCodeAt(truncated.length);
    if (
        precedingCodeUnit >= 0xd800 &&
        precedingCodeUnit <= 0xdbff &&
        followingCodeUnit >= 0xdc00 &&
        followingCodeUnit <= 0xdfff
    ) {
        truncated = truncated.slice(0, -1);
    }

    return truncated;
}

function serializeUpdate<T>(
    keys: string[],
    update: () => Promise<T>,
): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const previousUpdates = uniqueKeys
        .map((key) => updateTails.get(key))
        .filter((tail): tail is Promise<void> => tail !== undefined);
    const result = Promise.all(previousUpdates).then(update);
    const tail = result.then(() => undefined, () => undefined);

    for (const key of uniqueKeys) updateTails.set(key, tail);

    return result.finally(() => {
        for (const key of uniqueKeys) {
            if (updateTails.get(key) === tail) updateTails.delete(key);
        }
    });
}

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
    claudeRunner: ClaudeRunner = runClaude,
): Promise<void> {
    if (users.length === 0) return;

    const uniqueUsers = Array.from(
        new Map(users.map((u) => [u.id, u])).values(),
    );

    return serializeUpdate(
        uniqueUsers.map((user) => `profile:${user.id}`),
        async () => {
            const profileSections = uniqueUsers.map((u) => {
                const existing = getUserProfile(u.id);
                return `===CURRENT ${u.tag} (ID: ${u.id})===\n${existing || "(no profile yet)"}`;
            }).join("\n\n");

            try {
                const prompt = renderPrompt("profileUpdate", {
                    conversationContext,
                    profileMaxChars: PROFILE_MAX_CHARS,
                    profileSections,
                });

                const { stdout } = await claudeRunner(
                    ["-p"],
                    prompt,
                    CLAUDE_WORKLOAD_CONFIG["profile-update"],
                );
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
                        const capped = truncateWithoutSplittingSurrogatePair(
                            profileText,
                            PROFILE_MAX_CHARS,
                        );
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
        },
    );
}

export async function backgroundServerMemoryUpdate(
    guildId: string,
    guildName: string,
    channelName: string,
    conversationContext: string,
    claudeRunner: ClaudeRunner = runClaude,
): Promise<void> {
    return serializeUpdate([`server:${guildId}`], async () => {
        const memoryPath = path.join(PROFILES_DIR, `server_${guildId}.txt`);
        const existingMemory = getServerMemory(guildId);

        try {
            const prompt = renderPrompt("serverMemoryUpdate", {
                channelName,
                conversationContext,
                existingMemory: existingMemory || "(no server memory yet)",
                guildName,
                serverMemoryMaxChars: SERVER_MEMORY_MAX_CHARS,
            });

            const { stdout } = await claudeRunner(
                ["-p"],
                prompt,
                CLAUDE_WORKLOAD_CONFIG["server-memory-update"],
            );

            const newMemory = stdout.trim();
            if (newMemory && newMemory !== existingMemory.trim()) {
                const capped = truncateWithoutSplittingSurrogatePair(
                    newMemory,
                    SERVER_MEMORY_MAX_CHARS,
                );
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
    });
}
