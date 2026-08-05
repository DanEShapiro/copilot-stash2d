import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  copilotInternalRoots,
  copyExternalContextFiles,
  discoverExternalContextFiles,
  extractReferencedPaths,
} from "../src/context-files.mjs";
import { temporaryDirectory, writeText } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

test("extracts common absolute path forms", () => {
  assert.deepEqual(
    extractReferencedPaths(
      "Read `/tmp/input file.txt`, '/tmp/other.txt', and /tmp/plain.txt.",
    ),
    ["/tmp/input file.txt", "/tmp/other.txt", "/tmp/plain.txt"],
  );
});

test("does not convert URLs or slash-prefixed network paths into files", () => {
  assert.deepEqual(
    extractReferencedPaths(
      "Open `https://example.com/page`, \"ssh://host/repo\", and `//server/share`.",
    ),
    [],
  );
});

test("splits colon-joined paths and keeps line-number suffixes usable", () => {
  assert.deepEqual(
    extractReferencedPaths("Error in /src/a.ts:/src/b.ts today."),
    ["/src/a.ts", "/src/b.ts"],
  );
  assert.deepEqual(
    extractReferencedPaths("See /src/a.ts:42:7 for details."),
    ["/src/a.ts"],
  );
});

test("preserves JSON-escaped Windows drive paths", () => {
  const escapedPath = String.raw`C:\\Users\\me\\config.json`;
  assert.deepEqual(
    extractReferencedPaths(`{"path":"${escapedPath}"}`),
    [escapedPath],
  );
});

test("extracts Windows UNC paths", () => {
  assert.deepEqual(
    extractReferencedPaths("Read `\\\\server\\share\\folder\\input.txt`."),
    ["\\\\server\\share\\folder\\input.txt"],
  );
});

test("extracts explicit relative paths", () => {
  assert.deepEqual(
    extractReferencedPaths(
      "Read `./local.txt`, '../shared/input.json', and `docs/reference`.",
    ),
    ["./local.txt", "../shared/input.json", "docs/reference"],
  );
});

test("does not treat bare slash commands or single-segment routes as files", () => {
  assert.deepEqual(
    extractReferencedPaths(
      "Use /cwd, /plugin, and /stash2d-save. API route /users. Read /tmp/input.txt and /etc/hosts.",
    ),
    ["/tmp/input.txt", "/etc/hosts"],
  );
});

test("identifies Copilot home and cache roots", () => {  assert.deepEqual(
    copilotInternalRoots({
      env: {},
      homeDirectory: "/home/example",
      platform: "linux",
    }),
    ["/home/example/.copilot", "/home/example/.cache/copilot"],
  );
});

test("discovers external files but excludes files in Git repositories", async (t) => {
  const directory = await temporaryDirectory(t);
  const external = path.join(directory, "Downloads", "input.txt");
  const repository = path.join(directory, "repo");
  const repositoryFile = path.join(repository, "src", "code.js");
  const exportPath = path.join(directory, "session.md");
  await writeText(external, "external");
  await writeText(repositoryFile, "code");
  await writeText(exportPath, "export");
  await execFileAsync("git", ["init", "-q", repository]);

  const candidates = await discoverExternalContextFiles(
    `Read \`${external}\` and \`${repositoryFile}\`.`,
    exportPath,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].resolvedPath, await realpath(external));
});

test("resolves relative references against the active working directory", async (t) => {
  const directory = await temporaryDirectory(t);
  const external = path.join(directory, "outside", "input.txt");
  const currentDirectory = path.join(directory, "work");
  await writeText(external, "external");

  const candidates = await discoverExternalContextFiles(
    "Read `../outside/input.txt`.",
    undefined,
    { baseDirectory: currentDirectory },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].resolvedPath, await realpath(external));
});

test("groups explicitly referenced directories and copies their files", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "reference");
  const first = path.join(source, "one.txt");
  const second = path.join(source, "nested", "two.txt");
  await writeText(first, "one");
  await writeText(second, "two");

  const candidates = await discoverExternalContextFiles(
    `Read every file in \`${source}\`.`,
    undefined,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "directory");
  assert.equal(candidates[0].fileCount, 2);
  assert.deepEqual(
    candidates[0].files.map((file) => file.relativePath),
    ["nested\\two.txt", "one.txt"].map((value) =>
      value.split("\\").join(path.sep),
    ),
  );

  const archive = path.join(directory, "archive");
  const entries = await copyExternalContextFiles(candidates, archive);
  assert.equal(entries.length, 2);
  assert.equal(
    await readFile(
      path.join(archive, "Context", "001-reference", "nested", "two.txt"),
      "utf8",
    ),
    "two",
  );
});

