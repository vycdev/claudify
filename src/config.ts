import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export const MESSAGES_DIR =
    process.env.MESSAGES_DIR || path.join(process.cwd(), "messages");
export const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID || "";
export const HISTORY_DIR = path.join(MESSAGES_DIR, "history");
export const PENDING_DIR = path.join(MESSAGES_DIR, "pending");
export const PROFILES_DIR = path.join(MESSAGES_DIR, "profiles");
export const SUMMARIES_DIR = path.join(MESSAGES_DIR, "summaries");
export const IMAGES_DIR = path.join(MESSAGES_DIR, "images");

export const PROFILE_MAX_CHARS = 2000;
export const SERVER_MEMORY_MAX_CHARS = 10000;

export const MCP_PORT = parseInt(process.env.MCP_PORT || "3100", 10);
export const MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp-config.json");

// Ensure directories exist
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
