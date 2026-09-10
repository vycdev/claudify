import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const moduleUrl = new URL("../build/codexClient.js", import.meta.url);
const fixture = `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.id===undefined)return;
 const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 if(m.method==='close_then_request'){
  process.stdout.write(JSON.stringify({method:'model/rerouted',params:{threadId:'thread-1',toModel:'another-model'}})+'\\n'+JSON.stringify({id:900,method:'item/tool/requestUserInput',params:{}})+'\\n');return;
 }
 if(m.method==='hang')return;
 if(m.method==='die'){process.exit(1);return;}
 if(m.method==='notify')send({method:'account/updated',params:{authMode:'chatgpt'}});
 if(m.method==='env')send({id:m.id,result:{keys:Object.keys(process.env),argv:process.argv}});
 else send({id:m.id,result:m.method==='account/read'?{account:null}: {ok:true}});
});`;

test("Codex transport initializes and multiplexes without leaking API or Discord credentials", async () => {
    const { createCodexClient } = await import(moduleUrl);
    const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-codex-client-"),
    );
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only-not-a-real-key";
    let client;
    try {
        client = await createCodexClient({
            home,
            executable: {
                command: process.execPath,
                args: ["-e", fixture, "--"],
            },
        });
        const events = [];
        client.onNotification((method, params) =>
            events.push({ method, params }),
        );
        const [account, env] = await Promise.all([
            client.request("account/read"),
            client.request("env"),
        ]);
        assert.equal(account.account, null);
        assert.ok(!env.keys.includes("OPENAI_API_KEY"));
        assert.ok(!env.keys.includes("DISCORD_TOKEN"));
        assert.ok(env.keys.includes("CODEX_HOME"));
        assert.ok(env.argv.includes('forced_login_method="chatgpt"'));
        await client.request("notify");
        assert.equal(events[0].params.authMode, "chatgpt");
        if (process.platform !== "win32")
            assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    } finally {
        client?.close();
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("Codex transport refuses a home with unmanaged provider configuration", async () => {
    const { createCodexClient } = await import(moduleUrl);
    const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-codex-unsafe-"),
    );
    fs.writeFileSync(path.join(home, "config.toml"), 'model_provider="other"');
    try {
        await assert.rejects(
            createCodexClient({
                home,
                executable: {
                    command: process.execPath,
                    args: ["-e", fixture, "--"],
                },
            }).then((client) => client.close()),
            /config.toml/,
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("closing during a notification discards later frames without crashing the bot", async () => {
    const { createCodexClient } = await import(moduleUrl);
    const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-codex-close-frame-"),
    );
    const client = await createCodexClient({
        home,
        executable: { command: process.execPath, args: ["-e", fixture, "--"] },
    });
    client.onNotification((method) => {
        if (method === "model/rerouted") client.close();
    });
    try {
        await assert.rejects(client.request("close_then_request"), /closed/);
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(client.request("account/read"), /closed/);
    } finally {
        client.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("Codex transport rejects pending requests on timeout and process exit", async () => {
    const { createCodexClient } = await import(moduleUrl);
    for (const method of ["hang", "die"]) {
        const home = fs.mkdtempSync(
            path.join(os.tmpdir(), "claudify-codex-exit-"),
        );
        const client = await createCodexClient({
            home,
            requestTimeoutMs: 200,
            executable: {
                command: process.execPath,
                args: ["-e", fixture, "--"],
            },
        });
        try {
            await assert.rejects(client.request(method), /closed|timed out/);
        } finally {
            client.close();
            fs.rmSync(home, { recursive: true, force: true });
        }
    }
});
