export interface ParsedClaudeResponse {
    reactions: string[];
    text: string;
    historyContent: string;
}

function maskFencedCode(text: string): string {
    const lines = text.split(/(\r\n|\n|\r)/);
    let inFence = false;
    let fenceCharacter: "`" | "~" | undefined;
    let fenceLength = 0;

    return lines
        .map((line) => {
            if (line === "\r\n" || line === "\n" || line === "\r") {
                return line;
            }
            const opening = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
            const closing = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
            if (inFence) {
                if (
                    closing &&
                    closing[2][0] === fenceCharacter &&
                    closing[2].length >= fenceLength
                ) {
                    inFence = false;
                    fenceCharacter = undefined;
                    fenceLength = 0;
                }
                return " ".repeat(line.length);
            }
            if (
                opening &&
                (opening[2][0] === "~" || !opening[3].includes("`"))
            ) {
                inFence = true;
                fenceCharacter = opening[2][0] as "`" | "~";
                fenceLength = opening[2].length;
                return " ".repeat(line.length);
            }
            return line;
        })
        .join("");
}

export function parseClaudeResponse(response: string): ParsedClaudeResponse {
    const maskedResponse = maskFencedCode(response);
    const matches = [
        ...maskedResponse.matchAll(/\[REACT:(.+?)\]\s*/g),
    ];
    const reactions = matches
        .map((match) => match[1].trim())
        .filter((emoji) => emoji.length > 0);
    let text = response;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
        const match = matches[i];
        text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    }
    text = text.trim();
    return {
        reactions,
        text,
        historyContent: text || (reactions.length > 0
            ? `[reacted: ${reactions.join(", ")}]`
            : ""),
    };
}
