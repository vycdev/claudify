#!/usr/bin/env node

import fs from "node:fs";

const capturePath = process.env.CLAUDIFY_SCHEDULER_CAPTURE_PATH;
if (!capturePath) throw new Error("Missing scheduler capture path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    input += chunk;
});
process.stdin.on("end", () => {
    const writeEvent = (event) => {
        fs.appendFileSync(
            capturePath,
            `${JSON.stringify({ event, input })}\n`,
        );
    };
    writeEvent("start");
    const delay = input === "background-1" ? 1_300 : 10;
    setTimeout(() => {
        writeEvent("end");
        process.stdout.write(`response:${input}`);
    }, delay);
});
