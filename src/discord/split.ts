interface FenceSpan {
    openingStart: number;
    contentStart: number;
    closingStart: number;
    closingEnd: number;
    marker: string;
    opener: string;
}

interface OpenFence {
    openingStart: number;
    contentStart: number;
    markerCharacter: "`" | "~";
    marker: string;
    opener: string;
}

function findFenceSpans(text: string): FenceSpan[] {
    const spans: FenceSpan[] = [];
    let openFence: OpenFence | undefined;
    let lineStart = 0;

    while (lineStart < text.length) {
        let contentEnd = lineStart;
        while (
            contentEnd < text.length &&
            text[contentEnd] !== "\n" &&
            text[contentEnd] !== "\r"
        ) {
            contentEnd++;
        }

        let nextLineStart = contentEnd;
        if (text[nextLineStart] === "\r" && text[nextLineStart + 1] === "\n") {
            nextLineStart += 2;
        } else if (
            text[nextLineStart] === "\r" ||
            text[nextLineStart] === "\n"
        ) {
            nextLineStart++;
        }

        const line = text.slice(lineStart, contentEnd);
        if (openFence) {
            const closingMatch = line.match(/^( {0,3})(`{3,}|~{3,})[\t ]*$/);
            if (
                closingMatch &&
                closingMatch[2][0] === openFence.markerCharacter &&
                closingMatch[2].length >= openFence.marker.length
            ) {
                spans.push({
                    openingStart: openFence.openingStart,
                    contentStart: openFence.contentStart,
                    closingStart: lineStart,
                    closingEnd: nextLineStart,
                    marker: openFence.marker,
                    opener: openFence.opener,
                });
                openFence = undefined;
            }
        } else {
            const openingMatch = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
            if (openingMatch) {
                const marker = openingMatch[2];
                const markerCharacter = marker[0] as "`" | "~";
                const info = openingMatch[3];

                // CommonMark does not allow backticks in the info string of a
                // backtick fence; treating such a line as text avoids false opens.
                if (markerCharacter === "~" || !info.includes("`")) {
                    openFence = {
                        openingStart: lineStart,
                        contentStart: nextLineStart,
                        markerCharacter,
                        marker,
                        opener: line,
                    };
                }
            }
        }

        if (nextLineStart === text.length) break;
        lineStart = nextLineStart;
    }

    if (openFence) {
        spans.push({
            openingStart: openFence.openingStart,
            contentStart: openFence.contentStart,
            closingStart: text.length,
            closingEnd: text.length,
            marker: openFence.marker,
            opener: openFence.opener,
        });
    }

    return spans;
}

function fenceAtPosition(
    spans: FenceSpan[],
    position: number,
): FenceSpan | undefined {
    return spans.find(
        (span) =>
            position >= span.contentStart && position <= span.closingStart,
    );
}

function isInsideFenceLine(spans: FenceSpan[], position: number): boolean {
    return spans.some(
        (span) =>
            (position > span.openingStart && position < span.contentStart) ||
            (position > span.closingStart && position < span.closingEnd),
    );
}

function splitsSurrogatePair(text: string, position: number): boolean {
    const precedingCodeUnit = text.charCodeAt(position - 1);
    const followingCodeUnit = text.charCodeAt(position);
    return (
        precedingCodeUnit >= 0xd800 &&
        precedingCodeUnit <= 0xdbff &&
        followingCodeUnit >= 0xdc00 &&
        followingCodeUnit <= 0xdfff
    );
}

function continuationOpener(fence: FenceSpan, maxLen: number): string {
    const minimumClosingLength = fence.marker.length + 1;
    return fence.opener.length + 1 + minimumClosingLength < maxLen
        ? fence.opener
        : fence.marker;
}

function closingSuffix(content: string, fence: FenceSpan | undefined): string {
    if (!fence) return "";
    return content.endsWith("\n") || content.endsWith("\r")
        ? fence.marker
        : `\n${fence.marker}`;
}

interface ChunkCandidate {
    splitAt: number;
    content: string;
    suffix: string;
}

function makeCandidate(
    text: string,
    offset: number,
    splitAt: number,
    spans: FenceSpan[],
): ChunkCandidate {
    const content = text.slice(offset, offset + splitAt);
    const endingFence = fenceAtPosition(spans, offset + splitAt);
    return {
        splitAt,
        content,
        suffix: closingSuffix(content, endingFence),
    };
}

function findLargestFittingCandidate(
    text: string,
    offset: number,
    prefix: string,
    maxLen: number,
    spans: FenceSpan[],
): ChunkCandidate | undefined {
    const remainingLength = text.length - offset;
    const largestSourceLength = Math.min(
        remainingLength,
        maxLen - prefix.length,
    );

    for (let splitAt = largestSourceLength; splitAt >= 1; splitAt--) {
        const absoluteSplit = offset + splitAt;
        if (
            isInsideFenceLine(spans, absoluteSplit) ||
            splitsSurrogatePair(text, absoluteSplit)
        ) {
            continue;
        }

        const candidate = makeCandidate(text, offset, splitAt, spans);
        if (
            prefix.length + candidate.content.length + candidate.suffix.length <=
            maxLen
        ) {
            return candidate;
        }
    }
    return undefined;
}

function findPreferredBoundary(
    text: string,
    offset: number,
    maxSourceLength: number,
    spans: FenceSpan[],
): number | undefined {
    const candidateEnd = offset + maxSourceLength;
    const endingFence = fenceAtPosition(spans, candidateEnd);
    if (endingFence && endingFence.openingStart > offset) {
        return endingFence.openingStart - offset;
    }

    const slice = text.slice(offset, candidateEnd);
    const paragraphBreaks = ["\r\n\r\n", "\n\n", "\r\r"];
    let paragraphEnd = -1;
    for (const separator of paragraphBreaks) {
        const index = slice.lastIndexOf(separator);
        if (index >= 0) paragraphEnd = Math.max(paragraphEnd, index + separator.length);
    }
    if (paragraphEnd > maxSourceLength * 0.3) return paragraphEnd;

    const lineBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("\r"));
    if (lineBreak > maxSourceLength * 0.3) return lineBreak + 1;

    const space = slice.lastIndexOf(" ");
    return space > maxSourceLength * 0.3 ? space + 1 : undefined;
}

