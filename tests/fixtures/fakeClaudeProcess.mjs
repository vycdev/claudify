#!/usr/bin/env node

import fs from "node:fs";

const pidPath = process.env.CLAUDIFY_PROCESS_TEST_PID_PATH;
if (!pidPath) throw new Error("Missing process test PID path");

process.on("SIGTERM", () => {
    // Deliberately stay alive so the parent must escalate to SIGKILL.
});

fs.writeFileSync(pidPath, String(process.pid));
setInterval(() => {}, 60_000);
