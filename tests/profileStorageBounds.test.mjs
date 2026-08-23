import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("caps oversized persisted profiles and server memory when loaded", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-profile-bounds-"),
    );
    const profilesDir = path.join(messagesDir, "profiles");
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(
        path.join(profilesDir, "user-1.txt"),
        "P".repeat(2500),
        "utf8",
    );
    fs.writeFileSync(
        path.join(profilesDir, "server_guild-1.txt"),
        "M".repeat(12000),
        "utf8",
    );
    const unicodeProfilePrefix = "U".repeat(1999);
    const unicodeMemoryPrefix = "N".repeat(9999);
    fs.writeFileSync(
        path.join(profilesDir, "unicode-user.txt"),
        `${unicodeProfilePrefix}😀tail`,
        "utf8",
    );
    fs.writeFileSync(
        path.join(profilesDir, "server_unicode-guild.txt"),
        `${unicodeMemoryPrefix}😀tail`,
        "utf8",
    );

    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const script = [
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('user-1'), server: profiles.getServerMemory('guild-1'), unicodeUser: profiles.getUserProfile('unicode-user'), unicodeServer: profiles.getServerMemory('unicode-guild') }));",
    ].join("\n");

    try {
        const result = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", script],
            {
                encoding: "utf8",
                env: { ...process.env, MESSAGES_DIR: messagesDir },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        const loaded = JSON.parse(result.stdout);
        assert.equal(loaded.user.length, 2000);
        assert.equal(loaded.server.length, 10000);
        assert.equal(loaded.user, "P".repeat(2000));
        assert.equal(loaded.server, "M".repeat(10000));
        assert.equal(loaded.unicodeUser, unicodeProfilePrefix);
        assert.equal(loaded.unicodeServer, unicodeMemoryPrefix);
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});
