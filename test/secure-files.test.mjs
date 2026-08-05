import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  copyVerifiedFile,
  DestinationFileCopyError,
} from "../src/secure-files.mjs";
import { temporaryDirectory } from "./helpers.mjs";

test("rolls back a destination when close reports a writeback failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, "source.txt");
  const destinationPath = path.join(directory, "archive", "destination.txt");
  const content = Buffer.from("content");
  const identity = {
    device: 1,
    inode: 2,
    byteSize: content.length,
    mtimeMs: 3,
  };
  let sourceOffset = 0;
  let removed = false;
  const sourceHandle = {
    close: async () => {},
    read: async (buffer, offset, length) => {
      const bytesRead = Math.min(length, content.length - sourceOffset);
      content.copy(
        buffer,
        offset,
        sourceOffset,
        sourceOffset + bytesRead,
      );
      sourceOffset += bytesRead;
      return { bytesRead };
    },
    stat: async () => ({
      ctimeMs: 4,
      dev: identity.device,
      ino: identity.inode,
      isFile: () => true,
      mtimeMs: identity.mtimeMs,
      size: identity.byteSize,
    }),
  };
  const destinationHandle = {
    close: async () => {
      throw Object.assign(new Error("writeback failed"), { code: "EIO" });
    },
    write: async (_buffer, _offset, length) => ({
      bytesWritten: length,
    }),
  };
  let openCount = 0;

  await assert.rejects(
    copyVerifiedFile(sourcePath, destinationPath, identity, {
      openFile: async () => {
        openCount += 1;
        return openCount === 1 ? sourceHandle : destinationHandle;
      },
      removeFile: async () => {
        removed = true;
      },
    }),
    (error) =>
      error instanceof DestinationFileCopyError && error.code === "EIO",
  );
  assert.equal(removed, true);
});
