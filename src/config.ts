import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === "") return fallback;

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
export const PENDING_DIR = path.join(MESSAGES_DIR, "pending");
export const PROFILES_DIR = path.join(MESSAGES_DIR, "profiles");
export const SUMMARIES_DIR = path.join(MESSAGES_DIR, "summaries");
export const IMAGES_DIR = path.join(MESSAGES_DIR, "images");

export const PROFILE_MAX_CHARS = 2000;
export const SERVER_MEMORY_MAX_CHARS = 10000;

export const COOLDOWN_MS = parseNonNegativeInteger(process.env.COOLDOWN_MS, 10000);
export const BOT_MODEL = process.env.BOT_MODEL || "claude-haiku-4-5";
export const BOT_EFFORT = process.env.BOT_EFFORT?.trim() || "";
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
export const MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp-config.json");
export const PROMPTS_PATH =
    process.env.PROMPTS_PATH || path.join(process.cwd(), "prompts", "prompts.json");

// Ensure directories exist
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
