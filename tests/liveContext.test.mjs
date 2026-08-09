import assert from "node:assert/strict";
import test from "node:test";

import { formatLiveMessagesContext } from "../build/discord/handler.js";

function message(id, content, timestamp) {
    return {
        id,
        createdAt: new Date(timestamp),
        author: {
            id: `user-${id}`,
            displayName: `User ${id}`,
            globalName: null,
            username: `user-${id}`,
        },
        content,
        attachments: { size: 0 },
        embeds: [],
    };
}

test("bounds live context while retaining the newest messages", () => {
    const context = formatLiveMessagesContext(
        [
            message("old", "oldest live message", "2026-08-09T10:00:00.000Z"),
            message("middle", "middle live message", "2026-08-09T10:01:00.000Z"),
            message("new", "newest live message", "2026-08-09T10:02:00.000Z"),
        ],
        3,
        190,
    );

    assert.ok(context.length <= 190);
    assert.doesNotMatch(context, /oldest live message/);
    assert.match(context, /newest live message/);
    assert.match(context, /omitted_oldest=2/);
});
