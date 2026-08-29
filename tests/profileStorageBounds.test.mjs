import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("bounds regular legacy memory and ignores symbolic links", (t) => {
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
    const outsideFile = path.join(messagesDir, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "must not be loaded", "utf8");
    let symlinksCreated = true;
    try {
        fs.symlinkSync(
            outsideFile,
            path.join(profilesDir, "symlink-user.txt"),
        );
        fs.symlinkSync(
            outsideFile,
            path.join(profilesDir, "server_symlink-guild.txt"),
        );
    } catch (error) {
        if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
        symlinksCreated = false;
        t.diagnostic("symbolic-link assertions require host permission");
    }

    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const script = [
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('user-1'), server: profiles.getServerMemory('guild-1'), unicodeUser: profiles.getUserProfile('unicode-user'), unicodeServer: profiles.getServerMemory('unicode-guild'), symlinkUser: profiles.getUserProfile('symlink-user'), symlinkServer: profiles.getServerMemory('symlink-guild') }));",
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
        if (symlinksCreated) {
            assert.equal(loaded.symlinkUser, "");
            assert.equal(loaded.symlinkServer, "");
        }
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

test("reads user and server legacy memory from opened descriptors", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-profile-race-"),
    );
    const profilesDir = path.join(messagesDir, "profiles");
    const profilePath = path.join(profilesDir, "race-user.txt");
    const serverPath = path.join(profilesDir, "server_race-guild.txt");
    const profileReplacementPath = path.join(messagesDir, "profile-replacement.txt");
    const serverReplacementPath = path.join(messagesDir, "server-replacement.txt");
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(profilePath, "expected user memory", "utf8");
    fs.writeFileSync(serverPath, "expected server memory", "utf8");
    fs.writeFileSync(profileReplacementPath, "must not load user", "utf8");
    fs.writeFileSync(serverReplacementPath, "must not load server", "utf8");

    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const script = [
        'import fs from "node:fs";',
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        `const profilePath = ${JSON.stringify(profilePath)};`,
        `const serverPath = ${JSON.stringify(serverPath)};`,
        `const replacements = new Map(${JSON.stringify([
            [profilePath, profileReplacementPath],
            [serverPath, serverReplacementPath],
        ])});`,
        "const originalReadFileSync = fs.readFileSync.bind(fs);",
        "fs.readFileSync = (target, options) => {",
        "  const replacement = replacements.get(target);",
        "  if (replacement) {",
        "    fs.rmSync(target);",
        "    fs.renameSync(replacement, target);",
        "  }",
        "  return originalReadFileSync(target, options);",
        "};",
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('race-user'), server: profiles.getServerMemory('race-guild') }));",
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
        assert.deepEqual(JSON.parse(result.stdout), {
            user: "expected user memory",
            server: "expected server memory",
        });
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});

