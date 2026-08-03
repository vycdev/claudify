export function normalizeBotMentions(
    content: string,
    botUserId: string,
    botName: string,
): string {
    return content
        .replaceAll(`<@${botUserId}>`, () => botName)
        .replaceAll(`<@!${botUserId}>`, () => botName);
}
