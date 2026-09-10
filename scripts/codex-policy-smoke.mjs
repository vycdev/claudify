// Offline policy regression test for Codex 0.154.0. Build first.
// CODEX_BIN=/path/to/codex node scripts/codex-policy-smoke.mjs
// Uses the production transport, policy builder and tools-only bridge.
// All model responses are fixed synthetic SSE from loopback; no OAuth/inference.
// Nonzero exit means the effective policy failed; never ignore this gate.
// Pinned-source blocker: core/src/tools/spec_plan.rs:1128-1133 registers all
// three MCP resource handlers whenever mcp.has_servers(). Namespace exclusion
// filters exposure (same file:780-788,807-815), not registry dispatch
// (core/src/tools/registry.rs:515-519). Do not turn this RED test into a skip.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createCodexClient } from "../build/codexClient.js";
import { codexThreadConfig } from "../build/codex.js";
import { CODEX_NO_ENVIRONMENT } from "../build/codexPolicy.js";
import { createCodexMcpBridge } from "../build/codexMcpBridge.js";

assert.equal(process.argv.length, 2, "Unknown argument");
const bin = process.env.CODEX_BIN || "codex";
const root = fs.mkdtempSync(path.join(process.env.CODEX_POLICY_ARTIFACT_DIR || os.tmpdir(), "codex-policy-"));
const save = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2));
// Never inherit auth, proxy, provider, or personal Codex configuration.
const childEnv = home => ({ PATH: process.env.PATH, HOME: home, CODEX_HOME: home });
assert.equal(execFileSync(bin, ["--version"], { env: childEnv(root), cwd: root, encoding: "utf8" }).trim(), "codex-cli 0.154.0");
const model = "gpt-5.6-luna";
const provider = "policy-loopback-fixture"; // Deliberate test-only provider, never production OpenAI.
const marker = "FIXED LOCAL RESOURCE CANARY; NOT A CREDENTIAL\n";
const canary = path.join(root, "canary.txt");
fs.writeFileSync(canary, marker);
const resourceUri = `file://${canary}`;
const patch = `*** Begin Patch\n*** Update File: ${canary}\n@@\n-${marker.trim()}\n+HARMLESS SYNTHETIC PATCH\n*** End Patch`;
const reports = [];
let active;
let networkHits = 0;
const server = http.createServer(async (req, res) => {
    try {
        if (req.url === "/network-canary") { networkHits++; res.end("LOCAL"); return; }
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (req.url === "/mcp") {
            assert.equal(req.headers.authorization, "Bearer FIXED-SYNTHETIC-UPSTREAM-ONLY");
            active.mcpRequests.push(body);
            let result = {};
            if (body.method === "initialize") result = {
                protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} },
                serverInfo: { name: "fixed-policy-fixture", version: "1" },
            };
            if (body.method === "tools/list") result = { tools: ["echo", "blocked"].map(name => ({
                name, description: "Fixed harmless local marker", inputSchema: { type: "object", properties: {}, additionalProperties: false },
            })) };
            if (body.method === "tools/call") {
                active.mcpCalls.push(body.params.name);
                result = { content: [{ type: "text", text: `LOCAL-MCP-${body.params.name}-OK` }] };
            }
            if (body.method === "resources/list") result = { resources: [{ uri: resourceUri, name: "temporary-canary", mimeType: "text/plain" }] };
            if (body.method === "resources/templates/list") result = { resourceTemplates: [] };
            if (body.method === "resources/read") {
                assert.equal(body.params.uri, resourceUri, "Fixture refuses every other resource");
                active.resourceReads.push(body.params.uri);
                result = { contents: [{ uri: resourceUri, mimeType: "text/plain", text: fs.readFileSync(canary, "utf8") }] };
            }
            if (body.id === undefined) { res.writeHead(202).end(); return; }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
            return;
        }
        assert.equal(req.url, "/v1/responses", "Only loopback fixture endpoints are supported");
        assert.equal(req.headers.authorization, undefined, "Fixture must not receive credentials");
        assert.equal(body.model, model);
        active.requests.push(body);
        save(`${active.name}-request-${active.requests.length}.json`, body);
        // A failing old policy can spawn subagents. They receive only a fixed
        // final answer, never another probe program, and cannot consume the
        // root thread's first fixture response.
        const rootRequest = body.client_metadata?.thread_id === active.threadId;
        const firstRootRequest = rootRequest && !active.dispatched;
        if (firstRootRequest) active.dispatched = true;
        const items = firstRootRequest ? active.items : [{
            type: "message", id: "fixed-final", role: "assistant", phase: "final_answer",
            content: [{ type: "output_text", text: "SYNTHETIC FIXTURE COMPLETE; NO INFERENCE" }],
        }];
        const id = `fixed-response-${active.requests.length}`;
        const events = [
            { type: "response.created", response: { id } },
            ...items.map(item => ({ type: "response.output_item.done", item })),
            { type: "response.completed", response: { id, output: items, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" }).end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    } catch (error) {
        active?.fixtureErrors.push(String(error));
        res.writeHead(500).end("Local fixture assertion failed");
    }
});


server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
// Every denied call has fixed harmless arguments. No model-generated code is used.
const denied = [
    ["functions", "exec_command", { cmd: "printf HARMLESS" }],
    ["functions", "shell", { command: ["printf", "HARMLESS"] }],
    ["functions", "shell_command", { command: "printf HARMLESS" }],
    ["functions", "write_stdin", { session_id: 0, chars: "" }],
    ["functions", "view_image", { path: canary }],
    ["functions", "read_file", { path: canary }],
    ["functions", "js_repl", { code: "1" }],
    ["skills", "list", {}], ["skills", "read", { package: canary }],
    ["functions", "list_mcp_resources", { server: "fixture" }],
    ["functions", "list_mcp_resource_templates", { server: "fixture" }],
    ["functions", "read_mcp_resource", { server: "fixture", uri: resourceUri }],
    ["multi_agent_v1", "spawn_agent", { message: "Fixed harmless synthetic fixture" }],
    ...["resume_agent", "close_agent"].map(name => ["multi_agent_v1", name, { id: "nonexistent" }]),
    ["multi_agent_v1", "send_input", { id: "nonexistent", message: "harmless" }],
    ["multi_agent_v1", "wait_agent", { agent_ids: ["nonexistent"] }],
    ["mcp__fixture", "blocked", {}],
    ["functions", "request_user_input", { questions: [] }],
];
const nestedName = (namespace, name) => namespace === "functions" ? name : `${namespace}__${name}`;
try {
    for (const response of [true, false]) {
        const name = response ? "response" : "background";
        const home = path.join(root, `${name}-home`);
        fs.mkdirSync(home, { mode: 0o700 });
        active = { name, requests: [], notifications: [], mcpRequests: [], mcpCalls: [], resourceReads: [], clientRequests: [], fixtureErrors: [] };
        const probes = [...denied, ...(!response ? [["web", "run", {}], ["mcp__fixture", "echo", {}]] : [])];
        const nested = probes.map(([ns, tool, args]) => [nestedName(ns, tool), args]);
        nested.push(["apply_patch", patch]);
        const cell = `text({kind:'catalog', names:ALL_TOOLS.map(t=>t.name).sort()});
for(const [name,args] of ${JSON.stringify(nested)}) { try { text({kind:'nested',name,result:await tools[name](args)}); } catch(e) { text({kind:'nested',name,error:String(e)}); } }
for(const spec of ${JSON.stringify(["node:fs", "node:child_process", resourceUri, url + "/network-canary"])}) { try { await import(spec);text({kind:'import',name:spec,allowed:true}); } catch(e) { text({kind:'import',name:spec,error:String(e)}); } }
for(const [name,fn] of [['process',()=>process.cwd()],['require',()=>require('node:fs')],['fetch',()=>fetch('${url}/network-canary')],['Function-process',()=>Function('return process')()],['image-file',()=>image(${JSON.stringify(resourceUri)})],['image-http',()=>image('${url}/network-canary')]]) { try { text({kind:'runtime',name,result:await fn()}); } catch(e) { text({kind:'runtime',name,error:String(e)}); } }
${response ? "text({kind:'mcp',result:await tools.mcp__fixture__echo({})});" : ""}`;
        fs.writeFileSync(path.join(root, `${name}-synthetic-cell.js`), cell);
        active.items = [
            { type: "custom_tool_call", call_id: "nested-probes", namespace: "functions", name: "exec", input: cell },
            { type: "custom_tool_call", call_id: "direct-patch", namespace: "functions", name: "apply_patch", input: patch },
            ...probes.map(([namespace, name, args]) => ({ type: "function_call", call_id: `direct-${namespace}-${name}`, namespace, name, arguments: JSON.stringify(args) })),
        ];
        let client, timer, bridge;
        const report = { name, passed: false, failures: [] };
        const check = (label, fn) => { try { fn(); } catch (error) { report.failures.push({ label, error: String(error) }); } };
        try {
            client = await createCodexClient({ home, executable: { command: bin } });
            assert.equal((await client.request("account/read", { refreshToken: false })).account, null);
            if (response) bridge = await createCodexMcpBridge({ fixture: { url: url + "/mcp", http_headers: { Authorization: "Bearer FIXED-SYNTHETIC-UPSTREAM-ONLY" }, enabled_tools: ["echo"] } });
            const config = codexThreadConfig(bridge?.servers ?? {}, response);
            assert.ok(!JSON.stringify(config).includes("FIXED-SYNTHETIC-UPSTREAM-ONLY"));
            assert.ok(!JSON.stringify(config).includes(url + "/mcp"));
            // Explicitly isolated fixture provider. Never override the built-in openai endpoint.
            config[`model_providers.${provider}`] = { name: "Labelled synthetic loopback fixture", base_url: url + "/v1", wire_api: "responses", requires_openai_auth: false, supports_websockets: false, supports_standalone_web_search: true };
            save(`${name}-config.json`, config);
            const processConfig = await client.request("config/read", { includeLayers: true });
            save(`${name}-process-config.json`, processConfig);
            check("process-scoped host policy", () => assert.deepEqual(processConfig.config.features.code_mode_host, { enabled: true, disable_in_process_fallback: true }));
            const thread = await client.request("thread/start", { model, modelProvider: provider, cwd: home, ephemeral: true, sandbox: "read-only", approvalPolicy: "never", ...CODEX_NO_ENVIRONMENT, config, baseInstructions: "Labelled fixed synthetic policy fixture. No inference.", developerInstructions: "No external actions." });
            save(`${name}-thread.json`, thread);
            assert.equal(thread.model, model); assert.equal(thread.modelProvider, provider);
            active.threadId = thread.thread.id;
            check("effective no-environment thread", () => assert.deepEqual(thread.thread.environments, []));
            let finish;
            const completed = new Promise(resolve => { finish = resolve; });
            client.onNotification((method, params) => {
                active.notifications.push({ method, params });
                if (method === "turn/completed" && params.threadId === thread.thread.id) finish(params.turn);
            });
            await client.request("turn/start", { threadId: thread.thread.id, model, effort: "medium", input: [{ type: "text", text: "Fixed synthetic fixture only" }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, ...CODEX_NO_ENVIRONMENT });
            const turn = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Policy fixture timeout")), 45000); })]);
            assert.equal(turn.status, "completed");
            const last = active.requests.filter(r => r.client_metadata?.thread_id === thread.thread.id).at(-1);
            assert.ok(last, "No synthetic model request captured");
            const outputs = last.input.filter(item => item.type.endsWith("call_output"));
            const codeOutput = outputs.find(item => item.call_id === "nested-probes")?.output;
            const rows = (Array.isArray(codeOutput) ? codeOutput : []).flatMap(item => { try { return [JSON.parse(item.text)]; } catch { return []; } });
            check("all runtime probes returned evidence", () => assert.deepEqual(rows.filter(r => r.kind === "runtime").map(r => r.name).sort(), ["Function-process", "fetch", "image-file", "image-http", "process", "require"]));
            check("all import probes returned evidence", () => assert.equal(rows.filter(r => r.kind === "import").length, 4));
            report.nestedTools = rows.find(row => row.kind === "catalog")?.names;
            const allowed = response ? ["mcp__fixture__echo", "web__run"] : [];
            check("runtime nested allowlist", () => assert.deepEqual(report.nestedTools, allowed));
            const metadata = JSON.parse(last.client_metadata?.["x-codex-turn-metadata"] || "{}");
            report.toolMetadata = metadata.tool_namespaces_info;
            const info = Object.values(report.toolMetadata || {}).flatMap(ns => Object.values(ns.functions));
            check("authoritative nested metadata", () => assert.deepEqual(info.filter(t => t.code_mode_name).map(t => t.code_mode_name).sort(), allowed));
            check("authoritative direct metadata", () => assert.deepEqual(info.filter(t => t.direct).map(t => t.name).sort(), ["exec", "wait"]));
            const advertised = last.input.filter(i => i.type === "additional_tools").flatMap(i => i.tools).flatMap(ns => ns.type === "namespace" ? ns.tools.map(t => `${ns.name}.${t.name}`) : [ns.name]);
            report.advertisedDirect = advertised;
            check("serialized direct allowlist", () => assert.deepEqual(advertised.sort(), ["functions.exec", "functions.wait"]));
            for (const [tool] of nested) check(`nested denial: ${tool}`, () => assert.match(rows.find(r => r.kind === "nested" && r.name === tool)?.error || "", /not a function/));
            for (const row of rows.filter(r => r.kind === "import" || r.kind === "runtime")) check(`${row.kind} denial: ${row.name}`, () => assert.ok(row.error && !row.allowed, JSON.stringify(row)));
            report.directOutputs = outputs.filter(o => o.call_id.startsWith("direct-"));
            for (const item of active.items.filter(i => i.call_id.startsWith("direct-"))) check(`direct denial: ${item.call_id}`, () => {
                const output = report.directOutputs.find(o => o.call_id === item.call_id)?.output;
                if (response && ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(item.name)) assert.match(output, /Mcp error: -32601: Method not found/);
                else assert.match(JSON.stringify(output), /unsupported (?:custom tool )?call:/);
            });
            report.mcpCalls = active.mcpCalls;
            report.resourceReads = active.resourceReads;
            check("only authorized MCP calls", () => assert.deepEqual(active.mcpCalls, response ? ["echo"] : []));
            check("no MCP resource reads", () => assert.deepEqual(active.resourceReads, []));
            check("no upstream resources/prompts/sampling traffic", () => assert.deepEqual(active.mcpRequests.filter(r => /^(resources|prompts|sampling)\//.test(r.method)), []));
            check("resource canary never returned", () => assert.ok(!JSON.stringify(outputs).includes(marker.trim())));
            check("canary unchanged", () => assert.equal(fs.readFileSync(canary, "utf8"), marker));
            check("no direct network canary contact", () => assert.equal(networkHits, 0));

            check("fixture server assertions", () => assert.deepEqual(active.fixtureErrors, []));
            save(`${name}-outputs.json`, outputs);
        } catch (error) { report.failures.push({ label: "execution", error: String(error) }); }
        finally {
            clearTimeout(timer); client?.close();
            await bridge?.close();
            // Both transports have a one-second SIGKILL backstop. Keep the old
            // fixture state until its process (and any failed-policy subagents)
            // can no longer send requests into the next case.
            await new Promise(resolve => setTimeout(resolve, 1100));
            save(`${name}-notifications.json`, active.notifications);
            save(`${name}-mcp-requests.json`, active.mcpRequests);
        }
        report.passed = report.failures.length === 0;
        reports.push(report);
    }
} finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
const result = { passed: reports.every(r => r.passed), authenticated: false, liveInferencePerformed: false, syntheticModelResponses: true, model, fixtureProvider: provider, productionProviderUnchanged: "openai", artifacts: root, reports };
save("summary.json", result);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
