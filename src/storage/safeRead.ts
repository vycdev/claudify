import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export type VerifiedReadResult =
    | { state: "missing" }
    | { state: "unsafe" }
    | { state: "valid"; text: string };

interface OpenDirectory {
    descriptor: number;
    path: string;
    stat: fs.BigIntStats;
}

function hasStableIdentity(stat: fs.BigIntStats): boolean {
    return stat.ino !== 0n;
}

function isSameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return hasStableIdentity(left)
        && hasStableIdentity(right)
        && left.dev === right.dev
        && left.ino === right.ino;
}

function comparablePath(filePath: string): string {
    const normalized = path.resolve(filePath).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function directoryChain(rootPath: string, directoryPath: string): string[] {
    const root = path.resolve(rootPath);
    const resolved = path.resolve(directoryPath);
    const relative = path.relative(root, resolved);
    if (
        relative.startsWith(`..${path.sep}`)
        || relative === ".."
        || path.isAbsolute(relative)
    ) return [];

    const chain = [root];
    let current = root;
    for (const part of relative.split(path.sep)) {
        if (!part) continue;
        current = path.join(current, part);
        chain.push(current);
    }
    return chain;
}

function closeDescriptor(descriptor: number): boolean {
    try {
        fs.closeSync(descriptor);
        return true;
    } catch {
        return false;
    }
}

function closeDirectories(directories: readonly OpenDirectory[]): boolean {
    let closed = true;
    for (const directory of [...directories].reverse()) {
        if (!closeDescriptor(directory.descriptor)) closed = false;
    }
    return closed;
}

function openVerifiedDirectoryChain(
    rootPath: string,
    directoryPath: string,
): OpenDirectory[] | undefined {
    const directories: OpenDirectory[] = [];
    const chain = directoryChain(rootPath, directoryPath);
    if (chain.length === 0) return undefined;
    let verified = false;

    try {
        for (const currentPath of chain) {
            const pathStat = fs.lstatSync(currentPath, { bigint: true });
            if (
                !pathStat.isDirectory()
                || pathStat.isSymbolicLink()
                || !hasStableIdentity(pathStat)
            ) return undefined;

            let descriptor: number | undefined;
            try {
                descriptor = fs.openSync(
                    currentPath,
                    fs.constants.O_RDONLY
                        | (fs.constants.O_DIRECTORY ?? 0)
                        | (fs.constants.O_NOFOLLOW ?? 0)
                        | (fs.constants.O_NONBLOCK ?? 0),
                );
                const openedStat = fs.fstatSync(descriptor, { bigint: true });
                if (
                    !openedStat.isDirectory()
                    || !isSameFile(pathStat, openedStat)
                ) return undefined;
                directories.push({
                    descriptor,
                    path: currentPath,
                    stat: openedStat,
                });
                descriptor = undefined;
            } finally {
                if (descriptor !== undefined) fs.closeSync(descriptor);
            }
        }

        if (
            comparablePath(fs.realpathSync.native(directoryPath))
            !== comparablePath(directoryPath)
        ) return undefined;

        verified = true;
        return directories;
    } catch {
        return undefined;
    } finally {
        if (!verified) closeDirectories(directories);
    }
}

function directoryChainIsUnchanged(
    directories: readonly OpenDirectory[],
    directoryPath: string,
): boolean {
    try {
        for (const directory of directories) {
            const pathStat = fs.lstatSync(directory.path, { bigint: true });
            if (
                !pathStat.isDirectory()
                || pathStat.isSymbolicLink()
                || !isSameFile(pathStat, directory.stat)
            ) return false;
        }
        return comparablePath(fs.realpathSync.native(directoryPath))
            === comparablePath(directoryPath);
    } catch {
        return false;
    }
}

interface BoundedReadResult {
    bytesRead: number;
    exceededLimit: boolean;
    text: string;
}

function readUtf8FromDescriptor(
    descriptor: number,
    maxBytes?: number,
): BoundedReadResult {
    if (maxBytes === undefined) {
        const bytes = fs.readFileSync(descriptor);
        return {
            bytesRead: bytes.length,
            exceededLimit: false,
            text: bytes.toString("utf8"),
        };
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError("maxBytes must be a non-negative safe integer");
    }

    const chunks: Buffer[] = [];
    const readLimit = maxBytes + 1;
    let bytesRead = 0;
    while (bytesRead < readLimit) {
        const chunk = Buffer.allocUnsafe(
            Math.min(64 * 1024, readLimit - bytesRead),
        );
        const chunkBytes = fs.readSync(
            descriptor,
            chunk,
            0,
            chunk.length,
            null,
        );
        if (chunkBytes === 0) break;
        chunks.push(
            chunkBytes === chunk.length
                ? chunk
                : chunk.subarray(0, chunkBytes),
        );
        bytesRead += chunkBytes;
    }

    if (bytesRead > maxBytes) {
        return { bytesRead, exceededLimit: true, text: "" };
    }
    return {
        bytesRead,
        exceededLimit: false,
        text: Buffer.concat(chunks, bytesRead).toString("utf8"),
    };
}

export function readVerifiedUtf8File(
    filePath: string,
    rootDirectory: string,
    expectedDirectory: string,
    maxBytes?: number,
): VerifiedReadResult {
    if (
        comparablePath(path.dirname(filePath))
        !== comparablePath(expectedDirectory)
    ) return { state: "unsafe" };

    const directories = openVerifiedDirectoryChain(
        rootDirectory,
        expectedDirectory,
    );
    if (!directories) return { state: "unsafe" };

    let descriptor: number | undefined;
    let result: VerifiedReadResult = { state: "unsafe" };
    let cleanupSucceeded = true;
    try {
        result = (() => {
            let pathStat: fs.BigIntStats;
            try {
                pathStat = fs.lstatSync(filePath, { bigint: true });
            } catch (error: unknown) {
                return (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? { state: "missing" }
                    : { state: "unsafe" };
            }
            if (
                !pathStat.isFile()
                || pathStat.isSymbolicLink()
                || !hasStableIdentity(pathStat)
                || (
                    maxBytes !== undefined
                    && pathStat.size > BigInt(maxBytes)
                )
            ) return { state: "unsafe" };

            descriptor = fs.openSync(
                filePath,
                fs.constants.O_RDONLY
                    | (fs.constants.O_NOFOLLOW ?? 0)
                    | (fs.constants.O_NONBLOCK ?? 0),
            );
            const openedStat = fs.fstatSync(descriptor, { bigint: true });
            if (
                !openedStat.isFile()
                || !isSameFile(pathStat, openedStat)
                || (
                    maxBytes !== undefined
                    && openedStat.size > BigInt(maxBytes)
                )
                || !directoryChainIsUnchanged(directories, expectedDirectory)
            ) return { state: "unsafe" };

            const read = readUtf8FromDescriptor(descriptor, maxBytes);
            const finalStat = fs.fstatSync(descriptor, { bigint: true });
            if (
                read.exceededLimit
                || !finalStat.isFile()
                || !isSameFile(openedStat, finalStat)
                || finalStat.size !== openedStat.size
                || BigInt(read.bytesRead) !== finalStat.size
                || (
                    maxBytes !== undefined
                    && finalStat.size > BigInt(maxBytes)
                )
                || !directoryChainIsUnchanged(directories, expectedDirectory)
            ) return { state: "unsafe" };
            return { state: "valid", text: read.text };
        })();
    } catch {
        result = { state: "unsafe" };
    } finally {
        if (descriptor !== undefined) {
            cleanupSucceeded = closeDescriptor(descriptor);
        }
        if (!closeDirectories(directories)) cleanupSucceeded = false;
    }
    return cleanupSucceeded ? result : { state: "unsafe" };
}

export function writeVerifiedUtf8File(
    filePath: string,
    text: string,
    rootDirectory: string,
    expectedDirectory: string,
    maxBytes?: number,
): boolean {
    if (
        comparablePath(path.dirname(filePath))
        !== comparablePath(expectedDirectory)
        || (
            maxBytes !== undefined
            && Buffer.byteLength(text, "utf8") > maxBytes
        )
    ) return false;

    const directories = openVerifiedDirectoryChain(
        rootDirectory,
        expectedDirectory,
    );
    if (!directories) return false;

    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    let descriptor: number | undefined;
    let temporaryCreated = false;
    let committed = false;
    let result = false;
    let cleanupSucceeded = true;
    try {
        result = (() => {
            try {
                const destinationStat = fs.lstatSync(filePath, { bigint: true });
                if (
                    !destinationStat.isFile()
                    || destinationStat.isSymbolicLink()
                    || !hasStableIdentity(destinationStat)
                ) return false;
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    return false;
                }
            }

            if (!directoryChainIsUnchanged(directories, expectedDirectory)) {
                return false;
            }
            descriptor = fs.openSync(
                temporaryPath,
                fs.constants.O_WRONLY
                    | fs.constants.O_CREAT
                    | fs.constants.O_EXCL
                    | (fs.constants.O_NOFOLLOW ?? 0),
                0o600,
            );
            temporaryCreated = true;
            const temporaryStat = fs.fstatSync(descriptor, { bigint: true });
            if (
                !temporaryStat.isFile()
                || !hasStableIdentity(temporaryStat)
                || !directoryChainIsUnchanged(directories, expectedDirectory)
            ) return false;

            fs.writeFileSync(descriptor, text, "utf8");
            fs.fsyncSync(descriptor);
            const writtenStat = fs.fstatSync(descriptor, { bigint: true });
            if (
                !isSameFile(temporaryStat, writtenStat)
                || writtenStat.size !== BigInt(Buffer.byteLength(text, "utf8"))
                || !directoryChainIsUnchanged(directories, expectedDirectory)
            ) {
                return false;
            }

            fs.renameSync(temporaryPath, filePath);
            committed = true;
            const destinationStat = fs.lstatSync(filePath, { bigint: true });
            const committedStat = fs.fstatSync(descriptor, { bigint: true });
            return destinationStat.isFile()
                && !destinationStat.isSymbolicLink()
                && isSameFile(writtenStat, destinationStat)
                && isSameFile(writtenStat, committedStat)
                && committedStat.size === writtenStat.size
                && directoryChainIsUnchanged(
                    directories,
                    expectedDirectory,
                );
        })();
    } catch {
        result = false;
    } finally {
        if (descriptor !== undefined && !closeDescriptor(descriptor)) {
            cleanupSucceeded = false;
        }
        if (
            !committed
            && temporaryCreated
            && directoryChainIsUnchanged(directories, expectedDirectory)
        ) {
            try {
                fs.rmSync(temporaryPath, { force: true });
            } catch {
                // A failed cleanup must not turn an unsafe write into success.
            }
        }
        if (!closeDirectories(directories)) cleanupSucceeded = false;
    }
    return cleanupSucceeded && result;
}
