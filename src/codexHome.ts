import fs from "node:fs";
import path from "node:path";

// Resolve existing ancestors as well as an existing leaf. The credential
// directory commonly does not exist until the first private login.
function canonicalPath(value: string): string {
    const absolute = path.resolve(value);
    try {
        return fs.realpathSync(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(absolute);
        if (parent === absolute) throw error;
        return path.join(canonicalPath(parent), path.basename(absolute));
    }
}

export function resolvePrivateCodexHome(
    requestedHome: string,
    forbiddenRoots: readonly string[] = [],
): string {
    try {
        const stat = fs.lstatSync(path.resolve(requestedHome));
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(
                "Codex home must be a private directory, not a symbolic link.",
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const home = canonicalPath(requestedHome);
    for (const root of forbiddenRoots) {
        const relative = path.relative(canonicalPath(root), home);
        if (
            !relative ||
            (relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative))
        ) {
            throw new Error(
                "CODEX_HOME must be outside MESSAGES_DIR so MCP tools cannot read credentials.",
            );
        }
    }
    return home;
}
