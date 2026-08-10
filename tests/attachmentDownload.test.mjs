import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const imagesUrl = new URL("../build/storage/images.js", import.meta.url).href;
const configUrl = new URL("../build/config.js", import.meta.url).href;

function runAttachmentScript(messagesDir, source) {
    return spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", source],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                MESSAGES_DIR: messagesDir,
            },
        },
    );
}

test("rejects oversized attachment responses before writing them", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-attachment-download-"),
    );
    try {
        const script = `
            const { MCP_ATTACHMENT_MAX_BYTES } = await import(${JSON.stringify(configUrl)});
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            let bodyCancelled = false;
            const body = new ReadableStream({
                cancel() { bodyCancelled = true; },
            });
            globalThis.fetch = async () => ({
                ok: true,
                status: 200,
                statusText: "OK",
                headers: new Headers({
                    "content-length": String(MCP_ATTACHMENT_MAX_BYTES + 1),
                }),
                body,
            });
            try {
                await downloadAttachment("https://example.test/large.png", "large.png");
                process.exit(1);
            } catch (error) {
                if (!String(error?.message).includes("download limit")) process.exit(2);
                if (!bodyCancelled) process.exit(3);
            }
        `;
        const result = runAttachmentScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
            fs.existsSync(path.join(messagesDir, "images", "large.png")),
            false,
        );
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

test("writes attachment responses within the download limit", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-attachment-download-"),
    );
    try {
        const script = `
            const fs = await import("node:fs");
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            globalThis.fetch = async () => new Response("small image", {
                headers: { "content-type": "image/png" },
            });
            const filePath = await downloadAttachment(
                "https://example.test/small.png",
                "small.png",
            );
            if (fs.readFileSync(filePath, "utf8") !== "small image") process.exit(1);
        `;
        const result = runAttachmentScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});
