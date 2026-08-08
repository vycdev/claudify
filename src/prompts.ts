import fs from "fs";
import { PROMPTS_PATH } from "./config.js";

const REQUIRED_PROMPTS = [
    "botSystem",
    "dailySummarySystem",
    "profileUpdate",
    "serverMemoryUpdate",
] as const;

export type PromptName = (typeof REQUIRED_PROMPTS)[number];

type PromptValue = string | string[];
type PromptMap = Record<string, PromptValue>;
type PromptVariables = Record<string, string | number>;

let cachedPrompts: PromptMap | null = null;

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPromptMap(value: unknown): value is PromptMap {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;

    return Object.values(value).every(
        (entry) => typeof entry === "string" || isStringArray(entry),
    );
}

function hasPromptContent(value: PromptValue): boolean {
    const source = Array.isArray(value) ? value.join("\n") : value;
    return source.trim().length > 0;
}

function loadPrompts(): PromptMap {
    if (cachedPrompts) return cachedPrompts;

    const raw = fs.readFileSync(PROMPTS_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!isPromptMap(parsed)) {
        throw new Error(`Prompt file ${PROMPTS_PATH} must be a JSON object of strings or string arrays`);
    }

    for (const promptName of REQUIRED_PROMPTS) {
        const prompt = parsed[promptName];
        if (prompt === undefined) {
            throw new Error(`Prompt file ${PROMPTS_PATH} is missing "${promptName}"`);
        }
        if (!hasPromptContent(prompt)) {
            throw new Error(`Prompt file ${PROMPTS_PATH} must not have an empty "${promptName}"`);
        }
    }

    cachedPrompts = parsed;
    return parsed;
}

function getPromptSource(name: PromptName): string {
    const prompt = loadPrompts()[name];
    if (!prompt) throw new Error(`Prompt "${name}" is not configured`);
    return Array.isArray(prompt) ? prompt.join("\n") : prompt;
}

export function renderPrompt(
    name: PromptName,
    variables: PromptVariables = {},
): string {
    const source = getPromptSource(name);
    return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
        const value = variables[key];
        return value === undefined ? match : String(value);
    });
}
