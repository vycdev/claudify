import assert from "node:assert/strict";
import test from "node:test";

import {
    fetchReplyChain,
    formatLiveMessagesContext,
    selectLiveContextLimit,
} from "../build/discord/handler.js";

function message(id, content, timestamp) {
    return {
        id,
        createdAt: new Date(timestamp),
        author: {
            id: `user-${id}`,
            bot: false,
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
        340,
    );

    assert.ok(context.length <= 340);
    assert.doesNotMatch(context, /oldest live message/);
    assert.match(context, /newest live message/);
    assert.match(
        context,
        /message_id=new; author_id=user-new; author_bot=false; created_at=2026-08-09T10:02:00.000Z/,
    );
    assert.match(context, /omitted_oldest=2/);
});

test("formats each live message only once while applying the budget", () => {
    let contentReads = 0;
    const messages = Array.from({ length: 500 }, (_, index) => {
        const value = message(
            String(index),
            "",
            new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        );
        Object.defineProperty(value, "content", {
            get() {
                contentReads++;
                return "x".repeat(2_000);
            },
        });
        return value;
    });

    const context = formatLiveMessagesContext(messages, 500, 140_000);

    assert.ok(context.length <= 140_000);
    assert.equal(contentReads, messages.length);
});

test("excludes messages already represented by the active turn", () => {
    const context = formatLiveMessagesContext(
        [
            message("reply", "explicit reply target", "2026-08-09T10:00:00.000Z"),
            message("background", "useful background", "2026-08-09T10:01:00.000Z"),
            message("current", "current turn", "2026-08-09T10:02:00.000Z"),
        ],
        3,
        1000,
        new Set(["reply", "current"]),
    );

    assert.match(context, /useful background/);
    assert.doesNotMatch(context, /explicit reply target/);
    assert.doesNotMatch(context, /current turn/);
    assert.match(context, /excluded_explicit_turn=2/);
});

test("reply chains are ordered oldest-to-direct and stop at the configured depth", async () => {
    const oldest = { ...message("oldest", "original topic", "2026-08-09T10:00:00.000Z"), reference: null };
    const middle = { ...message("middle", "first follow-up", "2026-08-09T10:01:00.000Z"), reference: { messageId: "oldest" } };
    const direct = { ...message("direct", "latest answer", "2026-08-09T10:02:00.000Z"), reference: { messageId: "middle" } };
    const byId = new Map([["oldest", oldest], ["middle", middle], ["direct", direct]]);
    const channel = {
        messages: {
            fetch: async (id) => {
                const found = byId.get(id);
                if (!found) throw new Error("not found");
                return found;
            },
        },
    };

    assert.deepEqual(
        (await fetchReplyChain(channel, "direct", 5)).map((item) => item.id),
        ["oldest", "middle", "direct"],
    );
    assert.deepEqual(
        (await fetchReplyChain(channel, "direct", 2)).map((item) => item.id),
        ["middle", "direct"],
    );
});

test("reply requests use a smaller flat slice unless they explicitly request a recap", () => {
    assert.equal(selectLiveContextLimit("try again", false), 35);
    assert.equal(selectLiveContextLimit("try again", true), 15);
    assert.equal(selectLiveContextLimit("give me a recap", true), 500);
});