test("does not traverse a directory mentioned without archive intent", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "large-local-tree");
  await writeText(path.join(source, "one.txt"), "one");

  const candidates = await discoverExternalContextFiles(
    `The ${source} path is local, not on the sandbox. Where is it there?`,
    undefined,
  );

  assert.deepEqual(candidates, []);
});

test("preserves archive intent across comma-separated directory lists", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  await writeText(path.join(first, "one.txt"), "one");
  await writeText(path.join(second, "two.txt"), "two");

  const candidates = await discoverExternalContextFiles(
    `Archive \`${first}\`, \`${second}\`.`,
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.resolvedPath).sort(),
    [await realpath(first), await realpath(second)].sort(),
  );
});

test("keeps intent scoped for prefix paths and relative path periods", async (t) => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, "root");
  const nested = path.join(root, "test");
  const relativeSource = path.join(directory, "src");
  const relativeTest = path.join(directory, "test");
  await writeText(path.join(root, "root.txt"), "root");
  await writeText(path.join(nested, "nested.txt"), "nested");
  await writeText(path.join(relativeSource, "src.txt"), "src");
  await writeText(path.join(relativeTest, "test.txt"), "test");

  const prefixCandidates = await discoverExternalContextFiles(
    `Archive \`${nested}\`; \`${root}\` is unrelated.`,
  );
  assert.deepEqual(
    prefixCandidates.map((candidate) => candidate.resolvedPath),
    [await realpath(nested)],
  );

  const relativeCandidates = await discoverExternalContextFiles(
    "Archive `./src`, `./test`.",
    undefined,
    { baseDirectory: directory },
  );
  assert.deepEqual(
    relativeCandidates.map((candidate) => candidate.resolvedPath).sort(),
    [await realpath(relativeSource), await realpath(relativeTest)].sort(),
  );
});

test("does not treat directory nouns or child file references as directory intent", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "Downloads");
  const report = path.join(source, "report.pdf");
  await writeText(report, "report");
  await writeText(path.join(source, "private.txt"), "private");

  assert.deepEqual(
    await discoverExternalContextFiles(
      `My files are in ${source}, unrelated question about the weather.`,
    ),
    [],
  );

  const candidates = await discoverExternalContextFiles(
    `I cleaned up ${source} yesterday.\nRead \`${report}\` for the numbers.`,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "file");
  assert.equal(candidates[0].resolvedPath, await realpath(report));
});

test("does not borrow intent from trailing-separator or prefix-sibling paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const project = path.join(directory, "project");
  const projectFile = path.join(project, "src", "main.ts");
  const log = path.join(directory, "log");
  const logFile = path.join(directory, "logs", "error.txt");
  await writeText(path.join(project, "secret.env"), "secret");
  await writeText(projectFile, "main");
  await writeText(path.join(log, "old.txt"), "old");
  await writeText(logFile, "error");

  const candidates = await discoverExternalContextFiles(
    [
      `My project lives in ${project}${path.sep} by the way.`,
      `Please read \`${projectFile}\` and explain it.`,
      `${log} is where things go.`,
      `Read \`${logFile}\` for details.`,
    ].join("\n"),
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.resolvedPath).sort(),
    [await realpath(projectFile), await realpath(logFile)].sort(),
  );
  assert.ok(candidates.every((candidate) => candidate.kind === "file"));
});

test("keeps explicitly referenced files separate from approved directory groups", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "reference");
  const report = path.join(source, "report.pdf");
  await writeText(report, "report");
  await writeText(path.join(source, "other.txt"), "other");

  const candidates = await discoverExternalContextFiles(
    `Archive \`${source}\` and keep \`${report}\`.`,
  );

  assert.equal(candidates.length, 2);
  const directoryCandidate = candidates.find(
    (candidate) => candidate.kind === "directory",
  );
  const fileCandidate = candidates.find((candidate) => candidate.kind === "file");
  assert.deepEqual(
    directoryCandidate.files.map((file) => file.relativePath),
    ["other.txt"],
  );
  assert.equal(fileCandidate.resolvedPath, await realpath(report));
});

