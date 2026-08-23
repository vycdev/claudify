import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP history filters matching regular files and preserves pending indentation", async (t) => {
    const messagesDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "claudify-mcp-history-"),
    );
    t.after(() => fs.rmSync(messagesDir, { recursive: true, force: true }));
    process.env.MESSAGES_DIR = messagesDir;

    const [
        { Client },
        { InMemoryTransport },
        { createMcpServer },
        { savePending },
    ] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/inMemory.js"),
        import("../build/mcp/server.js"),
        import("../build/storage/pending.js"),
    ]);

    const historyDir = path.join(messagesDir, "history");
    fs.writeFileSync(
        path.join(historyDir, "general_2026-08-01.txt"),
        "[10:00:00] user: expected entry\n" +
            "[10:15:00] user: ordered a café\n",
        "utf8",
    );
    fs.writeFileSync(
        path.join(historyDir, "general_chat_2026-08-01.txt"),
        "[10:30:00] user: similarly named channel entry\n",
        "utf8",
    );
    fs.writeFileSync(
        path.join(historyDir, "release_2026-08-01_2026-08-02.txt"),
        "[11:00:00] user: wrong-day entry\n",
        "utf8",
    );
    const historyV2Dir = path.join(historyDir, "v2");
    fs.mkdirSync(historyV2Dir, { recursive: true });
    fs.writeFileSync(
        path.join(
            historyV2Dir,
            "v2_111111111111111111__general_2026-08-01.txt",
        ),
        "[12:00:00] user: namespaced entry\n",
        "utf8",
    );
    const outsideFile = path.join(
        os.tmpdir(),
        `claudify-history-secret-${process.pid}-${Date.now()}.txt`,
    );
    t.after(() => fs.rmSync(outsideFile, { force: true }));
    fs.writeFileSync(outsideFile, "symlinked secret\n", "utf8");
    fs.symlinkSync(
        outsideFile,
        path.join(historyDir, "linked_2026-08-01.txt"),
    );
    fs.mkdirSync(path.join(historyDir, "directory_2026-08-01.txt"));
    fs.symlinkSync(
        outsideFile,
        path.join(
            historyV2Dir,
            "v2_222222222222222222__linked_2026-08-01.txt",
        ),
    );
    fs.mkdirSync(
        path.join(
            historyV2Dir,
            "v2_333333333333333333__directory_2026-08-01.txt",
        ),
    );
    const pendingDir = path.join(messagesDir, "pending");
    fs.writeFileSync(
        path.join(pendingDir, "regular.txt"),
        "ordinary pending entry\n",
        "utf8",
    );
    fs.symlinkSync(outsideFile, path.join(pendingDir, "linked.txt"));
    fs.mkdirSync(path.join(pendingDir, "directory.txt"));

    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "history-test", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await server.close();
    });

    const result = await client.callTool({
        name: "read-message-history",
        arguments: { date: "2026-08-01" },
    });
    const text = result.content.find((item) => item.type === "text")?.text;

    assert.equal(typeof text, "string");
    assert.match(text, /general_2026-08-01\.txt/);
    assert.match(text, /expected entry/);
    assert.match(
        text,
        /v2\/v2_111111111111111111__general_2026-08-01\.txt/,
    );
    assert.match(text, /namespaced entry/);
    assert.doesNotMatch(text, /release_2026-08-01_2026-08-02\.txt/);
    assert.doesNotMatch(text, /wrong-day entry/);
    assert.doesNotMatch(text, /linked_2026-08-01\.txt/);
    assert.doesNotMatch(text, /directory_2026-08-01\.txt/);
    assert.doesNotMatch(text, /symlinked secret/);

    const pendingResult = await client.callTool({
        name: "read-message-history",
        arguments: { type: "pending" },
    });
    const pendingText = pendingResult.content.find(
        (item) => item.type === "text",
    )?.text;

    assert.equal(typeof pendingText, "string");
    assert.match(pendingText, /regular\.txt/);
    assert.match(pendingText, /ordinary pending entry/);
    assert.doesNotMatch(pendingText, /linked\.txt/);
    assert.doesNotMatch(pendingText, /directory\.txt/);
    assert.doesNotMatch(pendingText, /symlinked secret/);

    savePending({
        id: "222222222222222222",
        author: { tag: "user#0001" },
        channel: { name: "general" },
        channelId: "111111111111111111",
        createdAt: new Date("2026-08-01T12:30:00.000Z"),
        content: "pending entry\nExample:\n    const answer = 42;",
    });
    savePending({
        id: "444444444444444444",
        author: { tag: "user#0002" },
        channel: { name: "random" },
        channelId: "999999999999999999",
        createdAt: new Date("2026-08-01T12:45:00.000Z"),
        content: "other-channel pending entry",
    });
    savePending({
        id: "555555555555555555",
        author: { tag: "user#0003" },
        channel: { name: "general" },
        channelId: "111111111111111111",
        createdAt: new Date("2026-08-02T00:15:00.000Z"),
        content: "next-day pending entry",
    });
    fs.writeFileSync(
        path.join(messagesDir, "pending", "333333333333333333.txt"),
        [
            "Author: legacy#0001",
            "Channel: #general",
            "Timestamp: 2026-08-01T12:15:00.000Z",
            "---",
            "Channel ID: 111111111111111111",
            "legacy pending entry",
        ].join("\n"),
        "utf8",
    );

    const pendingDateResult = await client.callTool({
        name: "read-message-history",
        arguments: { type: "pending", date: "2026-08-01" },
    });
    const pendingDateText = pendingDateResult.content.find(
        (item) => item.type === "text",
    )?.text;

    assert.equal(typeof pendingDateText, "string");
    assert.match(pendingDateText, /222222222222222222\.txt/);
    assert.match(pendingDateText, /333333333333333333\.txt/);
    assert.match(pendingDateText, /444444444444444444\.txt/);
    assert.doesNotMatch(pendingDateText, /regular\.txt/);
    assert.doesNotMatch(pendingDateText, /555555555555555555\.txt/);
    assert.doesNotMatch(pendingDateText, /next-day pending entry/);

    for (const channel of ["general", "111111111111111111"]) {
        const pendingResult = await client.callTool({
            name: "read-message-history",
            arguments: { type: "pending", channel },
        });
        const pendingText = pendingResult.content.find(
            (item) => item.type === "text",
        )?.text;

        assert.equal(typeof pendingText, "string");
        assert.match(pendingText, /222222222222222222\.txt/);
        assert.match(pendingText, /pending entry/);
        assert.match(pendingText, /\n    const answer = 42;/);
        assert.doesNotMatch(pendingText, /444444444444444444\.txt/);
        assert.doesNotMatch(pendingText, /other-channel pending entry/);
        if (channel === "general") {
            assert.match(pendingText, /333333333333333333\.txt/);
            assert.match(pendingText, /legacy pending entry/);
        } else {
            assert.doesNotMatch(pendingText, /333333333333333333\.txt/);
            assert.doesNotMatch(pendingText, /legacy pending entry/);
        }
    }

    const channelResult = await client.callTool({
        name: "read-message-history",
        arguments: { channel: "general", date: "2026-08-01" },
    });
    const channelText = channelResult.content.find(
        (item) => item.type === "text",
    )?.text;

    assert.equal(typeof channelText, "string");
    assert.match(channelText, /general_2026-08-01\.txt/);
    assert.match(channelText, /expected entry/);
    assert.match(
        channelText,
        /v2\/v2_111111111111111111__general_2026-08-01\.txt/,
    );
    assert.match(channelText, /namespaced entry/);
    assert.doesNotMatch(channelText, /general_chat_2026-08-01\.txt/);
    assert.doesNotMatch(channelText, /similarly named channel entry/);

    const { tools } = await client.listTools();
    const historyTool = tools.find(
        ({ name }) => name === "read-message-history",
    );
    assert.equal(historyTool.inputSchema.properties.channel.minLength, 1);
    assert.equal(
        historyTool.inputSchema.properties.channel.pattern,
        String.raw`\S`,
    );

    for (const channel of ["", " \t\n "]) {
        await assert.rejects(
            client.callTool({
                name: "read-message-history",
                arguments: { channel },
            }),
            /Invalid arguments: channel: Channel must contain at least one non-whitespace character/,
        );
    }

    const unicodeSearchResult = await client.callTool({
        name: "read-message-history",
        arguments: { search: "cafe\u0301" },
    });
    const unicodeSearchText = unicodeSearchResult.content.find(
        (item) => item.type === "text",
    )?.text;

    assert.equal(typeof unicodeSearchText, "string");
    assert.match(unicodeSearchText, /ordered a café/);

    await assert.rejects(
        client.callTool({
            name: "read-message-history",
            arguments: { date: "2026-02-30" },
        }),
        /Invalid arguments: date: Invalid calendar date/,
    );
});
