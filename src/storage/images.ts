import fs from "fs";
import path from "path";
import { IMAGES_DIR, MCP_ATTACHMENT_MAX_BYTES } from "../config.js";

async function readResponseBody(response: Response): Promise<Buffer> {
    const contentLength = response.headers.get("content-length");
    const declaredLength = contentLength === null ? undefined : Number(contentLength);
    if (
        declaredLength !== undefined &&
        Number.isSafeInteger(declaredLength) &&
        declaredLength > MCP_ATTACHMENT_MAX_BYTES
    ) {
        throw new Error(
            `Attachment exceeds the ${MCP_ATTACHMENT_MAX_BYTES}-byte download limit`,
        );
    }

    if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MCP_ATTACHMENT_MAX_BYTES) {
            throw new Error(
                `Attachment exceeds the ${MCP_ATTACHMENT_MAX_BYTES}-byte download limit`,
            );
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            totalBytes += chunk.length;
            if (totalBytes > MCP_ATTACHMENT_MAX_BYTES) {
                await reader.cancel().catch(() => {});
                throw new Error(
                    `Attachment exceeds the ${MCP_ATTACHMENT_MAX_BYTES}-byte download limit`,
                );
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes);
}

export async function downloadAttachment(
    url: string,
    filename: string,
): Promise<string> {
    const filePath = path.resolve(IMAGES_DIR, filename);
    const relativePath = path.relative(IMAGES_DIR, filePath);
    if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error("Attachment filename resolves outside the images directory");
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download attachment: HTTP ${response.status} ${response.statusText}`,
        );
    }

    const buffer = await readResponseBody(response);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}