test("recognizes intent for home-relative directories and attachment paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const homeDirectory = path.join(directory, "home");
  const notes = path.join(homeDirectory, "notes");
  await writeText(path.join(notes, "one.txt"), "one");

  const homeCandidates = await discoverExternalContextFiles(
    "Read every file in `~/notes`.",
    undefined,
    { homeDirectory },
  );
  assert.equal(homeCandidates.length, 1);
  assert.equal(homeCandidates[0].kind, "directory");
  assert.equal(homeCandidates[0].originalPath, "~/notes");

  const attachmentCandidates = await discoverExternalContextFiles(
    "",
    undefined,
    {
      attachmentReferences: [{ path: notes, source: "attachment" }],
      homeDirectory,
    },
  );
  assert.equal(attachmentCandidates.length, 1);
  assert.equal(attachmentCandidates[0].kind, "directory");
});

test("uses structured attachments without trusting path-shaped user JSON", async (t) => {
  const directory = await temporaryDirectory(t);
  const attachmentDirectory = path.join(directory, "attachment");
  const impersonatedDirectory = path.join(directory, "impersonated");
  await writeText(path.join(attachmentDirectory, "keep.txt"), "keep");
  await writeText(path.join(impersonatedDirectory, "skip.txt"), "skip");

  const candidates = await discoverExternalContextFiles(
    `{"path":"${impersonatedDirectory.replaceAll("\\", "\\\\")}"}`,
    undefined,
    {
      attachmentReferences: [
        { path: attachmentDirectory, source: "attachment" },
      ],
    },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].resolvedPath, await realpath(attachmentDirectory));
});

test("preserves structured Windows UNC attachment paths", async () => {
  const uncPath = "\\\\server\\share\\folder";
  const candidates = await discoverExternalContextFiles("", undefined, {
    attachmentReferences: [{ path: uncPath, source: "attachment" }],
    classifyGitRoot: async () => ({}),
    getFileInfo: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 5,
    }),
    getLinkInfo: async () => ({ isSymbolicLink: () => false }),
    resolveRealPath: async (filePath) => filePath,
  });

  if (process.platform === "win32") {
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].resolvedPath, uncPath);
  } else {
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].originalPath, uncPath);
  }
});

test("rejects explicitly referenced symbolic links before resolution", async () => {
  const candidatePath = path.resolve("linked-context");
  let resolved = false;
  const candidates = await discoverExternalContextFiles(
    `Read \`${candidatePath}\`.`,
    undefined,
    {
      getLinkInfo: async () => ({ isSymbolicLink: () => true }),
      resolveRealPath: async (filePath) => {
        if (filePath === candidatePath) {
          resolved = true;
        }
        return candidatePath;
      },
    },
  );

  assert.deepEqual(candidates, []);
  assert.equal(resolved, false);
});

test("rejects links in parent path components", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "target");
  const linkedParent = path.join(directory, "linked-parent");
  await writeText(path.join(target, "input.txt"), "input");
  await symlink(
    target,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir",
  );

  const candidates = await discoverExternalContextFiles(
    `Read \`${path.join(linkedParent, "input.txt")}\`.`,
  );

  assert.deepEqual(candidates, []);
});

test("skips referenced Git trees and nested repositories", async (t) => {
  const directory = await temporaryDirectory(t);
  const repository = path.join(directory, "repository");
  await writeText(path.join(repository, "tracked.txt"), "tracked");
  await execFileAsync("git", ["init", "-q", repository]);

  const parent = path.join(directory, "parent");
  await writeText(path.join(parent, "keep.txt"), "keep");
  await writeText(path.join(parent, "nested-repo", "nested.txt"), "nested");
  await execFileAsync("git", ["init", "-q", path.join(parent, "nested-repo")]);

  assert.deepEqual(
    await discoverExternalContextFiles(`Read \`${repository}\`.`),
    [],
  );
  const candidates = await discoverExternalContextFiles(
    `Read \`${parent}\`.`,
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    candidates[0].files.map((file) => file.relativePath),
    ["keep.txt"],
  );
});

