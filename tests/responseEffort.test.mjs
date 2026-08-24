import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyResponseEffort,
    selectResponseRunOptions,
} from "../build/responseEffort.js";

function signals(question, overrides = {}) {
    return {
        question,
        imageCount: 0,
        requiresMorpheus: false,
        ...overrides,
    };
}

test("classifies simple turns without escalating ordinary questions", () => {
    assert.equal(classifyResponseEffort(signals("sup")), "simple");
    assert.equal(
        classifyResponseEffort(signals("what time is it?")),
        "simple",
    );
    assert.equal(
        classifyResponseEffort(signals("who sent the last message?")),
        "simple",
    );
});

test("retains complex effort for deterministic high-value signals", () => {
    assert.equal(
        classifyResponseEffort(signals("press it", { requiresMorpheus: true })),
        "morpheus",
    );
    assert.equal(
        classifyResponseEffort(signals("what is this?", { imageCount: 1 })),
        "attachment",
    );
    assert.equal(
        classifyResponseEffort(signals("x".repeat(600))),
        "long-request",
    );
    assert.equal(
        classifyResponseEffort(signals("debug this stack trace please")),
        "code-or-error",
    );
    assert.equal(
        classifyResponseEffort(signals("what changed? why did it change?")),
        "multi-part",
    );
    assert.equal(
        classifyResponseEffort(signals("explain the tradeoffs here")),
        "reasoning-intent",
    );
});

test("adaptive routing changes effort without changing model or workload", () => {
    const base = Object.freeze({
        workload: "response",
        model: "claude-sonnet-5",
        effort: "high",
    });
    const simple = selectResponseRunOptions(
        base,
        "adaptive",
        "low",
        signals("sup"),
    );
    const complex = selectResponseRunOptions(
        base,
        "adaptive",
        "low",
        signals("analyze this design"),
    );

    assert.deepEqual(simple, {
        options: {
            workload: "response",
            model: "claude-sonnet-5",
            effort: "low",
        },
        reason: "simple",
    });
    assert.deepEqual(complex, {
        options: base,
        reason: "reasoning-intent",
    });
    assert.equal(simple.options.model, complex.options.model);
});

test("fixed routing preserves the exact resolved response options", () => {
    const base = Object.freeze({
        workload: "response",
        model: "response-model",
        effort: "medium",
    });
    const selected = selectResponseRunOptions(
        base,
        "fixed",
        "low",
        signals("sup"),
    );

    assert.equal(selected.options, base);
    assert.equal(selected.reason, "fixed");
});
