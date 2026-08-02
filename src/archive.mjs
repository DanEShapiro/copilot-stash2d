import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const ARCHIVE_FORMAT_VERSION = 1;

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

export async function copyTree(sourceRoot, destinationRoot) {
  const resolvedRoot = await realpath(sourceRoot);
  const rootInfo = await stat(resolvedRoot);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Session artifact root must be a directory: ${sourceRoot}`);
  }
  const copied = [];

  async function visit(source, destination, relativePath) {
    const info = await stat(source);
    const resolved = await realpath(source);
    if (
      resolved !== resolvedRoot &&
      !resolved.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new Error(`Session artifact escapes its source directory: ${source}`);
    }
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true });
      const entries = await readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new Error(`Session artifact symlinks are not supported: ${path.join(source, entry.name)}`);
        }
        await visit(
          path.join(source, entry.name),
          path.join(destination, entry.name),
          path.join(relativePath, entry.name),
        );
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(`Unsupported session artifact type: ${source}`);
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

export async function validateArchive(archivePath) {
  async function assertSafeTree(entryPath) {
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Archive symlinks are not supported: ${entryPath}`);
    }
    if (info.isDirectory()) {
      const entries = await readdir(entryPath, { withFileTypes: true });
      for (const entry of entries) {
        await assertSafeTree(path.join(entryPath, entry.name));
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(`Unsupported archive entry type: ${entryPath}`);
    }
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
  await assertSafeTree(archivePath);

  const requiredFiles = ["Session.md", "Handoff.md", "Metadata.json"];
  for (const fileName of requiredFiles) {
    const filePath = path.join(archivePath, fileName);
    let info;
    try {
      info = await lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Archive is missing required file: ${fileName}`);
      }
      throw error;
    }
    if (!info.isFile()) {
      throw new Error(`Archive entry must be a regular file: ${fileName}`);
    }
  }

  let metadata;
  try {
    metadata = JSON.parse(
      await readFile(path.join(archivePath, "Metadata.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(`Metadata.json is not valid JSON: ${error.message}`);
  }
  if (metadata.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported archive format version: ${metadata.formatVersion ?? "missing"}`,
    );
  }
  return metadata;
}

export async function listFilesRecursively(directoryPath) {
  if (!(await pathExists(directoryPath))) {
    return [];
  }
  const files = [];

  async function visit(currentPath) {
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
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      await visit(path.join(currentPath, entry.name));
    }
  }

  await visit(directoryPath);
  return files.sort();
}
