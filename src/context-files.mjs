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
  if (candidate.startsWith("~/")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  return candidate;
}

function splitFusedPaths(value) {
  return value
    .split(/:(?=(?:~\/|\/|[A-Za-z]:[\\/]))/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractReferencedPaths(markdown) {
  const values = new Set();
  const patterns = [
    /`((?:~\/|\/|[A-Za-z]:[\\/])[^`\r\n]+)`/g,
    /["']((?:~\/|\/|[A-Za-z]:[\\/])[^"'\r\n]+)["']/g,
    /(?:^|\s)((?:~\/|\/|[A-Za-z]:[\\/])[^\s<>{}\[\]"'`]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      for (const fragment of splitFusedPaths(match[1])) {
        const candidate = cleanCandidate(fragment);
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
      { timeout: 5000 },
    );
    return stdout.trim() || undefined;
  } catch (error) {
    if (
      error?.code === 128 ||
      error?.stderr?.includes("not a git repository")
    ) {
      return undefined;
    }
    if (error?.code === "ENOENT") {
      throw new Error("git is required to classify referenced files.");
    }
    throw new Error(
      `Unable to determine whether this file belongs to a Git repository: ${filePath}. ${error.message}`,
    );
  }
}

export async function discoverExternalContextFiles(
  markdown,
  sourcePath,
  { excludedRoots = [] } = {},
) {
  const sourceRealPath = sourcePath ? await realpath(sourcePath) : undefined;
  const configuredRoots = [
    ...copilotInternalRoots(),
    ...excludedRoots.filter(Boolean),
  ];
  const ignoredRoots = await Promise.all(
    configuredRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          return path.resolve(root);
        }
        throw error;
      }
    }),
  );
  const candidates = [];
  const seen = new Set();

  for (const referencedPath of extractReferencedPaths(markdown)) {
    const absolutePath = path.resolve(referencedPath);
    let resolvedPath;
    let info;
    try {
      resolvedPath = await realpath(absolutePath);
      info = await stat(resolvedPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
    if (!info.isFile() || resolvedPath === sourceRealPath || seen.has(resolvedPath)) {
      continue;
    }
    if (ignoredRoots.some((root) => isWithinRoot(resolvedPath, root))) {
      continue;
    }
    seen.add(resolvedPath);
    const gitRoot = await gitRootFor(resolvedPath);
    if (gitRoot) {
      continue;
    }
    candidates.push({
      originalPath: referencedPath,
      resolvedPath,
      byteSize: info.size,
    });
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