test("skips directories that exceed the discovery walk limit", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "large");
  await writeText(path.join(source, "one.txt"), "one");
  await writeText(path.join(source, "two.txt"), "two");
  const warnings = [];

  const candidates = await discoverExternalContextFiles(
    `Read \`${source}\`.`,
    undefined,
    {
      maxDirectoryFiles: 1,
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.match(warnings[0], /discovery safety limit/);
});

test("bounds total directory entries inspected", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "entries");
  await writeText(path.join(source, "one.txt"), "one");
  await writeText(path.join(source, "two.txt"), "two");
  await writeText(path.join(source, "three.txt"), "three");
  const warnings = [];

  const candidates = await discoverExternalContextFiles(
    `Archive \`${source}\`.`,
    undefined,
    {
      maxDirectoryEntries: 2,
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.match(warnings[0], /2 inspected entries/);
});

test("keeps explicit files when their parent directory exceeds the walk limit", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "large");
  const first = path.join(source, "one.txt");
  await writeText(first, "one");
  await writeText(path.join(source, "two.txt"), "two");
  await writeText(path.join(source, "three.txt"), "three");

  const candidates = await discoverExternalContextFiles(
    `Read \`${source}\` and \`${first}\`.`,
    undefined,
    { maxDirectoryFiles: 1 },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "file");
  assert.equal(candidates[0].resolvedPath, await realpath(first));
});

test("excludes Copilot internals and the active session workspace", async (t) => {
  const directory = await temporaryDirectory(t);
  const copilotFile = path.join(directory, ".copilot", "pkg", "internal.js");
  const sessionFile = path.join(directory, "session-workspace", "files", "notes.md");
  const externalFile = path.join(directory, "Downloads", "input.txt");
  const exportPath = path.join(directory, "session.md");
  await writeText(copilotFile, "internal");
  await writeText(sessionFile, "session artifact");
  await writeText(externalFile, "external");
  await writeText(exportPath, "export");

  const candidates = await discoverExternalContextFiles(
    `Read \`${copilotFile}\`, \`${sessionFile}\`, and \`${externalFile}\`.`,
    exportPath,
    {
      excludedRoots: [
        path.join(directory, ".copilot"),
        path.join(directory, "session-workspace"),
      ],
    },
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.resolvedPath),
    [await realpath(externalFile)],
  );
});

test("copies approved external context with collision-safe names", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = path.join(directory, "one", "input.txt");
  const second = path.join(directory, "two", "input.txt");
  await writeText(first, "first");
  await writeText(second, "second");

  const entries = await copyExternalContextFiles(
    [
      {
        originalPath: first,
        resolvedPath: first,
        byteSize: 5,
      },
      {
        originalPath: second,
        resolvedPath: second,
        byteSize: 6,
      },
    ],
    directory,
  );

  assert.equal(entries[0].archivedPath, "Context/001-input.txt");
  assert.equal(entries[1].archivedPath, "Context/002-input.txt");
});

test("avoids collisions after sanitizing directory file names", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = path.join(directory, "first.txt");
  const second = path.join(directory, "second.txt");
  await writeText(first, "first");
  await writeText(second, "second");

  const entries = await copyExternalContextFiles(
    [
      {
        kind: "directory",
        originalPath: directory,
        resolvedPath: directory,
        files: [
          {
            originalPath: first,
            resolvedPath: await realpath(first),
            relativePath: "a:b.txt",
            byteSize: 5,
          },
          {
            originalPath: second,
            resolvedPath: await realpath(second),
            relativePath: "a?b.txt",
            byteSize: 6,
          },
        ],
      },
    ],
    path.join(directory, "archive"),
  );

  const archivedRoot = `Context/001-${path.basename(directory)}`;
  assert.deepEqual(
    entries.map((entry) => entry.archivedPath),
    [`${archivedRoot}/a_b.txt`, `${archivedRoot}/a_b-2.txt`],
  );
  assert.equal(
    await readFile(path.join(directory, "archive", ...entries[0].archivedPath.split("/")), "utf8"),
    "first",
  );
  assert.equal(
    await readFile(path.join(directory, "archive", ...entries[1].archivedPath.split("/")), "utf8"),
    "second",
  );
});

