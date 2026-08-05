import {
  copyFile,
  lstat,
  mkdir,
  opendir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  assertNoLinkedPathComponents,
  copyVerifiedFile,
  fileIdentity,
  readVerifiedFile,
} from "./secure-files.mjs";

export const ARCHIVE_FORMAT_VERSION = 1;
export const MAX_ARCHIVE_ENTRIES = 6000;
export const MAX_ARCHIVE_DIRECTORIES = 1000;
export const MAX_ARCHIVE_DEPTH = 64;
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ".",
    pad(date.getMinutes()),
    ".",
    pad(date.getSeconds()),
  ].join("");
}

export function sanitizeTitle(title) {
  const sanitized = String(title ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return sanitized || "session";
}

export function archiveFolderName(title, date = new Date()) {
  return `${formatLocalTimestamp(date)} - copilot-stash2d - ${sanitizeTitle(title)}`;
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function createArchiveDirectory(outputDirectory, title, date = new Date()) {
  const archivePath = path.join(
    outputDirectory,
    archiveFolderName(title, date),
  );
  try {
    await mkdir(archivePath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Archive destination already exists: ${archivePath}`);
    }
    throw error;
  }
  return archivePath;
}

export async function writeHandoff(archivePath, handoff) {
  await writeFile(
    path.join(archivePath, "Handoff.md"),
    `${handoff.trim()}\n`,
    "utf8",
  );
}

export async function writeMetadata(archivePath, metadata) {
  await writeFile(
    path.join(archivePath, "Metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export async function removeIncompleteArchive(archivePath) {
  if (archivePath) {
    await rm(archivePath, { recursive: true, force: true });
  }
}

export async function copyTree(
  sourceRoot,
  destinationRoot,
  {
    maxBytes = MAX_ARCHIVE_BYTES,
    maxDepth = MAX_ARCHIVE_DEPTH,
    maxDirectories = MAX_ARCHIVE_DIRECTORIES,
    maxEntries = MAX_ARCHIVE_ENTRIES,
  } = {},
) {
  const resolvedRoot = await realpath(sourceRoot);
  const rootInfo = await stat(resolvedRoot);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Session artifact root must be a directory: ${sourceRoot}`);
  }
  const copied = [];
  let directoryCount = 0;
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(source, destination, relativePath, depth = 0) {
    if (depth > maxDepth) {
      throw new Error(
        `Session artifacts exceed the safety depth limit of ${maxDepth}: ${source}`,
      );
    }
    const info = await stat(source);
    const resolved = await realpath(source);
    if (
      resolved !== resolvedRoot &&
      !resolved.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new Error(`Session artifact escapes its source directory: ${source}`);
    }
    if (info.isDirectory()) {
      directoryCount += 1;
      if (directoryCount > maxDirectories) {
        throw new Error(
          `Session artifacts exceed the safety limit of ${maxDirectories} directories.`,
        );
      }
      await mkdir(destination, { recursive: true });
      const directory = await opendir(source);
      try {
        for await (const entry of directory) {
          entryCount += 1;
          if (entryCount > maxEntries) {
            throw new Error(
              `Session artifacts exceed the safety limit of ${maxEntries} entries.`,
            );
          }
          if (entry.isSymbolicLink()) {
            throw new Error(`Session artifact symlinks are not supported: ${path.join(source, entry.name)}`);
          }
          await visit(
            path.join(source, entry.name),
            path.join(destination, entry.name),
            path.join(relativePath, entry.name),
            depth + 1,
          );
        }
      } finally {
        await directory.close().catch(() => {});
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(`Unsupported session artifact type: ${source}`);
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      throw new Error(
        `Session artifacts exceed the safety limit of ${maxBytes} total bytes.`,
      );
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied.push({
      archivedPath: relativePath.split(path.sep).join("/"),
      byteSize: info.size,
    });
  }

  await visit(sourceRoot, destinationRoot, "");
  return copied;
}

export async function copyArchiveSnapshotFiles(
  sourceRoot,
  destinationRoot,
  attachments,
) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  for (const attachment of attachments) {
    const relativePath = attachment.displayName
      .split("/")
      .join(path.sep);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `Archive attachment path is invalid: ${attachment.displayName}`,
      );
    }
    const expectedSourcePath = path.resolve(resolvedSourceRoot, relativePath);
    if (path.relative(expectedSourcePath, attachment.path) !== "") {
      throw new Error(
        `Archive attachment escaped its source directory: ${attachment.path}`,
      );
    }
    await copyVerifiedFile(
      attachment.path,
      path.join(destinationRoot, relativePath),
      attachment.identity,
    );
  }
}

export async function inspectArchive(
  archivePath,
  {
    maxBytes = MAX_ARCHIVE_BYTES,
    maxDepth = MAX_ARCHIVE_DEPTH,
    maxDirectories = MAX_ARCHIVE_DIRECTORIES,
    maxEntries = MAX_ARCHIVE_ENTRIES,
    maxMetadataBytes = 1024 * 1024,
  } = {},
) {
  const entries = [];
  let directoryCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let resolvedArchiveRoot;
  async function assertSafeTree(entryPath, depth = 0) {
    if (depth > maxDepth) {
      throw new Error(
        `Archive exceeds the safety depth limit of ${maxDepth}: ${entryPath}`,
      );
    }
    await assertNoLinkedPathComponents(entryPath);
    const resolvedPath = await realpath(entryPath);
    if (!isWithinRoot(resolvedPath, resolvedArchiveRoot)) {
      throw new Error(`Archive entry escapes its root: ${entryPath}`);
    }
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Archive symlinks are not supported: ${entryPath}`);
    }
    if (info.isDirectory()) {
      directoryCount += 1;
      if (directoryCount > maxDirectories) {
        throw new Error(
          `Archive exceeds the safety limit of ${maxDirectories} directories.`,
        );
      }
      if (depth > 0) {
        entries.push({
          identity: fileIdentity(info),
          relativePath: path
            .relative(archivePath, entryPath)
            .split(path.sep)
            .join("/"),
          sourcePath: entryPath,
          type: "directory",
        });
      }
      const directory = await opendir(entryPath);
      try {
        for await (const entry of directory) {
          entryCount += 1;
          if (entryCount > maxEntries) {
            throw new Error(
              `Archive exceeds the safety limit of ${maxEntries} entries.`,
            );
          }
          await assertSafeTree(
            path.join(entryPath, entry.name),
            depth + 1,
          );
        }
      } finally {
        await directory.close().catch(() => {});
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(`Unsupported archive entry type: ${entryPath}`);
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      throw new Error(
        `Archive exceeds the safety limit of ${maxBytes} total bytes.`,
      );
    }
    entries.push({
      identity: fileIdentity(info),
      relativePath: path
        .relative(archivePath, entryPath)
        .split(path.sep)
        .join("/"),
      sourcePath: entryPath,
      type: "file",
    });
  }

  let rootInfo;
  try {
    rootInfo = await lstat(archivePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Archive directory does not exist: ${archivePath}`);
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Archive path must be a real directory: ${archivePath}`);
  }
  resolvedArchiveRoot = await realpath(archivePath);
  await assertSafeTree(archivePath);

  const requiredFiles = ["Session.md", "Handoff.md", "Metadata.json"];
  let metadataEntry;
  for (const fileName of requiredFiles) {
    const entry = entries.find(
      (candidate) => candidate.relativePath === fileName,
    );
    if (!entry) {
      throw new Error(`Archive is missing required file: ${fileName}`);
    }
    if (entry.type !== "file") {
      throw new Error(`Archive entry must be a regular file: ${fileName}`);
    }
    if (fileName === "Metadata.json") {
      metadataEntry = entry;
    }
  }
  if (metadataEntry.identity.byteSize > maxMetadataBytes) {
    throw new Error(
      `Metadata.json is ${metadataEntry.identity.byteSize} bytes; the Stash2D safety limit is ${maxMetadataBytes}.`,
    );
  }

  const metadataContent = await readVerifiedFile(
    metadataEntry.sourcePath,
    metadataEntry.identity,
    maxMetadataBytes,
  );
  let metadata;
  try {
    metadata = JSON.parse(metadataContent.toString("utf8"));
  } catch (error) {
    throw new Error(`Metadata.json is not valid JSON: ${error.message}`);
  }
  if (metadata.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported archive format version: ${metadata.formatVersion ?? "missing"}`,
    );
  }
  return {
    entries,
    metadata,
    totals: {
      bytes: totalBytes,
      directories: directoryCount,
      entries: entryCount,
    },
  };
}

export async function validateArchive(archivePath, options) {
  return (await inspectArchive(archivePath, options)).metadata;
}

export async function listFilesRecursively(
  directoryPath,
  {
    maxDepth = MAX_ARCHIVE_DEPTH,
    maxEntries = MAX_ARCHIVE_ENTRIES,
  } = {},
) {
  if (!(await pathExists(directoryPath))) {
    return [];
  }
  const files = [];
  let entryCount = 0;

  async function visit(currentPath, depth = 0) {
    if (depth > maxDepth) {
      throw new Error(
        `Directory exceeds the safety depth limit of ${maxDepth}: ${currentPath}`,
      );
    }
    const info = await lstat(currentPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Archive symlinks are not supported: ${currentPath}`);
    }
    if (info.isFile()) {
      files.push(currentPath);
      return;
    }
    if (!info.isDirectory()) {
      throw new Error(`Unsupported archive entry type: ${currentPath}`);
    }
    const directory = await opendir(currentPath);
    try {
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > maxEntries) {
          throw new Error(
            `Directory exceeds the safety limit of ${maxEntries} entries: ${directoryPath}`,
          );
        }
        await visit(path.join(currentPath, entry.name), depth + 1);
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }

  await visit(directoryPath);
  return files.sort();
}
