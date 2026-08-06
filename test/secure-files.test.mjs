import assert from "node:assert/strict";
import {
  access,
  mkdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertNoLinkedPathComponents,
  copyVerifiedFile,
  DestinationFileCopyError,
  fileIdentity,
} from "../src/secure-files.mjs";
import { temporaryDirectory } from "./helpers.mjs";

test("allows explicitly configured operating-system path aliases", async () => {
  const root = path.parse(path.resolve(".")).root;
  const allowedPath = path.join(root, "system-alias");
  const targetPath = path.join(allowedPath, "folder", "file.txt");

  await assert.doesNotReject(
    assertNoLinkedPathComponents(targetPath, {
      allowedLinkedPaths: new Set([allowedPath]),
      getLinkInfo: async (filePath) => ({
        isSymbolicLink: () => filePath === allowedPath,
      }),
    }),
  );
});

test("rejects linked destination directory components", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, "source.txt");
  const archivePath = path.join(directory, "archive");
  const outsidePath = path.join(directory, "outside");
  const linkedPath = path.join(archivePath, "linked");
  const escapedPath = path.join(outsidePath, "escaped.txt");
  await writeFile(sourcePath, "content");
  await mkdir(archivePath);
  await mkdir(outsidePath);
  await symlink(
    outsidePath,
    linkedPath,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    copyVerifiedFile(
      sourcePath,
      path.join(linkedPath, "escaped.txt"),
      fileIdentity(await stat(sourcePath)),
      { trustedDestinationRoot: archivePath },
    ),
    (error) =>
      error instanceof DestinationFileCopyError &&
      error.code === "SYMLINK",
  );
  await assert.rejects(access(escapedPath), { code: "ENOENT" });
});

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
      trustedDestinationRoot: directory,
    }),
    (error) =>
      error instanceof DestinationFileCopyError && error.code === "EIO",
  );
  assert.equal(removed, true);
});

test("rolls back a destination when the source handle cannot close", async (t) => {
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
    close: async () => {
      throw Object.assign(new Error("source close failed"), { code: "EIO" });
    },
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
      dev: identity.device,
      ino: identity.inode,
      isFile: () => true,
      mtimeMs: identity.mtimeMs,
      size: identity.byteSize,
    }),
  };
  const destinationHandle = {
    close: async () => {},
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
      trustedDestinationRoot: directory,
    }),
    /source close failed/,
  );
  assert.equal(removed, true);
});
