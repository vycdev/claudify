import {
    MEMORY_UPDATE_BATCH_MAX_CHARS,
    MEMORY_UPDATE_DEBOUNCE_MS,
    MEMORY_UPDATE_MAX_DELAY_MS,
} from "../config.js";
import {
    backgroundProfileUpdate,
    backgroundServerMemoryUpdate,
} from "./profiles.js";

export interface MemoryUpdateBatchRequest {
    scopeId: string;
    guildId?: string;
    guildName?: string;
    channelId: string;
    channelName: string;
    users: Array<{ tag: string; id: string }>;
    conversationContext: string;
}

interface PendingMemoryBatch {
    firstQueuedAt: number;
    guildId?: string;
    guildName?: string;
    channelContexts: Map<string, { name: string; context: string }>;
    users: Map<string, { tag: string; id: string }>;
    timer?: NodeJS.Timeout;
}

type ProfileUpdater = typeof backgroundProfileUpdate;
type ServerMemoryUpdater = typeof backgroundServerMemoryUpdate;

function trimStartWithoutSplittingSurrogatePair(
    text: string,
    maxChars: number,
): string {
    if (text.length <= maxChars) return text;

    let start = text.length - maxChars;
    const firstCodeUnit = text.charCodeAt(start);
    const precedingCodeUnit = text.charCodeAt(start - 1);
    if (
        firstCodeUnit >= 0xdc00
        && firstCodeUnit <= 0xdfff
        && precedingCodeUnit >= 0xd800
        && precedingCodeUnit <= 0xdbff
    ) {
        start++;
    }
    return text.slice(start);
}

export class MemoryUpdateBatcher {
    private readonly pending = new Map<string, PendingMemoryBatch>();
    private readonly inFlight = new Map<string, Promise<void>>();

    constructor(
        private readonly debounceMs: number = MEMORY_UPDATE_DEBOUNCE_MS,
        private readonly maxDelayMs: number = MEMORY_UPDATE_MAX_DELAY_MS,
        private readonly maxContextChars: number = MEMORY_UPDATE_BATCH_MAX_CHARS,
        private readonly profileUpdater: ProfileUpdater = backgroundProfileUpdate,
        private readonly serverMemoryUpdater: ServerMemoryUpdater = backgroundServerMemoryUpdate,
    ) {}

    enqueue(request: MemoryUpdateBatchRequest): void {
        const now = Date.now();
        let batch = this.pending.get(request.scopeId);
        if (!batch) {
            batch = {
                firstQueuedAt: now,
                channelContexts: new Map(),
                users: new Map(),
            };
            this.pending.set(request.scopeId, batch);
        }

        batch.guildId = request.guildId;
        batch.guildName = request.guildName;
        for (const user of request.users) batch.users.set(user.id, user);

        // A newer live slice from the same channel subsumes the older one. Use
        // the channel ID because display names are not unique within a guild.
        // Move it to the end so global trimming retains the freshest data.
        batch.channelContexts.delete(request.channelId);
        batch.channelContexts.set(
            request.channelId,
            {
                name: request.channelName,
                context: trimStartWithoutSplittingSurrogatePair(
                    request.conversationContext.trim(),
                    this.maxContextChars,
                ),
            },
        );

        if (batch.timer) clearTimeout(batch.timer);
        const remainingUntilForcedFlush = Math.max(
            0,
            this.maxDelayMs - (now - batch.firstQueuedAt),
        );
        const delay = Math.min(this.debounceMs, remainingUntilForcedFlush);
        batch.timer = setTimeout(() => {
            void this.flush(request.scopeId).catch((error: unknown) => {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                console.error(
                    `[MemoryBatch] Failed to flush ${request.scopeId}: ${message}`,
                );
            });
        }, delay);
        batch.timer.unref();
    }

    async flush(scopeId: string): Promise<void> {
        // A previous batch for this scope may still be writing profiles or
        // server memory. Wait before starting the newer snapshot.
        const previous = this.inFlight.get(scopeId);
        if (previous) await previous.catch(() => {});

        const batch = this.pending.get(scopeId);
        if (!batch) return;

        this.pending.delete(scopeId);
        if (batch.timer) clearTimeout(batch.timer);

        const combinedContext = trimStartWithoutSplittingSurrogatePair(
            Array.from(batch.channelContexts.values(), ({ name, context }) =>
                `=== #${name} ===\n${context}`,
            ).join("\n\n"),
            this.maxContextChars,
        );
        const users = Array.from(batch.users.values());
        const updates: Array<Promise<void>> = [];

        if (users.length > 0 && combinedContext) {
            updates.push(this.profileUpdater(users, combinedContext));
        }
        if (batch.guildId && batch.guildName && combinedContext) {
            const channelNames = Array.from(
                batch.channelContexts.values(),
                ({ name }) => name,
            );
            const channelLabel = channelNames.length === 1
                ? channelNames[0]
                : `multiple channels: ${channelNames.join(", ")}`;
            updates.push(this.serverMemoryUpdater(
                batch.guildId,
                batch.guildName,
                channelLabel,
                combinedContext,
            ));
        }

        console.error(
            `[MemoryBatch] Flushing ${scopeId}: ${users.length} user(s), ${batch.channelContexts.size} channel(s), ${combinedContext.length} chars`,
        );
        const current = Promise.all(updates).then(() => {});
        this.inFlight.set(scopeId, current);
        try {
            await current;
        } finally {
            if (this.inFlight.get(scopeId) === current) {
                this.inFlight.delete(scopeId);
            }
        }
    }
}

const memoryUpdateBatcher = new MemoryUpdateBatcher();

export function queueBackgroundMemoryUpdate(
    request: MemoryUpdateBatchRequest,
): void {
    memoryUpdateBatcher.enqueue(request);
}