test("avoids sanitized file and directory prefix collisions", async (t) => {
  const directory = await temporaryDirectory(t);
  const nestedSource = path.join(directory, "nested-source.txt");
  const flatSource = path.join(directory, "flat-source.txt");
  await writeText(nestedSource, "nested");
  await writeText(flatSource, "flat");

  const entries = await copyExternalContextFiles(
    [
      {
        kind: "directory",
        originalPath: directory,
        resolvedPath: directory,
        files: [
          {
            originalPath: nestedSource,
            resolvedPath: await realpath(nestedSource),
            relativePath: path.join("a:b", "file.txt"),
            byteSize: 6,
          },
          {
            originalPath: flatSource,
            resolvedPath: await realpath(flatSource),
            relativePath: "a?b",
            byteSize: 4,
          },
        ],
      },
    ],
    path.join(directory, "archive"),
  );

  const archivedRoot = `Context/001-${path.basename(directory)}`;
  assert.deepEqual(
    entries.map((entry) => entry.archivedPath),
    [`${archivedRoot}/a_b/file.txt`, `${archivedRoot}/a_b-2`],
  );
});

test("preserves distinct sanitized directories and Windows-reserved names", async (t) => {
  const directory = await temporaryDirectory(t);
  const sources = [];
  for (const [index, content] of ["one", "two", "three"].entries()) {
    const source = path.join(directory, `source-${index}.txt`);
    await writeText(source, content);
    sources.push(await realpath(source));
  }

  const entries = await copyExternalContextFiles(
    [
      {
        kind: "directory",
        originalPath: directory,
        resolvedPath: directory,
        files: [
          {
            originalPath: sources[0],
            resolvedPath: sources[0],
            relativePath: path.join("a:b", "one.txt"),
            byteSize: 3,
          },
          {
            originalPath: sources[1],
            resolvedPath: sources[1],
            relativePath: path.join("a?b", "two.txt"),
            byteSize: 3,
          },
          {
            originalPath: sources[2],
            resolvedPath: sources[2],
            relativePath: "NUL.txt",
            byteSize: 5,
          },
        ],
      },
    ],
    path.join(directory, "archive"),
  );

  const archivedRoot = `Context/001-${path.basename(directory)}`;
  assert.deepEqual(
    entries.map((entry) => entry.archivedPath),
    [
      `${archivedRoot}/a_b/one.txt`,
      `${archivedRoot}/a_b-2/two.txt`,
      `${archivedRoot}/_NUL.txt`,
    ],
  );
});

test("skips approved sources replaced before their verified open", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "source.txt");
  await writeText(source, "original");
  const info = await stat(source);
  const warnings = [];

  const entries = await copyExternalContextFiles(
    [
      {
        originalPath: source,
        resolvedPath: source,
        byteSize: info.size,
        device: info.dev,
        inode: info.ino,
        mtimeMs: info.mtimeMs,
      },
    ],
    path.join(directory, "archive"),
    {
      beforeCopyContextFile: async () => {
        await rm(source);
        await writeText(source, "replacement");
      },
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(entries, []);
  assert.match(warnings[0], /SOURCE_CHANGED/);
});

test("skips approved source files that disappear during copying", async (t) => {
  const directory = await temporaryDirectory(t);
  const missing = path.join(directory, "missing.txt");
  const available = path.join(directory, "available.txt");
  await writeText(missing, "missing");
  await writeText(available, "available");
  const warnings = [];

  const entries = await copyExternalContextFiles(
    [
      {
        originalPath: missing,
        resolvedPath: missing,
        byteSize: 7,
      },
      {
        originalPath: available,
        resolvedPath: available,
        byteSize: 9,
      },
    ],
    path.join(directory, "archive"),
    {
      beforeCopyContextFile: async (source) => {
        if (source === missing) {
          await rm(source);
        }
      },
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].resolvedSourcePath, available);
  assert.match(warnings[0], /became unavailable/);
  assert.match(warnings[0], /ENOENT/);
});

