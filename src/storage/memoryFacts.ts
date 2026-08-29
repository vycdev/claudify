import { createHash } from "crypto";
import path from "path";
import {
    MEMORY_FACT_MAX_CHARS,
    MEMORY_FACTS_MAX_PER_SCOPE,
    MESSAGES_DIR,
    PROFILE_FACTS_DIR,
    SERVER_FACTS_DIR,
} from "../config.js";
import {
    readVerifiedUtf8File,
    writeVerifiedUtf8File,
} from "./safeRead.js";

export type MemoryFactAttribution = "explicit" | "inferred";
export type MemoryFactScope = "user" | "server";

export interface MemoryFact {
    id: string;
    text: string;
    sourceMessageId: string;
    observedAt: string;
    attribution: MemoryFactAttribution;
}

export interface MemoryFactCandidate {
    text: string;
    sourceMessageId: string;
    attribution: MemoryFactAttribution;
    supersedesFactIds?: string[];
}

export interface SourceMessageMetadata {
    authorId: string;
    authorBot: boolean;
    createdAt: string;
}

interface MemoryFactDocument {
    version: 1;
    facts: MemoryFact[];
}

interface ReadResult {
    state: "missing" | "valid" | "invalid";
    facts: MemoryFact[];
}

const FACT_ID_PATTERN = /^[a-f0-9]{16}$/;
const SOURCE_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const MAX_FACT_DOCUMENT_BYTES = 1_048_576;

function truncateWithoutSplittingSurrogatePair(
    text: string,
    maxLength: number,
): string {
    let truncated = text.slice(0, maxLength);
    if (truncated.length === text.length || truncated.length === 0) {
        return truncated;
    }

    const precedingCodeUnit = truncated.charCodeAt(truncated.length - 1);
    const followingCodeUnit = text.charCodeAt(truncated.length);
    if (
        precedingCodeUnit >= 0xd800
        && precedingCodeUnit <= 0xdbff
        && followingCodeUnit >= 0xdc00
        && followingCodeUnit <= 0xdfff
    ) {
        truncated = truncated.slice(0, -1);
    }
    return truncated;
}

function normalizeFactText(text: string): string {
    return truncateWithoutSplittingSurrogatePair(
        text.replace(/\s+/gu, " ").trim(),
        MEMORY_FACT_MAX_CHARS,
    );
}

function isMemoryFact(value: unknown): value is MemoryFact {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const fact = value as Record<string, unknown>;
    return typeof fact.id === "string"
        && FACT_ID_PATTERN.test(fact.id)
        && typeof fact.text === "string"
        && fact.text.length > 0
        && fact.text.length <= MEMORY_FACT_MAX_CHARS
        && typeof fact.sourceMessageId === "string"
        && SOURCE_MESSAGE_ID_PATTERN.test(fact.sourceMessageId)
        && typeof fact.observedAt === "string"
        && !Number.isNaN(Date.parse(fact.observedAt))
        && (fact.attribution === "explicit" || fact.attribution === "inferred");
}

function factPath(scope: MemoryFactScope, scopeId: string): string {
    const directory = scope === "user" ? PROFILE_FACTS_DIR : SERVER_FACTS_DIR;
    return path.join(directory, `${encodeURIComponent(scopeId)}.json`);
}

function readDocument(scope: MemoryFactScope, scopeId: string): ReadResult {
    const filePath = factPath(scope, scopeId);
    const directory = scope === "user" ? PROFILE_FACTS_DIR : SERVER_FACTS_DIR;
    const result = readVerifiedUtf8File(
        filePath,
        MESSAGES_DIR,
        directory,
        MAX_FACT_DOCUMENT_BYTES,
    );
    if (result.state === "missing") {
        return { state: "missing", facts: [] };
    }
    if (result.state === "unsafe") {
        console.error(`[MemoryFacts] Refusing invalid fact document ${filePath}`);
        return { state: "invalid", facts: [] };
    }

    try {
        const parsed: unknown = JSON.parse(result.text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("document must be an object");
        }
        const document = parsed as Record<string, unknown>;
        if (
            document.version !== 1
            || !Array.isArray(document.facts)
            || !document.facts.every(isMemoryFact)
        ) {
            throw new Error("document has an invalid schema");
        }
        return {
            state: "valid",
            facts: document.facts.slice(-MEMORY_FACTS_MAX_PER_SCOPE),
        };
    } catch (error: unknown) {
        console.error(`[MemoryFacts] Could not read ${filePath}: ${String(error)}`);
        return { state: "invalid", facts: [] };
    }
}

