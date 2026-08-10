export interface ParsedClaudeResponse {
    reactions: string[];
    text: string;
    historyContent: string;
}

export function parseClaudeResponse(response: string): ParsedClaudeResponse {
    const reactions = [...response.matchAll(/\[REACT:(.+?)\]/g)].map((match) =>
        match[1].trim(),
    ).filter((emoji) => emoji.length > 0);
    const text = response.replace(/\[REACT:(.+?)\]\s*/g, "").trim();

    return {
        reactions,
        text,
        historyContent: text || (reactions.length > 0
            ? `[reacted: ${reactions.join(", ")}]`
            : ""),
    };
}