// Split Discord messages at readable boundaries and balance CommonMark fenced
// code blocks that are too long to fit in one message.
export function smartSplit(text: string, maxLen: number = 2000): string[] {
    if (!Number.isSafeInteger(maxLen) || maxLen < 9) {
        throw new RangeError("maxLen must be an integer of at least 9");
    }
    if (text.length <= maxLen) return [text];

    const spans = findFenceSpans(text);
    const chunks: string[] = [];
    let offset = 0;

    while (offset < text.length) {
        const startingFence = fenceAtPosition(spans, offset);
        const prefix = startingFence
            ? `${continuationOpener(startingFence, maxLen)}\n`
            : "";
        let candidate = findLargestFittingCandidate(
            text,
            offset,
            prefix,
            maxLen,
            spans,
        );
        if (!candidate) {
            throw new RangeError(
                "maxLen is too small to balance this fenced code block",
            );
        }

        if (offset + candidate.splitAt < text.length) {
            const preferredSplit = findPreferredBoundary(
                text,
                offset,
                candidate.splitAt,
                spans,
            );
            if (preferredSplit && preferredSplit > 0) {
                const preferred = makeCandidate(
                    text,
                    offset,
                    preferredSplit,
                    spans,
                );
                if (
                    !isInsideFenceLine(spans, offset + preferredSplit) &&
                    !splitsSurrogatePair(text, offset + preferredSplit) &&
                    prefix.length +
                        preferred.content.length +
                        preferred.suffix.length <=
                        maxLen
                ) {
                    candidate = preferred;
                }
            }
        }

        chunks.push(`${prefix}${candidate.content}${candidate.suffix}`);
        offset += candidate.splitAt;
    }

    return chunks;
}
