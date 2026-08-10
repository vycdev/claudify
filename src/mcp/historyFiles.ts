const HISTORY_DATE_SUFFIX = /_(\d{4}-\d{2}-\d{2})\.txt$/;

export function getLegacyHistoryChannel(filename: string): string | undefined {
    const dateSuffix = filename.match(HISTORY_DATE_SUFFIX);
    if (dateSuffix?.index === undefined || dateSuffix.index === 0) {
        return undefined;
    }

    return filename.slice(0, dateSuffix.index);
}

export function isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value;
}

function getHistoryDate(filename: string): string | undefined {
    const date = filename.match(HISTORY_DATE_SUFFIX)?.[1];
    return date && isCalendarDate(date) ? date : undefined;
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
