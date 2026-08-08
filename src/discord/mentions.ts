export function normalizeBotMentions(
    content: string,
    botUserId: string,
    botName: string,
): string {
    return content
        .replaceAll(`<@${botUserId}>`, () => botName)
        .replaceAll(`<@!${botUserId}>`, () => botName);
}

export function hasContentBesidesBotMentions(
    content: string,
    botUserId: string,
): boolean {
    return (
        content
            .replaceAll(`<@${botUserId}>`, "")
            .replaceAll(`<@!${botUserId}>`, "")
            .trim().length > 0
    );
}
