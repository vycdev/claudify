import type { CodexClient } from "./codexClient.js";
import { requireCodexSubscription } from "./codex.js";

export type CodexAuthStatus = "subscription" | "signed-out" | "unsupported";
type Notify = (message: string) => void | Promise<void>;
interface LoginSession {
    owner: string;
    client?: CodexClient;
    loginId?: string;
    timer?: NodeJS.Timeout;
    unsubscribe?: () => void;
    earlyCompletion?: Record<string, unknown>;
    completing: boolean;
    notify: Notify;
}
export interface CodexAuthOptions {
    clientFactory: () => Promise<CodexClient>;
    loginTimeoutMs: number;
}
export class CodexAuthManager {
    private session?: LoginSession;
    private loggingOut = false;
    constructor(private readonly options: CodexAuthOptions) {}

    async getStatus(): Promise<CodexAuthStatus> {
        const client = await this.options.clientFactory();
        try {
            const { account } = await client.request("account/read", {
                refreshToken: false,
            });
            if (account === null) return "signed-out";
            return account &&
                typeof account === "object" &&
                "type" in account &&
                account.type === "chatgpt"
                ? "subscription"
                : "unsupported";
        } finally {
            client.close();
        }
    }

    async getUsage(): Promise<string> {
        const client = await this.options.clientFactory();
        try {
            await requireCodexSubscription(client);
            const data = await client.request("account/rateLimits/read");
            const limits =
                data.rateLimits && typeof data.rateLimits === "object"
                    ? (data.rateLimits as Record<string, unknown>)
                    : {};
            const lines = ["Codex subscription allowance reported by OpenAI:"];
            for (const key of ["primary", "secondary"]) {
                const raw = limits[key];
                if (!raw || typeof raw !== "object") continue;
                const window = raw as Record<string, unknown>;
                const used = window.usedPercent;
                if (
                    typeof used !== "number" ||
                    !Number.isFinite(used) ||
                    used < 0 ||
                    used > 100
                )
                    continue;
                const minutes = window.windowDurationMins;
                const label =
                    typeof minutes === "number" &&
                    Number.isSafeInteger(minutes) &&
                    minutes > 0
                        ? `${minutes}-minute window`
                        : key;
                const reset = window.resetsAt;
                const resetText =
                    typeof reset === "number" &&
                    Number.isSafeInteger(reset) &&
                    reset > 0 &&
                    reset < 100_000_000_000
                        ? `, resets <t:${reset}:R>`
                        : "";
                lines.push(
                    `${label}: ${Math.round(100 - used)}% remaining${resetText}`,
                );
            }
            return lines.length > 1
                ? lines.join("\n")
                : "OpenAI did not report subscription allowance windows. Check the Codex usage dashboard; local tokens are not remaining quota.";
        } finally {
            client.close();
        }
    }

    private finish(session: LoginSession, message?: string): void {
        if (this.session !== session) return;
        this.session = undefined;
        if (session.timer) clearTimeout(session.timer);
        session.unsubscribe?.();
        session.client?.close();
        if (message)
            void Promise.resolve()
                .then(() => session.notify(message))
                .catch(() => {});
    }

    private async completed(
        session: LoginSession,
        params: Record<string, unknown>,
    ): Promise<void> {
        if (this.session !== session || session.completing) return;
        if (!session.loginId) {
            session.earlyCompletion = params;
            return;
        }
        if (params.loginId !== session.loginId) return;
        session.completing = true;
        try {
            if (params.success !== true || !session.client)
                throw new Error("Login failed.");
            await requireCodexSubscription(session.client);
            this.finish(
                session,
                "Codex is authenticated with a ChatGPT subscription. The credentials stay on the bot host.",
            );
        } catch {
            this.finish(
                session,
                "Codex login was not completed with a ChatGPT subscription. Retry !codex auth login. No API-key fallback was used.",
            );
        }
    }

    async startLogin(
        owner: string,
        notify: Notify,
    ): Promise<{
        verificationUrl: string;
        userCode: string;
        cancelDelivery: () => Promise<void>;
    }> {
        if (this.session || this.loggingOut)
            throw new Error(
                "A Codex authentication operation is already active.",
            );
        const session: LoginSession = { owner, notify, completing: false };
        this.session = session;
        session.timer = setTimeout(() => {
            this.finish(
                session,
                "Codex login expired. Start a new login if needed.",
            );
        }, this.options.loginTimeoutMs);
        try {
            const client = await this.options.clientFactory();
            if (this.session !== session) {
                client.close();
                throw new Error("Codex login expired or was cancelled.");
            }
            session.client = client;
            session.unsubscribe = client.onNotification((method, params) => {
                if (method === "account/login/completed")
                    void this.completed(session, params);
                if (method === "$closed")
                    this.finish(
                        session,
                        "Codex login connection ended. Check status or start a new login.",
                    );
            });
            const login = await client.request("account/login/start", {
                type: "chatgptDeviceCode",
            });
            if (this.session !== session)
                throw new Error("Codex login expired or was cancelled.");
            const url = new URL(
                typeof login.verificationUrl === "string"
                    ? login.verificationUrl
                    : "invalid",
            );
            if (
                login.type !== "chatgptDeviceCode" ||
                typeof login.loginId !== "string" ||
                !login.loginId ||
                url.origin !== "https://auth.openai.com" ||
                !/^\/codex\/device\/?$/.test(url.pathname) ||
                url.search ||
                url.hash ||
                url.username ||
                url.password ||
                typeof login.userCode !== "string" ||
                !/^[A-Z0-9-]{4,32}$/.test(login.userCode)
            )
                throw new Error("Unexpected device-login response.");
            session.loginId = login.loginId;
            if (session.earlyCompletion)
                void this.completed(session, session.earlyCompletion);
            return {
                verificationUrl: url.toString(),
                userCode: login.userCode,
                // Bind failed-delivery cleanup to this session, not its owner.
                cancelDelivery: async () => {
                    await this.cancelSession(session);
                },
            };
        } catch {
            this.finish(session);
            throw new Error(
                "Could not start Codex device login. Check the CLI installation and enable device-code authentication in ChatGPT security settings, then retry.",
            );
        }
    }

    async cancelLogin(owner: string): Promise<"canceled" | "not-pending"> {
        const session = this.session;
        if (!session) return "not-pending";
        if (session.owner !== owner)
            throw new Error("Only the login owner may cancel this session.");
        return this.cancelSession(session);
    }

    private async cancelSession(
        session: LoginSession,
    ): Promise<"canceled" | "not-pending"> {
        if (this.session !== session) return "not-pending";
        try {
            if (session.loginId && session.client) {
                const result = await session.client.request(
                    "account/login/cancel",
                    {
                        loginId: session.loginId,
                    },
                );
                if (result.status === "notFound" || this.session !== session)
                    return "not-pending";
                if (result.status !== "canceled")
                    throw new Error(
                        "Codex cancellation could not be verified.",
                    );
            }
            return "canceled";
        } finally {
            this.finish(session);
        }
    }

    async logout(owner: string): Promise<void> {
        if (this.loggingOut)
            throw new Error("Codex logout is already in progress.");
        this.loggingOut = true;
        let client: CodexClient | undefined;
        try {
            if (this.session) await this.cancelLogin(owner);
            client = await this.options.clientFactory();
            await client.request("account/logout");
            const result = await client.request("account/read", {
                refreshToken: false,
            });
            if (result.account !== null)
                throw new Error("Codex logout could not be verified.");
        } finally {
            client?.close();
            this.loggingOut = false;
        }
    }
}
