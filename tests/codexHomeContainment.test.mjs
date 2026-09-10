import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("../build/codexClient.js", import.meta.url).href;
const configUrl = new URL("../build/config.js", import.meta.url).href;
const fixture = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`;

test(
    "Codex storage rejects ancestor aliases before creating a credential directory",
    { skip: process.platform === "win32" },
    async () => {
        const { createCodexClient } = await import(moduleUrl);
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), "claudify-codex-alias-"),
        );
        try {
            const messages = path.join(root, "messages");
            fs.mkdirSync(messages);
            const alias = path.join(root, "alias");
            fs.symlinkSync(messages, alias, "dir");
            for (const [home, forbidden] of [
                [path.join(alias, "credentials"), messages],
                [path.join(messages, "credentials"), alias],
            ]) {
                await assert.rejects(
                    createCodexClient({
                        home,
                        forbiddenRoots: [forbidden],
                        executable: {
                            command: process.execPath,
                            args: ["-e", fixture, "--"],
                        },
                    }).then((client) => client.close()),
                    /outside MESSAGES_DIR/,
                );
                assert.equal(
                    fs.existsSync(path.join(messages, "credentials")),
                    false,
                );
                const result = spawnSync(
                    process.execPath,
                    [
                        "--input-type=module",
                        "-e",
                        `await import(${JSON.stringify(configUrl)})`,
                    ],
                    {
                        env: {
                            ...process.env,
                            BOT_PROVIDER: "codex",
                            MESSAGES_DIR: forbidden,
                            CODEX_HOME: home,
                        },
                        encoding: "utf8",
                    },
                );
                assert.notEqual(result.status, 0);
                assert.match(result.stderr, /outside MESSAGES_DIR/);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    },
);

test(
    "an unrelated ancestor alias is resolved safely without permitting a home symlink",
    { skip: process.platform === "win32" },
    async () => {
        const { createCodexClient } = await import(moduleUrl);
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), "claudify-codex-outside-"),
        );
        try {
            const outside = path.join(root, "private");
            fs.mkdirSync(outside);
            const alias = path.join(root, "alias");
            fs.symlinkSync(outside, alias, "dir");
            const options = {
                forbiddenRoots: [path.join(root, "messages")],
                executable: {
                    command: process.execPath,
                    args: ["-e", fixture, "--"],
                },
            };
            const client = await createCodexClient({
                ...options,
                home: path.join(alias, "credentials"),
            });
            client.close();
            const homeLink = path.join(root, "home-link");
            fs.symlinkSync(path.join(outside, "credentials"), homeLink, "dir");
            await assert.rejects(
                createCodexClient({ ...options, home: homeLink }).then(
                    (client) => client.close(),
                ),
                /symbolic link/,
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    },
);
