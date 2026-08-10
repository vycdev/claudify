#!/usr/bin/env node

import fs from "node:fs";

const capturePath = process.env.CLAUDIFY_ROUTING_CAPTURE_PATH;
if (!capturePath) throw new Error("Missing routing capture path");
const claudeCode = Object.entries(process.env)
    .find(([name]) => name.toUpperCase() === "CLAUDECODE")?.[1] ?? null;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    input += chunk;
});
process.stdin.on("end", () => {
    fs.appendFileSync(
        capturePath,
        `${JSON.stringify({
            args: process.argv.slice(2),
            anthropicModel: process.env.ANTHROPIC_MODEL ?? null,
            claudeCode,
            input,
        })}\n`,
    );
    process.stdout.write(`response:${input}`);
});
