import assert from "node:assert/strict";
import test from "node:test";

import { buildReactionQuestion } from "../build/discord/handler.js";

function makeMessage({ content = "", attachments = [], embeds = [] } = {}) {
    return {
        content,
        attachments: new Map(attachments.map((attachment) => [attachment.id, attachment])),
        embeds,
    };
}

test("includes embed content in reaction-triggered questions", () => {
    const message = makeMessage({
        embeds: [{
            title: "Release",
            description: "Version 2 is live",
            fields: [{ name: "Status", value: "Stable" }],
        }],
    });

    assert.equal(
        buildReactionQuestion("Alice", "Bob", message),
        "[Alice said this, and Bob wants you to respond to it]: [Embed: Release: Version 2 is live: Status: Stable]",
    );
});

test("preserves text and attachment context in reaction-triggered questions", () => {
    const message = makeMessage({
        content: "Please review",
        attachments: [{ id: "attachment-1" }],
    });

    assert.equal(
        buildReactionQuestion("Alice", "Bob", message),
        "[Alice said this, and Bob wants you to respond to it]: Please review [1 attachment(s)]",
    );
});

test("includes URL-only embeds in reaction-triggered questions", () => {
    const message = makeMessage({
        embeds: [{ url: "https://example.com/release" }],
    });

    assert.equal(
        buildReactionQuestion("Alice", "Bob", message),
        "[Alice said this, and Bob wants you to respond to it]: [Embed: https://example.com/release]",
    );
});
