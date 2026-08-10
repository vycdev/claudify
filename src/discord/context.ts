export function formatContextTime(timestamp: Date): string {
    return `${timestamp.toISOString().slice(11, 19)} UTC`;
}
