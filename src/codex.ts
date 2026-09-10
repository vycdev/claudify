import { createCodexClient, type CodexClient } from "./codexClient.js";
import { enqueueModelRun } from "./claude.js";
import { createCodexMcpBridge, type CodexMcpBridge } from "./codexMcpBridge.js";
import { codexThreadConfig, CODEX_NO_ENVIRONMENT, requireNoEnvironment } from "./codexPolicy.js";
import type {
    ClaudeExecutionTrace,
    ClaudeToolCallTrace,
} from "./claudeStream.js";
import type { ModelRunner } from "./modelTypes.js";

export interface CodexMcpServer {
    url: string;
    http_headers?: Record<string, string>;
    enabled_tools?: string[];
}
export interface CodexRunnerOptions {
    home: string;
    forbiddenRoots?: readonly string[];
    mcpServers?: Record<string, CodexMcpServer>;
    clientFactory?: () => Promise<CodexClient>;
    bridgeFactory?: typeof createCodexMcpBridge;
    timeoutMs?: number;
}
function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

export async function requireCodexSubscription(
    client: CodexClient,
): Promise<Record<string, unknown>> {
    const { account } = await client.request("account/read", {
        refreshToken: false,
    });
    if (record(account).type !== "chatgpt")
        throw new Error(
            "Codex requires a ChatGPT subscription login. Use !codex auth login in an admin DM; API keys are not supported.",
        );
    return record(account);
}

export { codexThreadConfig } from "./codexPolicy.js";

async function checkModel(
    client: CodexClient,
    model: string,
    effort: string | undefined,
    hasImages: boolean,
): Promise<void> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
        const page = await client.request("model/list", { cursor, limit: 100 });
        const found = (Array.isArray(page.data) ? page.data : [])
            .map(record)
            .find((item) => item.model === model);
        if (found) {
            if (
                effort &&
                !(
                    Array.isArray(found.supportedReasoningEfforts)
                        ? found.supportedReasoningEfforts
                        : []
                ).some((item) => record(item).reasoningEffort === effort)
            )
                throw new Error(
                    "The selected Codex model does not support the configured reasoning effort.",
                );
            if (
                hasImages &&
                Array.isArray(found.inputModalities) &&
                !found.inputModalities.includes("image")
            )
                throw new Error(
                    "The selected Codex model does not support image input.",
                );
            return;
        }
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
        if (cursor && seen.has(cursor))
            throw new Error("Codex model catalog pagination did not advance.");
        if (cursor) seen.add(cursor);
    } while (cursor);
    throw new Error(
        "The configured Codex model is unavailable for this account. No fallback model was used.",
    );
}
function failedToolResult(value: unknown): boolean {
    const result = record(value);
    if (
        result.isError === true ||
        record(result.structuredContent).success === false
    )
        return true;
    for (const entry of Array.isArray(result.content) ? result.content : []) {
        const text = record(entry).text;
        if (typeof text !== "string") continue;
        try {
            if (record(JSON.parse(text)).success === false) return true;
        } catch {
            /* Plain text MCP output. */
        }
    }
    return false;
}

