import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ARCHIVE_FORMAT_VERSION,
  archiveFolderName,
  copyArchiveSnapshotFiles,
  copyTree,
  pathExists,
  sanitizeTitle,
  validateArchive,
  writeMetadata,
} from "../src/archive.mjs";
import { temporaryDirectory, writeText } from "./helpers.mjs";

test("creates stable timestamped archive names", () => {
  const date = new Date(2026, 6, 31, 21, 36, 7);
  assert.equal(
    archiveFolderName('A/B: "session"', date),
    "2026-07-31 21.36.07 - copilot-stash2d - A B session",
  );
  assert.equal(sanitizeTitle("..."), "session");
});

test("validates structure while allowing edited archive content", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeText(path.join(directory, "Session.md"), "edited transcript");
  await writeText(path.join(directory, "Handoff.md"), "edited handoff");
  await writeMetadata(directory, {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    title: "edited metadata",
  });

  const metadata = await validateArchive(directory);
  assert.equal(metadata.title, "edited metadata");
});

test("rejects unsupported archive versions", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeText(path.join(directory, "Session.md"), "session");
  await writeText(path.join(directory, "Handoff.md"), "handoff");
  await writeMetadata(directory, { formatVersion: 99 });

  await assert.rejects(
    validateArchive(directory),
    /Unsupported archive format version: 99/,
  );
});

test("rejects oversized metadata before parsing it", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeText(path.join(directory, "Session.md"), "session");
  await writeText(path.join(directory, "Handoff.md"), "handoff");
  await writeText(path.join(directory, "Metadata.json"), '{"large":"value"}');

  await assert.rejects(
    validateArchive(directory, { maxMetadataBytes: 4 }),
    /Metadata\.json is 17 bytes.*safety limit is 4/,
  );
});

test("rejects symlinks in edited archives before apply", async (t) => {
  const directory = await temporaryDirectory(t);
  const outside = path.join(directory, "outside.txt");
  const archive = path.join(directory, "archive");
  await writeText(outside, "sensitive");
  await writeText(path.join(archive, "Session.md"), "session");
  await writeText(path.join(archive, "Handoff.md"), "handoff");
  await writeMetadata(archive, { formatVersion: ARCHIVE_FORMAT_VERSION });
  await mkdir(path.join(archive, "Context"));
  await symlink(outside, path.join(archive, "Context", "linked.txt"));

  await assert.rejects(
    validateArchive(archive),
    /Archive symlinks are not supported|Linked path components are not supported/,
  );
});

test("copies an artifact tree and rejects symlinks", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await writeText(path.join(source, "nested", "artifact.txt"), "artifact");

  const entries = await copyTree(source, destination);
  assert.deepEqual(entries, [
    { archivedPath: "nested/artifact.txt", byteSize: 8 },
  ]);
  assert.equal(
    await readFile(path.join(destination, "nested", "artifact.txt"), "utf8"),
    "artifact",
  );

  await mkdir(path.join(directory, "linked-source"));
  await symlink(
    path.join(source, "nested", "artifact.txt"),
    path.join(directory, "linked-source", "artifact-link"),
  );
  await assert.rejects(
    copyTree(
      path.join(directory, "linked-source"),
      path.join(directory, "linked-destination"),
    ),
    /symlinks are not supported/,
  );
});

test("rejects a file passed as the copyTree root", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "artifact.txt");
  await writeText(source, "artifact");

  await assert.rejects(
    copyTree(source, path.join(directory, "destination")),
    /root must be a directory/,
  );
});

test("bounds archive entry count and nesting depth", async (t) => {
  const directory = await temporaryDirectory(t);
  const archive = path.join(directory, "archive");
  await writeText(path.join(archive, "Session.md"), "session");
  await writeText(path.join(archive, "Handoff.md"), "handoff");
  await writeMetadata(archive, { formatVersion: ARCHIVE_FORMAT_VERSION });
  await writeText(path.join(archive, "Context", "one.txt"), "one");
  await writeText(path.join(archive, "Context", "nested", "two.txt"), "two");

  await assert.rejects(
    validateArchive(archive, { maxEntries: 4 }),
    /safety limit of 4 entries/,
  );
  await assert.rejects(
    validateArchive(archive, { maxDepth: 1 }),
    /safety depth limit of 1/,
  );
});

test("bounds and verifies session artifact copies", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "source");
  const sourceFile = path.join(source, "artifact.txt");
  const destination = path.join(directory, "destination");
  await writeText(sourceFile, "original");

  await assert.rejects(
    copyTree(source, destination, { maxBytes: 2 }),
    /safety limit of 2 total bytes/,
  );

  await assert.rejects(
    copyTree(source, destination, {
      beforeCopy: async (filePath) => {
        await writeText(filePath, "replacement");
      },
    }),
    /Source file changed while it was being copied/,
  );
  assert.equal(
    await pathExists(path.join(destination, "artifact.txt")),
    false,
  );
});

test("rejects snapshot attachment path traversal", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourceRoot = path.join(directory, "source");
  const destinationRoot = path.join(directory, "snapshot");
  const sourcePath = path.join(sourceRoot, "Context", "input.txt");
  await writeText(sourcePath, "input");
  const info = await stat(sourcePath);
  const attachment = {
    path: sourcePath,
    identity: {
      device: info.dev,
      inode: info.ino,
      byteSize: info.size,
      mtimeMs: info.mtimeMs,
    },
  };

  for (const displayName of [
    "Context/../../evil.txt",
    "Context/../evil.txt",
  ]) {
    await assert.rejects(
      copyArchiveSnapshotFiles(sourceRoot, destinationRoot, [
        { ...attachment, displayName },
      ]),
      /Archive attachment path is invalid/,
    );
  }
  assert.equal(await pathExists(path.join(directory, "evil.txt")), false);
});

test("rejects snapshot source paths outside the archive root", async (t) => {
  const directory = await temporaryDirectory(t);
  const sourceRoot = path.join(directory, "source");
  const destinationRoot = path.join(directory, "snapshot");
  const outsidePath = path.join(directory, "outside.txt");
  await writeText(outsidePath, "outside");
  const info = await stat(outsidePath);

  await assert.rejects(
    copyArchiveSnapshotFiles(sourceRoot, destinationRoot, [
      {
        displayName: "Context/outside.txt",
        path: outsidePath,
        identity: {
          device: info.dev,
          inode: info.ino,
          byteSize: info.size,
          mtimeMs: info.mtimeMs,
        },
      },
    ]),
    /escaped its source directory/,
  );
  assert.equal(
    await pathExists(path.join(destinationRoot, "Context", "outside.txt")),
    false,
  );
});
