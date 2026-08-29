import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const profilesUrl = new URL("../build/storage/profiles.js", import.meta.url).href;
const memoryFactsUrl = new URL(
    "../build/storage/memoryFacts.js",
    import.meta.url,
).href;

function factDocument(text) {
    return `${JSON.stringify({
        version: 1,
        facts: [{
            id: "0123456789abcdef",
            text,
            sourceMessageId: "message-1",
            observedAt: "2026-08-29T00:00:00.000Z",
            attribution: "explicit",
        }],
    })}\n`;
}

function writeFact(directory, id, text) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, `${encodeURIComponent(id)}.json`),
        factDocument(text),
        "utf8",
    );
}

function runScript(messagesDir, lines) {
    return spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", lines.join("\n")],
        {
            encoding: "utf8",
            env: { ...process.env, MESSAGES_DIR: messagesDir },
        },
    );
}

function readAndWriteProbeScript(
    userWriteId = "new-user",
    serverWriteId = "new-server",
) {
    return [
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        `const memoryFacts = await import(${JSON.stringify(memoryFactsUrl)});`,
        "const candidates = [{ text: 'new memory', sourceMessageId: 'message-1', attribution: 'explicit' }];",
        "const validSources = new Set(['message-1']);",
        "const timestamps = new Map([['message-1', '2026-08-29T00:00:00.000Z']]);",
        "let userWriteRejected = false;",
        "let serverWriteRejected = false;",
        `try { memoryFacts.mergeMemoryFacts('user', ${JSON.stringify(userWriteId)}, candidates, validSources, timestamps); } catch { userWriteRejected = true; }`,
        `try { memoryFacts.mergeMemoryFacts('server', ${JSON.stringify(serverWriteId)}, candidates, validSources, timestamps); } catch { serverWriteRejected = true; }`,
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('victim'), server: profiles.getServerMemory('victim-guild'), userWriteRejected, serverWriteRejected }));",
    ];
}

