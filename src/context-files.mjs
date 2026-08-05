import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function copilotInternalRoots({
  env = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
} = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const roots = new Set([
    env.COPILOT_HOME || platformPath.join(homeDirectory, ".copilot"),
  ]);

  if (env.COPILOT_CACHE_HOME) {
    roots.add(env.COPILOT_CACHE_HOME);
  } else if (platform === "darwin") {
    roots.add(platformPath.join(homeDirectory, "Library", "Caches", "copilot"));
  } else if (platform === "win32" && env.LOCALAPPDATA) {
    roots.add(platformPath.join(env.LOCALAPPDATA, "copilot"));
  } else {
    roots.add(
      platformPath.join(
        env.XDG_CACHE_HOME || platformPath.join(homeDirectory, ".cache"),
        "copilot",
      ),
    );
  }

  if (env.COPILOT_PLUGIN_DATA) {
    roots.add(env.COPILOT_PLUGIN_DATA);
  }
  return [...roots].map((root) => platformPath.resolve(root));
}

function cleanCandidate(value) {
  let candidate = value.trim();
  candidate = candidate.replace(/^file:\/\//, "");
  candidate = candidate.replace(/[),.;:]+$/g, "");
  candidate = candidate.replace(/:(?:\d+)(?::\d+)?$/g, "");
  if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  return candidate;
}

function splitFusedPaths(value) {
  const separators = [
    ...value.matchAll(/:(?=(?:~[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\))/g),
  ].filter(
    (match) => !(match.index === 1 && /^[A-Za-z]$/.test(value[0])),
  );
  const parts = [];
  let start = 0;
  for (const separator of separators) {
    parts.push(value.slice(start, separator.index));
    start = separator.index + 1;
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function extractReferencedPaths(markdown) {
  const values = new Set();
  const patterns = [
    {
      expression:
        /`((?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|[^`\s/\\]+[\\/])[^`\r\n]+)`/g,
      bare: false,
    },
    {
      expression:
        /["']((?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|[^"'\s/\\]+[\\/])[^"'\r\n]+)["']/g,
      bare: false,
    },
    {
      expression:
        /(?:^|\s)((?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s<>{}\[\]"'`]+)/gm,
      bare: true,
    },
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern.expression)) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(match[1])) {
        continue;
      }
      for (const fragment of splitFusedPaths(match[1])) {
        const candidate = cleanCandidate(fragment);
        if (candidate.startsWith("//")) {
          continue;
        }
        if (
          pattern.bare &&
          candidate.startsWith("/") &&
          !candidate.slice(1).includes("/")
        ) {
          continue;
        }
        if (candidate) {
          values.add(candidate);
        }
      }
    }
  }
  return [...values];
}

async function gitRootFor(filePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", path.dirname(filePath), "rev-parse", "--show-toplevel"],
      {
        timeout: 5000,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    return { root: stdout.trim() || undefined };
  } catch (error) {
    if (
      error?.stderr?.includes("not a git repository")
    ) {
      return {};
    }
    if (error?.code === "ENOENT") {
      return {
        warning:
          "Git is unavailable, so referenced external files could not be safely classified and were skipped.",
      };
    }
    return {
      warning: `Unable to determine whether referenced files belong to a Git repository, so unclassifiable files were skipped. ${error.message}`,
    };
  }
}

