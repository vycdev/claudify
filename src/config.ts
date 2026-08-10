import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import type {
    ClaudeEffort,
    ClaudeRunOptions,
    ClaudeWorkload,
} from "./claudeTypes.js";

dotenv.config();

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_BOT_MODEL = "claude-haiku-4-5";
const VALID_BOT_EFFORTS: ReadonlySet<string> = new Set([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
const WORKLOAD_ENV: Readonly<
    Record<ClaudeWorkload, { model: string; effort: string }>
> = {
    response: {
        model: "CLAUDE_RESPONSE_MODEL",
        effort: "CLAUDE_RESPONSE_EFFORT",
    },
    "profile-update": {
        model: "CLAUDE_PROFILE_MODEL",
        effort: "CLAUDE_PROFILE_EFFORT",
    },
    "server-memory-update": {
        model: "CLAUDE_SERVER_MEMORY_MODEL",
        effort: "CLAUDE_SERVER_MEMORY_EFFORT",
    },
    "daily-summary": {
        model: "CLAUDE_SUMMARY_MODEL",
        effort: "CLAUDE_SUMMARY_EFFORT",
    },
};

function parseBotEffort(value: string | undefined): ClaudeEffort | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized && VALID_BOT_EFFORTS.has(normalized)
        ? normalized as ClaudeEffort
        : undefined;
}

function parseGlobalModel(value: string | undefined): string {
    const normalized = value?.trim();
    if (!normalized) return DEFAULT_BOT_MODEL;
    if (/[\s\p{Cc}]/u.test(normalized)) {
        console.error(
            `[Claude Config] Invalid BOT_MODEL; using ${DEFAULT_BOT_MODEL}`,
        );
        return DEFAULT_BOT_MODEL;
    }
    return normalized;
}

function parseGlobalEffort(value: string | undefined): ClaudeEffort | undefined {
    const normalized = value?.trim();
    if (!normalized) return undefined;

    const effort = parseBotEffort(normalized);
    if (!effort) {
        console.error(
            `[Claude Config] Invalid BOT_EFFORT=${JSON.stringify(normalized)}; using the Claude CLI default`,
        );
    }
    return effort;
}

function resolveModelOverride(
    envName: string,
    value: string | undefined,
    fallback: string,
): string | undefined {
    const normalized = value?.trim();
    if (!normalized || normalized.toLowerCase() === "inherit") return fallback;
    if (normalized.toLowerCase() === "default") return undefined;
    if (/[\s\p{Cc}]/u.test(normalized)) {
        console.error(
            `[Claude Config] Invalid ${envName}; inheriting BOT_MODEL`,
        );
        return fallback;
    }
    return normalized;
}

function resolveEffortOverride(
    envName: string,
    value: string | undefined,
    fallback: ClaudeEffort | undefined,
): ClaudeEffort | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || normalized === "inherit") return fallback;
    if (normalized === "default") return undefined;

    const effort = parseBotEffort(normalized);
    if (!effort) {
        console.error(
            `[Claude Config] Invalid ${envName}=${JSON.stringify(value?.trim())}; inheriting BOT_EFFORT`,
        );
        return fallback;
    }
    return effort;
}

function resolveWorkloadConfig(
    workload: ClaudeWorkload,
    globalModel: string,
    globalEffort: ClaudeEffort | undefined,
): Readonly<ClaudeRunOptions> {
    const envNames = WORKLOAD_ENV[workload];
    return Object.freeze({
        workload,
        model: resolveModelOverride(
            envNames.model,
            process.env[envNames.model],
            globalModel,
        ),
        effort: resolveEffortOverride(
            envNames.effort,
            process.env[envNames.effort],
            globalEffort,
        ),
    });
}

function parseNonNegativeInteger(
    value: string | undefined,
    fallback: number,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    if (value === undefined || value.trim() === "") return fallback;

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum
        ? parsed
        : fallback;
}

function parsePositiveInteger(
    value: string | undefined,
    fallback: number,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    if (value === undefined) return fallback;

    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return fallback;

    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
        ? parsed
        : fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;

    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return fallback;

    const port = Number(normalized);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65535
        ? port
        : fallback;
}

export const MESSAGES_DIR =
    process.env.MESSAGES_DIR || path.join(process.cwd(), "messages");
