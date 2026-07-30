import fs from "node:fs";

const [, , group, action] = process.argv;
const markerPath = process.env.CLAUDIFY_AUTH_TEST_MARKER;

if (!markerPath || group !== "auth") {
    process.exit(2);
}

if (action === "status") {
    if (fs.existsSync(markerPath)) {
        process.stdout.write(
            JSON.stringify({
                loggedIn: true,
                authMethod: "claude.ai",
                apiProvider: "firstParty",
            }),
        );
        process.exit(0);
    }
    process.stdout.write(JSON.stringify({ loggedIn: false }));
    process.exit(1);
}

if (action === "login") {
    const loginUrl = "https://claude.com/cai/oauth/authorize?test=1";
    if (process.env.CLAUDIFY_AUTH_TEST_IGNORE_SIGTERM === "1") {
        process.on("SIGTERM", () => {});
        const pidPath = process.env.CLAUDIFY_AUTH_TEST_PID_PATH;
        if (pidPath) {
            fs.writeFileSync(pidPath, String(process.pid), "utf8");
        }
        setInterval(() => {}, 1_000);
    }
    process.stdout.write(
        `\u001b]8;;${loginUrl}\u0007${loginUrl}\u001b]8;;\u0007\n`,
    );
    if (process.env.CLAUDIFY_AUTH_TEST_CLOSE_STDIN === "1") {
        process.stdin.destroy();
        setTimeout(() => process.exit(1), 100);
    } else {
        process.stdin.setEncoding("utf8");
        let bufferedInput = "";
        process.stdin.on("data", (input) => {
            bufferedInput += input;
            const lines = bufferedInput.split(/\r?\n/);
            bufferedInput = lines.pop() || "";
            for (const line of lines) {
                const code = line.trim();
                if (!code) continue;
                if (process.env.CLAUDIFY_AUTH_TEST_IGNORE_SIGTERM === "1") {
                    continue;
                }
                if (code === "valid-code") {
                    fs.writeFileSync(markerPath, "authenticated", {
                        encoding: "utf8",
                        mode: 0o600,
                    });
                    setTimeout(() => process.exit(0), 50);
                    return;
                }
                process.stderr.write(
                    "Invalid code. Please make sure the full code was copied.\n",
                );
            }
        });
    }
}
