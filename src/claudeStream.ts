export type ClaudeToolResultStatus = "pending" | "success" | "failure";

export interface ClaudeToolCallTrace {
    id: string;
    name: string;
    resultStatus: ClaudeToolResultStatus;
}

export interface ClaudeExecutionTrace {
    format: "stream-json";
    resultEventReceived: boolean;
    malformedEventCount: number;
    toolCalls: ClaudeToolCallTrace[];
}

export interface ClaudeStreamResult {
    result: string;
    trace: ClaudeExecutionTrace;
}

const MAX_STREAM_LINE_CHARS = 4 * 1024 * 1024;
const MAX_RECORDED_TOOL_CALLS = 256;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
    try {
        return asRecord(JSON.parse(value));
    } catch {
        return undefined;
    }
}

function commandResultSucceeded(
    event: Record<string, unknown>,
    contentBlock: Record<string, unknown>,
): boolean | undefined {
    const toolUseResult = asRecord(event.tool_use_result);
    const structuredContent = asRecord(toolUseResult?.structuredContent);
    if (typeof structuredContent?.success === "boolean") {
        return structuredContent.success;
    }

    const content = contentBlock.content;
    if (typeof content !== "string") return undefined;
    const parsed = parseJsonObject(content);
    return typeof parsed?.success === "boolean" ? parsed.success : undefined;
}

export class ClaudeStreamCollector {
    private buffer = "";
    private discardingOversizedLine = false;
    private malformedEventCount = 0;
    private result = "";
    private resultEventReceived = false;
    private readonly toolCalls: ClaudeToolCallTrace[] = [];
    private readonly toolCallById = new Map<string, ClaudeToolCallTrace>();

    consume(chunk: string): void {
        this.buffer += chunk;
        this.consumeCompleteLines();
        if (this.buffer.length > MAX_STREAM_LINE_CHARS) {
            this.buffer = "";
            this.discardingOversizedLine = true;
            this.malformedEventCount++;
        }
    }

    finish(): ClaudeStreamResult {
        if (!this.discardingOversizedLine && this.buffer.trim()) {
            this.consumeLine(this.buffer);
        }
        this.buffer = "";
        return {
            result: this.result,
            trace: {
                format: "stream-json",
                resultEventReceived: this.resultEventReceived,
                malformedEventCount: this.malformedEventCount,
                toolCalls: this.toolCalls.map((call) => ({ ...call })),
            },
        };
    }

    private consumeCompleteLines(): void {
        let newlineIndex = this.buffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (this.discardingOversizedLine) {
                this.discardingOversizedLine = false;
            } else {
                this.consumeLine(line);
            }
            newlineIndex = this.buffer.indexOf("\n");
        }
    }

    private consumeLine(line: string): void {
        const normalized = line.trim();
        if (!normalized) return;
        const event = parseJsonObject(normalized);
        if (!event) {
            this.malformedEventCount++;
            return;
        }

        if (event.type === "assistant") this.consumeAssistantEvent(event);
        if (event.type === "user") this.consumeUserEvent(event);
        if (event.type === "result") {
            this.resultEventReceived = true;
            if (typeof event.result === "string") this.result = event.result;
        }
    }

    private consumeAssistantEvent(event: Record<string, unknown>): void {
        const message = asRecord(event.message);
        if (!Array.isArray(message?.content)) return;

        for (const value of message.content) {
            const block = asRecord(value);
            if (
                block?.type !== "tool_use"
                || typeof block.id !== "string"
                || typeof block.name !== "string"
                || this.toolCallById.has(block.id)
                || this.toolCalls.length >= MAX_RECORDED_TOOL_CALLS
            ) continue;

            const call: ClaudeToolCallTrace = {
                id: block.id,
                name: block.name,
                resultStatus: "pending",
            };
            this.toolCalls.push(call);
            this.toolCallById.set(call.id, call);
        }
    }

    private consumeUserEvent(event: Record<string, unknown>): void {
        const message = asRecord(event.message);
        if (!Array.isArray(message?.content)) return;

        for (const value of message.content) {
            const block = asRecord(value);
            if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
                continue;
            }
            const call = this.toolCallById.get(block.tool_use_id);
            if (!call) continue;

            if (block.is_error === true) {
                call.resultStatus = "failure";
                continue;
            }
            if (call.name === "mcp__morpheus__run_command") {
                const succeeded = commandResultSucceeded(event, block);
                call.resultStatus = succeeded === false ? "failure" : "success";
                continue;
            }
            call.resultStatus = "success";
        }
    }
}
