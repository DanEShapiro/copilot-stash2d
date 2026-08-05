import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
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
  return value
    .split(/:(?=(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\))/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractReferencedPaths(markdown) {
  const values = new Set();
  const patterns = [
    {
      expression:
        /`((?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^`\r\n]+)`/g,
      bare: false,
    },
    {
      expression:
        /["']((?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^"'\r\n]+)["']/g,
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
      for (const fragment of splitFusedPaths(match[1])) {
        const candidate = cleanCandidate(fragment);
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

  for (const referencedPath of extractReferencedPaths(markdown)) {
    const absolutePath = path.resolve(baseDirectory, referencedPath);
    let resolvedPath;
    let info;
    try {
      resolvedPath = await resolveRealPath(absolutePath);
      info = await getFileInfo(resolvedPath);
    } catch (error) {
      skippedCandidateErrors.add(error?.code ?? "unknown error");
      continue;
    }
    if (!info.isFile() || resolvedPath === sourceRealPath || seen.has(resolvedPath)) {
      continue;
    }
    if (ignoredRoots.some((root) => isWithinRoot(resolvedPath, root))) {
      continue;
    }
    seen.add(resolvedPath);
    const classification = await classifyGitRoot(resolvedPath);
    if (classification.warning) {
      if (!warnings.has(classification.warning)) {
        warnings.add(classification.warning);
        await onWarning(classification.warning);
      }
      continue;
    }
    if (classification.root) {
      continue;
    }
    candidates.push({
      originalPath: referencedPath,
      resolvedPath,
      byteSize: info.size,
    });
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
    const fileName = `${String(index + 1).padStart(3, "0")}-${safeBaseName(candidate.resolvedPath)}`;
    const archivedPath = path.join("Context", fileName);
    await copyFile(candidate.resolvedPath, path.join(archivePath, archivedPath));
    entries.push({
      originalPath: candidate.originalPath,
      resolvedSourcePath: candidate.resolvedPath,
      archivedPath: archivedPath.split(path.sep).join("/"),
      byteSize: candidate.byteSize,
    });
  }
  return entries;
}
