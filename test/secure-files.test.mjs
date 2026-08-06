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
  readVerifiedFile,
  SourceFileChangedError,
  SourceFileCopyError,
  SourceFileReadError,
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

test("preserves the primary copy failure when close and cleanup also fail", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourcePath = path.join(directory, "source.txt");
  const destinationPath = path.join(directory, "archive", "destination.txt");
  const identity = {
    device: 1,
    inode: 2,
    byteSize: 1,
    mtimeMs: 3,
  };
  const sourceHandle = {
    close: async () => {
      throw Object.assign(new Error("source close failed"), { code: "ECLOSE" });
    },
    read: async () => {
      throw Object.assign(new Error("source read failed"), { code: "EREAD" });
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
    close: async () => {
      throw Object.assign(
        new Error("destination close failed"),
        { code: "EDESTCLOSE" },
      );
    },
  };
  let openCount = 0;

  await assert.rejects(
    copyVerifiedFile(sourcePath, destinationPath, identity, {
      openFile: async () => {
        openCount += 1;
        return openCount === 1 ? sourceHandle : destinationHandle;
      },
      removeFile: async () => {
        throw Object.assign(new Error("cleanup failed"), { code: "ECLEANUP" });
      },
      trustedDestinationRoot: directory,
    }),
    (error) =>
      error instanceof SourceFileCopyError &&
      error.code === "EREAD" &&
      error.message.includes("source read failed"),
  );
});

test("reports verified read failures with read-specific errors", async () => {
  const sourcePath = path.resolve("metadata.json");
  await assert.rejects(
    readVerifiedFile(
      sourcePath,
      { byteSize: 1 },
      1024,
      {
        openFile: async () => {
          throw Object.assign(new Error("open failed"), { code: "EACCES" });
        },
      },
    ),
    (error) =>
      error instanceof SourceFileReadError &&
      error.code === "EACCES" &&
      error.message.includes("could not be read"),
  );
});

test("preserves verified read validation failures when close also fails", async () => {
  const sourcePath = path.resolve("metadata.json");
  const handle = {
    close: async () => {
      throw Object.assign(new Error("close failed"), { code: "ECLOSE" });
    },
    stat: async () => ({
      dev: 1,
      ino: 2,
      isFile: () => true,
      mtimeMs: 3,
      size: 2,
    }),
  };

  await assert.rejects(
    readVerifiedFile(
      sourcePath,
      { device: 1, inode: 2, byteSize: 1, mtimeMs: 3 },
      1024,
      { openFile: async () => handle },
    ),
    (error) =>
      error instanceof SourceFileChangedError &&
      error.message.includes("being read"),
  );
});

test("reports verified read close failures after a successful read", async () => {
  const sourcePath = path.resolve("metadata.json");
  let readCount = 0;
  const handle = {
    close: async () => {
      throw Object.assign(new Error("close failed"), { code: "ECLOSE" });
    },
    read: async (buffer) => {
      readCount += 1;
      if (readCount === 1) {
        buffer[0] = 65;
        return { bytesRead: 1 };
      }
      return { bytesRead: 0 };
    },
    stat: async () => ({
      dev: 1,
      ino: 2,
      isFile: () => true,
      mtimeMs: 3,
      size: 1,
    }),
  };

  await assert.rejects(
    readVerifiedFile(
      sourcePath,
      { device: 1, inode: 2, byteSize: 1, mtimeMs: 3 },
      1024,
      { openFile: async () => handle },
    ),
    (error) =>
      error instanceof SourceFileReadError &&
      error.code === "ECLOSE" &&
      error.message.includes("close failed"),
  );
});
