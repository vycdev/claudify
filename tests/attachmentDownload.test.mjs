import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const imagesUrl = new URL("../build/storage/images.js", import.meta.url).href;
const configUrl = new URL("../build/config.js", import.meta.url).href;

function runAttachmentScript(messagesDir, source, env = {}) {
    return spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", source],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                MESSAGES_DIR: messagesDir,
                ...env,
            },
        },
    );
}

test("times out a stalled attachment before headers without saving a file", () => {
    const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-attachment-timeout-"));
    try {
        const script = `
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            globalThis.fetch = (_url, { signal } = {}) => new Promise((resolve, reject) => {
                setTimeout(() => reject(new Error("stalled")), 150);
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            try {
                await downloadAttachment("https://example.test/stall.png", "stall.png");
                process.exit(1);
            } catch (error) {
                if (error?.name !== "TimeoutError") process.exit(2);
                if (fs.existsSync(path.join(process.env.MESSAGES_DIR, "images", "stall.png"))) process.exit(3);
            }
        `;
        const result = runAttachmentScript(messagesDir, script, { ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "30" });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

test("times out an attachment body stalled after headers", () => {
    const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-attachment-timeout-"));
    try {
        const script = `
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            globalThis.fetch = async (_url, { signal } = {}) => {
                const body = new ReadableStream({
                    start(controller) {
                        const fallback = setTimeout(() => controller.error(new Error("stalled")), 150);
                        signal?.addEventListener("abort", () => {
                            clearTimeout(fallback);
                            controller.error(signal.reason);
                        }, { once: true });
                    },
                });
                return new Response(body);
            };
            try {
                await downloadAttachment("https://example.test/stall.png", "stall.png");
                process.exit(1);
            } catch (error) {
                if (error?.name !== "TimeoutError") process.exit(2);
                if (fs.existsSync(path.join(process.env.MESSAGES_DIR, "images", "stall.png"))) process.exit(3);
            }
        `;
        const result = runAttachmentScript(messagesDir, script, { ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "30" });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

test("an actual HTTP response body is interrupted by the download deadline", () => {
    const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-attachment-timeout-"));
    try {
        const script = `
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { createServer } = await import("node:http");
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            const server = createServer((_request, response) => {
                response.writeHead(200, { "content-type": "image/png" });
                response.write("partial");
            });
            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            try {
                await downloadAttachment(
                    \`http://127.0.0.1:\${server.address().port}/stall.png\`,
                    "stall.png",
                );
                process.exitCode = 1;
            } catch (error) {
                if (error?.name !== "TimeoutError" && error?.name !== "AbortError") process.exitCode = 2;
                if (fs.existsSync(path.join(process.env.MESSAGES_DIR, "images", "stall.png"))) process.exitCode = 3;
            } finally {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
            }
        `;
        const result = runAttachmentScript(messagesDir, script, { ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "150" });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

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

test("bounds long attachment filenames without losing their extension", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-attachment-filename-"),
    );
    try {
        const script = `
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { ATTACHMENT_FILENAME_MAX_BYTES } = await import(${JSON.stringify(configUrl)});
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));

            const savedPath = await downloadAttachment(
                "https://example.test/image.png",
                \`123_\${"😀".repeat(100)}.png\`,
            );
            const savedName = path.basename(savedPath);
            if (Buffer.byteLength(savedName) > ATTACHMENT_FILENAME_MAX_BYTES) process.exit(1);
            if (!savedName.startsWith("123_") || !savedName.endsWith(".png")) process.exit(2);
            if (savedName.includes("�")) process.exit(3);
            if (!fs.readFileSync(savedPath).equals(Buffer.from([1, 2, 3]))) process.exit(4);

            const sharedPrefix = "a".repeat(300);
            const firstPath = await downloadAttachment(
                "https://example.test/first.png",
                \`\${sharedPrefix}-first.png\`,
            );
            const secondPath = await downloadAttachment(
                "https://example.test/second.png",
                \`\${sharedPrefix}-second.png\`,
            );
            if (firstPath === secondPath) process.exit(5);

            const boundaryExtension = "." + "x".repeat(174);
            const boundaryPath = await downloadAttachment(
                "https://example.test/boundary",
                "b".repeat(300) + boundaryExtension,
            );
            if (!boundaryPath.endsWith(boundaryExtension)) process.exit(6);
        `;
        const result = runAttachmentScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

test("rejects normalized paths before bounding attachment filenames", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-attachment-filename-"),
    );
    try {
        const script = `
            const { downloadAttachment } = await import(${JSON.stringify(imagesUrl)});
            let fetched = false;
            globalThis.fetch = async () => {
                fetched = true;
                return new Response("unsafe");
            };
            const filename = \`../\${"a".repeat(300)}/../images/safe.png\`;
            try {
                await downloadAttachment("https://example.test/safe.png", filename);
                process.exit(1);
            } catch (error) {
                if (!String(error?.message).includes("must not include a directory path")) {
                    process.exit(2);
                }
                if (fetched) process.exit(3);
            }
        `;
        const result = runAttachmentScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(path.join(messagesDir, "safe.png")), false);
        assert.equal(
            fs.existsSync(path.join(messagesDir, "images", "safe.png")),
            false,
        );
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});
