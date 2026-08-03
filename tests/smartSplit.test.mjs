import assert from "node:assert/strict";
import test from "node:test";

import { smartSplit } from "../build/discord/split.js";

function assertBalancedFences(text) {
    let openFence;
    for (const line of text.split(/\r\n|\n|\r/)) {
        if (openFence) {
            const closingMatch = line.match(/^( {0,3})(`{3,}|~{3,})[\t ]*$/);
            if (
                closingMatch &&
                closingMatch[2][0] === openFence.character &&
                closingMatch[2].length >= openFence.length
            ) {
                openFence = undefined;
            }
            continue;
        }

        const openingMatch = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
        if (!openingMatch) continue;
        const marker = openingMatch[2];
        if (marker[0] === "`" && openingMatch[3].includes("`")) continue;
        openFence = { character: marker[0], length: marker.length };
    }
    assert.equal(openFence, undefined, `unclosed fence in ${JSON.stringify(text)}`);
}

test("leaves messages that fit the Discord limit unchanged", () => {
    const text = "Short response with `inline code`.";
    assert.deepEqual(smartSplit(text, 40), [text]);
});

test("balances fenced code blocks across split messages", () => {
    const code = "x".repeat(220);
    const text = `Intro\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nOutro`;
    const chunks = smartSplit(text, 80);

    assert.ok(chunks.length > 2);
    assert.ok(chunks.every((chunk) => chunk.length <= 80));
    chunks.forEach(assertBalancedFences);
    assert.equal(
        chunks.reduce(
            (count, chunk) => count + (chunk.match(/x/g)?.length ?? 0),
            0,
        ),
        code.length,
    );
    assert.equal(chunks[0], "Intro\n\n");
    assert.match(chunks.at(-1), /Outro$/);
});

test("preserves code content when splitting at line boundaries", () => {
    const lines = Array.from(
        { length: 12 },
        (_, index) => `    const value${index} = ${index};`,
    );
    const text = `\`\`\`js\n${lines.join("\n")}\n\`\`\``;
    const chunks = smartSplit(text, 72);

    assert.ok(chunks.every((chunk) => chunk.length <= 72));
    chunks.forEach(assertBalancedFences);
    for (const line of lines) {
        assert.ok(chunks.some((chunk) => chunk.includes(line)));
    }
});

test("ignores backticks inside fenced code content", () => {
    const text = `\`\`\`js\nvalue = "\`\`\`";\n${"x".repeat(100)}\n\`\`\``;
    const chunks = smartSplit(text, 48);

    assert.ok(chunks.every((chunk) => chunk.length <= 48));
    chunks.forEach(assertBalancedFences);
    assert.ok(chunks.some((chunk) => chunk.includes('value = "```";')));
});

test("balances longer backtick and tilde fences", () => {
    for (const marker of ["````", "~~~"]) {
        const text = `${marker}js\n${"x".repeat(100)}\n${marker}`;
        const chunks = smartSplit(text, 40);

        assert.ok(chunks.every((chunk) => chunk.length <= 40));
        chunks.forEach(assertBalancedFences);
        assert.ok(chunks.every((chunk) => !/^`$/.test(chunk)));
    }
});

test("preserves trailing whitespace in fenced code", () => {
    const text = `\`\`\`js\nline with trailing   \n${"x".repeat(100)}\n\`\`\``;
    const chunks = smartSplit(text, 40);

    chunks.forEach(assertBalancedFences);
    assert.ok(chunks.some((chunk) => chunk.includes("line with trailing   \n")));
});

test("rejects limits too small to balance a continuation fence", () => {
    assert.throws(
        () => smartSplit("````\na\n````", 9),
        /too small to balance/,
    );
});

test("never exceeds the requested limit when fence suffixes change", () => {
    const text =
        "```js\n```\n```\n ~~~ js\n\n\nxxxxx\n~~~\na```ba```ba```b   ```   \n```";
    const chunks = smartSplit(text, 41);

    assert.ok(chunks.every((chunk) => chunk.length <= 41));
});

test("balances fences that use bare carriage-return line endings", () => {
    const text = `\`\`\`js\r${"x".repeat(100)}\r\`\`\``;
    const chunks = smartSplit(text, 40);

    assert.ok(chunks.every((chunk) => chunk.length <= 40));
    chunks.forEach(assertBalancedFences);
});
