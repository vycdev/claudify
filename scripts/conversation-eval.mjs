import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runClaude } from "../build/claude.js";
import {
    enforceResponseContract,
    parseClaudeResponse,
} from "../build/discord/response.js";
import {
    buildConversationTurnState,
    renderConversationTurnState,
} from "../build/discord/turn.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(currentDir);
const fixtures = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "tests", "fixtures", "conversation-replays.json"),
    "utf8",
));
const promptMap = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "prompts", "prompts.json"),
    "utf8",
));
const systemPrompt = promptMap.botSystem.join("\n")
    .replaceAll("{{botName}}", "Claudify")
    .replaceAll("{{botModel}}", process.env.CONVERSATION_EVAL_MODEL || "claude-sonnet-5")
    .replaceAll("{{historyDir}}", "/eval/history")
    .replaceAll("{{messagesDir}}", "/eval/messages");

function fixturePrompt(fixture, state) {
    const parts = [
        "=== Active conversation turn (authoritative harness state) ===",
        renderConversationTurnState(state),
        "",
    ];
    if (fixture.invocation.replyTarget) {
        parts.push(
            "=== Direct reply target ===",
            JSON.stringify(fixture.invocation.replyTarget, null, 2),
            "",
        );
    }
    parts.push(
        "=== Current message ===",
        fixture.invocation.messageContent,
        "",
        "=== Response envelope contract ===",
        "Return ONLY one JSON object with fields text, reaction, reason, and targetMessageId.",
        `targetMessageId must be ${JSON.stringify(state.responseTargetMessageId)}.`,
    );
    if (state.requiresTextResponse) {
        parts.push(
            `text must not be empty because textRequirement is ${state.textRequirement}.`,
        );
    }
    return parts.join("\n");
}

function evaluateFixture(fixture, parsed) {
    const failures = [];
    const normalized = parsed.text.toLowerCase();
    if (!parsed.structured) failures.push("response was not structured JSON");
    if (parsed.contractFallback) failures.push("response needed contract fallback");
    if (fixture.expect.requiresTextResponse && !parsed.text) {
        failures.push("required text was empty");
    }
    if (!fixture.expect.requiredAnyResponsePatterns.some(
        (pattern) => normalized.includes(pattern.toLowerCase()),
    )) {
        failures.push("response missed every expected acknowledgement pattern");
    }
    for (const pattern of fixture.expect.forbiddenResponsePatterns) {
        if (normalized.includes(pattern.toLowerCase())) {
            failures.push(`response contained forbidden pattern: ${pattern}`);
        }
    }
    return failures;
}

let failed = false;
for (const fixture of fixtures) {
    const state = buildConversationTurnState(fixture.invocation);
    const result = await runClaude(
        [
            "-p",
            "--system-prompt",
            systemPrompt,
            "--output-format",
            "stream-json",
            "--verbose",
        ],
        fixturePrompt(fixture, state),
        {
            workload: "response",
            model: process.env.CONVERSATION_EVAL_MODEL || "claude-sonnet-5",
            effort: "high",
        },
    );
    const parsed = enforceResponseContract(
        parseClaudeResponse(result.stdout),
        state,
    );
    const failures = evaluateFixture(fixture, parsed);
    if (failures.length === 0) {
        console.log(`PASS ${fixture.id}: ${parsed.text}`);
    } else {
        failed = true;
        console.error(`FAIL ${fixture.id}: ${failures.join("; ")}`);
        console.error(`  response: ${parsed.text}`);
    }
}

if (failed) process.exitCode = 1;
