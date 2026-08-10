import assert from "node:assert/strict";
import test from "node:test";

import { formatContextTime } from "../build/discord/context.js";

test("formats live-context timestamps in UTC", () => {
    const timestamp = new Date("2026-08-08T05:34:56.789-07:00");

    assert.equal(formatContextTime(timestamp), "12:34:56 UTC");
});
