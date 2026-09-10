import assert from "node:assert/strict";
import test from "node:test";
import { fetchReplyChain, formatLiveMessagesContext } from "../build/discord/handler.js";
import { isSensitiveAuthMessage } from "../build/sensitiveAuth.js";

const sensitive = [
    "!codex", "!codex auth login SYNTHETIC_SECRET", " \t!CoDeX\nunknown SYNTHETIC_SECRET",
    "!codex usage SYNTHETIC_SECRET", "!auth", "!AUTH\tcode SYNTHETIC_SECRET",
];
const ordinary = ["!authentic", "!codexish", "!auth-code", "!codex_auth", "discuss !auth help", "hello"];

function message(id, content, reference) {
    return {
        id, content, reference,
        createdAt: new Date("2026-09-10T00:00:00Z"),
        author: { id: "user", bot: false, username: "user" },
        attachments: new Map([["attachment", {
            id: "attachment", name: "SYNTHETIC_ATTACHMENT.png",
            url: "https://example.invalid/SYNTHETIC_ATTACHMENT.png", contentType: "image/png",
        }]]),
        embeds: [{ title: "SYNTHETIC_EMBED", description: "SYNTHETIC_SECRET" }],
    };
}

for (const content of sensitive) {
    test(`live context excludes the whole sensitive message: ${JSON.stringify(content)}`, () => {
        assert.equal(formatLiveMessagesContext([message("secret", content)], 35, 10000), "");
        const normal = { ...message("normal", "ordinary conversation"), attachments: new Map(), embeds: [] };
        const context = formatLiveMessagesContext([message("secret", content), normal], 35, 10000);
        assert.match(context, /ordinary conversation/);
        assert.doesNotMatch(context, /SYNTHETIC_|message_id=secret|attachment\(s\)/);
    });
}
for (const content of sensitive) {
    test(`reply chain stops at sensitive boundary: ${JSON.stringify(content)}`, async () => {
        const secret = message("secret", content, { messageId: "older" });
        const direct = message("direct", "ordinary follow-up", { messageId: "secret" });
        const older = message("older", "unrelated older conversation");
        const byId = new Map([secret, direct, older].map((msg) => [msg.id, msg]));
        const fetched = [];
        const channel = { messages: { fetch: async (id) => { fetched.push(id); return byId.get(id); } } };
        assert.deepEqual(await fetchReplyChain(channel, "secret"), []);
        assert.deepEqual(fetched, ["secret"]);
        fetched.length = 0;
        const [snapshot] = await fetchReplyChain(channel, "direct");
        assert.notEqual(snapshot, direct);
        assert.equal(snapshot.id, direct.id);
        assert.equal(snapshot.content, direct.content);
        assert.deepEqual(snapshot.reference, direct.reference);
        assert.deepEqual(fetched, ["direct", "secret"]);
    });
}

test("shared predicate uses complete, case-insensitive command tokens", () => {
    for (const content of sensitive) assert.equal(isSensitiveAuthMessage(content), true, content);
    for (const content of [...ordinary, "", "!auth: code", "!codex-login", "!auth😀"])
        assert.equal(isSensitiveAuthMessage(content), false, content);
});

for (const content of ordinary) {
    test(`live context preserves ordinary command boundaries: ${content}`, () => {
        const context = formatLiveMessagesContext([message("normal", content)], 35, 10000);
        assert.ok(context.includes(content));
        assert.match(context, /1 attachment\(s\).*SYNTHETIC_EMBED/);
    });
}