export async function discoverExternalContextFiles(
  markdown,
  sourcePath,
  {
    baseDirectory = process.cwd(),
    excludedRoots = [],
    classifyGitRoot = gitRootFor,
    resolveRealPath = realpath,
    getFileInfo = stat,
    maxDirectoryFiles = 200,
    maxDirectoryDirectories = 50,
    onWarning = async () => {},
  } = {},
) {
  const warnings = new Set();
  async function warnOnce(key, message) {
    if (!warnings.has(key)) {
      warnings.add(key);
      await onWarning(message);
    }
  }

  let sourceRealPath;
  if (sourcePath) {
    try {
      sourceRealPath = await resolveRealPath(sourcePath);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        await warnOnce(
          `source:${error?.code ?? error?.message}`,
          `The source transcript path could not be resolved and will not be used for external-file exclusion. ${error.message}`,
        );
      }
    }
  }
  const configuredRoots = [
    ...copilotInternalRoots(),
    ...excludedRoots.filter(Boolean),
  ];
  const ignoredRoots = await Promise.all(
    configuredRoots.map(async (root) => {
      try {
        return await resolveRealPath(root);
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
          await warnOnce(
            `root:${error?.code ?? error?.message}`,
            `An exclusion root could not be resolved; its lexical path will still be excluded. ${error.message}`,
          );
        }
        return path.resolve(root);
      }
    }),
  );
  const candidates = [];
  const seen = new Set();
  const skippedCandidateErrors = new Set();
  const gitClassificationCache = new Map();

  async function gitClassificationFor(resolvedPath) {
    const directory = path.dirname(resolvedPath);
    if (!gitClassificationCache.has(directory)) {
      gitClassificationCache.set(
        directory,
        Promise.resolve(classifyGitRoot(resolvedPath)),
      );
    }
    return gitClassificationCache.get(directory);
  }
  async function classifyFile(
    resolvedPath,
    originalPath,
    relativePath = path.basename(resolvedPath),
    { skipGitClassification = false, pendingSeen } = {},
  ) {
    if (
      resolvedPath === sourceRealPath ||
      seen.has(resolvedPath) ||
      pendingSeen?.has(resolvedPath)
    ) {
      return undefined;
    }
    if (ignoredRoots.some((root) => isWithinRoot(resolvedPath, root))) {
      return undefined;
    }
    (pendingSeen ?? seen).add(resolvedPath);
    if (!skipGitClassification) {
      const classification = await gitClassificationFor(resolvedPath);
      if (classification.warning) {
        await warnOnce("git-classification", classification.warning);
        return undefined;
      }
      if (classification.root) {
        return undefined;
      }
    }
    const info = await getFileInfo(resolvedPath);
    return {
      originalPath,
      resolvedPath,
      relativePath,
      byteSize: info.size,
    };
  }

  async function collectDirectoryFiles(directoryPath, originalPath) {
    const rootClassification = await gitClassificationFor(
      path.join(directoryPath, ".stash2d-directory-probe"),
    );
    if (rootClassification.warning) {
      await warnOnce("git-classification", rootClassification.warning);
      return [];
    }
    if (rootClassification.root) {
      return [];
    }

    const files = [];
    const pendingSeen = new Set();
    let directoryCount = 0;
    let limitExceeded = false;

    async function hasGitMarker(directoryPath) {
      try {
        await getFileInfo(path.join(directoryPath, ".git"));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          return false;
        }
        skippedCandidateErrors.add(error?.code ?? "unknown error");
        return true;
      }
    }

    async function visit(currentPath, relativeRoot = "") {
      if (limitExceeded) {
        return;
      }
      directoryCount += 1;
      if (directoryCount > maxDirectoryDirectories) {
        limitExceeded = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(currentPath, { withFileTypes: true });
      } catch (error) {
        skippedCandidateErrors.add(error?.code ?? "unknown error");
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (limitExceeded) {
          return;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.name === ".git") {
          continue;
        }
        const entryPath = path.join(currentPath, entry.name);
        const relativePath = path.join(relativeRoot, entry.name);
        if (entry.isDirectory()) {
          if (
            ignoredRoots.some((root) => isWithinRoot(entryPath, root)) ||
            (await hasGitMarker(entryPath))
          ) {
            continue;
          }
          await visit(entryPath, relativePath);
        } else if (entry.isFile()) {
          if (files.length >= maxDirectoryFiles) {
            limitExceeded = true;
            return;
          }
          try {
            const resolvedPath = await resolveRealPath(entryPath);
            const file = await classifyFile(
              resolvedPath,
              originalPath,
              relativePath,
              { skipGitClassification: true, pendingSeen },
            );
            if (file) {
              files.push(file);
            }
          } catch (error) {
            skippedCandidateErrors.add(error?.code ?? "unknown error");
          }
        }
      }
    }
    await visit(directoryPath);
    if (limitExceeded) {
      await warnOnce(
        `directory-limit:${directoryPath}`,
        `Referenced directory ${directoryPath} exceeds the discovery safety limit of ${maxDirectoryFiles} files or ${maxDirectoryDirectories} directories and was skipped.`,
      );
      return [];
    }
    for (const resolvedPath of pendingSeen) {
      seen.add(resolvedPath);
    }
    return files;
  }

  const references = [];
  for (const referencedPath of extractReferencedPaths(markdown)) {
    const absolutePath = path.resolve(baseDirectory, referencedPath);
    try {
      const resolvedPath = await resolveRealPath(absolutePath);
      references.push({
        referencedPath,
        resolvedPath,
        info: await getFileInfo(resolvedPath),
      });
    } catch (error) {
      skippedCandidateErrors.add(error?.code ?? "unknown error");
    }
  }

  references.sort(
    (left, right) =>
      Number(right.info.isDirectory()) - Number(left.info.isDirectory()),
  );
  for (const { referencedPath, resolvedPath, info } of references) {
    if (info.isDirectory()) {
      if (ignoredRoots.some((root) => isWithinRoot(resolvedPath, root))) {
        continue;
      }
      const files = await collectDirectoryFiles(resolvedPath, referencedPath);
      if (files.length > 0) {
        candidates.push({
          kind: "directory",
          originalPath: referencedPath,
          resolvedPath,
          fileCount: files.length,
          byteSize: files.reduce((total, file) => total + file.byteSize, 0),
          files,
        });
      }
      continue;
    }
    if (!info.isFile()) {
      continue;
    }
    const file = await classifyFile(resolvedPath, referencedPath);
    if (file) {
      candidates.push({
        kind: "file",
        ...file,
        fileCount: 1,
        files: [file],
      });
    }
  }

  if (skippedCandidateErrors.size > 0) {
    await onWarning(
      `Some optional referenced paths could not be inspected and were skipped (${[...skippedCandidateErrors].join(", ")}).`,
    );
  }

  return candidates;
}

