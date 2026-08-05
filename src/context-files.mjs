import {
  lstat,
  mkdir,
  opendir,
  realpath,
  stat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { directoryLimitWarning } from "./messages.mjs";
import {
  assertNoLinkedPathComponents,
  copyVerifiedFile,
  fileIdentity,
  SourceFileCopyError,
  SourceFileChangedError,
} from "./secure-files.mjs";

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

function cleanCandidate(
  value,
  {
    expandHome = true,
    homeDirectory = os.homedir(),
  } = {},
) {
  let candidate = value.trim();
  candidate = candidate.replace(/^file:\/\//, "");
  candidate = candidate.replace(/[),.;:]+$/g, "");
  candidate = candidate.replace(/:(?:\d+)(?::\d+)?$/g, "");
  if (
    expandHome &&
    (candidate.startsWith("~/") || candidate.startsWith("~\\"))
  ) {
    candidate = path.join(homeDirectory, candidate.slice(2));
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
    parts.push({ start, value: value.slice(start, separator.index) });
    start = separator.index + 1;
  }
  parts.push({ start, value: value.slice(start) });
  return parts
    .map((part) => {
      const leadingWhitespace = part.value.length - part.value.trimStart().length;
      return {
        start: part.start + leadingWhitespace,
        value: part.value.trim(),
      };
    })
    .filter((part) => part.value);
}

function extractReferencedPathReferences(
  markdown,
  { homeDirectory = os.homedir() } = {},
) {
  const values = new Map();
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
      const captureOffset = match[0].indexOf(match[1]);
      for (const fragment of splitFusedPaths(match[1])) {
        const originalPath = cleanCandidate(fragment.value, {
          expandHome: false,
        });
        const referencedPath = cleanCandidate(fragment.value, {
          homeDirectory,
        });
        const candidate = referencedPath;
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
          const start = match.index + captureOffset + fragment.start;
          const end = start + originalPath.length;
          values.set(`${start}\0${end}\0${originalPath}\0${referencedPath}`, {
            end,
            originalPath,
            referencedPath,
            start,
          });
        }
      }
    }
  }
  return [...values.values()];
}

function attachmentReference(attachmentPath, homeDirectory) {
  const referencedPath =
    attachmentPath === "~"
      ? homeDirectory
      : attachmentPath.startsWith("~/") || attachmentPath.startsWith("~\\")
        ? path.join(homeDirectory, attachmentPath.slice(2))
        : attachmentPath;
  return {
    originalPath: attachmentPath,
    referencedPath,
    source: "attachment",
    directoryIntent: true,
  };
}

export function extractReferencedPaths(markdown, options) {
  return [
    ...new Set(
      parseMessagePathReferences(markdown, options).map(
        ({ referencedPath }) => referencedPath,
      ),
    ),
  ];
}

function clauseBounds(line, span, spans) {
  const separators = /[;.!?]/g;
  let start = 0;
  let end = line.length;
  for (const match of line.matchAll(separators)) {
    if (
      spans.some(
        (reference) =>
          match.index >= reference.start && match.index < reference.end,
      )
    ) {
      continue;
    }
    if (match.index < span.start) {
      start = match.index + 1;
    } else if (match.index >= span.end) {
      end = match.index;
      break;
    }
  }
  return { start, end };
}

