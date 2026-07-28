import fs from "fs";
import path from "path";
import { IMAGES_DIR } from "../config.js";

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

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return filePath;
}
