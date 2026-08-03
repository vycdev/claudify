const HISTORY_DATE_SUFFIX = /_(\d{4}-\d{2}-\d{2})\.txt$/;

function getHistoryDate(filename: string): string | undefined {
    const date = filename.match(HISTORY_DATE_SUFFIX)?.[1];
    if (!date) return undefined;

    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === date
        ? date
        : undefined;
}

export function compareHistoryFilenames(left: string, right: string): number {
    const leftDate = getHistoryDate(left);
    const rightDate = getHistoryDate(right);

    if (leftDate && rightDate && leftDate !== rightDate) {
        return leftDate.localeCompare(rightDate);
    }
    if (leftDate && !rightDate) return 1;
    if (!leftDate && rightDate) return -1;

    return left.localeCompare(right);
}
