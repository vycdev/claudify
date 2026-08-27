import fs from "fs";
import path from "path";
import {
    CLAUDE_WORKLOAD_CONFIG,
    MEMORY_FACT_MAX_CHARS,
    PROFILES_DIR,
    PROFILE_MAX_CHARS,
    SERVER_MEMORY_MAX_CHARS,
} from "../config.js";
import { runClaude } from "../claude.js";
import { renderPrompt } from "../prompts.js";
import {
    extractHumanSourceMessageIds,
    extractSourceMessageMetadata,
    mergeMemoryFacts,
    renderMemoryFacts,
    type MemoryFactAttribution,
    type MemoryFactCandidate,
} from "./memoryFacts.js";

type ClaudeRunner = typeof runClaude;

interface ProfileFactCandidate extends MemoryFactCandidate {
    userId: string;
}

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
        precedingCodeUnit >= 0xd800
        && precedingCodeUnit <= 0xdbff
        && followingCodeUnit >= 0xdc00
        && followingCodeUnit <= 0xdfff
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

function readBounded(filePath: string, maxChars: number): string {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return "";

    const text = fs.readFileSync(filePath, "utf8");
    return truncateWithoutSplittingSurrogatePair(text, maxChars);
}

function renderCombinedMemory(
    sourceBackedFacts: string,
    legacyMemory: string,
    maxChars: number,
): string {
    if (!sourceBackedFacts) return legacyMemory;
    if (!legacyMemory) {
        return truncateWithoutSplittingSurrogatePair(
            sourceBackedFacts,
            maxChars,
        );
    }

    const legacyHeader = "Legacy memory (read-only):\n";
    const combined = `${sourceBackedFacts}\n\n${legacyHeader}${legacyMemory}`;
    if (combined.length <= maxChars) return combined;

    const separator = `\n\n${legacyHeader}`;
    const legacyBudget = Math.max(
        1,
        Math.floor((maxChars - separator.length) * 0.3),
    );
    const factBudget = Math.max(0, maxChars - separator.length - legacyBudget);
    return [
        truncateWithoutSplittingSurrogatePair(sourceBackedFacts, factBudget),
        separator,
        truncateWithoutSplittingSurrogatePair(legacyMemory, legacyBudget),
    ].join("");
}

function parseJsonObject(output: string): Record<string, unknown> {
    const trimmed = output.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    const source = fenced?.[1] ?? trimmed;
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("memory update must be a JSON object");
    }
    return parsed as Record<string, unknown>;
}

function parseAttribution(value: unknown): MemoryFactAttribution | undefined {
    return value === "explicit" || value === "inferred" ? value : undefined;
}

function parseSupersedes(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        return undefined;
    }
    return value;
}

function parseProfileCandidates(output: string): ProfileFactCandidate[] {
    const parsed = parseJsonObject(output);
    if (!Array.isArray(parsed.facts)) {
        throw new Error("profile update JSON must contain a facts array");
    }

    const candidates: ProfileFactCandidate[] = [];
    for (const value of parsed.facts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const fact = value as Record<string, unknown>;
        const attribution = parseAttribution(fact.attribution);
        const supersedesFactIds = parseSupersedes(fact.supersedesFactIds);
        if (
            typeof fact.userId !== "string"
            || typeof fact.text !== "string"
            || typeof fact.sourceMessageId !== "string"
            || !attribution
            || (fact.supersedesFactIds !== undefined && !supersedesFactIds)
        ) continue;
        candidates.push({
            userId: fact.userId,
            text: fact.text,
            sourceMessageId: fact.sourceMessageId,
            attribution,
            supersedesFactIds,
        });
    }
    return candidates;
}

function parseServerCandidates(output: string): MemoryFactCandidate[] {
    const parsed = parseJsonObject(output);
    if (!Array.isArray(parsed.facts)) {
        throw new Error("server-memory update JSON must contain a facts array");
    }

    const candidates: MemoryFactCandidate[] = [];
    for (const value of parsed.facts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const fact = value as Record<string, unknown>;
        const attribution = parseAttribution(fact.attribution);
        const supersedesFactIds = parseSupersedes(fact.supersedesFactIds);
        if (
            typeof fact.text !== "string"
            || typeof fact.sourceMessageId !== "string"
            || !attribution
            || (fact.supersedesFactIds !== undefined && !supersedesFactIds)
        ) continue;
        candidates.push({
            text: fact.text,
            sourceMessageId: fact.sourceMessageId,
            attribution,
            supersedesFactIds,
        });
    }
    return candidates;
}

export function getUserProfile(userId: string): string {
    const legacy = readBounded(
        path.join(PROFILES_DIR, `${userId}.txt`),
        PROFILE_MAX_CHARS,
    );
    return renderCombinedMemory(
        renderMemoryFacts("user", userId),
        legacy,
        PROFILE_MAX_CHARS,
    );
}

