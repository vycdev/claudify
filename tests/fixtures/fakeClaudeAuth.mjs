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
    process.stdout.write(
        "\u001b[36mOpen https://claude.ai/oauth/authorize?test=1\u001b[0m\n",
    );
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (input) => {
        if (input.trim().startsWith("valid-code")) {
            fs.writeFileSync(markerPath, "authenticated", {
                encoding: "utf8",
                mode: 0o600,
            });
            process.exit(0);
        }
        process.exit(1);
    });
}