export function createCodexRunner(settings: CodexRunnerOptions): ModelRunner {
    return (args, input, options, imagePaths = []) =>
        enqueueModelRun(options.workload, async () => {
            const client = await (settings.clientFactory?.() ??
                createCodexClient({ home: settings.home, forbiddenRoots: settings.forbiddenRoots }));
            let timer: NodeJS.Timeout | undefined;
            const runAbort = new AbortController();
            let bridge: CodexMcpBridge | undefined;
            let unsubscribe: (() => void) | undefined;
            let threadId: string | undefined;
            let turnId: string | undefined;
            const trace: ClaudeExecutionTrace = {
                format: "stream-json",
                resultEventReceived: false,
                malformedEventCount: 0,
                toolCalls: [],
            };
            const byId = new Map<string, ClaudeToolCallTrace>();
            let output = "";
            let rejectTurn: ((reason: Error) => void) | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    const error = Object.assign(
                        new Error(
                            "Codex request timed out. An action may have started; verify its state before retrying.",
                        ),
                        { code: "CODEX_TIMEOUT", trace },
                    );
                    reject(error);
                    rejectTurn?.(error);
                    runAbort.abort();
                    client.close();
                }, settings.timeoutMs ?? 120_000);
            });
            const run = async () => {
                await requireCodexSubscription(client);
                if (!options.model)
                    throw new Error("Codex requires an explicit model.");
                await checkModel(
                    client,
                    options.model,
                    options.effort,
                    imagePaths.length > 0,
                );
                const systemIndex = args.indexOf("--system-prompt");
                if (options.workload === "response") {
                    bridge = await (settings.bridgeFactory ?? createCodexMcpBridge)(
                        settings.mcpServers ?? {}, { signal: runAbort.signal },
                    );
                    if (runAbort.signal.aborted) { await bridge.close(); runAbort.signal.throwIfAborted(); }
                }
                const thread = await client.request("thread/start", {
                    model: options.model,
                    modelProvider: "openai",
                    cwd: settings.home,
                    sandbox: "read-only",
                    approvalPolicy: "never",
                    ephemeral: true,
                    ...CODEX_NO_ENVIRONMENT,
                    baseInstructions:
                        systemIndex >= 0
                            ? args[systemIndex + 1]
                            : "Follow the user's data-processing instructions. Return only the requested result.",
                    developerInstructions:
                        "You are running inside Claudify, a Discord bot. Use only the supplied Discord/Morpheus MCP tools and web search. Images are attached directly. Never execute shell commands, edit local files, read credentials, or try to change your configuration. History is available through Discord MCP tools, not Read/Grep/Glob. Do not claim an external action succeeded without a successful tool result.",
                    config: codexThreadConfig(
                        bridge?.servers ?? {},
                        options.workload === "response",
                    ),
                    serviceName: "claudify",
                    serviceTier: "default",
                });
                threadId =
                    typeof record(thread.thread).id === "string"
                        ? (record(thread.thread).id as string)
                        : undefined;
                if (
                    !threadId ||
                    thread.model !== options.model ||
                    thread.modelProvider !== "openai"
                )
                    throw new Error(
                        "Codex did not select the requested model/provider; refusing a fallback.",
                    );
                if (
                    record(thread.sandbox).type !== "readOnly" ||
                    thread.approvalPolicy !== "never"
                )
                    throw new Error(
                        "Codex did not apply the required read-only sandbox and approval policy.",
                    );
                requireNoEnvironment(thread);
                const completed = new Promise<void>((resolve, reject) => {
                    rejectTurn = reject;
                    unsubscribe = client.onNotification((method, params) => {
                        if (method === "$closed") {
                            reject(
                                new Error(
                                    "Codex connection closed before the turn completed.",
                                ),
                            );
                            return;
                        }
                        if (params.threadId !== threadId) return;
                        if (
                            turnId &&
                            typeof params.turnId === "string" &&
                            params.turnId !== turnId
                        )
                            return;
                        if (
                            method === "model/rerouted" &&
                            params.toModel !== options.model
                        ) {
                            reject(
                                new Error(
                                    "Codex reported a model reroute; the configured-model contract could not be maintained. No retry or bypass was attempted; usage or an action may already have occurred.",
                                ),
                            );
                            client.close();
                            return;
                        }
                        const item = record(params.item);
                        if (
                            method === "item/started" ||
                            method === "item/completed"
                        ) {
                            if (
                                item.type === "mcpToolCall" &&
                                typeof item.id === "string" &&
                                typeof item.server === "string" &&
                                typeof item.tool === "string"
                            ) {
                                let call = byId.get(item.id);
                                if (!call) {
                                    if (byId.size >= 256) {
                                        trace.malformedEventCount++;
                                        reject(
                                            new Error(
                                                "Codex exceeded the tool trace limit.",
                                            ),
                                        );
                                        return;
                                    }
                                    call = {
                                        id: item.id,
                                        name: `mcp__${item.server}__${item.tool}`,
                                        resultStatus: "pending",
                                    };
                                    byId.set(item.id, call);
                                    trace.toolCalls.push(call);
                                }
                                if (method === "item/completed")
                                    call.resultStatus =
                                        item.error ||
                                        item.status === "failed" ||
                                        failedToolResult(item.result)
                                            ? "failure"
                                            : item.status === "completed" &&
                                                item.result != null
                                              ? "success"
                                              : "pending";
                            }
                            if (
                                method === "item/completed" &&
                                item.type === "agentMessage" &&
                                item.phase !== "commentary" &&
                                typeof item.text === "string"
                            ) {
                                if (item.text.length > 64 * 1024) {
                                    reject(
                                        new Error(
                                            "Codex output exceeded the response limit.",
                                        ),
                                    );
                                    return;
                                }
                                output = item.text;
                            }
                        }
                        if (method === "turn/completed") {
                            const turn = record(params.turn);
                            if (turnId && turn.id !== turnId) return;
                            trace.resultEventReceived = true;
                            if (turn.status !== "completed" || turn.error)
                                reject(
                                    new Error(
                                        "Codex could not complete the turn. Check subscription limits, authentication, and model settings; no fallback was used.",
                                    ),
                                );
                            else resolve();
                        }
                    });
                });
                // Attach a rejection handler immediately: notifications can arrive
                // before the turn/start response, including a process failure.
                void completed.catch(() => {});
                const started = await client.request("turn/start", {
                    threadId,
                    ...CODEX_NO_ENVIRONMENT,
                    input: [
                        { type: "text", text: input },
                        ...imagePaths.map((image) => ({
                            type: "localImage",
                            path: image,
                        })),
                    ],
                    model: options.model,
                    ...(options.effort ? { effort: options.effort } : {}),
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                    serviceTier: "default",
                });
                turnId =
                    typeof record(started.turn).id === "string"
                        ? (record(started.turn).id as string)
                        : undefined;
                if (!turnId) throw new Error("Codex did not start a turn.");
                await completed;
                if (!output.trim())
                    throw new Error("Codex returned no final answer.");
                return { stdout: output, stderr: "", trace };
            };
            try {
                return await Promise.race([run(), timeout]);
            } finally {
                if (timer) clearTimeout(timer);
                unsubscribe?.();
                runAbort.abort();
                client.close();
                await bridge?.close();
            }
        });
}
