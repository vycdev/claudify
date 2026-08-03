export function parseAskCommand(content: string): string | null {
    const command = content.trim();
    if (!/^!ask(?:\s|$)/.test(command)) return null;

    return command.slice("!ask".length).trim();
}
