export interface ParsedClaudeResponse {
    reactions: string[];
    text: string;
    historyContent: string;
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

function isInsideInlineCode(spans: InlineCodeSpan[], index: number): boolean {
    return spans.some((span) => index >= span.start && index < span.end);
}

export function parseClaudeResponse(response: string): ParsedClaudeResponse {
    const inlineCodeSpans = findInlineCodeSpans(response);
    const reactions: string[] = [];
    const removals: { start: number; end: number }[] = [];

    for (const match of response.matchAll(/\[REACT:(.+?)\]\s*/g)) {
        const start = match.index ?? 0;
        if (isInsideInlineCode(inlineCodeSpans, start)) continue;
        reactions.push(match[1].trim());
        removals.push({ start, end: start + match[0].length });
    }

    let text = response;
    for (const removal of removals.reverse()) {
        text = text.slice(0, removal.start) + text.slice(removal.end);
    }
    text = text.trim();

    return {
        reactions,
        text,
        historyContent: text || `[reacted: ${reactions.join(", ")}]`,
    };
}
