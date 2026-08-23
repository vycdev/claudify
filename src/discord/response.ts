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

interface InlineCodeSpan {
    start: number;
    end: number;
}

function findInlineCodeSpans(text: string): InlineCodeSpan[] {
    const spans: InlineCodeSpan[] = [];
    let index = 0;

    while (index < text.length) {
        if (text[index] !== "`") {
            index++;
            continue;
        }

        let markerEnd = index + 1;
        while (text[markerEnd] === "`") markerEnd++;
        const marker = text.slice(index, markerEnd);
        const lineBreakOffset = text.slice(markerEnd).search(/[\r\n]/);
        const lineEnd =
            lineBreakOffset === -1 ? text.length : markerEnd + lineBreakOffset;
        const closingStart = text.indexOf(marker, markerEnd);
        if (closingStart === -1 || closingStart >= lineEnd) {
            index = markerEnd;
            continue;
        }

        spans.push({
            start: index,
            end: closingStart + marker.length,
        });
        index = closingStart + marker.length;
    }

    return spans;
}

function maskInlineCode(text: string): string {
    let masked = text;
    for (const span of findInlineCodeSpans(text).reverse()) {
        masked =
            masked.slice(0, span.start) +
            " ".repeat(span.end - span.start) +
            masked.slice(span.end);
    }
    return masked;
}

export function parseClaudeResponse(response: string): ParsedClaudeResponse {
    const maskedResponse = maskInlineCode(maskFencedCode(response));
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
