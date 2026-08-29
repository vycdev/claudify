#!/usr/bin/env node

import fs from "node:fs";

const pidPath = process.env.CLAUDIFY_PROCESS_TEST_PID_PATH;
if (!pidPath) throw new Error("Missing process test PID path");

process.on("SIGTERM", () => {
    // Deliberately stay alive so the parent must escalate to SIGKILL.
});

if (process.env.CLAUDIFY_PROCESS_TEST_EMIT_TRACE === "1") {
    process.stdout.write(`${JSON.stringify({
        type: "assistant",
        message: {
            content: [{
                type: "tool_use",
                id: "history-tool-1",
                name: "mcp__discord__read-message-history",
            }],
        },
    })}\n`);
    process.stderr.write("partial diagnostic\n");
}
fs.writeFileSync(pidPath, String(process.pid));
setInterval(() => {}, 60_000);