function safeBaseName(filePath) {
  return path.basename(filePath).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_");
}

export async function copyExternalContextFiles(candidates, archivePath) {
  const entries = [];
  if (candidates.length === 0) {
    return entries;
  }
  const contextPath = path.join(archivePath, "Context");
  await mkdir(contextPath, { recursive: true });

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const prefix = String(index + 1).padStart(3, "0");
    const files = candidate.files ?? [
      {
        originalPath: candidate.originalPath,
        resolvedPath: candidate.resolvedPath,
        relativePath: path.basename(candidate.resolvedPath),
        byteSize: candidate.byteSize,
      },
    ];
    for (const file of files) {
      const archivedPath =
        candidate.kind === "directory"
          ? path.join(
              "Context",
              `${prefix}-${safeBaseName(candidate.resolvedPath)}`,
              ...file.relativePath.split(path.sep).map(safeBaseName),
            )
          : path.join(
              "Context",
              `${prefix}-${safeBaseName(file.resolvedPath)}`,
            );
      await mkdir(path.dirname(path.join(archivePath, archivedPath)), {
        recursive: true,
      });
      await copyFile(
        file.resolvedPath,
        path.join(archivePath, archivedPath),
      );
      entries.push({
        originalPath: file.originalPath,
        resolvedSourcePath: file.resolvedPath,
        archivedPath: archivedPath.split(path.sep).join("/"),
        byteSize: file.byteSize,
      });
    }
  }
  return entries;
}
