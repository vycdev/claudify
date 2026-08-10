import fs from "fs";
import path from "path";
import { IMAGES_DIR } from "../config.js";

const NO_FOLLOW_FLAG =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

function assertSafeAttachmentDestination(filePath: string): void {
    if (!fs.lstatSync(IMAGES_DIR).isDirectory()) {
        throw new Error("Images path must be a directory, not a symbolic link");
    }

    try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
            throw new Error("Attachment destination must not be a symbolic link");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function writeAttachmentFile(filePath: string, buffer: Buffer): void {
    assertSafeAttachmentDestination(filePath);

    let fileDescriptor: number;
    try {
        fileDescriptor = fs.openSync(
            filePath,
            fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC |
                NO_FOLLOW_FLAG,
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new Error("Attachment destination must not be a symbolic link");
        }
        throw error;
    }

    try {
        fs.writeFileSync(fileDescriptor, buffer);
    } finally {
        fs.closeSync(fileDescriptor);
    }
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
    if (path.basename(filename) !== filename) {
        throw new Error("Attachment filename must not include a directory path");
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download attachment: HTTP ${response.status} ${response.statusText}`,
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    writeAttachmentFile(filePath, buffer);
    return filePath;
}
