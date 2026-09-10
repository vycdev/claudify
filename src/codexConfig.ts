import type { ClaudeWorkload } from "./claudeTypes.js";
import type {
    ModelEffort,
    ModelProvider,
    ModelRunOptions,
} from "./modelTypes.js";

export function parseBotProvider(value: string | undefined): ModelProvider {
    const provider = value?.trim().toLowerCase() || "claude";
    if (provider !== "claude" && provider !== "codex")
        throw new Error("BOT_PROVIDER must be claude or codex.");
    return provider;
}
const efforts = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
function model(
    value: string | undefined,
    fallback: string,
    key: string,
): string {
    const normalized = value?.trim();
    if (!normalized || normalized === "inherit") return fallback;
    if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized) ||
        normalized === "default"
    )
        throw new Error(`${key} must be an explicit Codex model ID.`);
    return normalized;
}
function effort(
    value: string | undefined,
    fallback: ModelEffort | undefined,
    key: string,
): ModelEffort | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || normalized === "inherit") return fallback;
    if (normalized === "default") return undefined;
    if (!efforts.has(normalized))
        throw new Error(`${key} is not a valid reasoning effort.`);
    return normalized as ModelEffort;
}
export function resolveCodexConfig(env: NodeJS.ProcessEnv) {
    const globalModel = model(env.CODEX_MODEL, "gpt-5.6-luna", "CODEX_MODEL");
    const globalEffort = effort(env.CODEX_EFFORT, "medium", "CODEX_EFFORT");
    const names: Record<ClaudeWorkload, string> = {
        response: "RESPONSE",
        "profile-update": "PROFILE",
        "server-memory-update": "SERVER_MEMORY",
        "daily-summary": "SUMMARY",
    };
    const workloads = {} as Record<ClaudeWorkload, Readonly<ModelRunOptions>>;
    for (const [workload, prefix] of Object.entries(names)) {
        const modelKey = `CODEX_${prefix}_MODEL`;
        const effortKey = `CODEX_${prefix}_EFFORT`;
        workloads[workload as ClaudeWorkload] = Object.freeze({
            workload: workload as ClaudeWorkload,
            model: model(env[modelKey], globalModel, modelKey),
            effort: effort(env[effortKey], globalEffort, effortKey),
        });
    }
    const mode =
        env.CODEX_RESPONSE_EFFORT_MODE?.trim().toLowerCase() || "fixed";
    if (mode !== "fixed" && mode !== "adaptive")
        throw new Error(
            "CODEX_RESPONSE_EFFORT_MODE must be fixed or adaptive.",
        );
    const simpleEffort =
        env.CODEX_RESPONSE_SIMPLE_EFFORT?.trim().toLowerCase() === "inherit"
            ? workloads.response.effort
            : effort(
                  env.CODEX_RESPONSE_SIMPLE_EFFORT,
                  "low",
                  "CODEX_RESPONSE_SIMPLE_EFFORT",
              );
    return Object.freeze({
        workloads: Object.freeze(workloads),
        mode,
        simpleEffort,
    });
}
