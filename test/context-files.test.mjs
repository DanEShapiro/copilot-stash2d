import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
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
    ["./local.txt", "docs/reference", "../shared/input.json"],
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

test("keeps explicit files when their parent directory exceeds the walk limit", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "large");
  const first = path.join(source, "one.txt");
  await writeText(first, "one");
  await writeText(path.join(source, "two.txt"), "two");

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
      onWarning: async (message) => warnings.push(message),
    },
  );

  assert.deepEqual(candidates, []);
  assert.deepEqual(warnings, [
    "Some optional referenced paths could not be inspected and were skipped (ENOENT, ENOTDIR).",
  ]);
});
