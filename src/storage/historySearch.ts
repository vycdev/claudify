import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    HISTORY_FTS_MAX_CHARS,
    HISTORY_FTS_MAX_RESULTS,
    HISTORY_SEARCH_DB_PATH,
    HISTORY_SEARCH_CONTEXT_LINES,
    HISTORY_V2_DIR,
} from "../config.js";
import { parseChannelHistoryFileName } from "./historyPaths.js";

interface IndexedFileState {
    file_path: string;
    size: number;
    mtime_ms: number;
    line_count: number;
}

export interface HistorySearchMatch {
    date: string;
    content: string;
    rank: number;
}

let database: DatabaseSync | undefined;

function getDatabase(): DatabaseSync {
    if (database) return database;

    database = new DatabaseSync(HISTORY_SEARCH_DB_PATH);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
            channel_id UNINDEXED,
            file_path UNINDEXED,
            line_number UNINDEXED,
            history_date UNINDEXED,
            content,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS history_fts_files (
            file_path TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime_ms REAL NOT NULL,
            line_count INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS history_fts_files_channel
            ON history_fts_files(channel_id);
    `);
    return database;
}

function readIndexableLines(filePath: string): string[] {
    return fs.readFileSync(filePath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function isRegularHistoryFile(filePath: string): boolean {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
}

function synchronizeChannelIndex(db: DatabaseSync, channelId: string): void {
    const trackedRows = db.prepare(`
        SELECT file_path, size, mtime_ms, line_count
        FROM history_fts_files
        WHERE channel_id = ?
    `).all(channelId) as unknown as IndexedFileState[];
    const tracked = new Map(trackedRows.map((row) => [row.file_path, row]));

    const files = fs.readdirSync(HISTORY_V2_DIR)
        .map((fileName) => ({
            fileName,
            parsed: parseChannelHistoryFileName(fileName),
        }))
        .filter((entry) => entry.parsed?.channelId === channelId)
        .map((entry) => ({
            filePath: path.join(HISTORY_V2_DIR, entry.fileName),
            date: entry.parsed!.date,
        }))
        .filter((entry) => isRegularHistoryFile(entry.filePath));
    const currentPaths = new Set(files.map((file) => file.filePath));

    const deleteSearchRows = db.prepare(
        "DELETE FROM history_fts WHERE file_path = ?",
    );
    const deleteFileState = db.prepare(
        "DELETE FROM history_fts_files WHERE file_path = ?",
    );
    const insertSearchRow = db.prepare(`
        INSERT INTO history_fts(
            channel_id,
            file_path,
            line_number,
            history_date,
            content
        ) VALUES (?, ?, ?, ?, ?)
    `);
    const upsertFileState = db.prepare(`
        INSERT INTO history_fts_files(
            file_path,
            channel_id,
            size,
            mtime_ms,
            line_count
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
            channel_id = excluded.channel_id,
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            line_count = excluded.line_count
    `);

    db.exec("BEGIN IMMEDIATE");
    try {
        for (const state of trackedRows) {
            if (currentPaths.has(state.file_path)) continue;
            deleteSearchRows.run(state.file_path);
            deleteFileState.run(state.file_path);
        }

        for (const file of files) {
            const stat = fs.statSync(file.filePath);
            const state = tracked.get(file.filePath);
            if (
                state
                && state.size === stat.size
                && state.mtime_ms === stat.mtimeMs
            ) {
                continue;
            }

            const lines = readIndexableLines(file.filePath);
            const appendOnly = Boolean(
                state
                && stat.size >= state.size
                && lines.length >= state.line_count,
            );
            const firstNewLine = appendOnly ? state!.line_count : 0;
            if (!appendOnly) deleteSearchRows.run(file.filePath);

            for (let index = firstNewLine; index < lines.length; index++) {
                insertSearchRow.run(
                    channelId,
                    file.filePath,
                    index,
                    file.date,
                    lines[index],
                );
            }
            upsertFileState.run(
                file.filePath,
                channelId,
                stat.size,
                stat.mtimeMs,
                lines.length,
            );
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function buildMatchExpression(terms: string[]): string {
    return terms
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(" OR ");
}

export function searchChannelHistory(
    channelId: string,
    terms: string[],
    excludeDates: string[] = [],
    maxResults: number = HISTORY_FTS_MAX_RESULTS,
    maxChars: number = HISTORY_FTS_MAX_CHARS,
): HistorySearchMatch[] {
    if (terms.length === 0 || maxResults === 0 || maxChars === 0) return [];

    const db = getDatabase();
    synchronizeChannelIndex(db, channelId);

    const excludedClause = excludeDates.length > 0
        ? `AND history_date NOT IN (${excludeDates.map(() => "?").join(", ")})`
        : "";
    const rows = db.prepare(`
        SELECT
            file_path,
            line_number,
            history_date,
            content,
            bm25(history_fts) AS rank
        FROM history_fts
        WHERE history_fts MATCH ?
          AND channel_id = ?
          ${excludedClause}
        ORDER BY rank ASC, history_date DESC, line_number DESC
        LIMIT ?
    `).all(
        buildMatchExpression(terms),
        channelId,
        ...excludeDates,
        maxResults,
    ) as unknown as Array<{
        file_path: string;
        line_number: number;
        history_date: string;
        content: string;
        rank: number;
    }>;

    const matches: HistorySearchMatch[] = [];
    const seenContent = new Set<string>();
    const fileLines = new Map<string, string[]>();
    let usedChars = 0;
    for (const row of rows) {
        if (!isRegularHistoryFile(row.file_path)) continue;
        let lines = fileLines.get(row.file_path);
        if (!lines) {
            lines = readIndexableLines(row.file_path);
            fileLines.set(row.file_path, lines);
        }
        const lineNumber = Number(row.line_number);
        const content = lines.slice(
            Math.max(0, lineNumber - HISTORY_SEARCH_CONTEXT_LINES),
            Math.min(lines.length, lineNumber + HISTORY_SEARCH_CONTEXT_LINES + 1),
        ).join("\n") || row.content;
        if (seenContent.has(content)) continue;
        const renderedLength = row.history_date.length + content.length + 3;
        if (usedChars + renderedLength > maxChars) break;
        matches.push({
            date: row.history_date,
            content,
            rank: row.rank,
        });
        seenContent.add(content);
        usedChars += renderedLength;
    }
    return matches;
}