test("does not hide archive destination copy failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "source.txt");
  const archive = path.join(directory, "archive");
  const destination = path.join(archive, "Context", "001-source.txt");
  await writeText(source, "source");
  await mkdir(destination, { recursive: true });

  await assert.rejects(
    copyExternalContextFiles(
      [{ originalPath: source, resolvedPath: source, byteSize: 6 }],
      archive,
    ),
    /EEXIST|EPERM|EISDIR|EACCES/,
  );
  assert.equal((await stat(destination)).isDirectory(), true);
});

test("warns when a referenced file vanishes during classification", async (t) => {
  const directory = await temporaryDirectory(t);
  const external = path.join(directory, "input.txt");
  await writeText(external, "input");
  const warnings = [];
  let targetStats = 0;

  const candidates = await discoverExternalContextFiles(
    `Read \`${external}\`.`,
    undefined,
    {
      classifyGitRoot: async () => ({}),
      getFileInfo: async (filePath) => {
        if (filePath === await realpath(external)) {
          targetStats += 1;
          if (targetStats === 2) {
            throw Object.assign(new Error("file vanished"), { code: "ENOENT" });
          }
        }
        return stat(filePath);
      },
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.match(warnings[0], /could not be inspected/);
  assert.match(warnings[0], /ENOENT/);
});

test("skips external files when Git classification is unavailable", async (t) => {
  const directory = await temporaryDirectory(t);
  const external = path.join(directory, "Downloads", "input.txt");
  await writeText(external, "external");
  const warnings = [];

  const candidates = await discoverExternalContextFiles(
    `Read \`${external}\`.`,
    undefined,
    {
      classifyGitRoot: async () => ({ warning: "Git unavailable" }),
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.deepEqual(warnings, ["Git unavailable"]);
});

test("deduplicates varying Git classification warnings", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = path.join(directory, "one", "input.txt");
  const second = path.join(directory, "two", "input.txt");
  await writeText(first, "one");
  await writeText(second, "two");
  const warnings = [];

  const candidates = await discoverExternalContextFiles(
    `Read \`${first}\` and \`${second}\`.`,
    undefined,
    {
      classifyGitRoot: async (filePath) => ({
        warning: `Unable to classify ${filePath}`,
      }),
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.equal(warnings.length, 1);
});

test("skips inaccessible UNC references instead of aborting discovery", async () => {
  const warnings = [];
  const error = Object.assign(
    new Error(
      "UNKNOWN: unknown error, realpath '\\\\spocore\\src\\inaccessible.cs'",
    ),
    { code: "UNKNOWN" },
  );

  const candidates = await discoverExternalContextFiles(
    "Read `\\\\spocore\\src\\inaccessible.cs`.",
    undefined,
    {
      excludedRoots: [],
      resolveRealPath: async (filePath) => {
        if (filePath.includes("spocore")) {
          throw error;
        }
        return filePath;
      },
      getLinkInfo: async () => ({ isSymbolicLink: () => false }),
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /optional referenced paths/);
  assert.match(warnings[0], /UNKNOWN/);
});

test("combines inaccessible referenced-path warnings", async () => {
  const warnings = [];
  const candidates = await discoverExternalContextFiles(
    "Read `C:\\one.txt`, `C:\\two.txt`, and `C:\\three.txt`.",
    undefined,
    {
      excludedRoots: [],
      resolveRealPath: async (filePath) => {
        if (filePath.includes("one")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        if (filePath.includes("two")) {
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        }
        if (filePath.includes("three")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return filePath;
      },
      getLinkInfo: async () => ({ isSymbolicLink: () => false }),
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.deepEqual(warnings, [
    "Some optional referenced paths could not be inspected and were skipped (EACCES, ECONNRESET).",
  ]);
});

test("warns when referenced paths are missing", async () => {
  const warnings = [];
  const candidates = await discoverExternalContextFiles(
    "Read `C:\\missing.txt` and `C:\\not-a-directory\\input.txt`.",
    undefined,
    {
      excludedRoots: [],
      resolveRealPath: async (filePath) => {
        const code = filePath.includes("not-a-directory") ? "ENOTDIR" : "ENOENT";
        throw Object.assign(new Error(code), { code });
      },
      getLinkInfo: async () => ({ isSymbolicLink: () => false }),
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.deepEqual(warnings, [
    "Some optional referenced paths could not be inspected and were skipped (ENOENT, ENOTDIR).",
  ]);
});