test("facts-root junctions cannot be read or written", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-facts-root-junction-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const profilesDir = path.join(messagesDir, "profiles");
    const factsDir = path.join(profilesDir, "facts");
    const outsideFactsDir = path.join(testDir, "outside-facts");
    const outsideUsersDir = path.join(outsideFactsDir, "users");
    const outsideServersDir = path.join(outsideFactsDir, "servers");
    fs.mkdirSync(profilesDir, { recursive: true });
    writeFact(outsideUsersDir, "victim", "must not load user");
    writeFact(outsideServersDir, "victim-guild", "must not load server");
    fs.symlinkSync(outsideFactsDir, factsDir, "junction");

    try {
        const result = runScript(messagesDir, readAndWriteProbeScript());
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            user: "",
            server: "",
            userWriteRejected: true,
            serverWriteRejected: true,
        });
        assert.equal(fs.existsSync(path.join(outsideUsersDir, "new-user.json")), false);
        assert.equal(fs.existsSync(path.join(outsideServersDir, "new-server.json")), false);
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("user and server fact-scope junctions cannot be read or written", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-scope-junction-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const factsDir = path.join(messagesDir, "profiles", "facts");
    const usersDir = path.join(factsDir, "users");
    const serversDir = path.join(factsDir, "servers");
    const outsideUsersDir = path.join(testDir, "outside-users");
    const outsideServersDir = path.join(testDir, "outside-servers");
    fs.mkdirSync(factsDir, { recursive: true });
    writeFact(outsideUsersDir, "victim", "must not load user");
    writeFact(outsideServersDir, "victim-guild", "must not load server");
    fs.symlinkSync(outsideUsersDir, usersDir, "junction");
    fs.symlinkSync(outsideServersDir, serversDir, "junction");

    try {
        const result = runScript(messagesDir, readAndWriteProbeScript());
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            user: "",
            server: "",
            userWriteRejected: true,
            serverWriteRejected: true,
        });
        assert.equal(fs.existsSync(path.join(outsideUsersDir, "new-user.json")), false);
        assert.equal(fs.existsSync(path.join(outsideServersDir, "new-server.json")), false);
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("final fact-file symbolic links cannot be read or overwritten", (t) => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-file-symlink-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const usersDir = path.join(messagesDir, "profiles", "facts", "users");
    const serversDir = path.join(messagesDir, "profiles", "facts", "servers");
    const outsideUser = path.join(testDir, "outside-user.json");
    const outsideServer = path.join(testDir, "outside-server.json");
    fs.mkdirSync(usersDir, { recursive: true });
    fs.mkdirSync(serversDir, { recursive: true });
    fs.writeFileSync(outsideUser, factDocument("must not load user"));
    fs.writeFileSync(outsideServer, factDocument("must not load server"));

    try {
        try {
            fs.symlinkSync(outsideUser, path.join(usersDir, "victim.json"));
            fs.symlinkSync(
                outsideServer,
                path.join(serversDir, "victim-guild.json"),
            );
        } catch (error) {
            if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
            t.diagnostic("symbolic-link assertions require host permission");
            return;
        }

        const result = runScript(
            messagesDir,
            readAndWriteProbeScript("victim", "victim-guild"),
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            user: "",
            server: "",
            userWriteRejected: true,
            serverWriteRejected: true,
        });
        assert.match(fs.readFileSync(outsideUser, "utf8"), /must not load user/u);
        assert.match(
            fs.readFileSync(outsideServer, "utf8"),
            /must not load server/u,
        );
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fact reads use opened descriptors when file paths are replaced", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-file-race-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const usersDir = path.join(messagesDir, "profiles", "facts", "users");
    const serversDir = path.join(messagesDir, "profiles", "facts", "servers");
    const userPath = path.join(usersDir, "victim.json");
    const serverPath = path.join(serversDir, "victim-guild.json");
    const userReplacement = path.join(testDir, "user-replacement.json");
    const serverReplacement = path.join(testDir, "server-replacement.json");
    writeFact(usersDir, "victim", "expected user fact");
    writeFact(serversDir, "victim-guild", "expected server fact");
    fs.writeFileSync(userReplacement, factDocument("must not load user"));
    fs.writeFileSync(serverReplacement, factDocument("must not load server"));

    const script = [
        'import fs from "node:fs";',
        `const profiles = await import(${JSON.stringify(profilesUrl)});`,
        `const replacements = new Map(${JSON.stringify([
            [userPath, userReplacement],
            [serverPath, serverReplacement],
        ])});`,
        "const factDescriptors = new Map();",
        "const originalOpenSync = fs.openSync.bind(fs);",
        "const originalReadSync = fs.readSync.bind(fs);",
        "fs.openSync = (target, ...args) => {",
        "  const descriptor = originalOpenSync(target, ...args);",
        "  if (replacements.has(target)) factDescriptors.set(descriptor, target);",
        "  return descriptor;",
        "};",
        "fs.readSync = (descriptor, ...args) => {",
        "  const target = factDescriptors.get(descriptor);",
        "  const replacement = replacements.get(target);",
        "  if (replacement) {",
        "    replacements.delete(target);",
        "    fs.rmSync(target);",
        "    fs.renameSync(replacement, target);",
        "  }",
        "  return originalReadSync(descriptor, ...args);",
        "};",
        "process.stdout.write(JSON.stringify({ user: profiles.getUserProfile('victim'), server: profiles.getServerMemory('victim-guild') }));",
    ];

    try {
        const result = runScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        const loaded = JSON.parse(result.stdout);
        assert.match(loaded.user, /expected user fact/u);
        assert.doesNotMatch(loaded.user, /must not load/u);
        assert.match(loaded.server, /expected server fact/u);
        assert.doesNotMatch(loaded.server, /must not load/u);
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fact reads reject files that grow beyond the byte cap after opening", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-size-race-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const usersDir = path.join(messagesDir, "profiles", "facts", "users");
    const serversDir = path.join(messagesDir, "profiles", "facts", "servers");
    const userPath = path.join(usersDir, "victim.json");
    const serverPath = path.join(serversDir, "victim-guild.json");
    writeFact(usersDir, "victim", "initial user fact");
    writeFact(serversDir, "victim-guild", "initial server fact");

    const script = [
        'import fs from "node:fs";',
        `const memoryFacts = await import(${JSON.stringify(memoryFactsUrl)});`,
        `const factPaths = new Set(${JSON.stringify([userPath, serverPath])});`,
        "const factDescriptors = new Map();",
        "const grown = new Set();",
        "const originalOpenSync = fs.openSync.bind(fs);",
        "const originalReadSync = fs.readSync.bind(fs);",
        "const originalAppendFileSync = fs.appendFileSync.bind(fs);",
        "fs.openSync = (target, ...args) => {",
        "  const descriptor = originalOpenSync(target, ...args);",
        "  if (factPaths.has(target)) factDescriptors.set(descriptor, target);",
        "  return descriptor;",
        "};",
        "fs.readSync = (descriptor, ...args) => {",
        "  const target = factDescriptors.get(descriptor);",
        "  if (target && !grown.has(target)) {",
        "    grown.add(target);",
        "    originalAppendFileSync(target, ' '.repeat(1_100_000), 'utf8');",
        "  }",
        "  return originalReadSync(descriptor, ...args);",
        "};",
        "const user = memoryFacts.getMemoryFacts('user', 'victim');",
        "const server = memoryFacts.getMemoryFacts('server', 'victim-guild');",
        "process.stdout.write(JSON.stringify({ user, server, grown: grown.size }));",
    ];

    try {
        const result = runScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            user: [],
            server: [],
            grown: 2,
        });
        assert.ok(fs.statSync(userPath).size > 1_048_576);
        assert.ok(fs.statSync(serverPath).size > 1_048_576);
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fact read close failures fail closed and still close directory handles", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-close-failure-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const usersDir = path.join(messagesDir, "profiles", "facts", "users");
    const serversDir = path.join(messagesDir, "profiles", "facts", "servers");
    const userPath = path.join(usersDir, "victim.json");
    const serverPath = path.join(serversDir, "victim-guild.json");
    writeFact(usersDir, "victim", "initial user fact");
    writeFact(serversDir, "victim-guild", "initial server fact");

    const script = [
        'import fs from "node:fs";',
        `const memoryFacts = await import(${JSON.stringify(memoryFactsUrl)});`,
        `const factPaths = new Set(${JSON.stringify([userPath, serverPath])});`,
        "const factDescriptors = new Set();",
        "const originalOpenSync = fs.openSync.bind(fs);",
        "const originalCloseSync = fs.closeSync.bind(fs);",
        "let injectedFailures = 0;",
        "let laterCloses = 0;",
        "fs.openSync = (target, ...args) => {",
        "  const descriptor = originalOpenSync(target, ...args);",
        "  if (factPaths.has(target)) factDescriptors.add(descriptor);",
        "  return descriptor;",
        "};",
        "fs.closeSync = (descriptor) => {",
        "  if (factDescriptors.delete(descriptor)) {",
        "    originalCloseSync(descriptor);",
        "    injectedFailures += 1;",
        "    throw new Error('injected final-file close failure');",
        "  }",
        "  if (injectedFailures > 0) laterCloses += 1;",
        "  return originalCloseSync(descriptor);",
        "};",
        "const user = memoryFacts.getMemoryFacts('user', 'victim');",
        "const server = memoryFacts.getMemoryFacts('server', 'victim-guild');",
        "process.stdout.write(JSON.stringify({ user, server, injectedFailures, laterCloses }));",
    ];

    try {
        const result = runScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.user, []);
        assert.deepEqual(output.server, []);
        assert.equal(output.injectedFailures, 2);
        assert.ok(output.laterCloses >= 2, JSON.stringify(output));
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fact write close failures fail closed and still close directory handles", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-write-close-failure-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const usersDir = path.join(messagesDir, "profiles", "facts", "users");
    const targetPath = path.join(usersDir, "new-user.json");
    fs.mkdirSync(usersDir, { recursive: true });

    const script = [
        'import fs from "node:fs";',
        `const memoryFacts = await import(${JSON.stringify(memoryFactsUrl)});`,
        `const targetPath = ${JSON.stringify(targetPath)};`,
        "const temporaryDescriptors = new Set();",
        "const originalOpenSync = fs.openSync.bind(fs);",
        "const originalCloseSync = fs.closeSync.bind(fs);",
        "let injectedFailures = 0;",
        "let laterCloses = 0;",
        "fs.openSync = (target, ...args) => {",
        "  const descriptor = originalOpenSync(target, ...args);",
        "  if (typeof target === 'string' && target.startsWith(`${targetPath}.tmp-`)) temporaryDescriptors.add(descriptor);",
        "  return descriptor;",
        "};",
        "fs.closeSync = (descriptor) => {",
        "  if (temporaryDescriptors.delete(descriptor)) {",
        "    originalCloseSync(descriptor);",
        "    injectedFailures += 1;",
        "    throw new Error('injected temporary-file close failure');",
        "  }",
        "  if (injectedFailures > 0) laterCloses += 1;",
        "  return originalCloseSync(descriptor);",
        "};",
        "let writeRejected = false;",
        "try { memoryFacts.mergeMemoryFacts('user', 'new-user', [{ text: 'new memory', sourceMessageId: 'message-1', attribution: 'explicit' }], new Set(['message-1'])); } catch { writeRejected = true; }",
        "process.stdout.write(JSON.stringify({ writeRejected, injectedFailures, laterCloses, targetExists: fs.existsSync(targetPath) }));",
    ];

    try {
        const result = runScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.writeRejected, true);
        assert.equal(output.injectedFailures, 1);
        assert.ok(output.laterCloses >= 1, JSON.stringify(output));
        assert.equal(output.targetExists, true);
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fact writes fail safely if their scope directory moves before commit", () => {
    const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-fact-write-dir-race-"),
    );
    const messagesDir = path.join(testDir, "messages");
    const factsDir = path.join(messagesDir, "profiles", "facts");
    const usersDir = path.join(factsDir, "users");
    const parkedDir = path.join(factsDir, "users-original");
    const outsideDir = path.join(testDir, "outside-users");
    const targetPath = path.join(usersDir, "new-user.json");
    const outsideTarget = path.join(outsideDir, "new-user.json");
    fs.mkdirSync(usersDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const script = [
        'import fs from "node:fs";',
        `const memoryFacts = await import(${JSON.stringify(memoryFactsUrl)});`,
        `const usersDir = ${JSON.stringify(usersDir)};`,
        `const parkedDir = ${JSON.stringify(parkedDir)};`,
        `const outsideDir = ${JSON.stringify(outsideDir)};`,
        `const targetPath = ${JSON.stringify(targetPath)};`,
        `const outsideTarget = ${JSON.stringify(outsideTarget)};`,
        "const originalRenameSync = fs.renameSync.bind(fs);",
        "let attempted = false;",
        "let swapped = false;",
        "let swapError = '';",
        "fs.renameSync = (source, destination) => {",
        "  if (!attempted && destination === targetPath) {",
        "    attempted = true;",
        "    try {",
        "      originalRenameSync(usersDir, parkedDir);",
        "      fs.symlinkSync(outsideDir, usersDir, process.platform === 'win32' ? 'junction' : 'dir');",
        "      swapped = true;",
        "    } catch (error) {",
        "      swapError = error.code ?? String(error);",
        "    }",
        "  }",
        "  return originalRenameSync(source, destination);",
        "};",
        "let writeRejected = false;",
        "let changed = 0;",
        "try { changed = memoryFacts.mergeMemoryFacts('user', 'new-user', [{ text: 'new memory', sourceMessageId: 'message-1', attribution: 'explicit' }], new Set(['message-1'])); } catch { writeRejected = true; }",
        "process.stdout.write(JSON.stringify({ attempted, swapped, swapError, writeRejected, changed, outsideExists: fs.existsSync(outsideTarget) }));",
    ];

    try {
        const result = runScript(messagesDir, script);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.attempted, true);
        assert.equal(output.outsideExists, false);
        if (output.swapped) {
            assert.equal(output.writeRejected, true);
            assert.equal(output.changed, 0);
        } else {
            assert.ok(output.swapError, JSON.stringify(output));
            assert.equal(output.writeRejected, false);
            assert.equal(output.changed, 1);
        }
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test("fact-scope swaps fail closed for user and server operations", () => {
    const scenarios = [
        { scope: "user", id: "victim", directory: "users" },
        { scope: "server", id: "victim-guild", directory: "servers" },
    ];

    for (const scenario of scenarios) {
        const testDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "claudify-fact-dir-race-"),
        );
        const messagesDir = path.join(testDir, "messages");
        const factsDir = path.join(messagesDir, "profiles", "facts");
        const scopeDir = path.join(factsDir, scenario.directory);
        const parkedDir = path.join(factsDir, `${scenario.directory}-original`);
        const outsideDir = path.join(testDir, `outside-${scenario.directory}`);
        writeFact(scopeDir, scenario.id, "expected fact");
        writeFact(outsideDir, scenario.id, "must not be loaded");

        const script = [
            'import fs from "node:fs";',
            `const memoryFacts = await import(${JSON.stringify(memoryFactsUrl)});`,
            `const scopeDir = ${JSON.stringify(scopeDir)};`,
            `const parkedDir = ${JSON.stringify(parkedDir)};`,
            `const outsideDir = ${JSON.stringify(outsideDir)};`,
            "const originalOpenSync = fs.openSync.bind(fs);",
            "let swapped = false;",
            "fs.openSync = (...args) => {",
            "  if (!swapped && args[0] === scopeDir) {",
            "    fs.renameSync(scopeDir, parkedDir);",
            "    fs.symlinkSync(outsideDir, scopeDir, 'junction');",
            "    swapped = true;",
            "  }",
            "  return originalOpenSync(...args);",
            "};",
            `const facts = memoryFacts.getMemoryFacts(${JSON.stringify(scenario.scope)}, ${JSON.stringify(scenario.id)});`,
            "let writeRejected = false;",
            `try { memoryFacts.mergeMemoryFacts(${JSON.stringify(scenario.scope)}, 'new-scope', [{ text: 'new memory', sourceMessageId: 'message-1', attribution: 'explicit' }], new Set(['message-1'])); } catch { writeRejected = true; }`,
            "process.stdout.write(JSON.stringify({ facts, writeRejected }));",
        ];

        try {
            const result = runScript(messagesDir, script);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), {
                facts: [],
                writeRejected: true,
            });
            assert.equal(fs.existsSync(path.join(outsideDir, "new-scope.json")), false);
        } finally {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    }
});
