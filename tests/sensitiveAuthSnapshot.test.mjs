import assert from "node:assert/strict";
import test from "node:test";
import { Attachment, Collection, Embed, Message } from "discord.js";
import { snapshotConversationMessage } from "../build/sensitiveAuth.js";

function fixture() {
    // Real Discord data classes and a circular service graph; no client login.
    const client = {};
    const channel = { id: "channel", client };
    const guild = { id: "guild", client };
    client.channel = channel;
    const message = Object.create(Message.prototype);
    Object.defineProperties(message, {
        client: { value: client, configurable: true },
        channel: { value: channel, configurable: true },
        guild: { value: guild, configurable: true },
    });
    Object.assign(message, {
        id: "123456789123456789", channelId: channel.id, guildId: guild.id,
        createdTimestamp: Date.parse("2026-09-10T00:00:00Z"),
        content: "!authentic ordinary content", author: { id: "user", username: "User", bot: false },
        embeds: [new Embed({ title: "ordinary title", fields: [{ name: "field", value: "ordinary value" }],
            footer: { text: "ordinary footer" }, image: { url: "https://example.invalid/ordinary.png" } })],
        attachments: new Collection([["image", new Attachment({ id: "image", filename: "ordinary.png", size: 42,
            content_type: "image/png", description: "ordinary description", url: "https://example.invalid/ordinary.png" })]]),
        reference: { messageId: "older", channelId: "channel", guildId: "guild", type: 0 },
    });
    return message;
}

test("snapshot classifies content once and rejects before reading sensitive data", () => {
    const message = { get content() { reads++; return " \t!CoDeX auth login SYNTHETIC_SECRET"; },
        get attachments() { throw new Error("must not read sensitive attachments"); },
        get embeds() { throw new Error("must not read sensitive embeds"); } };
    let reads = 0;
    assert.equal(snapshotConversationMessage(message), undefined);
    assert.equal(reads, 1);
    const ordinary = fixture();
    Object.defineProperty(ordinary, "content", { get() { reads++; return "ordinary content"; } });
    reads = 0;
    const snapshot = snapshotConversationMessage(ordinary);
    assert.equal(reads, 1);
    assert.equal(snapshot.content, "ordinary content");
    assert.equal(snapshot.content, "ordinary content");
    assert.equal(reads, 1);
});

test("snapshot owns deep embed data, attachment entries/collection and reference", () => {
    const original = fixture();
    const snapshot = snapshotConversationMessage(original);
    assert.ok(snapshot instanceof Message);
    assert.ok(snapshot.embeds[0] instanceof Embed);
    assert.ok(snapshot.attachments instanceof Collection);
    assert.ok(snapshot.attachments.get("image") instanceof Attachment);
    original.content = "!auth code SYNTHETIC_SECRET";
    original.embeds[0].data.fields[0].value = "SYNTHETIC_FIELD";
    original.embeds[0].data.footer.text = "SYNTHETIC_FOOTER";
    original.embeds[0].data.image.url = "https://example.invalid/SYNTHETIC_IMAGE";
    original.attachments.get("image").url = "https://example.invalid/SYNTHETIC_ATTACHMENT";
    original.attachments.get("image").description = "SYNTHETIC_DESCRIPTION";
    original.attachments.clear();
    original.reference.messageId = "SYNTHETIC_REFERENCE";
    original.reference = null;
    original.embeds = [];
    original.attachments = new Collection();
    assert.equal(snapshot.content, "!authentic ordinary content");
    assert.equal(snapshot.embeds[0].fields[0].value, "ordinary value");
    assert.equal(snapshot.embeds[0].footer.text, "ordinary footer");
    assert.equal(snapshot.embeds[0].image.url, "https://example.invalid/ordinary.png");
    assert.equal(snapshot.attachments.get("image").url, "https://example.invalid/ordinary.png");
    assert.equal(snapshot.attachments.get("image").description, "ordinary description");
    assert.equal(snapshot.reference.messageId, "older");
    assert.doesNotMatch(JSON.stringify({ content: snapshot.content, embeds: snapshot.embeds,
        attachments: [...snapshot.attachments.values()], reference: snapshot.reference }), /SYNTHETIC_/);
});

test("snapshot preserves Discord response methods and service references without cloning the graph", () => {
    const original = fixture();
    const snapshot = snapshotConversationMessage(original);
    assert.equal(snapshot.reply, original.reply);
    assert.equal(snapshot.react, original.react);
    assert.equal(snapshot.client, original.client);
    assert.equal(snapshot.guild, original.guild);
    assert.equal(snapshot.channel, original.channel);
    assert.equal(snapshot.author, original.author);
    assert.equal(snapshot.id, original.id);
    assert.equal(snapshot.createdAt.toISOString(), original.createdAt.toISOString());
    assert.equal(snapshot.createdTimestamp, original.createdTimestamp);
});

test("snapshot includes ordinary edits made before processing starts", () => {
    const original = fixture();
    original.content = "ordinary edited content";
    original.embeds[0].data.footer.text = "edited footer";
    original.attachments.get("image").description = "edited description";
    original.reference.messageId = "edited-reference";
    const snapshot = snapshotConversationMessage(original);
    assert.equal(snapshot.content, "ordinary edited content");
    assert.equal(snapshot.embeds[0].footer.text, "edited footer");
    assert.equal(snapshot.attachments.get("image").description, "edited description");
    assert.equal(snapshot.reference.messageId, "edited-reference");
});