function parseMessagePathReferences(
  markdown,
  { homeDirectory = os.homedir() } = {},
) {
  const intent =
    /\b(?:analy[sz](?:e|ed|ing)|archiv(?:e|ed|ing)|cop(?:y|ied|ying)|includ(?:e|ed|ing)|inspect(?:ed|ing)?|keep|kept|look(?:ed|ing)?|mov(?:e|ed|ing)|open(?:ed|ing)?|put|read(?:ing)?|review(?:ed|ing)?|sav(?:e|ed|ing)|scan(?:ned|ning)?|search(?:ed|ing)?|stor(?:e|ed|ing)|use(?:d|ing)?)\b/i;
  const references = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const spans = extractReferencedPathReferences(line, {
      homeDirectory,
    }).sort((left, right) => left.start - right.start);
    for (const span of spans) {
      const bounds = clauseBounds(line, span, spans);
      const clauseReferences = spans.filter(
        (reference) =>
          reference.start >= bounds.start && reference.end <= bounds.end,
      );
      const clause = line.slice(bounds.start, bounds.end);
      const surroundingText = [...clauseReferences]
        .sort((left, right) => right.start - left.start)
        .reduce(
          (text, reference) =>
            `${text.slice(0, reference.start - bounds.start)}${text.slice(reference.end - bounds.start)}`,
          clause,
        );
      const key = `${span.originalPath}\0${span.referencedPath}`;
      const existing = references.get(key);
      references.set(key, {
        originalPath: span.originalPath,
        referencedPath: span.referencedPath,
        source: "message",
        directoryIntent:
          Boolean(existing?.directoryIntent) || intent.test(surroundingText),
      });
    }
  }
  return [...references.values()];
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
    attachmentReferences = [],
    baseDirectory = process.cwd(),
    homeDirectory = os.homedir(),
    excludedRoots = [],
    classifyGitRoot = gitRootFor,
    resolveRealPath = realpath,
    getFileInfo = stat,
    getLinkInfo = lstat,
    maxDirectoryFiles = 200,
    maxDirectoryDirectories = 50,
    maxDirectoryEntries = 1000,
    openDirectory = opendir,
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
    ...copilotInternalRoots({ homeDirectory }),
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
  const checkedPathComponents = new Set();

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
    { pendingSeen, skipGitClassification = false, source = "message" } = {},
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
    (pendingSeen ?? seen).add(resolvedPath);
    return {
      ...fileIdentity(info),
      originalPath,
      resolvedPath,
      relativePath,
      source,
      byteSize: info.size,
    };
  }

  async function collectDirectoryFiles(
    directoryPath,
    originalPath,
    explicitFilePaths,
    source,
  ) {
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
    let entryCount = 0;
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
      let directory;
      try {
        await assertNoLinkedPathComponents(currentPath, { getLinkInfo });
        const resolvedDirectory = await resolveRealPath(currentPath);
        if (!isWithinRoot(resolvedDirectory, directoryPath)) {
          skippedCandidateErrors.add("PATH_ESCAPE");
          return;
        }
        directory = await openDirectory(resolvedDirectory);
      } catch (error) {
        skippedCandidateErrors.add(error?.code ?? "unknown error");
        return;
      }
      try {
        for await (const entry of directory) {
          entryCount += 1;
          if (entryCount > maxDirectoryEntries) {
            limitExceeded = true;
            return;
          }
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
              await assertNoLinkedPathComponents(entryPath, {
                getLinkInfo,
              });
              const resolvedPath = await resolveRealPath(entryPath);
              if (!isWithinRoot(resolvedPath, directoryPath)) {
                skippedCandidateErrors.add("PATH_ESCAPE");
                continue;
              }
              if (explicitFilePaths.has(resolvedPath)) {
                continue;
              }
              const file = await classifyFile(
                resolvedPath,
                originalPath,
                relativePath,
                { pendingSeen, skipGitClassification: true, source },
              );
              if (file) {
                files.push(file);
              }
            } catch (error) {
              skippedCandidateErrors.add(error?.code ?? "unknown error");
            }
          }
        }
      } finally {
        await directory.close().catch(() => {});
      }
    }
    await visit(directoryPath);
    if (limitExceeded) {
      await warnOnce(
        `directory-limit:${directoryPath}`,
        directoryLimitWarning(directoryPath, {
          maxFiles: maxDirectoryFiles,
          maxDirectories: maxDirectoryDirectories,
          maxEntries: maxDirectoryEntries,
        }),
      );
      return [];
    }
    files.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    for (const resolvedPath of pendingSeen) {
      seen.add(resolvedPath);
    }
    return files;
  }

  const references = [];
  const extractedReferences = [
    ...parseMessagePathReferences(markdown, { homeDirectory }),
    ...attachmentReferences
      .filter(
        (reference) =>
          reference?.source === "attachment" &&
          typeof reference.path === "string",
      )
      .map((reference) =>
        attachmentReference(reference.path, homeDirectory),
      ),
  ];
  for (const {
    directoryIntent,
    originalPath,
    referencedPath,
    source,
  } of extractedReferences) {
    const absolutePath = path.resolve(baseDirectory, referencedPath);
    try {
      await assertNoLinkedPathComponents(absolutePath, {
        getLinkInfo,
        checkedPaths: checkedPathComponents,
      });
      const resolvedPath = await resolveRealPath(absolutePath);
      const info = await getFileInfo(resolvedPath);
      if (info.isDirectory() && !directoryIntent) {
        continue;
      }
      references.push({
        originalPath,
        referencedPath,
        resolvedPath,
        info,
        source,
      });
    } catch (error) {
      skippedCandidateErrors.add(error?.code ?? "unknown error");
    }
  }

  references.sort(
    (left, right) =>
      Number(right.info.isDirectory()) - Number(left.info.isDirectory()) ||
      Number(right.source === "attachment") -
        Number(left.source === "attachment"),
  );
  const explicitFilePaths = new Set(
    references
      .filter(({ info }) => info.isFile())
      .map(({ resolvedPath }) => resolvedPath),
  );
  for (const { originalPath, resolvedPath, info, source } of references) {
    if (info.isDirectory()) {
      if (ignoredRoots.some((root) => isWithinRoot(resolvedPath, root))) {
        continue;
      }
      const files = await collectDirectoryFiles(
        resolvedPath,
        originalPath,
        explicitFilePaths,
        source,
      );
      if (files.length > 0) {
        candidates.push({
          kind: "directory",
          originalPath,
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
    try {
      const file = await classifyFile(
        resolvedPath,
        originalPath,
        path.basename(resolvedPath),
        { source },
      );
      if (file) {
        candidates.push({
          kind: "file",
          ...file,
          fileCount: 1,
          files: [file],
        });
      }
    } catch (error) {
      skippedCandidateErrors.add(error?.code ?? "unknown error");
    }
  }

  if (skippedCandidateErrors.size > 0) {
    await onWarning(
      `Some optional referenced paths could not be inspected and were skipped (${[...skippedCandidateErrors].join(", ")}).`,
    );
  }

  return candidates;
}

function safePathSegment(value) {
  let segment = String(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "_");
  if (!segment) {
    segment = "_";
  }
  const deviceName = segment.split(".", 1)[0].toUpperCase();
  if (
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)
  ) {
    segment = `_${segment}`;
  }
  return segment;
}

function safeBaseName(filePath) {
  return safePathSegment(path.basename(filePath));
}

function suffixedSegment(segment, suffix, isFile) {
  if (!isFile) {
    return `${segment}-${suffix}`;
  }
  const parsed = path.parse(segment);
  return `${parsed.name}-${suffix}${parsed.ext}`;
}

function allocateArchivePath(segments, usedNodes) {
  const allocated = [];
  for (let index = 0; index < segments.length; index += 1) {
    const { identity, name } = segments[index];
    const isFile = index === segments.length - 1;
    const nodeType = isFile ? "file" : "directory";
    let segment = name;
    let suffix = 2;
    while (true) {
      const candidatePath = path.join(...allocated, segment);
      const key = candidatePath.toLowerCase();
      const existing = usedNodes.get(key);
      if (
        !existing ||
        (!isFile &&
          existing.type === "directory" &&
          existing.identity === identity)
      ) {
        usedNodes.set(key, { identity, type: nodeType });
        allocated.push(segment);
        break;
      }
      segment = suffixedSegment(name, suffix, isFile);
      suffix += 1;
    }
  }
  return path.join(...allocated);
}

export async function copyExternalContextFiles(
  candidates,
  archivePath,
  {
    beforeCopyContextFile = async () => {},
    onWarning = async () => {},
  } = {},
) {
  const entries = [];
  if (candidates.length === 0) {
    return entries;
  }
  const contextPath = path.join(archivePath, "Context");
  await mkdir(contextPath, { recursive: true });
  const skippedSourceErrors = new Set();
  const usedArchiveNodes = new Map();

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
      const archiveSegments =
        candidate.kind === "directory"
          ? [
              { identity: "Context", name: "Context" },
              {
                identity: `${prefix}:${candidate.resolvedPath}`,
                name: `${prefix}-${safeBaseName(candidate.resolvedPath)}`,
              },
              ...file.relativePath.split(path.sep).map((segment) => ({
                identity: segment,
                name: safePathSegment(segment),
              })),
            ]
          : [
              { identity: "Context", name: "Context" },
              {
                identity: `${prefix}:${file.resolvedPath}`,
                name: `${prefix}-${safeBaseName(file.resolvedPath)}`,
              },
            ];
      const archivedPath = allocateArchivePath(
        archiveSegments,
        usedArchiveNodes,
      );
      try {
        await copyVerifiedFile(
          file.resolvedPath,
          path.join(archivePath, archivedPath),
          file,
          { beforeCopy: beforeCopyContextFile },
        );
      } catch (error) {
        if (
          error instanceof SourceFileChangedError ||
          error instanceof SourceFileCopyError
        ) {
          skippedSourceErrors.add(error?.code ?? "unknown error");
          continue;
        }
        throw error;
      }
      entries.push({
        originalPath: file.originalPath,
        resolvedSourcePath: file.resolvedPath,
        source: file.source,
        archivedPath: archivedPath.split(path.sep).join("/"),
        byteSize: file.byteSize,
      });
    }
  }
  if (skippedSourceErrors.size > 0) {
    await onWarning(
      `Some approved optional context files became unavailable while the archive was being created and were skipped (${[...skippedSourceErrors].join(", ")}).`,
    );
  }
  return entries;
}