test("rejects a junction at the profiles directory root", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-profile-root-junction-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const profilesDir = path.join(messagesDir, "profiles");
    const outsideProfilesDir = path.join(testDir, "outside-profiles");
    fs.mkdirSync(messagesDir);
    fs.mkdirSync(outsideProfilesDir);
    fs.writeFileSync(
        path.join(outsideProfilesDir, "victim.txt"),
        "must not load user",
        "utf8",
    );
    fs.writeFileSync(
        path.join(outsideProfilesDir, "server_victim-guild.txt"),
        "must not load server",
        "utf8",
    );
    const factDocument = JSON.stringify({
        version: 1,
        facts: [{
            id: "0123456789abcdef",
            text: "must not load source-backed memory",
            sourceMessageId: "message-1",
            observedAt: "2026-08-29T00:00:00.000Z",
            attribution: "explicit",
        }],
    });
    const userFactsDir = path.join(outsideProfilesDir, "facts", "users");
    const serverFactsDir = path.join(outsideProfilesDir, "facts", "servers");
    fs.mkdirSync(userFactsDir, { recursive: true });
    fs.mkdirSync(serverFactsDir, { recursive: true });
    fs.writeFileSync(path.join(userFactsDir, "victim.json"), factDocument);
    fs.writeFileSync(
        path.join(serverFactsDir, "victim-guild.json"),
        factDocument,
    );
    fs.symlinkSync(outsideProfilesDir, profilesDir, "junction");

    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const script = [
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('victim'), server: profiles.getServerMemory('victim-guild') }));",
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
        assert.deepEqual(JSON.parse(result.stdout), { user: "", server: "" });
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("rejects a junction at the configured messages directory", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-messages-root-junction-"),
    );
    const messagesDir = path.join(testDir, "messages-link");
    const outsideMessagesDir = path.join(testDir, "outside-messages");
    const outsideProfilesDir = path.join(outsideMessagesDir, "profiles");
    fs.mkdirSync(outsideProfilesDir, { recursive: true });
    fs.writeFileSync(
        path.join(outsideProfilesDir, "victim.txt"),
        "must not load user",
        "utf8",
    );
    fs.writeFileSync(
        path.join(outsideProfilesDir, "server_victim-guild.txt"),
        "must not load server",
        "utf8",
    );
    fs.symlinkSync(outsideMessagesDir, messagesDir, "junction");

    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const script = [
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('victim'), server: profiles.getServerMemory('victim-guild') }));",
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
        assert.deepEqual(JSON.parse(result.stdout), { user: "", server: "" });
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fails closed when the profiles directory is swapped before opening", () => {
    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const scenarios = [
        {
            filename: "race-user.txt",
            read: "profiles.getUserProfile('race-user')",
        },
        {
            filename: "server_race-guild.txt",
            read: "profiles.getServerMemory('race-guild')",
        },
    ];

    for (const scenario of scenarios) {
        const testDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "claudify-profile-dir-race-"),
        );
        const messagesDir = path.join(testDir, "messages");
        const profilesDir = path.join(messagesDir, "profiles");
        const parkedProfilesDir = path.join(messagesDir, "profiles-original");
        const outsideProfilesDir = path.join(testDir, "outside-profiles");
        fs.mkdirSync(profilesDir, { recursive: true });
        fs.mkdirSync(outsideProfilesDir);
        fs.writeFileSync(
            path.join(profilesDir, scenario.filename),
            "expected memory",
            "utf8",
        );
        fs.writeFileSync(
            path.join(outsideProfilesDir, scenario.filename),
            "must not be loaded",
            "utf8",
        );

        const script = [
            'import fs from "node:fs";',
            `const profiles = await import(${JSON.stringify(profilesUrl)});`,
            `const profilesDir = ${JSON.stringify(profilesDir)};`,
            `const parkedProfilesDir = ${JSON.stringify(parkedProfilesDir)};`,
            `const outsideProfilesDir = ${JSON.stringify(outsideProfilesDir)};`,
            "const originalOpenSync = fs.openSync.bind(fs);",
            "let swapped = false;",
            "fs.openSync = (...args) => {",
            "  if (!swapped && args[0] === profilesDir) {",
            "    fs.renameSync(profilesDir, parkedProfilesDir);",
            "    fs.symlinkSync(outsideProfilesDir, profilesDir, 'junction');",
            "    swapped = true;",
            "  }",
            "  return originalOpenSync(...args);",
            "};",
            `process.stdout.write(${scenario.read});`,
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
            assert.equal(result.stdout, "");
        } finally {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    }
});

test("fails closed when filesystem identity is unavailable", () => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-profile-no-identity-"),
    );
    const profilesDir = path.join(messagesDir, "profiles");
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "user.txt"), "user memory");
    fs.writeFileSync(
        path.join(profilesDir, "server_guild.txt"),
        "server memory",
    );

    const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
    const script = [
        'import fs from "node:fs";',
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        "const originalLstatSync = fs.lstatSync.bind(fs);",
        "fs.lstatSync = (...args) => {",
        "  const stat = originalLstatSync(...args);",
        "  if (args[1]?.bigint) Object.defineProperty(stat, 'ino', { value: 0n });",
        "  return stat;",
        "};",
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('user'), server: profiles.getServerMemory('guild') }));",
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
        assert.deepEqual(JSON.parse(result.stdout), { user: "", server: "" });
    } finally {
        fs.rmSync(messagesDir, { recursive: true, force: true });
    }
});