export const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID || "";
export const AUTH_ADMIN_USER_IDS = new Set(
    (process.env.AUTH_ADMIN_USER_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
);
export const HISTORY_DIR = path.join(MESSAGES_DIR, "history");
export const HISTORY_V2_DIR = path.join(HISTORY_DIR, "v2");
export const PENDING_DIR = path.join(MESSAGES_DIR, "pending");
export const PROFILES_DIR = path.join(MESSAGES_DIR, "profiles");
export const SUMMARIES_DIR = path.join(MESSAGES_DIR, "summaries");
export const SUMMARIES_V2_DIR = path.join(SUMMARIES_DIR, "v2");
export const IMAGES_DIR = path.join(MESSAGES_DIR, "images");

export const PROFILE_MAX_CHARS = 2000;
export const SERVER_MEMORY_MAX_CHARS = 10000;
export const DISCORD_MESSAGE_MAX_CHARS = 2000;

export const COOLDOWN_MS = parseNonNegativeInteger(
    process.env.COOLDOWN_MS,
    10000,
    MAX_TIMER_DELAY_MS,
);
export const BOT_MODEL = parseGlobalModel(process.env.BOT_MODEL);
export const BOT_EFFORT = parseGlobalEffort(process.env.BOT_EFFORT) ?? "";
const GLOBAL_BOT_EFFORT = parseBotEffort(BOT_EFFORT);
export const CLAUDE_WORKLOAD_CONFIG: Readonly<
    Record<ClaudeWorkload, Readonly<ClaudeRunOptions>>
> = Object.freeze({
    response: resolveWorkloadConfig("response", BOT_MODEL, GLOBAL_BOT_EFFORT),
    "profile-update": resolveWorkloadConfig(
        "profile-update",
        BOT_MODEL,
        GLOBAL_BOT_EFFORT,
    ),
    "server-memory-update": resolveWorkloadConfig(
        "server-memory-update",
        BOT_MODEL,
        GLOBAL_BOT_EFFORT,
    ),
    "daily-summary": resolveWorkloadConfig(
        "daily-summary",
        BOT_MODEL,
        GLOBAL_BOT_EFFORT,
    ),
});

export function getResponseModelDisplay(): string {
    return CLAUDE_WORKLOAD_CONFIG.response.model ?? "Claude CLI default";
}

export function logClaudeWorkloadConfig(): void {
    for (const config of Object.values(CLAUDE_WORKLOAD_CONFIG)) {
        console.error(
            `[Claude Config] ${config.workload}: model=${config.model ?? "default"}, effort=${config.effort ?? "default"}`,
        );
    }
}
export const CLAUDE_AUTH_LOGIN_TIMEOUT_MS = parsePositiveInteger(
    process.env.CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
    300_000,
    MAX_TIMER_DELAY_MS,
);
export const SUPPRESS_MENTIONS =
    process.env.SUPPRESS_MENTIONS?.trim().toLowerCase() === "true";

export const LIVE_CONTEXT_LIMIT = parseNonNegativeInteger(process.env.LIVE_CONTEXT_LIMIT, 35);
export const DEEP_LIVE_CONTEXT_LIMIT = parseNonNegativeInteger(process.env.DEEP_LIVE_CONTEXT_LIMIT, 500);
export const HISTORY_RECENT_LINES = parseNonNegativeInteger(process.env.HISTORY_RECENT_LINES, 80);
export const HISTORY_RECAP_MAX_LINES = parseNonNegativeInteger(process.env.HISTORY_RECAP_MAX_LINES, 1000);
export const HISTORY_RECAP_MAX_CHARS = parseNonNegativeInteger(process.env.HISTORY_RECAP_MAX_CHARS, 140000);
export const HISTORY_SEARCH_MAX_BLOCKS = parseNonNegativeInteger(process.env.HISTORY_SEARCH_MAX_BLOCKS, 10);
export const HISTORY_SEARCH_CONTEXT_LINES = parseNonNegativeInteger(process.env.HISTORY_SEARCH_CONTEXT_LINES, 2);

export const MCP_PORT = parsePort(process.env.MCP_PORT, 3100);
export const MCP_HISTORY_MAX_CHARS = parsePositiveInteger(
    process.env.MCP_HISTORY_MAX_CHARS,
    120_000,
    1_000_000,
);
export const MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp-config.json");
export const PROMPTS_PATH =
    process.env.PROMPTS_PATH || path.join(process.cwd(), "prompts", "prompts.json");

// Ensure directories exist
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(HISTORY_V2_DIR, { recursive: true });
fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_V2_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
