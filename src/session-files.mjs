import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  copyTree,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_DEPTH,
  MAX_ARCHIVE_DIRECTORIES,
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

const EMPTY_USAGE = Object.freeze({
  entries: 0,
  directories: 0,
  bytes: 0,
});

function combinedUsage(...values) {
  return values.reduce(
    (total, value) => ({
      entries: total.entries + value.entries,
      directories: total.directories + value.directories,
      bytes: total.bytes + value.bytes,
    }),
    { ...EMPTY_USAGE },
  );
}

function assertUsageFitsArchive(usage) {
  if (
    usage.entries > MAX_ARCHIVE_ENTRIES ||
    usage.directories > MAX_ARCHIVE_DIRECTORIES ||
    usage.bytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error(
      "Session artifacts leave insufficient capacity for the required archive files within the archive safety limits.",
    );
  }
}

export function remainingSessionTreeBudget(
  usage,
  {
    missingPlanUsage = EMPTY_USAGE,
    reservedUsage = EMPTY_USAGE,
  } = {},
) {
  const committed = combinedUsage(
    reservedUsage,
    usage,
    missingPlanUsage,
  );
  return {
    entries:
      MAX_ARCHIVE_ENTRIES - committed.entries,
    directories:
      MAX_ARCHIVE_DIRECTORIES - committed.directories,
    bytes: MAX_ARCHIVE_BYTES - committed.bytes,
  };
}

export async function copySessionArtifacts(
  workspacePath,
  archivePath,
  {
    missingPlanUsage = EMPTY_USAGE,
    reservedUsage = EMPTY_USAGE,
  } = {},
) {
  const entries = [];
  const usage = { entries: 0, directories: 0, bytes: 0 };
  if (!workspacePath) {
    return {
      entries,
      unavailable: true,
      hasPlan: false,
      usage,
    };
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
    const planUsage = {
      entries: 2,
      directories: 1,
      bytes: info.size,
    };
    assertUsageFitsArchive(combinedUsage(reservedUsage, planUsage));
    const destination = path.join(archivePath, "SessionState", "plan.md");
    await copyVerifiedFile(
      planPath,
      destination,
      fileIdentity(info),
      { trustedDestinationRoot: archivePath },
    );
    entries.push({
      role: "plan",
      archivedPath: "SessionState/plan.md",
      byteSize: info.size,
    });
    Object.assign(usage, combinedUsage(usage, planUsage));
    hasPlan = true;
  }

  const filesPath = path.join(workspacePath, "files");
  if (await pathExists(filesPath)) {
    const info = await assertNotSymlink(filesPath);
    if (!info.isDirectory()) {
      throw new Error(`Session files path is not a directory: ${filesPath}`);
    }
    const treeBudget = remainingSessionTreeBudget(usage, {
      missingPlanUsage: hasPlan ? EMPTY_USAGE : missingPlanUsage,
      reservedUsage,
    });
    assertUsageFitsArchive({
      entries: MAX_ARCHIVE_ENTRIES - treeBudget.entries,
      directories: MAX_ARCHIVE_DIRECTORIES - treeBudget.directories,
      bytes: MAX_ARCHIVE_BYTES - treeBudget.bytes,
    });
    let treeUsage;
    const copied = await copyTree(
      filesPath,
      path.join(archivePath, "SessionFiles"),
      {
        maxBytes: treeBudget.bytes,
        maxDepth: MAX_ARCHIVE_DEPTH - 1,
        maxDirectories: treeBudget.directories,
        maxEntries: treeBudget.entries,
        onUsage: (value) => {
          treeUsage = value;
        },
      },
    );
    usage.entries += treeUsage.entries;
    usage.directories += treeUsage.directories;
    usage.bytes += treeUsage.bytes;
    entries.push(
      ...copied.map((entry) => ({
        role: "session-file",
        ...entry,
        archivedPath: path.posix.join("SessionFiles", entry.archivedPath),
      })),
    );
  }

  return {
    entries,
    unavailable: false,
    hasPlan,
    usage,
  };
}
