import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  copyTree,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  pathExists,
} from "./archive.mjs";
import {
  copyVerifiedFile,
  fileIdentity,
} from "./secure-files.mjs";

async function assertNotSymlink(filePath) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error(`Session artifact symlinks are not supported: ${filePath}`);
  }
  return info;
}

export async function copySessionArtifacts(workspacePath, archivePath) {
  const entries = [];
  if (!workspacePath) {
    return { entries, unavailable: true, hasPlan: false };
  }

  const planPath = path.join(workspacePath, "plan.md");
  let hasPlan = false;
  if (await pathExists(planPath)) {
    const info = await assertNotSymlink(planPath);
    if (!info.isFile()) {
      throw new Error(`Session plan is not a regular file: ${planPath}`);
    }
    if (info.size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `Session plan exceeds the archive safety limit of ${MAX_ARCHIVE_BYTES} bytes.`,
      );
    }
    const destination = path.join(archivePath, "SessionState", "plan.md");
    await copyVerifiedFile(
      planPath,
      destination,
      fileIdentity(info),
    );
    entries.push({
      role: "plan",
      archivedPath: "SessionState/plan.md",
      byteSize: info.size,
    });
    hasPlan = true;
  }

  const filesPath = path.join(workspacePath, "files");
  if (await pathExists(filesPath)) {
    const info = await assertNotSymlink(filesPath);
    if (!info.isDirectory()) {
      throw new Error(`Session files path is not a directory: ${filesPath}`);
    }
    const copied = await copyTree(
      filesPath,
      path.join(archivePath, "SessionFiles"),
      {
        maxBytes: MAX_ARCHIVE_BYTES -
          entries.reduce((total, entry) => total + entry.byteSize, 0),
        maxEntries: MAX_ARCHIVE_ENTRIES - entries.length,
      },
    );
    entries.push(
      ...copied.map((entry) => ({
        role: "session-file",
        ...entry,
        archivedPath: path.posix.join("SessionFiles", entry.archivedPath),
      })),
    );
  }

  return { entries, unavailable: false, hasPlan };
}
