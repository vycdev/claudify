declare module "node:sqlite" {
    type SQLInputValue = null | number | bigint | string | Uint8Array;

    interface StatementSync {
        all(...anonymousParameters: SQLInputValue[]): unknown[];
        run(...anonymousParameters: SQLInputValue[]): unknown;
    }

    export class DatabaseSync {
        constructor(path: string);
        exec(sql: string): void;
        prepare(sql: string): StatementSync;
    }
}
