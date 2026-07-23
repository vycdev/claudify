import fs from "fs";
import path from "path";
import { IMAGES_DIR } from "../config.js";

export async function downloadAttachment(
    url: string,
    filename: string,
): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download attachment: HTTP ${response.status} ${response.statusText}`,
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(IMAGES_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}
