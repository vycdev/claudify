import { createCodexClient, type CodexClient } from "./codexClient.js";
import { enqueueModelRun } from "./claude.js";
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
    mcpServers?: Record<string, CodexMcpServer>;
    clientFactory?: () => Promise<CodexClient>;
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

export function codexThreadConfig(
    mcpServers: Record<string, CodexMcpServer>,
    response: boolean,
): Record<string, unknown> {
    const config: Record<string, unknown> = {
        project_doc_max_bytes: 0,
        web_search: response ? "live" : "disabled",
        mcp_servers: response
            ? Object.fromEntries(
                  Object.entries(mcpServers).map(([name, server]) => [
                      name,
                      { ...server, required: true, enabled: true },
                  ]),
              )
            : {},
    };
    // Read-only sandbox blocks apply_patch even when a model advertises it.
    // Remove shell and local-file image tools, rather than relying on prompts.
    for (const feature of [
        "shell_tool",
        "unified_exec",
        "view_image",
        "multi_agent",
        "multi_agent_v2",
        "apps",
        "plugins",
        "hooks",
        "codex_hooks",
        "plugin_hooks",
        "js_repl",
        "code_mode",
        "code_mode_host",
        "computer_use",
        "browser_use",
        "image_generation",
        "memories",
        "memory_tool",
        "request_permissions_tool",
        "skill_mcp_dependency_install",
        "skill_env_var_dependency_prompt",
        "tool_suggest",
    ])
        config[`features.${feature}`] = false;
    config["features.skip_host_skill_discovery"] = true;
    return config;
}

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
                createCodexClient({ home: settings.home }));
            let timer: NodeJS.Timeout | undefined;
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
                const thread = await client.request("thread/start", {
                    model: options.model,
                    modelProvider: "openai",
                    cwd: settings.home,
                    sandbox: "read-only",
                    approvalPolicy: "never",
                    ephemeral: true,
                    baseInstructions:
                        systemIndex >= 0
                            ? args[systemIndex + 1]
                            : "Follow the user's data-processing instructions. Return only the requested result.",
                    developerInstructions:
                        "You are running inside Claudify, a Discord bot. Use only the supplied Discord/Morpheus MCP tools and web search. Images are attached directly. Never execute shell commands, edit local files, read credentials, or try to change your configuration. History is available through Discord MCP tools, not Read/Grep/Glob. Do not claim an external action succeeded without a successful tool result.",
                    config: codexThreadConfig(
                        settings.mcpServers ?? {},
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
                client.close();
            }
        });
}
