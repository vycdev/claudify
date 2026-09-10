import type { CodexGatewayServer } from "./codexMcpBridge.js";

// Codex 0.154.0: Luna's metadata requires CodeModeOnly. The host provider is
// process-scoped; never substitute a model/provider or fall back to direct tools.
export const CODEX_HOST_OVERRIDE = "features.code_mode_host={enabled=true,disable_in_process_fallback=true}";
export const CODEX_NO_ENVIRONMENT = { environments: [] as never[] };

export function codexThreadConfig(
    gateways: Record<string, CodexGatewayServer>, response: boolean,
): Record<string, unknown> {
    const config: Record<string, unknown> = {
        project_doc_max_bytes: 0,
        web_search: response ? "live" : "disabled",
        mcp_servers: response ? Object.fromEntries(Object.entries(gateways).map(([name, server]) => [name, {
            // No upstream headers or destination URLs can reach Codex.
            url: server.url, enabled_tools: server.enabled_tools, tools: server.tools,
            required: true, enabled: true,
        }])) : {},
        "features.code_mode": { enabled: true, excluded_tool_namespaces: ["functions"] },
        "features.tool_registry": { error_on_tool_collisions: true, turn_metadata_includes_tool_info: true },
        "orchestrator.skills.enabled": false,
        "agents.enabled": false,
        "tools.experimental_request_user_input.enabled": false,
        "features.skip_host_skill_discovery": true,
    };
    // Environment absence removes local tools; these known controls are defense
    // in depth. Namespace exclusion is exposure control, NOT executable denial:
    // native MCP resource calls are stopped by the application-owned gateway.
    for (const feature of ["shell_tool", "unified_exec", "view_image", "multi_agent_v2", "apps", "plugins", "hooks", "js_repl", "image_generation", "memory_tool", "request_permissions_tool", "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "tool_suggest"])
        config[`features.${feature}`] = false;
    return config;
}

export function requireNoEnvironment(thread: Record<string, unknown>): void {
    const environments = (thread.thread as Record<string, unknown> | undefined)?.environments;
    if (!Array.isArray(environments) || environments.length !== 0)
        throw new Error("Codex did not apply the required no-environment policy.");
}
