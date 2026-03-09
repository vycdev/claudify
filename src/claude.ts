import { spawn } from "child_process";

export function runClaude(
    args: string[],
    input: string,
    model?: string,
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) env[key] = value;
        }
        delete env.MCP_SERVER_NAME;
        if (model) {
            env.ANTHROPIC_MODEL = model;
            args = ["--model", model, ...args];
        }

        console.error(
            `[Claude CLI] Spawning with model=${model || "default"}, ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL || "unset"}`,
        );
        const proc = spawn("claude", args, { env });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const err: any = new Error(
                    `Claude CLI exited with code ${code}`,
                );
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });

        proc.on("error", reject);

        proc.stdin.write(input);
        proc.stdin.end();

        setTimeout(() => {
            proc.kill();
            reject(new Error("Claude CLI timed out after 120 seconds"));
        }, 120000);
    });
}
