import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("storage statistics ignore symlinked files and directories", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudify-storage-"));
    const storageDir = path.join(root, "storage");
    const externalDir = path.join(root, "external");
    fs.mkdirSync(storageDir);
    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(storageDir, "inside.txt"), "inside", "utf8");
    fs.writeFileSync(path.join(storageDir, "inside.bin"), "bin", "utf8");
    fs.writeFileSync(path.join(externalDir, "outside.txt"), "outside", "utf8");
    fs.symlinkSync(
        path.join(externalDir, "outside.txt"),
        path.join(storageDir, "linked.txt"),
    );
    fs.symlinkSync(externalDir, path.join(storageDir, "linked-directory"), "dir");

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const { countStorageFiles, getStorageDirectorySize } = await import(
        "../build/discord/commands/storage.js"
    );

    assert.equal(countStorageFiles(storageDir), 1);
    assert.equal(
        getStorageDirectorySize(storageDir),
        Buffer.byteLength("inside") + Buffer.byteLength("bin"),
    );
});
