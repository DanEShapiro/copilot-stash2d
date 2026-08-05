import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
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
    extractReferencedPaths("Read `./local.txt` and '../shared/input.json'."),
    ["./local.txt", "../shared/input.json"],
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
