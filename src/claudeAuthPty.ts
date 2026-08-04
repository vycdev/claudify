import { spawn as spawnPty } from "node-pty";

const [, , command, ...args] = process.argv;

if (!command) {
    process.stderr.write("Claude authentication PTY helper needs a command.\n");
    process.exit(2);
}

let terminal;
try {
    terminal = spawnPty(command, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
    });
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not start the Claude CLI: ${detail}\n`);
    process.exit(1);
}

let exiting = false;

terminal.onData((data) => {
    process.stdout.write(data);
});

terminal.onExit(({ exitCode }) => {
    if (exiting) return;
    exiting = true;
    process.exitCode = exitCode;
    // node-pty can retain native terminal handles after the child exits on
    // Windows. This helper is intentionally disposable, so end it explicitly.
    setTimeout(() => process.exit(exitCode), 25);
});

process.stdin.on("data", (data: Buffer) => {
    terminal.write(data);
});

const stopTerminal = () => {
    if (exiting) return;
    exiting = true;
    try {
        terminal.kill();
    } finally {
        setTimeout(() => process.exit(1), 250);
    }
};

process.stdin.on("end", stopTerminal);
process.on("SIGINT", stopTerminal);
process.on("SIGTERM", stopTerminal);