export function getServerMemory(guildId: string): string {
    const legacy = readBounded(
        path.join(PROFILES_DIR, `server_${guildId}.txt`),
        SERVER_MEMORY_MAX_CHARS,
    );
    return renderCombinedMemory(
        renderMemoryFacts("server", guildId),
        legacy,
        SERVER_MEMORY_MAX_CHARS,
    );
}

export async function backgroundProfileUpdate(
    users: { tag: string; id: string }[],
    conversationContext: string,
    claudeRunner: ClaudeRunner = runClaude,
): Promise<void> {
    if (users.length === 0) return;

    const uniqueUsers = Array.from(
        new Map(users.map((user) => [user.id, user])).values(),
    );

    return serializeUpdate(
        uniqueUsers.map((user) => `profile:${user.id}`),
        async () => {
            const profileSections = uniqueUsers.map((user) => {
                const existing = getUserProfile(user.id);
                return `===CURRENT ${user.tag} (ID: ${user.id})===\n${existing || "(no profile yet)"}`;
            }).join("\n\n");

            try {
                const prompt = renderPrompt("profileUpdate", {
                    conversationContext,
                    memoryFactMaxChars: MEMORY_FACT_MAX_CHARS,
                    profileMaxChars: PROFILE_MAX_CHARS,
                    profileSections,
                });
                const { stdout } = await claudeRunner(
                    ["-p"],
                    prompt,
                    CLAUDE_WORKLOAD_CONFIG["profile-update"],
                );
                const candidates = parseProfileCandidates(stdout);
                const allowedUsers = new Set(uniqueUsers.map((user) => user.id));
                const sourceMetadata = extractSourceMessageMetadata(
                    conversationContext,
                );
                let updateCount = 0;

                for (const user of uniqueUsers) {
                    if (!allowedUsers.has(user.id)) continue;
                    const userCandidates = candidates.filter((candidate) =>
                        candidate.userId === user.id
                        && sourceMetadata.get(candidate.sourceMessageId)?.authorId === user.id
                        && !sourceMetadata.get(candidate.sourceMessageId)?.authorBot
                    );
                    const validSources = new Set(
                        [...sourceMetadata.entries()]
                            .filter(([, value]) =>
                                value.authorId === user.id && !value.authorBot
                            )
                            .map(([messageId]) => messageId),
                    );
                    const sourceTimestamps = new Map(
                        [...sourceMetadata.entries()]
                            .filter(([messageId]) => validSources.has(messageId))
                            .map(([messageId, value]) => [
                                messageId,
                                value.createdAt,
                            ]),
                    );
                    const changed = mergeMemoryFacts(
                        "user",
                        user.id,
                        userCandidates,
                        validSources,
                        sourceTimestamps,
                    );
                    if (changed > 0) {
                        console.error(
                            `[Profile] Stored ${changed} source-backed fact update(s) for ${user.tag}`,
                        );
                        updateCount += changed;
                    }
                }

                if (updateCount === 0) {
                    console.error("[Profile] No source-backed profile updates needed");
                }
            } catch (error: any) {
                console.error(
                    `[Profile] Failed to update profiles: ${error.message}`,
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
        const existingMemory = getServerMemory(guildId);

        try {
            const prompt = renderPrompt("serverMemoryUpdate", {
                channelName,
                conversationContext,
                existingMemory: existingMemory || "(no server memory yet)",
                guildName,
                memoryFactMaxChars: MEMORY_FACT_MAX_CHARS,
                serverMemoryMaxChars: SERVER_MEMORY_MAX_CHARS,
            });
            const { stdout } = await claudeRunner(
                ["-p"],
                prompt,
                CLAUDE_WORKLOAD_CONFIG["server-memory-update"],
            );
            const sourceMetadata = extractSourceMessageMetadata(
                conversationContext,
            );
            const validSources = extractHumanSourceMessageIds(
                conversationContext,
            );
            const sourceTimestamps = new Map(
                [...sourceMetadata.entries()]
                    .filter(([messageId]) => validSources.has(messageId))
                    .map(([messageId, value]) => [messageId, value.createdAt]),
            );
            const changed = mergeMemoryFacts(
                "server",
                guildId,
                parseServerCandidates(stdout),
                validSources,
                sourceTimestamps,
            );
            if (changed > 0) {
                console.error(
                    `[ServerMemory] Stored ${changed} source-backed fact update(s) for ${guildName}`,
                );
            } else {
                console.error("[ServerMemory] No source-backed server updates needed");
            }
        } catch (error: any) {
            console.error(
                `[ServerMemory] Failed to update memory for ${guildName}: ${error.message}`,
            );
        }
    });
}