function writeDocument(
    scope: MemoryFactScope,
    scopeId: string,
    facts: MemoryFact[],
): void {
    const filePath = factPath(scope, scopeId);
    const document: MemoryFactDocument = { version: 1, facts };
    const directory = scope === "user" ? PROFILE_FACTS_DIR : SERVER_FACTS_DIR;
    const written = writeVerifiedUtf8File(
        filePath,
        `${JSON.stringify(document, null, 2)}\n`,
        MESSAGES_DIR,
        directory,
        MAX_FACT_DOCUMENT_BYTES,
    );
    if (!written) throw new Error(`Refusing unsafe ${scope} fact write`);
}

function createFactId(
    scope: MemoryFactScope,
    scopeId: string,
    sourceMessageId: string,
    text: string,
): string {
    return createHash("sha256")
        .update(`${scope}\0${scopeId}\0${sourceMessageId}\0${text}`)
        .digest("hex")
        .slice(0, 16);
}

export function extractSourceMessageMetadata(
    context: string,
): Map<string, SourceMessageMetadata> {
    const metadata = new Map<string, SourceMessageMetadata>();
    for (const match of context.matchAll(
        /\bmessage_id=([A-Za-z0-9_-]{3,128});\s*author_id=([A-Za-z0-9_-]{3,128});\s*author_bot=(true|false);\s*created_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/g,
    )) {
        if (Number.isNaN(Date.parse(match[4]))) continue;
        metadata.set(match[1], {
            authorId: match[2],
            authorBot: match[3] === "true",
            createdAt: new Date(match[4]).toISOString(),
        });
    }
    return metadata;
}

export function extractHumanSourceMessageIds(context: string): Set<string> {
    return new Set(
        [...extractSourceMessageMetadata(context)]
            .filter(([, value]) => !value.authorBot)
            .map(([messageId]) => messageId),
    );
}

export function getMemoryFacts(
    scope: MemoryFactScope,
    scopeId: string,
): MemoryFact[] {
    return readDocument(scope, scopeId).facts;
}

export function renderMemoryFacts(
    scope: MemoryFactScope,
    scopeId: string,
): string {
    const facts = getMemoryFacts(scope, scopeId);
    if (facts.length === 0) return "";

    return [
        "Source-backed facts (newest first):",
        ...facts.slice().reverse().map((fact) =>
            `- ${fact.text} [fact_id=${fact.id}; source_message_id=${fact.sourceMessageId}; attribution=${fact.attribution}; observed_at=${fact.observedAt}]`
        ),
    ].join("\n");
}

export function mergeMemoryFacts(
    scope: MemoryFactScope,
    scopeId: string,
    candidates: MemoryFactCandidate[],
    validSourceMessageIds: ReadonlySet<string>,
    sourceMessageTimestamps: ReadonlyMap<string, string> = new Map(),
): number {
    const readResult = readDocument(scope, scopeId);
    if (readResult.state === "invalid") {
        throw new Error(`Refusing to overwrite invalid ${scope} fact document`);
    }

    let facts = readResult.facts;
    let changedCount = 0;

    for (const candidate of candidates) {
        if (!validSourceMessageIds.has(candidate.sourceMessageId)) continue;
        if (!SOURCE_MESSAGE_ID_PATTERN.test(candidate.sourceMessageId)) continue;
        if (
            candidate.attribution !== "explicit"
            && candidate.attribution !== "inferred"
        ) continue;

        const text = normalizeFactText(candidate.text);
        if (!text) continue;

        const supersededIds = new Set(
            (candidate.supersedesFactIds ?? []).filter((id) =>
                FACT_ID_PATTERN.test(id)
            ),
        );
        const existingEquivalent = facts.find((fact) => fact.text === text);
        const beforeLength = facts.length;
        facts = facts.filter((fact) => !supersededIds.has(fact.id));
        const removedFacts = facts.length !== beforeLength;

        if (existingEquivalent && !supersededIds.has(existingEquivalent.id)) {
            if (removedFacts) changedCount++;
            continue;
        }

        const fact: MemoryFact = {
            id: createFactId(
                scope,
                scopeId,
                candidate.sourceMessageId,
                text,
            ),
            text,
            sourceMessageId: candidate.sourceMessageId,
            observedAt: sourceMessageTimestamps.get(candidate.sourceMessageId)
                ?? new Date().toISOString(),
            attribution: candidate.attribution,
        };
        if (!facts.some((existing) => existing.id === fact.id)) {
            facts.push(fact);
            changedCount++;
        } else if (removedFacts) {
            changedCount++;
        }
    }

    const boundedFacts = facts.slice(-MEMORY_FACTS_MAX_PER_SCOPE);
    if (boundedFacts.length !== readResult.facts.length || changedCount > 0) {
        writeDocument(scope, scopeId, boundedFacts);
    }
    return changedCount;
}
